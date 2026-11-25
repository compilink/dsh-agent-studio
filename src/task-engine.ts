/** Transactional task ownership and durable inbox commands, independent of model execution. */
import { randomUUID } from 'node:crypto';
import { StudioStore } from './store.js';
import type { StoredAgent } from './store.js';
import type { AgentTemplate, AttemptView, DeliveryView, NewTaskInput, TaskView } from './types.js';

const terminal = (task: TaskView) => ['completed', 'cancelled'].includes(task.status);
const now = () => new Date().toISOString();
export function fullText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' must be non-empty text');
  return value;
}

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
  private saveTask(task: TaskView): void {
    const next = {...task, updatedAt: now()};
    const status = next.status === 'paused' ? next.pausedFrom : next.status;
    if (status === 'queued' || status === 'running' || status === 'review') {
      if (next.pauseOwners?.length) {
        const busy = this.store.deliveries(next.runId).some(d => d.taskId === next.id && d.state === 'running');
        next.status = busy ? status : 'paused';
        next.pausedFrom = status;
        next.pauseRequested = busy || undefined;
      } else {
        next.status = status;
        next.pauseRequested = next.pausedFrom = undefined;
      }
    } else {
      next.pauseRequested = next.pausedFrom = next.pauseOwners = undefined;
    }
    this.store.saveTask(next);
    this.refresh(task.runId);
    if (!next.parentTaskId || !['cancelled','failed','blocked','queued','running'].includes(next.status)) return;
    const parent = this.store.task(next.parentTaskId);
    if (parent) this.reconcileChildren(parent);
  }
  private reconcileChildren(parent: TaskView): void {
    if (!parent.childTaskIds?.length || terminal(parent) || parent.status === 'failed' || parent.pauseOwners?.length) return;
    const problem = parent.childTaskIds.map(id => this.store.task(id)!).find(t => ['failed','blocked','cancelled'].includes(t.status));
    if (problem && parent.status !== 'blocked') {
      this.saveTask({...parent, status:'blocked', error:'Child task requires attention: '+problem.id});
    } else if (!problem && parent.status === 'blocked' && parent.error?.startsWith('Child task requires attention: ')) {
      this.saveTask({...parent, status:'running', error:undefined});
    }
  }
  createTask(runId: string, input: NewTaskInput): TaskView {
    return this.command(() => {
      const run = this.store.run(runId); if (!run) throw new Error('Unknown run');
      const prompt = fullText(input.prompt, 'prompt'), requestId = requiredText(input.requestId, 'requestId', 100);
      const existing = this.store.tasks(runId).find(t => t.requestId === requestId);
      if (existing) {
        if (existing.prompt !== prompt || existing.targetManagerId !== input.targetManagerId) throw new Error('requestId conflict: this submission already has different content');
        return existing;
      }
      if (run.status === 'stopped') throw new Error('Run is stopped');
      if (input.targetManagerId) {
        const target = this.actor(input.targetManagerId);
        if (target.runId !== runId || target.role !== 'manager' || target.parentId !== run.orchestratorId) throw new Error('Target must be a Manager in this Run');
        const owner = this.actor(run.orchestratorId);
        if (owner.delegateIds && !owner.delegateIds.includes(target.templateId)) throw new Error('Target manager is outside the delegated scope');
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
  /** Returns the permitted intermediary for a hierarchical Worker assignment, when necessary. */
  validateAssignment(runId: string, template: AgentTemplate): {root: StoredAgent; manager?: AgentTemplate} {
    const run = this.store.run(runId);
    if (!run || run.status === 'stopped') throw new Error('Unknown or stopped Run');
    const root = this.actor(run.orchestratorId);
    if (template.role === 'orchestrator') {
      if (template.id !== root.templateId || template.version !== root.templateVersion) throw new Error('Node requires the Orchestrator configuration used by this Run');
      return {root};
    }
    const targets = this.delegateTemplates(root);
    if (template.role === 'worker' && run.mode === 'hierarchical') {
      const manager = targets.map(t => this.store.template(t.id)!).find(t => t.role === 'manager' && (!t.delegateIds || t.delegateIds.includes(template.id)));
      if (!manager) throw new Error('No authorized Manager can assign this Worker');
      return {root,manager};
    }
    if (!targets.some(t => t.id === template.id && t.role === template.role)) throw new Error('Node template is outside the permitted delegation scope for this Run');
    return {root};
  }
  /** Bind an admission to a server-owned template snapshot through the Run's existing role policy. */
  createAssignedTask(runId: string, input: Pick<NewTaskInput,'prompt'|'requestId'>, template: AgentTemplate): TaskView {
    return this.command(() => {
      const existing = this.store.tasks(runId).find(task => task.requestId === input.requestId);
      if (existing) {
        if (existing.prompt !== input.prompt || existing.assignedTemplateId !== template.id || existing.assignedTemplateVersion !== template.version) throw new Error('requestId conflict: target or instructions changed');
        return existing;
      }
      const {root,manager} = this.validateAssignment(runId,template);
      const task = this.createTask(runId,input);
      if (template.role !== 'orchestrator') {
        let parent = root;
        if (manager) {
          const delegated = this.delegate(root.id,{taskId:task.id,prompt:task.prompt,role:'manager',templateId:manager.id},{freshManager:true});
          parent = this.actor(delegated.agentId);
        }
        this.delegate(parent.id,{taskId:task.id,prompt:task.prompt,role:template.role,templateId:template.id},{freshManager:true,pinned:template});
        // Direct dispatch already committed these coordination handoffs. Only the recipient needs a model turn.
        const assigned = this.taskIn(runId,task.id);
        for (const d of this.store.deliveries(runId)) {
          if (d.taskId === task.id && d.state === 'pending' && !d.attemptId && (assigned.latestAttemptId || d.agentId !== assigned.coordinatorId)) {
            this.store.saveDelivery({...d,state:'done'});
          }
        }
      }
      this.saveTask({...this.taskIn(runId,task.id),assignedTemplateId:template.id,assignedTemplateVersion:template.version});
      return this.taskIn(runId,task.id);
    });
  }
  message(runId: string, value: string, requestId?: string): void {
    this.command(() => { const run = this.store.run(runId); if (!run) throw new Error('Unknown run'); const text = fullText(value, 'message');
      if (requestId !== undefined) {
        requiredText(requestId, 'requestId', 100);
        const existing = run.deliveries.find(d => d.kind === 'message' && d.requestId === requestId);
        if (existing && existing.text !== text) throw new Error('requestId conflict: this submission already has different content');
        if (existing) return;
      }
      if (run.status === 'stopped') throw new Error('Run is stopped');
      const delivery = this.delivery(runId, run.orchestratorId, 'message', text); if (requestId) this.store.saveDelivery({...delivery, requestId});
      this.store.message(runId, 'user', text, delivery.id); });
  }
  /** Only children of the explicitly selected historical parent are eligible for private long-term identity reuse. */
  memorySources(actorId: string): {agentId: string; name: string; role: 'manager'|'worker'; templateId: string}[] {
    const actor = this.actor(actorId), run = this.store.run(actor.runId)!;
    if (actor.role === 'worker' || !actor.memorySourceAgentId || !run.memorySourceRunId) return [];
    const used = new Set(this.store.agents(run.id).map(a => a.memoryIdentityId));
    return this.store.agents(run.memorySourceRunId).filter(a => a.parentId === actor.memorySourceAgentId && a.role !== 'orchestrator' && (!actor.delegateIds || actor.delegateIds.includes(a.templateId)) && !used.has(a.memoryIdentityId))
      .map(a => ({agentId: a.id, name: a.name, role: a.role as 'manager'|'worker', templateId: a.templateId}));
  }
  delegate(actorId: string, input: {taskId: string; role: 'manager' | 'worker'; prompt: string; templateId?: string; agentId?: string; memorySourceAgentId?: string}, options: {freshManager?: boolean; pinned?: AgentTemplate} = {}): {agentId: string; role: 'manager' | 'worker'; reused: boolean; attemptId?: string} {
    return this.command(() => {
      const actor = this.actor(actorId), task = this.taskIn(actor.runId, input.taskId), run = this.store.run(actor.runId)!;
      const prompt = fullText(input.prompt, 'prompt');
      if (!['manager','worker'].includes(input.role) || actor.role === 'worker' || (actor.role === 'manager' && input.role !== 'worker')) throw new Error('Role cannot delegate to this child');
      if (actor.role === 'orchestrator' && ((run.mode === 'direct' && input.role !== 'worker') || (run.mode === 'hierarchical' && input.role !== 'manager'))) throw new Error('Delegation conflicts with execution mode');
      if (task.childTaskIds?.length || terminal(task) || ['paused','blocked','failed'].includes(task.status)) throw new Error('Task is not available for delegation');
      if (task.coordinatorId !== actorId) {
        const manager = this.store.agent(task.coordinatorId);
        if (actor.role === 'orchestrator' && input.role === 'manager' && manager?.parentId === actorId) return {agentId: manager.id, role: 'manager', reused: true};
        throw new Error('Only the task coordinator can delegate it');
      }
      if (input.templateId && actor.delegateIds && !actor.delegateIds.includes(input.templateId)) throw new Error('Template is outside the delegated scope');
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
        if ((input.templateId && input.templateId !== child.templateId) || (actor.delegateIds && !actor.delegateIds.includes(child.templateId))) throw new Error('Selected child is outside the delegated scope');
        if (input.role === 'worker' && this.store.attempts().some(a => a.workerId === child!.id && ['queued','running'].includes(a.status))) throw new Error('Worker is already assigned to another task');
      }
      if (!child && !options.freshManager && !input.memorySourceAgentId && input.role === 'manager') child = this.store.agents(task.runId).find(a => a.parentId === actorId && a.role === 'manager' && (!actor.delegateIds || actor.delegateIds.includes(a.templateId)) && (!input.templateId || a.templateId === input.templateId));
      const reused = !!child;
      if (!child) {
        const source = input.memorySourceAgentId ? this.store.agent(input.memorySourceAgentId) : undefined;
        if (input.memorySourceAgentId && (!source || !this.memorySources(actorId).some(a => a.agentId === source.id) || source.role !== input.role)) throw new Error('Memory source is not an authorized historical child');
        const templateId = input.templateId ?? source?.templateId;
        const template = options.pinned ?? (templateId ? this.store.template(templateId) : this.store.templates().find(t => t.role === input.role && (!actor.delegateIds || actor.delegateIds.includes(t.id))));
        if (!template || template.role !== input.role) throw new Error('Template role does not match child role');
        if (actor.delegateIds && !actor.delegateIds.includes(template.id)) throw new Error('Template is outside the delegated scope');
        if (source && source.templateId !== template.id) throw new Error('Memory source must match the child template');
        if (this.store.agents(task.runId).length >= 24) throw new Error('Run limit: 24 agents');
        const id = randomUUID();
        child = {id, sessionId: randomUUID(), runId: task.runId, parentId: actorId, createdBy: actorId, templateId: template.id, templateVersion: template.version, skills: this.store.skills.references(template.skillIds),
          memoryIdentityId: source?.memoryIdentityId ?? randomUUID(), ...(source ? {memorySourceAgentId: source.id} : {}), name: `${template.name} ${this.store.agents(task.runId).filter(a => a.role === input.role).length + 1}`,
          role: input.role, delegateIds: template.delegateIds?.slice(), selection: structuredClone(template.selection), systemPrompt: template.systemPrompt, status: 'dormant', createdAt: now()};
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
  delegateTemplates(actor: StoredAgent) {
    const mode = this.store.run(actor.runId)!.mode;
    return this.store.templates().filter(t =>
      actor.role !== 'worker' && (t.role === 'worker' ? actor.role === 'manager' || mode !== 'hierarchical' : t.role === 'manager' && actor.role === 'orchestrator' && mode !== 'direct') &&
      (!actor.delegateIds || actor.delegateIds.includes(t.id))
    ).map(({id, role, name}) => ({id, role, name}));
  }
  split(actorId: string, taskId: string, branches: {templateId: string; prompt: string}[]): string[] {
    return this.command(() => {
      const actor = this.actor(actorId), parent = this.taskIn(actor.runId, taskId);
      if (actor.role === 'worker' || parent.coordinatorId !== actorId || !['running','queued'].includes(parent.status) || parent.latestAttemptId) throw new Error('Only the current coordinator may split an active task');
      if (!Array.isArray(branches) || !branches.length || branches.length > 16) throw new Error('Provide 1 to 16 branches');
      if (parent.childTaskIds?.length) {
        const ids = parent.childTaskIds;
        if (ids.length !== branches.length || ids.some((id,i) => {
          const child = this.taskIn(actor.runId, id);
          return child.assignedTemplateId !== branches[i]?.templateId || child.prompt !== branches[i]?.prompt;
        })) throw new Error('Task already has different branches');
        return ids;
      }
      const targets = this.delegateTemplates(actor);
      const targetManager = parent.targetManagerId && actor.role === 'orchestrator' ? this.actor(parent.targetManagerId) : undefined;
      const ids = branches.map(branch => {
        const target = targets.find(t => t.id === branch.templateId);
        if (!target || target.role === 'orchestrator' || (targetManager && target.id !== targetManager.templateId)) throw new Error('Branch template outside the delegated scope');
        const prompt = fullText(branch.prompt, 'branch prompt');
        const id = randomUUID();
        this.store.saveTask({id, parentTaskId: taskId, assignedTemplateId: target.id, coordinatorId: actorId, runId: parent.runId, requestId: id, title: prompt.slice(0, 80), prompt, status: 'queued', createdAt: now(), updatedAt: now(), pauseOwners: parent.pauseOwners});
        this.delegate(actorId, {taskId: id, role: target.role, templateId: target.id, prompt, agentId: targetManager?.id}, {freshManager:true});
        return id;
      });
      this.saveTask({...parent, childTaskIds: ids, status: 'running'});
      return ids;
    });
  }
  descendants(runId: string, taskId: string): TaskView[] {
    const root = this.taskIn(runId, taskId);
    const tasks = this.store.tasks(runId), byId = new Map(tasks.map(t => [t.id,t]));
    const selected = new Set([root.id]);
    for (const id of selected) for (const child of byId.get(id)?.childTaskIds ?? []) selected.add(child);
    return tasks.filter(task => selected.has(task.id));
  }
  pauseTask(runId: string, taskId: string): TaskView {
    return this.command(() => {
      const root = this.taskIn(runId, taskId);
      if (!['queued','running','review','paused'].includes(root.status)) throw new Error('Only active tasks can be paused');
      for (const task of this.descendants(runId, taskId)) {
        if (!['queued','running','review','paused'].includes(task.status)) continue;
        this.saveTask({...task, pauseOwners: [...new Set([...(task.pauseOwners ?? []), taskId])]});
      }
      return this.taskIn(runId, taskId);
    });
  }
  resumeTask(runId: string, taskId: string): TaskView {
    return this.command(() => {
      const root = this.taskIn(runId, taskId);
      if (this.store.run(runId)?.status === 'stopped') throw new Error('Run is stopped');
      // Reconcile descendants before their parents. A paused parent may have missed a child's terminal transition.
      for (const member of this.descendants(runId, root.id).reverse()) {
        const task = this.taskIn(runId, member.id);
        if (task.pauseOwners?.includes(root.id)) {
          const owners = task.pauseOwners.filter(id => id !== root.id);
          this.saveTask({...task, pauseOwners: owners.length ? owners : undefined});
        }
        this.reconcileChildren(this.taskIn(runId,task.id));
      }
      return this.taskIn(runId, taskId);
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
      const summary = fullText(input.text, 'report');
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
      const summary = fullText(input.text, 'acceptance');
      this.saveTask({...task, status: 'completed', result: summary});
      this.store.saveAgent({...actor, lastResult: summary});
      if (task.parentTaskId) {
        const parent = this.taskIn(task.runId, task.parentTaskId);
        if (!terminal(parent) && parent.childTaskIds?.every(id => this.store.task(id)?.status === 'completed')) {
          this.saveTask({...parent, status: 'review', error: undefined});
          this.delivery(parent.runId, parent.coordinatorId, 'review', 'All child tasks have been accepted. Review their results and submit the combined result.', parent.id);
        }
      } else this.delivery(task.runId, this.store.run(task.runId)!.orchestratorId, 'result', summary, task.id, task.latestAttemptId);
      this.store.activity(task.runId, 'accepted', summary, actorId, task.id);
    });
  }
  /** Return the current report or one directly assigned branch for another revision. */
  revise(actorId: string, taskId: string, feedback: string, childId?: string): void {
    this.command(() => {
      const actor = this.actor(actorId), parent = this.taskIn(actor.runId,taskId);
      if (actor.role === 'worker' || parent.coordinatorId !== actorId || parent.status !== 'review') throw new Error('Revision requires the current coordinator review');
      const note = fullText(feedback,'revision feedback');
      if (childId && !parent.childTaskIds?.includes(childId)) throw new Error('Only a direct child can be revised');
      const target = childId ? this.taskIn(actor.runId,childId) : parent;
      if (childId && target.status !== 'completed') throw new Error('Child result is not ready for revision');
      const prior = target.latestAttemptId ? this.store.attempt(target.latestAttemptId) : undefined;
      if (!prior && (!childId || !target.childTaskIds?.length)) throw new Error('Choose a completed child to revise');
      if (prior && prior.status !== 'reported') throw new Error('The Worker has not reported this attempt');
      const review = this.store.deliveries(actor.runId).find(d => d.kind === 'review' && d.taskId === taskId && d.agentId === actorId && d.state === 'running');
      if (!review) throw new Error('A live review delivery is required');
      this.store.saveDelivery({...review,state:'done'});
      if (childId) this.saveTask({...parent,status:'running'});
      if (prior) {
        const first = this.store.attempts(target.id)[0]!;
        const assignment = this.store.deliveries(actor.runId).find(d => d.kind === 'task' && d.attemptId === first.id);
        const instruction = (assignment?.text ?? target.prompt) + '\n\nPrevious report:\n' + prior.summary + '\n\nRevision requested:\n' + note;
        this.startAttempt(target,prior.workerId,instruction);
      } else {
        this.saveTask({...target,status:'review',result:undefined,error:undefined});
        this.delivery(actor.runId,target.coordinatorId,'review','Revision requested:\n' + note,target.id);
      }
      this.store.activity(actor.runId,'revision-requested',note,actorId,target.id);
    });
  }
  retryTask(runId: string, taskId: string): TaskView {
    return this.command(() => {
      if (this.store.run(runId)?.status === 'stopped') throw new Error('Run is stopped');
      const task = this.taskIn(runId, taskId);
      for (let id = task.parentTaskId; id;) {
        const parent = this.taskIn(runId, id);
        if (parent.pauseOwners?.length || terminal(parent)) throw new Error('The parent task is paused or finished');
        id = parent.parentTaskId;
      }
      if (!['failed','blocked'].includes(task.status)) throw new Error('Only failed or blocked tasks can retry');
      this.cancelDeliveries(task.id);
      const old = task.latestAttemptId ? this.store.attempt(task.latestAttemptId) : undefined;
      if (task.childTaskIds?.length) {
        if (!task.childTaskIds.every(id => this.taskIn(runId,id).status === 'completed')) throw new Error('Retry the unfinished child task first');
        this.saveTask({...task, status: 'review', error: undefined});
        this.delivery(runId, task.coordinatorId, 'review', 'Review the completed child tasks.', task.id, undefined, true);
      } else if (old?.status === 'reported') {
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
      for (const childId of task.childTaskIds ?? []) this.cancelTask(runId, childId);
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
      const d = this.store.delivery(id); if (!d || d.state !== 'pending' || (d.taskId && this.store.task(d.taskId)?.pauseOwners?.length)) return;
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
      if (task.pauseOwners?.length) this.saveTask(task);
      if (task.childTaskIds?.length && d.kind === 'task') return;
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
        if (task.pauseOwners?.length) this.saveTask(task);
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
    return task.coordinatorId !== delivery.agentId || !!task.latestAttemptId || !!task.childTaskIds?.length;
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
      for (const run of this.store.runs()) {
        if (run.status === 'stopped') continue;
        for (const row of run.tasks.reverse()) {
          const task = this.taskIn(run.id,row.id);
          if (task.pauseOwners?.length) this.saveTask(task);
          this.reconcileChildren(this.taskIn(run.id,task.id));
        }
      }
    });
  }
}
