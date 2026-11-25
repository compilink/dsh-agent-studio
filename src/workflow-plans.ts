import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorkflowChecks, type RuleValidator } from './workflow-checks.js';
import type { StudioStore } from './store.js';
import type { TaskEngine } from './task-engine.js';
import type { AgentTemplate } from './types.js';

export class WorkflowError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const version = z.number().int().nonnegative();
export const graphSchema = z.object({
  name: z.string().trim().min(1).max(120),
  nodes: z.array(z.object({
    id, name: z.string().trim().min(1).max(120), instruction: z.string(),
    inputRule: z.string().optional(), outputRule: z.string().optional(),
    templateId: id.optional(), review: z.boolean(), x: z.number().int().min(0).max(10000), y: z.number().int().min(0).max(10000),
  }).strict()),
  edges: z.array(z.object({from: id, to: id}).strict()),
}).strict();

export type WorkflowGraph = z.output<typeof graphSchema>;

class AdmissionError extends WorkflowError {
  constructor(readonly nodeId: string, cause: unknown) {
    super(409, cause instanceof Error ? cause.message : '节点任务派发失败');
  }
}

/** The same dependency check used by the writing workbench, independent of its documents and roles. */
export function orderedNodes(graph: WorkflowGraph): string[] {
  const children = new Map(graph.nodes.map(node => [node.id, new Set<string>()]));
  if (children.size !== graph.nodes.length) throw new WorkflowError(400, '流程中有重复的节点 ID');
  const degrees = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const {from, to} of graph.edges) {
    const targets = children.get(from);
    const degree = degrees.get(to);
    if (!targets || degree === undefined) throw new WorkflowError(400, '连线引用了不存在的节点');
    if (targets.has(to)) throw new WorkflowError(400, '流程中有重复的连线');
    targets.add(to);
    degrees.set(to, degree + 1);
  }
  const ready = graph.nodes.filter(node => degrees.get(node.id) === 0).map(node => node.id);
  for (let i = 0; i < ready.length; i++) {
    for (const target of children.get(ready[i]!)!) {
      const degree = degrees.get(target)! - 1;
      degrees.set(target, degree);
      if (degree === 0) ready.push(target);
    }
  }
  if (ready.length !== graph.nodes.length) throw new WorkflowError(400, '流程连线不能形成环');
  return ready;
}

const fileInput = z.object({nodeId:id, name:z.string().trim().min(1).max(255), content:z.string()}).strict();
type FileInput = z.output<typeof fileInput>;

type Stage = 'waiting' | 'checking' | 'dispatched' | 'review' | 'released' | 'rejected' | 'failed';
interface Pass {
  stage: Stage;
  taskId?: string;
  attemptId?: string;
  input?: {nodeId: string; round: number; taskId: string; attemptId?: string}[];
  output?: string;
  manualApproval?: boolean;
  note?: string;
}

export interface WorkflowInstance {
  id: string;
  runId: string;
  templateId: string;
  version: number;
  stopped: boolean;
  nodes: {id: string; passes: Pass[]}[];
}

function latest(node: WorkflowInstance['nodes'][number]): Pass {
  return node.passes[node.passes.length - 1]!;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WorkflowError(400, '流程参数无效：' + parsed.error.issues[0]?.path.join('.'));
  return parsed.data;
}

/** Versioned workflow definitions and the durable handoff of approved results between ordinary Studio tasks. */
export class WorkflowService {
  private refreshing = false;
  readonly checks: WorkflowChecks;
  constructor(private readonly store: StudioStore, private readonly engine: TaskEngine, validate?: RuleValidator) {
    this.checks = new WorkflowChecks(store, validate, () => this.refresh());
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS workflow_templates(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, published INTEGER NOT NULL, draft TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workflow_retired(template_id TEXT PRIMARY KEY REFERENCES workflow_templates(id));
      CREATE TABLE IF NOT EXISTS workflow_versions(template_id TEXT NOT NULL REFERENCES workflow_templates(id), version INTEGER NOT NULL, graph TEXT NOT NULL, PRIMARY KEY(template_id,version));
      CREATE TABLE IF NOT EXISTS workflow_agent_versions(template_id TEXT NOT NULL, version INTEGER NOT NULL, agent_id TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(template_id,version,agent_id), FOREIGN KEY(template_id,version) REFERENCES workflow_versions(template_id,version));
      CREATE TABLE IF NOT EXISTS workflow_instances(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), request_id TEXT NOT NULL, active INTEGER NOT NULL, state TEXT NOT NULL, UNIQUE(run_id,request_id));
      CREATE TABLE IF NOT EXISTS workflow_input_files(instance_id TEXT NOT NULL REFERENCES workflow_instances(id), node_id TEXT NOT NULL, files TEXT NOT NULL, PRIMARY KEY(instance_id,node_id));
      CREATE INDEX IF NOT EXISTS workflow_active ON workflow_instances(active);`);
  }

  templates() {
    return this.store.db.prepare('SELECT t.*, r.template_id AS retired FROM workflow_templates t LEFT JOIN workflow_retired r ON t.id=r.template_id ORDER BY t.rowid DESC').all().map(row => ({
      id: String(row.id), retired: Boolean(row.retired), revision: Number(row.revision), published: Number(row.published), draft: JSON.parse(String(row.draft)) as WorkflowGraph,
    }));
  }

  private current(id: string) {
    const row = this.store.db.prepare('SELECT t.*, r.template_id AS retired FROM workflow_templates t LEFT JOIN workflow_retired r ON t.id=r.template_id WHERE t.id=?').get(id);
    if (!row) throw new WorkflowError(404, '找不到流程模板');
    return {retired: Boolean(row.retired), revision: Number(row.revision), published: Number(row.published), draft: JSON.parse(String(row.draft)) as WorkflowGraph};
  }

  private activeTemplate(templateId: string) {
    const template = this.current(templateId);
    if (template.retired) throw new WorkflowError(409, '模板已停用');
    return template;
  }

  setRetired(templateId: string, value: unknown) {
    const {expectedRevision, retired} = parse(z.object({expectedRevision: version, retired: z.boolean()}).strict(), value);
    return this.store.atomic(() => {
      const current = this.current(templateId);
      if (current.revision !== expectedRevision) throw new WorkflowError(409, '模板已有新修改，请重新载入');
      if (current.retired !== retired) {
        if (retired) this.store.db.prepare('INSERT INTO workflow_retired VALUES(?)').run(templateId);
        else this.store.db.prepare('DELETE FROM workflow_retired WHERE template_id=?').run(templateId);
        this.store.db.prepare('UPDATE workflow_templates SET revision=revision+1 WHERE id=?').run(templateId);
      }
      return {id: templateId, ...this.current(templateId)};
    });
  }

  restore(templateId: string, value: unknown) {
    const {expectedRevision, sourceVersion} = parse(z.object({expectedRevision: version, sourceVersion: version.min(1)}).strict(), value);
    return this.save(templateId, {expectedRevision, graph:this.graph(templateId, sourceVersion)});
  }

  save(templateId: string, value: unknown) {
    parse(id, templateId);
    const {expectedRevision, graph} = parse(z.object({expectedRevision: version, graph: graphSchema}).strict(), value);
    orderedNodes(graph);
    return this.store.atomic(() => {
      const existing = this.store.db.prepare('SELECT revision FROM workflow_templates WHERE id=?').get(templateId);
      if (existing) this.activeTemplate(templateId);
      if (Number(existing?.revision ?? 0) !== expectedRevision) throw new WorkflowError(409, '草稿已有新修改，请重新载入');
      this.store.db.prepare(`INSERT INTO workflow_templates VALUES (?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,draft=excluded.draft`).run(templateId, expectedRevision + 1, JSON.stringify(graph));
      return {id: templateId, ...this.current(templateId)};
    });
  }

  publish(templateId: string, value: unknown) {
    const {expectedRevision} = parse(z.object({expectedRevision: version}).strict(), value);
    return this.store.atomic(() => {
      const {revision, published, draft} = this.activeTemplate(templateId);
      if (revision !== expectedRevision) throw new WorkflowError(409, '草稿已有新修改，请重新载入');
      if (!draft.nodes.length || draft.nodes.some(node => !node.instruction.trim())) throw new WorkflowError(400, '发布前请添加节点并填写每个节点的指令');
      const pins = new Map<string, AgentTemplate>();
      for (const node of draft.nodes) {
        if (!node.templateId || pins.has(node.templateId)) continue;
        const agent = this.store.template(node.templateId);
        if (!agent) throw new WorkflowError(400, '找不到节点配置的 Agent 模板');
        pins.set(agent.id, agent);
      }
      if (published && JSON.stringify(this.graph(templateId, published)) === JSON.stringify(draft)
        && [...pins.values()].every(agent => this.agent(templateId, published, agent.id).version === agent.version)) {
        return {id: templateId, ...this.current(templateId)};
      }
      this.store.db.prepare('INSERT INTO workflow_versions VALUES(?,?,?)').run(templateId, published + 1, JSON.stringify(draft));
      for (const [agentId, agent] of pins) this.store.db.prepare('INSERT INTO workflow_agent_versions VALUES(?,?,?,?)')
        .run(templateId, published + 1, agentId, JSON.stringify(agent));
      this.store.db.prepare('UPDATE workflow_templates SET published=?,revision=revision+1 WHERE id=?').run(published + 1, templateId);
      return {id: templateId, ...this.current(templateId)};
    });
  }

  graph(templateId: string, number: number): WorkflowGraph {
    const row = this.store.db.prepare('SELECT graph FROM workflow_versions WHERE template_id=? AND version=?').get(templateId, number);
    if (!row) throw new WorkflowError(404, '找不到该流程版本');
    return JSON.parse(String(row.graph)) as WorkflowGraph;
  }

  private agent(templateId: string, version: number, agentId: string): AgentTemplate {
    const row = this.store.db.prepare('SELECT snapshot FROM workflow_agent_versions WHERE template_id=? AND version=? AND agent_id=?').get(templateId, version, agentId);
    if (!row) throw new WorkflowError(409, '找不到该流程版本的 Agent 快照');
    return JSON.parse(String(row.snapshot)) as AgentTemplate;
  }

  inspectVersion(templateId: string, version: number) {
    const graph = this.graph(templateId, version);
    return {...graph, nodes:graph.nodes.map(node => {
      if (!node.templateId) return node;
      const agent = this.agent(templateId, version, node.templateId);
      return {...node, agent:{id:agent.id, name:agent.name, role:agent.role, version:agent.version}};
    })};
  }

  instances(runId: string) {
    return this.store.db.prepare('SELECT state FROM workflow_instances WHERE run_id=? ORDER BY rowid DESC').all(runId)
      .map(row => JSON.parse(String(row.state)) as WorkflowInstance);
  }

  private instance(id: string): WorkflowInstance {
    const row = this.store.db.prepare('SELECT state FROM workflow_instances WHERE id=?').get(id);
    if (!row) throw new WorkflowError(404, '找不到流程实例');
    return JSON.parse(String(row.state)) as WorkflowInstance;
  }

  releasedOutput(instanceId: string, nodeId: string, round: number) {
    const instance = this.instance(instanceId);
    const node = instance.nodes.find(item => item.id === nodeId);
    if (!Number.isSafeInteger(round) || round < 1) throw new WorkflowError(400, '执行轮次无效');
    const pass = node?.passes[round - 1];
    if (!pass) throw new WorkflowError(404, '该流程节点没有这轮执行');
    if (pass.stage !== 'released' || !pass.output?.trim()) throw new WorkflowError(409, '此轮结果尚未放行');
    const graph = this.graph(instance.templateId, instance.version);
    const spec = graph.nodes.find(item => item.id === nodeId)!;
    return {title: graph.name + ' · ' + spec.name + ' · 第 ' + round + ' 轮', content: pass.output};
  }

  private requireRun(runId: string) {
    const run = this.store.run(runId);
    if (!run) throw new WorkflowError(404, '找不到协作');
    if (run.status === 'stopped') throw new WorkflowError(409, '协作已停止');
  }

  private files(instanceId: string, nodeId: string): FileInput[] {
    const row = this.store.db.prepare('SELECT files FROM workflow_input_files WHERE instance_id=? AND node_id=?').get(instanceId,nodeId);
    return row ? JSON.parse(String(row.files)) as FileInput[] : [];
  }

  start(templateId: string, value: unknown) {
    const input = parse(z.object({runId: id, version: version.min(1), requestId: id, files:z.array(fileInput).default([])}).strict(), value);
    return this.store.atomic(() => {
      const byNode = new Map<string, FileInput[]>();
      for (const file of input.files) {
        const group = byNode.get(file.nodeId) ?? [];
        group.push(file);
        byNode.set(file.nodeId, group);
      }
      const prior = this.store.db.prepare('SELECT state FROM workflow_instances WHERE run_id=? AND request_id=?').get(input.runId, input.requestId);
      if (prior) {
        const instance = JSON.parse(String(prior.state)) as WorkflowInstance;
        if (instance.templateId !== templateId || instance.version !== input.version) throw new WorkflowError(409, '启动请求与已有流程冲突');
        const count = this.store.db.prepare('SELECT COUNT(*) AS n FROM workflow_input_files WHERE instance_id=?').get(instance.id);
        if (Number(count?.n) !== byNode.size || [...byNode].some(([id,files]) => JSON.stringify(this.files(instance.id,id)) !== JSON.stringify(files))) throw new WorkflowError(409, '启动请求的附件与原实例不一致');
        return instance;
      }
      this.activeTemplate(templateId);
      this.requireRun(input.runId);
      const graph = this.graph(templateId, input.version);
      for (const nodeId of byNode.keys()) {
        if (!graph.nodes.some(node => node.id === nodeId)) throw new WorkflowError(400, '该流程版本没有附件指定的节点');
      }
      for (const agentId of new Set(graph.nodes.map(n => n.templateId).filter((value): value is string => !!value))) {
        this.engine.validateAssignment(input.runId, this.agent(templateId, input.version, agentId));
      }
      const instance: WorkflowInstance = {id: randomUUID(), runId: input.runId, templateId, version: input.version, stopped: false,
        nodes: graph.nodes.map(node => ({id: node.id, passes: [{stage: 'waiting'}]}))};
      this.store.db.prepare('INSERT INTO workflow_instances VALUES(?,?,?,1,?)').run(instance.id, instance.runId, input.requestId, JSON.stringify(instance));
      for (const [nodeId,files] of byNode) this.store.db.prepare('INSERT INTO workflow_input_files VALUES(?,?,?)').run(instance.id,nodeId,JSON.stringify(files));
      this.advance(instance, graph);
      return instance;
    });
  }

  private persist(instance: WorkflowInstance) {
    const active = !instance.stopped && instance.nodes.some(n => ['waiting','dispatched','checking','review','failed'].includes(latest(n).stage));
    this.store.db.prepare('UPDATE workflow_instances SET state=?,active=? WHERE id=?').run(JSON.stringify(instance), Number(active), instance.id);
  }

  private advance(instance: WorkflowInstance, graph: WorkflowGraph) {
    const before = JSON.stringify(instance);
    if (this.store.run(instance.runId)?.status === 'stopped') instance.stopped = true;
    if (!instance.stopped) {
      const byId = new Map(instance.nodes.map(node => [node.id, node]));
      const specs = new Map(graph.nodes.map(node => [node.id, node]));
      for (const id of orderedNodes(graph)) {
        const node = byId.get(id)!;
        const spec = specs.get(id)!;
        const pass = latest(node);
        const task = pass.taskId ? this.store.task(pass.taskId) : undefined;
        if (pass.stage === 'failed' && task && ['running','queued','review'].includes(task.status)) {
          pass.stage = 'dispatched'; delete pass.note;
        }
        if (pass.stage === 'dispatched') {
          if (task?.status === 'completed') {
            const attempt = task.latestAttemptId ? this.store.attempt(task.latestAttemptId) : undefined;
            if (attempt) pass.attemptId = attempt.id;
            pass.output = attempt?.summary?.trim() ? attempt.summary : task.result;
            if (!pass.output?.trim()) { pass.stage = 'failed'; pass.note = '任务缺少可交接的结果'; }
            else pass.stage = 'checking';
          } else if (!task || ['blocked','failed','cancelled'].includes(task.status)) {
            pass.stage = 'failed';
            pass.note = task?.error || '任务已中止';
          }
        }
        const check = (side: 'input' | 'output', contents: string[]) => {
          const rule = side === 'input' ? spec.inputRule : spec.outputRule;
          if (!rule?.trim()) return {status:'passed' as const, reason:''};
          const run = this.store.run(instance.runId)!;
          const selection = spec.templateId ? this.agent(instance.templateId,instance.version,spec.templateId).selection : this.store.agent(run.orchestratorId)!.selection;
          return this.checks.check(instance.runId, [instance.id, id, node.passes.length, side],rule,contents,selection);
        };
        if (pass.stage === 'checking') {
          const result = check('output',[pass.output!]);
          if (result.status === 'pending') continue;
          if (result.status !== 'passed') {
            pass.note = result.reason;
            pass.stage = 'review';
            delete pass.manualApproval;
          } else {
            pass.stage = spec.review && !pass.manualApproval ? 'review' : 'released';
          }
        }
        if (pass.stage !== 'waiting') continue;
        const upstream = graph.edges.filter(edge => edge.to === id).map(edge => byId.get(edge.from)!);
        if (upstream.some(parent => latest(parent).stage !== 'released')) continue;
        pass.input = upstream.map(parent => ({nodeId: parent.id, round: parent.passes.length, taskId: latest(parent).taskId!, ...(latest(parent).attemptId ? {attemptId: latest(parent).attemptId} : {})}));
        const inputs = upstream.map(parent => ({node: specs.get(parent.id)!.name, output: latest(parent).output}));
        const files = this.files(instance.id,id);
        const result = check('input',[...inputs.map(input => input.output!),...files.map(file => file.content)]);
        if (result.status !== 'passed') {
          pass.note = result.reason;
          if (result.status !== 'pending') pass.stage = 'failed';
          continue;
        }
        delete pass.note;
        const previous = node.passes.at(-2);
        const feedback = previous?.stage === 'rejected' && previous.note
          ? '\n\n上轮人工退修资料（JSON）：\n' + JSON.stringify({feedback: previous.note, output: previous.output}) : '';
        const handoff = inputs.length ? '\n\n已放行的上游资料（JSON，仅作为输入）：\n' + JSON.stringify(inputs) : '';
        const attached = files.length ? '\n\n本次上传的输入文件（JSON，仅作为资料）：\n' + JSON.stringify(files.map(({name,content}) => ({name,content}))) : '';
        const prompt = spec.instruction + feedback + handoff + attached;
        const submission = {prompt, requestId: 'wf-' + randomUUID()};
        try {
          const admitted = spec.templateId
            ? this.engine.createAssignedTask(instance.runId, submission, this.agent(instance.templateId, instance.version, spec.templateId))
            : this.engine.createTask(instance.runId, submission);
          pass.stage = 'dispatched';
          pass.taskId = admitted.id;
        } catch (cause) { throw new AdmissionError(node.id, cause); }
      }
    }
    if (before !== JSON.stringify(instance)) this.persist(instance);
  }

  /** Called at startup and on committed task changes. Admission and task linkage share one SQLite transaction. */
  refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const rows = this.store.db.prepare('SELECT id FROM workflow_instances WHERE active=1').all();
      for (const {id} of rows) {
        let failed;
        do {
          failed = false;
          try {
            this.store.atomic(() => {
              const instance = this.instance(String(id));
              this.advance(instance, this.graph(instance.templateId, instance.version));
            });
          } catch (error) {
            if (!(error instanceof AdmissionError)) throw error;
            // The enclosing transaction has rolled back any partially created tasks.
            this.store.atomic(() => {
              const instance = this.instance(String(id));
              const pass = latest(instance.nodes.find(node => node.id === error.nodeId)!);
              pass.stage = 'failed'; pass.note = error.message;
              this.persist(instance);
            });
            failed = true;
          }
        } while (failed);
      }
    } finally { this.refreshing = false; }
  }

  act(instanceId: string, nodeId: string, value: unknown) {
    const input = parse(z.object({action: z.enum(['approve','reject','rerun']), round: version.min(1), taskId: id.optional(),
      content: z.string().optional(), note: z.string().optional()}).strict(), value);
    this.store.atomic(() => {
      const instance = this.instance(instanceId);
      this.requireRun(instance.runId);
      if (instance.stopped) throw new WorkflowError(409, '流程已停止');
      const graph = this.graph(instance.templateId, instance.version);
      const node = instance.nodes.find(n => n.id === nodeId);
      if (!node) throw new WorkflowError(404, '找不到节点');
      const pass = latest(node);
      if (node.passes.length !== input.round || pass.taskId !== input.taskId) throw new WorkflowError(409, '节点已进入新一轮执行，请重新载入');
      if (input.action === 'rerun') {
        if (pass.stage === 'waiting' || pass.stage === 'dispatched' || pass.stage === 'checking') throw new WorkflowError(409, '该节点尚在执行');
        const reset = new Set([nodeId]);
        for (const key of orderedNodes(graph)) {
          if (graph.edges.some(edge => edge.to === key && reset.has(edge.from))) reset.add(key);
        }
        const affected = instance.nodes.filter(n => reset.has(n.id));
        if (affected.some(n => ['dispatched','checking'].includes(latest(n).stage))) throw new WorkflowError(409, '下游仍在执行，完成后可重跑');
        for (const n of affected) n.passes.push({stage: 'waiting'});
      } else {
        if (pass.stage !== 'review') throw new WorkflowError(409, '该版本当前不在待审核状态');
        if (input.action === 'approve') {
          const approved = input.content ?? pass.output;
          if (!approved?.trim()) throw new WorkflowError(400, '放行结果不可为空');
          pass.output = approved;
          pass.manualApproval = true;
          pass.stage = 'checking';
          delete pass.note;
        } else pass.stage = 'rejected';
        if (input.note) pass.note = input.note;
      }
      this.persist(instance);
    });
    this.refresh();
    return this.instance(instanceId);
  }
}
