// build.ts：XmindNode → 2020+ 格式 zip（[content.json, metadata.json]）。
// 备注写为 notes.plain.content；标记（M7b-W1）各数组逐枚出有 XMind 原生 marker-id
// 对应的值（iconsToMarkerIds：priority-N / flag-red / star-red；mood/number/arrow/
// progress/emoji 与其余 other slug 无原生对应，不导出——映射口径见 markers.ts 头注）。
import { strToU8, zipSync } from 'fflate';
import { iconsToMarkerIds } from './markers';
import type { JsonTopic, XmindNode } from './types';

/** 生成 2020+ 格式 zip：[content.json, metadata.json]。 */
export function buildXmind(root: XmindNode): Uint8Array {
  const topic = (n: XmindNode): JsonTopic => {
    const markerIds = iconsToMarkerIds(n.icons);
    return {
      class: 'topic',
      title: n.title,
      ...(markerIds.length > 0 ? { markers: markerIds.map((markerId) => ({ markerId })) } : {}),
      ...(n.note ? { notes: { plain: { content: n.note } } } : {}),
      ...(n.children.length ? { children: { attached: n.children.map(topic) } } : {}),
    };
  };
  const content = JSON.stringify([{ class: 'sheet', title: 'Sheet 1', rootTopic: topic(root) }]);
  return zipSync({
    'content.json': strToU8(content),
    'metadata.json': strToU8('{"creator":"Gmind"}'),
  });
}
