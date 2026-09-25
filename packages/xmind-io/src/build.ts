// build.ts：XmindNode → 2020+ 格式 zip（[content.json, metadata.json]）。
import { strToU8, zipSync } from 'fflate';
import type { JsonTopic, XmindNode } from './types';

/** 生成 2020+ 格式 zip：[content.json, metadata.json]。备注写为 notes.plain.content。 */
export function buildXmind(root: XmindNode): Uint8Array {
  const topic = (n: XmindNode): JsonTopic => ({
    class: 'topic',
    title: n.title,
    ...(n.note ? { notes: { plain: { content: n.note } } } : {}),
    ...(n.children.length ? { children: { attached: n.children.map(topic) } } : {}),
  });
  const content = JSON.stringify([{ class: 'sheet', title: 'Sheet 1', rootTopic: topic(root) }]);
  return zipSync({
    'content.json': strToU8(content),
    'metadata.json': strToU8('{"creator":"Gmind"}'),
  });
}
