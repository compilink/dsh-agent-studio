import type {DeliveryView, TaskView} from './types.js';

interface InputSource { kind: 'delivery' | 'task'; text: string }

/** Index only this delivery and, when different, the original instructions on the same task. */
export function taskInputSources(delivery: DeliveryView, task?: TaskView): InputSource[] {
  const sources: InputSource[] = [{kind:'delivery', text:delivery.text}];
  if (task) {
    if (task.id !== delivery.taskId || task.runId !== delivery.runId) throw new Error('Task does not belong to this delivery');
    if (task.prompt !== delivery.text) sources.push({kind:'task', text:task.prompt});
  }
  return sources;
}

export const MAX_PAGE = 16_000;

/** Keep small deliveries intact and attach a page directory when their combined input exceeds 16k UTF-16 units. */
export function presentTaskInputs(sources: InputSource[]) {
  if (sources.reduce((size, value) => size + value.text.length, 0) <= MAX_PAGE) return {text:sources[0]!.text};
  const text = sources[0]!.text.slice(0,1_200);
  const inputPages = sources.map(({kind,text:body}, source) => ({
    source, kind, characters:body.length, ...(source ? {preview:body.slice(0,1_200)} : {}),
  }));
  return {text, inputPages, readInputs:'Use studio_read_input with this deliveryId and a listed source to search for literal text or read pages. Follow nextOffset. Source 0 is this delivery; source 1, when listed, is this task’s original instructions.'};
}

export function readInputPage(sources: InputSource[], source: number, offset: number, limit: number, find?: string) {
  const input = sources[source];
  if (!input) throw new Error('当前投递没有这份输入');
  const content = input.text;
  const start = find === undefined ? Math.min(content.length,offset) : content.indexOf(find,offset);
  if (start < 0) return {source, totalCharacters:content.length, found:false};
  const end = Math.min(start + limit,content.length);
  return {source, totalCharacters:content.length, start, content:content.slice(start,end), nextOffset:end < content.length ? end : null};
}
