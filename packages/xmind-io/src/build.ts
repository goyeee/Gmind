// build.ts：XmindNode → 2020+ 格式 zip（[content.json, metadata.json]）。
// 备注写为 notes.plain.content；标记（M7b-W1）各数组逐枚出有 XMind 原生 marker-id
// 对应的值（iconsToMarkerIds：priority-N / flag-red / star-red；mood/number/arrow/
// progress/emoji 与其余 other slug 无原生对应，不导出——映射口径见 markers.ts 头注）。
// 描述（M7c-C1）：description 非空出自定义键 `description`（2020+ JSON 宽容未知键；
// XML 侧无对应标签，登记不映射——见 types.ts XmindNode 头注）。
import { strToU8, zipSync } from 'fflate';
import { iconsToMarkerIds } from './markers';
import type { JsonTopic, XmindNode, XmindSheet } from './types';

/** 生成 2020+ 格式 zip：[content.json, metadata.json]。多画布（计划四，裁定 8）：
 *  全部画布逐个出 sheet（title=画布名）；单画布调用方传单元素数组（兼容形态不变）。 */
export function buildXmind(sheets: XmindSheet[]): Uint8Array {
  const topic = (n: XmindNode): JsonTopic => {
    const markerIds = iconsToMarkerIds(n.icons);
    return {
      class: 'topic',
      title: n.title,
      ...(markerIds.length > 0 ? { markers: markerIds.map((markerId) => ({ markerId })) } : {}),
      ...(n.note ? { notes: { plain: { content: n.note } } } : {}),
      ...(n.description ? { description: n.description } : {}),
      ...(n.children.length ? { children: { attached: n.children.map(topic) } } : {}),
    };
  };
  const content = JSON.stringify(
    sheets.map((s, i) => ({
      class: 'sheet',
      title: s.title || `Sheet ${i + 1}`,
      rootTopic: topic(s.root),
    })),
  );
  return zipSync({
    'content.json': strToU8(content),
    'metadata.json': strToU8('{"creator":"Gmind"}'),
  });
}
