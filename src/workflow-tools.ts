import { createHash } from 'node:crypto';
import { z } from 'zod';
import { graphSchema, WorkflowError, type WorkflowInstance, type WorkflowService } from './workflow-plans.js';

export const workflowToolName = 'studio_workflow';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const version = z.number().int().positive();
const command = z.discriminatedUnion('operation', [
  z.object({operation: z.literal('list_templates')}).strict(),
  z.object({operation: z.literal('view_template'), templateId: id, version: version.optional()}).strict(),
  z.object({operation: z.literal('list_instances')}).strict(),
  z.object({operation: z.literal('view_instance'), instanceId: id}).strict(),
  z.object({operation: z.literal('start'), templateId: id, version}).strict(),
  z.object({operation: z.literal('propose_draft'), templateId: id, version, expectedRevision: version, graph: graphSchema}).strict(),
]);

// Both the tool and the canvas editor validate proposals with graphSchema.
export const workflowToolFields = {
  operation: {type: 'string', enum: command.options.map(option => option.shape.operation.value)},
  templateId: {type: 'string'},
  instanceId: {type: 'string'},
  version: {type: 'integer', minimum: 1, description: 'Exact published version inspected for this request.'},
  expectedRevision: {type: 'integer', minimum: 1, description: 'Current template revision from view_template.'},
  graph: z.toJSONSchema(graphSchema),
};

function progress(service: WorkflowService, instance: WorkflowInstance) {
  const graph = service.graph(instance.templateId, instance.version);
  const names = new Map(graph.nodes.map(node => [node.id, node.name]));
  return {
    id: instance.id,
    name: graph.name,
    templateId: instance.templateId,
    version: instance.version,
    stopped: instance.stopped,
    nodes: instance.nodes.map(node => {
      const pass = node.passes.at(-1);
      return {id: node.id, name: names.get(node.id), round: node.passes.length, stage: pass?.stage, taskId: pass?.taskId};
    }),
  };
}

/** The host supplies both identifiers from the live Orchestrator delivery. */
export function workflowCommand(service: WorkflowService, runId: string, deliveryId: string, input: unknown) {
  const parsed = command.safeParse(input);
  if (!parsed.success) throw new WorkflowError(400, '流程工具参数无效');
  const request = parsed.data;
  if (request.operation === 'list_instances') {
    return {instances: service.instances(runId).map(instance => progress(service, instance))};
  }
  if (request.operation === 'view_instance') {
    const instance = service.instances(runId).find(item => item.id === request.instanceId);
    if (!instance) throw new WorkflowError(404, '本协作找不到该流程实例');
    return progress(service, instance);
  }

  const shared = service.templates().filter(template => template.published > 0 && !template.retired);
  if (request.operation === 'list_templates') {
    return {templates: shared.map(template => ({
      id: template.id, name: service.graph(template.id, template.published).name, version: template.published,
    }))};
  }
  const template = shared.find(item => item.id === request.templateId);
  if (!template) throw new WorkflowError(404, '找不到可用的已发布模板');
  const selectedVersion = request.version ?? template.published;
  const graph = service.graph(template.id, selectedVersion);
  if (request.operation === 'view_template') {
    return {templateId: template.id, version: selectedVersion, latestVersion: template.published,
      revision: template.revision, graph};
  }
  if (request.operation === 'start') {
    const requestId = 'chat-' + createHash('sha256').update(JSON.stringify([deliveryId, template.id, selectedVersion])).digest('hex');
    const instance = service.start(template.id, {runId, version: selectedVersion, requestId});
    return progress(service, instance);
  }
  if (selectedVersion !== template.published || request.expectedRevision !== template.revision) {
    throw new WorkflowError(409, '模板版本已变化，请重新查看已发布的画布');
  }
  if (JSON.stringify(template.draft) !== JSON.stringify(graph)) {
    throw new WorkflowError(409, '此模板已有未发布的草稿，请先在工作流页审阅');
  }
  const priorNodes = new Map(graph.nodes.map(node => [node.id, node]));
  const nodes = request.graph.nodes.map(node => {
    const prior = priorNodes.get(node.id);
    // Omitted checks keep their published value. An explicit empty rule clears a check.
    return {inputRule: prior?.inputRule, outputRule: prior?.outputRule, ...node};
  });
  const result = service.save(template.id, {expectedRevision: template.revision, graph: {...request.graph,nodes}});
  return {templateId: template.id, draftRevision: result.revision, publishedVersion: template.published,
    status: '待人工审阅', url: '/workflows.html?template=' + encodeURIComponent(template.id)};
}
