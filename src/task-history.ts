import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { DeliveryView } from './types.js';

export interface TaskEvent {
  at: string;
  agent: string;
  kind: string;
  text: string;
  taskId: string;
}

function textContent(blocks: readonly ContentBlock[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

/** Project each native turn onto the task identified by its Studio delivery. */
export function nativeHistory(
  events: readonly SessionEvent[],
  agent: string,
  deliveries: ReadonlyMap<string, DeliveryView>,
  taskIds: ReadonlySet<string>,
): TaskEvent[] {
  const history: TaskEvent[] = [];
  const toolNames = new Map<string, string>();
  let taskId: string | undefined;

  for (const event of events) {
    if (event.type === 'turn/start') {
      taskId = undefined;
      continue;
    }
    if (event.type === 'user/message' && event.data.id.startsWith('studio-delivery:')) {
      // A recovered delivery appends a suffix to the original delivery ID.
      const [, deliveryId] = event.data.id.split(':', 2);
      const delivery = deliveryId ? deliveries.get(deliveryId) : undefined;
      taskId = delivery?.taskId;
      if (delivery && taskId && taskIds.has(taskId)) {
        history.push({at: new Date(event.time).toISOString(), agent, taskId, kind: '投递', text: delivery.text});
      }
      continue;
    }
    if (!taskId || !taskIds.has(taskId)) continue;

    const context = {at: new Date(event.time).toISOString(), agent, taskId};
    switch (event.type) {
      case 'assistant/message': {
        const text = textContent(event.data.message.content);
        if (text) history.push({...context, kind: 'Agent 回复', text});
        break;
      }
      case 'tool/call': {
        const {callId, name, arguments: args} = event.data;
        toolNames.set(callId, name);
        history.push({...context, kind: '调用 ' + name, text: args});
        break;
      }
      case 'tool/result': {
        const [result] = event.data.message.content;
        const label = result.isError ? '工具失败 ' : '工具结果 ';
        const name = toolNames.get(result.toolCallId) ?? '';
        history.push({...context, kind: label + name, text: textContent(result.content)});
        break;
      }
    }
  }
  return history;
}
