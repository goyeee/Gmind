// parse-xml.ts：XMind 8 content.xml 解析（DOMParser，浏览器原生 / jsdom 测试）。
// 层级在 <topic> > <children> > <topics type="attached"> > <topic> 下嵌套；备注取 <notes> > <plain> 文本。
// 标记（M7a-T1）：<marker-refs> > <marker-ref marker-id> 经 markersToIcons 映射三组制；
// 无对应的 marker 计入 style 降级（映射成功的不再计降级）。
import type { DegradedItem, XmindIcons, XmindNode } from './types';
import { XmindParseError } from './types';
import { DegradedCollector } from './parse-json';
import { markersToIcons } from './markers';

/** el 的直接子元素中第一个 localName 匹配项（命名空间无关）。 */
function childElement(el: Element, localName: string): Element | null {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.localName === localName) return c;
  }
  return null;
}

function countChildren(el: Element, localName: string): number {
  let n = 0;
  for (let i = 0; i < el.children.length; i++) {
    if (el.children[i].localName === localName) n++;
  }
  return n;
}

/** 收集 <children> 下 <topics type="attached|detached"> 里的直接 <topic> 子元素。 */
function collectTopics(el: Element, type: 'attached' | 'detached'): Element[] {
  const childrenEl = childElement(el, 'children');
  if (!childrenEl) return [];
  const out: Element[] = [];
  for (let i = 0; i < childrenEl.children.length; i++) {
    const topicsEl = childrenEl.children[i];
    if (topicsEl.localName !== 'topics' || topicsEl.getAttribute('type') !== type) continue;
    for (let j = 0; j < topicsEl.children.length; j++) {
      const topicEl = topicsEl.children[j];
      if (topicEl.localName === 'topic') out.push(topicEl);
    }
  }
  return out;
}

/** 统计一棵 XML 子树的全部节点数（含自身，attached+detached 一并计入）。 */
function countXmlTree(el: Element): number {
  const kids = [...collectTopics(el, 'attached'), ...collectTopics(el, 'detached')];
  return 1 + kids.reduce((sum, k) => sum + countXmlTree(k), 0);
}

function walkXmlTopic(el: Element, d: DegradedCollector): XmindNode {
  // 降级统计只看本主题的直接子元素，避免把子主题的降级重复计入父级。
  const markerRefs = childElement(el, 'marker-refs');
  let icons: XmindIcons | undefined;
  if (markerRefs) {
    const ids: string[] = [];
    for (let i = 0; i < markerRefs.children.length; i++) {
      const ref = markerRefs.children[i];
      if (ref.localName === 'marker-ref') ids.push(ref.getAttribute('marker-id') ?? '');
    }
    const mapped = markersToIcons(ids);
    d.add('style', mapped.dropped); // 仅无对应的 marker 计降级（映射成功不丢）
    if (Object.keys(mapped.icons).length > 0) {
      icons = mapped.icons;
    }
  }
  const labelsEl = childElement(el, 'labels');
  if (labelsEl) d.add('style', countChildren(labelsEl, 'label'));
  if (childElement(el, 'image') || childElement(el, 'img')) d.add('media', 1);
  const attachmentsEl = childElement(el, 'attachments');
  if (attachmentsEl) d.add('media', countChildren(attachmentsEl, 'attachment'));
  const summariesEl = childElement(el, 'summaries');
  if (summariesEl) d.add('structure', countChildren(summariesEl, 'summary'));
  for (const dt of collectTopics(el, 'detached')) d.add('structure', countXmlTree(dt));

  const titleEl = childElement(el, 'title');
  const notesEl = childElement(el, 'notes');
  const plainEl = notesEl ? childElement(notesEl, 'plain') : null;
  const note = plainEl?.textContent?.trim() || undefined;

  return {
    title: (titleEl?.textContent ?? '').trim(),
    ...(note !== undefined ? { note } : {}),
    ...(icons !== undefined ? { icons } : {}),
    children: collectTopics(el, 'attached').map((t) => walkXmlTopic(t, d)),
  };
}

/**
 * 解析 content.xml（XMind 8）：根元素非 <map> 或含解析错误 → CORRUPTED；
 * 第一个 sheet 无 topic → EMPTY；额外 sheet 计 structure 降级。
 */
export function parseContentXml(data: Uint8Array): { root: XmindNode; degraded: DegradedItem[] } {
  const text = new TextDecoder().decode(data);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const rootEl = doc.documentElement;
  const hasParserError = doc.getElementsByTagName('parsererror').length > 0;
  if (!rootEl || rootEl.localName !== 'map' || hasParserError) {
    throw new XmindParseError('CORRUPTED', 'content.xml 不是合法的 XMind 8 XML');
  }

  const sheetEls = doc.getElementsByTagName('sheet');
  const firstSheet = sheetEls[0] as Element | undefined;
  const rootTopicEl = firstSheet ? childElement(firstSheet, 'topic') : null;
  if (!rootTopicEl) {
    throw new XmindParseError('EMPTY', 'content.xml 第一个 sheet 缺少 topic');
  }

  const d = new DegradedCollector();
  if (sheetEls.length > 1) d.add('structure', sheetEls.length - 1);
  return { root: walkXmlTopic(rootTopicEl, d), degraded: d.items() };
}
