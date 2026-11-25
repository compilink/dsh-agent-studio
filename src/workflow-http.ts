import { WorkflowError, type WorkflowService } from './workflow-plans.js';

export function workflowRoute(service: WorkflowService, method: string, path: string, data: unknown) {
  const parts = path.replace(/^\/api\/workflows\/?/, '').split('/');
  const [group, id, action, nodeId] = parts;
  if (parts.length > 4 || parts.some(part => !part)) throw new WorkflowError(404, '找不到流程操作');
  if (group === 'templates') {
    if (!id && method === 'GET') return {status: 200, data: service.templates()};
    if (id && !action && method === 'PUT') return {status: 200, data: service.save(id, data)};
    if (id && !nodeId && action === 'publish' && method === 'POST') return {status: 200, data: service.publish(id, data)};
    if (id && !nodeId && action === 'restore' && method === 'POST') return {status: 200, data: service.restore(id, data)};
    if (id && !nodeId && action === 'retired' && method === 'PUT') return {status: 200, data: service.setRetired(id, data)};
    if (id && !nodeId && action === 'start' && method === 'POST') return {status: 201, data: service.start(id, data)};
    if (id && action === 'versions' && /^\d+$/.test(nodeId ?? '') && method === 'GET') return {status: 200, data: service.inspectVersion(id, Number(nodeId))};
  }
  if (group === 'runs' && id && !action && method === 'GET') return {status: 200, data: service.instances(id)};
  if (group === 'instances' && id && action === 'nodes' && nodeId && method === 'POST') return {status: 200, data: service.act(id, nodeId, data)};
  throw new WorkflowError(404, '找不到流程操作');
}
