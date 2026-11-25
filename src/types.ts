/** Public application and Web types; model sessions and business tasks have distinct state. */
import type { MemoryListInput, MemoryService } from './memory.js';
import type { DockerExecution, ExecutionConfigInput } from './execution.js';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
export type Role = 'orchestrator' | 'manager' | 'worker';
export type ExecutionMode = 'auto' | 'direct' | 'hierarchical';
export interface ModelSelection { provider: string; model: string; reasoningEffort?: string }
export interface ModelOption { provider: string; model: string; name: string; efforts: {id: string; name: string}[]; demo: boolean }
export interface AgentTemplate { publicNetwork?: boolean; skillIds?: string[]; delegateIds?: string[]; id: string; name: string; role: Role; systemPrompt: string; selection: ModelSelection; version: number; memoryIdentityId: string }
export interface AgentView { skills?: import('./skills.js').SkillReference[]; delegateIds?: string[]; id: string; runId: string; parentId: string | null; createdBy: string | null; templateId: string; name: string; role: Role; selection: ModelSelection; systemPrompt: string; status: string; sessionId: string; memoryIdentityId?: string; memorySourceAgentId?: string; createdAt: string; lastResult?: string; error?: string }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: string }
export type TaskStatus = 'paused' | 'queued' | 'running' | 'review' | 'completed' | 'blocked' | 'failed' | 'cancelled';
export interface TaskView { parentTaskId?: string; childTaskIds?: string[]; assignedTemplateId?: string; assignedTemplateVersion?: number; pausedFrom?: 'queued'|'running'|'review'; pauseOwners?: string[]; pauseRequested?: boolean; id: string; runId: string; title: string; prompt: string; requestId: string; coordinatorId: string; targetManagerId?: string; status: TaskStatus; latestAttemptId?: string; result?: string; error?: string; createdAt: string; updatedAt: string }
export type AttemptStatus = 'queued' | 'running' | 'reported' | 'interrupted' | 'failed' | 'cancelled';
export interface AttemptView { id: string; taskId: string; workerId: string; number: number; status: AttemptStatus; createdAt: string; startedAt?: string; endedAt?: string; summary?: string; evidence?: string[]; error?: string }
export interface DeliveryView { requestId?: string; id: string; runId: string; agentId: string; taskId?: string; kind: 'task' | 'review' | 'result' | 'message'; attemptId?: string; text: string; state: 'pending' | 'running' | 'done' | 'failed' | 'cancelled'; failures: number; nextAt: number; createdAt: string; error?: string; recovery?: boolean }
export interface RunView { id: string; title: string; mode: ExecutionMode; orchestratorId: string; memorySourceRunId?: string; status: string; createdAt: string; agents: AgentView[]; messages: ChatMessage[]; tasks: TaskView[]; attempts: AttemptView[]; deliveries: DeliveryView[] }
export interface Activity { id: string; runId: string; agentId?: string; taskId?: string; kind: string; text: string; createdAt: string }
export interface SchedulerConfig { maxActiveWorkers: number; pollIntervalMs: number; maxDeliveryAttempts: number; retryDelayMs: number }
export interface StudioSnapshot { phase: 3; backend: 'dsh'; demo: boolean; templates: AgentTemplate[]; models: ModelOption[]; runs: RunView[]; activity: Activity[]; capabilities: {modelSource: 'demo'|'dsh'; execution: 'docker'|'probe-only'; memory: 'sqlite-three-layer'; containers: 'enabled'|'disabled'; trustedTools: 'planned'; tasks: 'durable'; scheduling: 'non-preemptive'}; scheduler: SchedulerConfig; compatibility: {dshVersion: string; source?: string} }
export interface StudioOptions { dataDir: string; videoInputRoot?: string; dshHome?: string; onChange?: () => void; scheduler?: Partial<SchedulerConfig>; demoDelayMs?: number; execution?: ExecutionConfigInput; compaction?: BasicCompactionConfig }
export interface NewTaskInput { prompt: string; requestId: string; targetManagerId?: string }
export interface Studio {
  readonly network: Pick<import('./network-grants.js').NetworkGrants, 'settings'|'recent'>;
  readonly skills: import('./skills.js').SkillLibrary;
  workflows?: import('./workflow-plans.js').WorkflowService;
  /** Local host capability, never registered with model tools. */
  video?: import('./video-pipeline.js').VideoPipeline;
  snapshot(): Promise<StudioSnapshot>;
  refreshModels(): Promise<ModelOption[]>;
  probeModel(selection: ModelSelection, signal?: AbortSignal): Promise<{status: 'demo'|'verified'|'unavailable'; message: string}>;
  saveTemplate(input: Omit<AgentTemplate, 'version' | 'memoryIdentityId' | 'delegateIds'> & {version?: number; delegateIds?: string[]|null}): Promise<AgentTemplate>;
  createRun(input: {prompt: string; mode: ExecutionMode; orchestratorTemplateId?: string; reuseMemoryFromRunId?: string}): Promise<RunView>;
  listMemory(runId: string, input: MemoryListInput): Promise<ReturnType<MemoryService['list']>>;
  readMemory(runId: string, input: {id: string; offset?: number; limit?: number}): Promise<ReturnType<MemoryService['read']>>;
  listArtifacts(runId: string, attemptId: string, input: {path?: string}): ReturnType<DockerExecution['listFiles']>;
  readArtifact(runId: string, attemptId: string, input: {path: string; offset?: number; limit?: number}): ReturnType<DockerExecution['readFile']>;
  addTask(runId: string, input: NewTaskInput): Promise<TaskView>;
  retryTask(runId: string, taskId: string): Promise<TaskView>;
  cancelTask(runId: string, taskId: string): Promise<void>;
  pauseTask(runId: string, taskId: string): Promise<TaskView>;
  resumeTask(runId: string, taskId: string): Promise<TaskView>;
  taskOutput(runId: string, taskId: string): {title:string; content:string};
  taskHistory(runId: string, taskId: string, offset?: number): Promise<{events: import('./task-history.js').TaskEvent[]; nextOffset?: number}>;
  sendMessage(runId: string, text: string, requestId?: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  close(): Promise<void>;
}
