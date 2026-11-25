/** Transactional task ownership and durable inbox commands, independent of model execution. */
import { randomUUID } from 'node:crypto';
import { StudioStore } from './store.js';
import type { StoredAgent } from './store.js';
import type { AttemptView, DeliveryView, NewTaskInput, TaskView } from './types.js';

const terminal = (task: TaskView) => ['completed', 'cancelled'].includes(task.status);
const now = () => new Date().toISOString();
export function requiredText(value: unknown, name: string, max = 8000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name} must be non-empty text up to ${max} characters`);
  return value;
}

/** All task commands commit state and delivery records together; callbacks never run inside SQLite transactions. */
export class TaskEngine {
  constructor(readonly store: StudioStore, private readonly options: {onChange?: () => void} = {}) {}
  private command<T>(work: () => T): T { return this.store.atomic(() => { const result = work(); this.store.afterCommit(() => this.options.onChange?.()); return result; }); }
  private taskIn(runId: string, taskId: string): TaskView { const task = this.store.task(taskId); if (!task || task.runId !== runId) throw new Error('Unknown task'); return task; }
  private actor(id: string): StoredAgent { const actor = this.store.agent(id); if (!actor) throw new Error('Unknown agent'); return actor; }
  private refresh(runId: string): void {
    const tasks = this.store.tasks(runId);
    this.store.setRunStatus(runId, tasks.some(t => ['queued','running','review'].includes(t.status)) ? 'running' : tasks.some(t => ['blocked','failed'].includes(t.status)) ? 'blocked' : 'idle');
  }
  private delivery(runId: string, agentId: string, kind: DeliveryView['kind'], text: string, taskId?: string, attemptId?: string, recovery = false): DeliveryView {
    const value: DeliveryView = {id: randomUUID(), runId, agentId, kind, text, ...(taskId ? {taskId} : {}), ...(attemptId ? {attemptId} : {}), state: 'pending', failures: 0, nextAt: 0, createdAt: now(), ...(recovery ? {recovery: true} : {})};
    this.store.saveDelivery(value); return value;
  }
  private saveTask(task: TaskView): void { this.store.saveTask({...task, updatedAt: now()}); this.refresh(task.runId); }
  createTask(runId: string, input: NewTaskInput): TaskView {
    return this.command(() => {
      const run = this.store.run(runId); if (!run) throw new Error('Unknown run');
      const prompt = requiredText(input.prompt, 'prompt'), requestId = requiredText(input.requestId, 'requestId', 100);
      const existing = this.store.tasks(runId).find(t => t.requestId === requestId);
      if (existing) {
        if (existing.prompt !== prompt || existing.targetManagerId !== input.targetManagerId) throw new Error('requestId conflict: this submission already has different content');
        return existing;
      }
      if (input.targetManagerId) {
        const target = this.actor(input.targetManagerId);
        if (target.runId !== runId || target.role !== 'manager' || target.parentId !== run.orchestratorId) throw new Error('Target must be a Manager in this Run');
        if (run.mode === 'direct') throw new Error('Direct mode cannot target a Manager');
      }
      const task: TaskView = {id: randomUUID(), runId, requestId, prompt, title: prompt.slice(0, 80), coordinatorId: run.orchestratorId,
        ...(input.targetManagerId ? {targetManagerId: input.targetManagerId} : {}), status: 'queued', createdAt: now(), updatedAt: now()};
      this.store.saveTask(task);
      this.store.message(runId, 'user', `【新任务】${prompt}`, `task:${task.id}`);
      this.delivery(runId, run.orchestratorId, 'task', prompt, task.id);
      this.store.activity(runId, 'task-created', '新任务已持久接收；不会抢占当前执行', run.orchestratorId, task.id);
      this.refresh(runId); return task;
    });
  }
  message(runId: string, value: string): void {
    this.command(() => { const run = this.store.run(runId); if (!run) throw new Error('Unknown run'); const text = requiredText(value, 'message');
      const delivery = this.delivery(runId, run.orchestratorId, 'message', text); this.store.message(runId, 'user', text, delivery.id); });
  }
  /** Only children of the explicitly selected historical parent are eligible for private long-term identity reuse. */
  memorySources(actorId: string): {agentId: string; name: string; role: 'manager'|'worker'; templateId: string}[] {
    const actor = this.actor(actorId), run = this.store.run(actor.runId)!;
    if (actor.role === 'worker' || !actor.memorySourceAgentId || !run.memorySourceRunId) return [];
    const used = new Set(this.store.agents(run.id).map(a => a.memoryIdentityId));
    return this.store.agents(run.memorySourceRunId).filter(a => a.parentId === actor.memorySourceAgentId && a.role !== 'orchestrator' && !used.has(a.memoryIdentityId))
      .map(a => ({agentId: a.id, name: a.name, role: a.role as 'manager'|'worker', templateId: a.templateId}));
  }
  delegate(actorId: string, input: {taskId: string; role: 'manager' | 'worker'; prompt: string; templateId?: string; agentId?: string; memorySourceAgentId?: string}): {agentId: string; role: 'manager' | 'worker'; reused: boolean; attemptId?: string} {
    return this.command(() => {
      const actor = this.actor(actorId), task = this.taskIn(actor.runId, input.taskId), run = this.store.run(actor.runId)!;
      const prompt = requiredText(input.prompt, 'prompt');
      if (!['manager','worker'].includes(input.role) || actor.role === 'worker' || (actor.role === 'manager' && input.role !== 'worker')) throw new Error('Role cannot delegate to this child');
      if (actor.role === 'orchestrator' && ((run.mode === 'direct' && input.role !== 'worker') || (run.mode === 'hierarchical' && input.role !== 'manager'))) throw new Error('Delegation conflicts with execution mode');
      if (terminal(task) || ['blocked','failed'].includes(task.status)) throw new Error('Task is not available for delegation');
      if (task.coordinatorId !== actorId) {
        const manager = this.store.agent(task.coordinatorId);
        if (actor.role === 'orchestrator' && input.role === 'manager' && manager?.parentId === actorId) return {agentId: manager.id, role: 'manager', reused: true};
        throw new Error('Only the task coordinator can delegate it');
      }
      if (task.targetManagerId && actor.role === 'orchestrator' && (input.role !== 'manager' || (input.agentId && input.agentId !== task.targetManagerId))) throw new Error('Task must route to its selected Manager');
      if (task.latestAttemptId) {
        const prior = this.store.attempt(task.latestAttemptId)!;
        if (['queued','running','reported'].includes(prior.status)) return {agentId: prior.workerId, role: 'worker', reused: true, attemptId: prior.id};
      }
      let child: StoredAgent | undefined;
      if (input.memorySourceAgentId && input.agentId) throw new Error('Choose either an existing child or a historical memory source');
      const selectedId = task.targetManagerId && actor.role === 'orchestrator' ? task.targetManagerId : input.agentId;
      if (selectedId) {
        child = this.actor(selectedId);
        if (child.parentId !== actorId || child.runId !== task.runId || child.role !== input.role) throw new Error('Selected child is outside this execution group');
        if (input.role === 'worker' && this.store.attempts().some(a => a.workerId === child!.id && ['queued','running'].includes(a.status))) throw new Error('Worker is already assigned to another task');
      }
      if (!child && !input.memorySourceAgentId && input.role === 'manager') child = this.store.agents(task.runId).find(a => a.parentId === actorId && a.role === 'manager' && (!input.templateId || a.templateId === input.templateId));
      const reused = !!child;
      if (!child) {
        const source = input.memorySourceAgentId ? this.store.agent(input.memorySourceAgentId) : undefined;
        if (input.memorySourceAgentId && (!source || !this.memorySources(actorId).some(a => a.agentId === source.id) || source.role !== input.role)) throw new Error('Memory source is not an authorized historical child');
        const templateId = input.templateId ?? source?.templateId;
        const template = templateId ? this.store.template(templateId) : this.store.templates().find(t => t.role === input.role);
        if (!template || template.role !== input.role) throw new Error('Template role does not match child role');
        if (source && source.templateId !== template.id) throw new Error('Memory source must match the child template');
        if (this.store.agents(task.runId).length >= 24) throw new Error('Run limit: 24 agents');
        const id = randomUUID();
        child = {id, sessionId: randomUUID(), runId: task.runId, parentId: actorId, createdBy: actorId, templateId: template.id, templateVersion: template.version,
          memoryIdentityId: source?.memoryIdentityId ?? randomUUID(), ...(source ? {memorySourceAgentId: source.id} : {}), name: `${template.name} ${this.store.agents(task.runId).filter(a => a.role === input.role).length + 1}`,
          role: input.role, selection: structuredClone(template.selection), systemPrompt: template.systemPrompt, status: 'dormant', createdAt: now()};
        this.store.saveAgent(child);
      }
      if (input.role === 'manager') {
        this.saveTask({...task, coordinatorId: child.id, status: 'queued'});
        this.delivery(task.runId, child.id, 'task', prompt, task.id);
        this.store.activity(task.runId, 'delegated', `${actor.name} → ${child.name}`, actor.id, task.id);
        return {agentId: child.id, role: 'manager', reused};
      }
      const attempt = this.startAttempt(task, child.id, prompt);
      this.store.activity(task.runId, 'delegated', `${actor.name} → ${child.name}`, actor.id, task.id);
      return {agentId: child.id, role: 'worker', reused, attemptId: attempt.id};
    });
  }
  private startAttempt(task: TaskView, workerId: string, prompt: string, recovery = false): AttemptView {
    const attempt: AttemptView = {id: randomUUID(), taskId: task.id, workerId, number: this.store.attempts(task.id).length + 1, status: 'queued', createdAt: now()};
    this.store.saveAttempt(attempt); this.saveTask({...task, status: 'queued', latestAttemptId: attempt.id, error: undefined, result: undefined});
    this.delivery(task.runId, workerId, 'task', prompt, task.id, attempt.id, recovery); return attempt;
  }
  report(actorId: string, input: {taskId: string; attemptId: string; text: string; evidence?: string[]}): void {
    this.command(() => {
      const actor = this.actor(actorId), task = this.taskIn(actor.runId, input.taskId), attempt = this.store.attempt(input.attemptId);
      if (actor.role !== 'worker' || !attempt || attempt.taskId !== task.id || attempt.workerId !== actorId || task.latestAttemptId !== attempt.id) throw new Error('Report does not belong to the current Worker attempt');
      const summary = requiredText(input.text, 'report');
      if (attempt.status === 'reported' && attempt.summary === summary) return;
      if (terminal(task) || attempt.status !== 'running') throw new Error('Attempt is not running');
      const evidence = input.evidence ?? [];
      if (!Array.isArray(evidence) || evidence.length > 20 || evidence.some(item => typeof item !== 'string' || item.length > 2000)) throw new Error('evidence must be an array of at most 20 strings, each at most 2000 characters; omit evidence if no references are available. Do not JSON-encode the array.');
      this.store.saveAttempt({...attempt, status: 'reported', summary, evidence, endedAt: now()});
      this.saveTask({...task, status: 'review', result: summary}); this.store.saveAgent({...actor, lastResult: summary});
      this.delivery(task.runId, task.coordinatorId, 'review', summary, task.id, attempt.id);
      this.store.activity(task.runId, 'report', summary, actorId, task.id);
    });
  }
  accept(actorId: string, input: {taskId: string; text: string}): void {
    this.command(() => {
      const actor = this.actor(actorId), task = this.taskIn(actor.runId, input.taskId);
      if (actor.role === 'worker' || actorId !== task.coordinatorId) throw new Error('Only the task coordinator can accept the result');
      if (task.status === 'completed') return;
      if (task.status !== 'review') throw new Error('Task has no reported result to accept');
      const summary = requiredText(input.text, 'acceptance');
      this.saveTask({...task, status: 'completed', result: summary});
      this.store.saveAgent({...actor, lastResult: summary});
      this.delivery(task.runId, this.store.run(task.runId)!.orchestratorId, 'result', summary, task.id, task.latestAttemptId);
      this.store.activity(task.runId, 'accepted', summary, actorId, task.id);
    });
  }
  retryTask(runId: string, taskId: string): TaskView {
    return this.command(() => {
      const task = this.taskIn(runId, taskId);
      if (!['failed','blocked'].includes(task.status)) throw new Error('Only failed or blocked tasks can retry');
      this.cancelDeliveries(task.id);
      const old = task.latestAttemptId ? this.store.attempt(task.latestAttemptId) : undefined;
      if (old?.status === 'reported') {
        this.saveTask({...task, status: 'review', error: undefined});
        this.delivery(runId, task.coordinatorId, 'review', old.summary ?? task.result ?? '', task.id, old.id, true);
      } else if (old) {
        if (['queued','running'].includes(old.status)) this.store.saveAttempt({...old, status: 'failed', endedAt: now()});
        const assigned = this.store.deliveries().find(d => d.kind === 'task' && d.attemptId === old.id);
        if (!assigned) throw new Error('Attempt has no persisted execution instruction');
        this.startAttempt(task, old.workerId, assigned.text, true);
      } else {
        this.saveTask({...task, status: 'queued', error: undefined});
        this.delivery(runId, task.coordinatorId, 'task', task.prompt, task.id, undefined, true);
      }
      this.store.activity(runId, 'task-retried', old?.status === 'reported' ? '重试结果验收，保留已完成执行' : '已创建新的执行尝试，保留历史结果', task.coordinatorId, task.id);
      return this.store.task(taskId)!;
    });
  }
  private cancelDeliveries(taskId: string): void { for (const d of this.store.deliveries()) if (d.taskId === taskId && ['pending','running'].includes(d.state)) this.store.saveDelivery({...d, state: 'cancelled'}); }
  cancelTask(runId: string, taskId: string): void {
    this.command(() => {
      const task = this.taskIn(runId, taskId); if (terminal(task)) return;
      this.cancelDeliveries(taskId);
      for (const a of this.store.attempts(taskId)) if (['queued','running'].includes(a.status)) this.store.saveAttempt({...a, status: 'cancelled', endedAt: now()});
      this.saveTask({...task, status: 'cancelled'}); this.store.activity(runId, 'task-cancelled', '仅取消本任务', undefined, taskId);
    });
  }
  cancelRun(runId: string): void {
    this.command(() => {
      if (!this.store.run(runId)) throw new Error('Unknown run');
      for (const task of this.store.tasks(runId)) this.cancelTask(runId, task.id);
      for (const d of this.store.deliveries(runId)) if (['pending','running'].includes(d.state)) this.store.saveDelivery({...d, state: 'cancelled'});
      this.store.setRunStatus(runId, 'stopped');
    });
  }
  beginDelivery(id: string): DeliveryView | undefined {
    return this.command(() => {
      const d = this.store.delivery(id); if (!d || d.state !== 'pending') return;
      this.store.saveDelivery({...d, state: 'running'});
      if (d.attemptId && d.kind === 'task') {
        const a = this.store.attempt(d.attemptId)!;
        if (a.status !== 'queued') throw new Error('Attempt is not queued');
        this.store.saveAttempt({...a, status: 'running', startedAt: now()});
        this.saveTask({...this.store.task(a.taskId)!, status: 'running'});
      }
      return this.store.delivery(id);
    });
  }
  finishDelivery(id: string): void {
    this.command(() => {
      const d = this.store.delivery(id); if (!d || d.state !== 'running') return;
      this.store.saveDelivery({...d, state: 'done'});
      const task = d.taskId ? this.store.task(d.taskId) : undefined;
      if (!task || terminal(task)) return;
      const hasNext = this.store.deliveries().some(x => x.id !== id && x.taskId === task.id && ['pending','running'].includes(x.state));
      if (!hasNext && ['task','review'].includes(d.kind) && ['queued','running','review'].includes(task.status)) {
        const error = d.kind === 'review' ? '协调者回合结束但未验收结果' : '回合结束但未完成委派或报告';
        if (d.attemptId && d.kind === 'task') { const a = this.store.attempt(d.attemptId)!; if (a.status === 'running') this.store.saveAttempt({...a, status: 'failed', endedAt: now(), error}); }
        this.saveTask({...task, status: 'blocked', error});
      }
    });
  }
  failDelivery(id: string, error: string, maxAttempts: number, retryDelayMs: number): void {
    this.command(() => {
      const d = this.store.delivery(id); if (!d || d.state !== 'running') return;
      const task = d.taskId ? this.store.task(d.taskId) : undefined;
      if (task && (task.status === 'cancelled' || this.committedReceipt(d, task))) {
        this.store.saveDelivery({...d, state: 'done', error});
        this.store.activity(d.runId, 'delivery-reconciled', `业务结果已提交，保留原生投递异常：${error}`, d.agentId, d.taskId);
        return;
      }
      const failures = d.failures + 1;
      this.store.saveDelivery({...d, failures, error, state: failures < maxAttempts ? 'pending' : 'failed', nextAt: Date.now() + retryDelayMs * 2 ** Math.min(failures - 1, 8), recovery: true});
      if (d.attemptId && d.kind === 'task') {
        const a = this.store.attempt(d.attemptId)!;
        this.store.saveAttempt({...a, status: failures < maxAttempts ? 'queued' : 'failed', ...(failures >= maxAttempts ? {endedAt: now()} : {}), error});
      }
      if (task && !terminal(task)) this.saveTask({...task, status: failures < maxAttempts ? (d.kind === 'review' ? 'review' : 'queued') : 'failed', error});
      this.store.activity(d.runId, 'delivery-error', error, d.agentId, d.taskId);
    });
  }
  private committedReceipt(delivery: DeliveryView, task: TaskView): boolean {
    if (delivery.kind === 'review') return task.status === 'completed';
    if (delivery.kind !== 'task') return false;
    if (task.status === 'completed') return true;
    if (delivery.attemptId) return this.store.attempt(delivery.attemptId)?.status === 'reported' || task.latestAttemptId !== delivery.attemptId;
    return task.coordinatorId !== delivery.agentId || !!task.latestAttemptId;
  }
  /** Running deliveries belonged to a dead process; queued work remains ordered and cancelled work stays cancelled. */
  recover(): void {
    this.command(() => {
      for (const d of this.store.deliveries()) {
        if (d.state !== 'running') continue;
        const task = d.taskId ? this.store.task(d.taskId) : undefined;
        if (task?.status === 'cancelled') { this.store.saveDelivery({...d, state: 'cancelled'}); continue; }
        if (task && this.committedReceipt(d, task)) { this.store.saveDelivery({...d, state: 'done'}); continue; }
        const a = d.attemptId ? this.store.attempt(d.attemptId) : undefined;
        if (d.kind === 'task' && a?.status === 'running' && task && !terminal(task)) {
          this.store.saveAttempt({...a, status: 'interrupted', endedAt: now(), error: '运行进程中断'});
          this.store.saveDelivery({...d, state: 'done'});
          this.startAttempt(task, a.workerId, d.text, true);
          this.store.activity(d.runId, 'attempt-recovered', '保留中断尝试并创建恢复尝试', d.agentId, task.id);
        } else this.store.saveDelivery({...d, state: 'pending', nextAt: 0, recovery: true});
      }
    });
  }
}
