// parse-xml.ts：XMind 8 content.xml 解析（DOMParser，浏览器原生 / jsdom 测试；2026-11-14
// 导入保真 v2）。层级在 <topic> > <children> > <topics type="attached"> > <topic> 下嵌套；
// 备注取 <notes> > <plain> 文本。形状真值以 spec §二/§四 为准：
// - 标记：<marker-refs> > <marker-ref marker-id>（未映射计图标）；
// - 概要：<summaries><summary range="(s,e)" topic-id/>，标签文本在被 topic-id 引用的同父
//   标签桶 topic 上（真实 XMind 8 = <topics type="summary">，T7 冒烟实证；detached 桶
//   为设计文档阶段假设形状，保留兼容）（被引用 detached 者豁免漂浮且整树不下钻；
//   外框 <boundaries><boundary topic-id> 同）；
// - 图片：<img align svg:width svg:height xhtml:src="xap:resources/…">，src 按
//   xhtml:src→src→xlink:href→href 兜底，多图首张胜、余者逐张计图片；
// - 链接：topic 的 xlink:href（非 http/https 计超链接）；
// - 样式：topic style-id → styles.xml 间接表（parseXmind 预解析 Map 传入；缺表逐个计样式属性）；
// - 结构：根 structure-class 映射 structureType、非根逐个计结构覆盖；
// - sheet theme 是**属性**（子元素兜底）——两者都**不再计入**降级（2026-11-14 需求方
//   拍板：主题由 Gmind 自有主题替换，非内容丢失）；legend 忽略不计。
// 描述（M7c-C1）：XML 侧无对应标签（XMind 8 格式无 description 概念），登记不映射——
// 导入不产出、导出（buildXmind 只走 JSON 侧）不写入（口径见 types.ts XmindNode 头注）。
import type { DegradedItem, XmindIcons, XmindNode, XmindResources, XmindSheet } from './types';
import { XmindParseError } from './types';
import { applyStyleKeyMap, DegradedCollector, IMG_ALIGNS, RANGE_RE, structureTypeOf } from './parse-json';
import type { ImageAlign } from './parse-json';
import { markersToIcons } from './markers';

/** 图片 src 属性兜底链（spec §四：xhtml:src→src→xlink:href→href）。 */
const IMG_SRC_ATTRS = ['xhtml:src', 'src', 'xlink:href', 'href'] as const;

/** el 的直接子元素中第一个 localName 匹配项（命名空间无关）。 */
function childElement(el: Element, localName: string): Element | null {
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.localName === localName) return c;
  }
  return null;
}

/** el 的直接子元素中所有 localName 匹配项。 */
function childElements(el: Element, localName: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.localName === localName) out.push(c);
  }
  return out;
}

function countChildren(el: Element, localName: string): number {
  return childElements(el, localName).length;
}

/** 收集 <children> 下 <topics type="attached|detached|callout"> 里的直接 <topic> 子元素。 */
function collectTopics(el: Element, type: string): Element[] {
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

/** XML 属性数值（float 取整；缺失/非法返回 undefined）。 */
function attrNum(el: Element, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : undefined;
}

/**
 * styles.xml → 间接表 Map(style-id → 原始属性表)。zip 缺文件 / 解析失败 / 非 node 环境
 * （DOMParser 未定义，buildXmind 产物无 styles.xml 不会触达）→ 空表，调用方按「缺表」计数。
 */
export function parseStylesTable(data: Uint8Array | undefined): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!data || typeof DOMParser === 'undefined') return out;
  try {
    const doc = new DOMParser().parseFromString(new TextDecoder().decode(data), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) return out;
    const root = doc.documentElement;
    if (!root || root.localName !== 'styles') return out;
    for (const styleEl of Array.from(root.children)) {
      if (styleEl.localName !== 'style') continue;
      const id = styleEl.getAttribute('id');
      if (!id) continue;
      const props: Record<string, string> = {};
      for (const p of Array.from(styleEl.children)) {
        if (p.localName !== 'property') continue;
        const name = p.getAttribute('name');
        const value = p.getAttribute('value');
        if (name !== null && value !== null) props[name] = value;
      }
      out.set(id, props);
    }
  } catch {
    return out;
  }
  return out;
}

/** XML 图片（spec §四）：多图首张（可解析者）胜、其余逐张计图片；zip 查无键计图片跳过。 */
function resolveXmlImages(el: Element, resources: XmindResources, d: DegradedCollector): XmindNode['image'] {
  const imgs = [...childElements(el, 'img'), ...childElements(el, 'image')];
  if (imgs.length === 0) return undefined;
  let taken: XmindNode['image'] | undefined;
  for (const img of imgs) {
    let resolved: XmindNode['image'] | undefined;
    let src: string | undefined;
    for (const attr of IMG_SRC_ATTRS) {
      const v = img.getAttribute(attr);
      if (v) {
        src = v;
        break;
      }
    }
    if (src) {
      const path = src.startsWith('xap:') ? src.slice(4) : src;
      if (resources[path]) {
        const w = attrNum(img, 'svg:width');
        const h = attrNum(img, 'svg:height');
        const alignRaw = img.getAttribute('align');
        const align: ImageAlign | undefined =
          alignRaw && (IMG_ALIGNS as readonly string[]).includes(alignRaw) ? (alignRaw as ImageAlign) : undefined;
        resolved = {
          path,
          ...(w !== undefined ? { w } : {}),
          ...(h !== undefined ? { h } : {}),
          ...(align !== undefined ? { align } : {}),
        };
      }
    }
    if (resolved !== undefined && taken === undefined) taken = resolved;
    else d.add('image'); // 其余逐张计图片（含查无键/无 src 者）
  }
  return taken;
}

/** 收集本主题 <summaries> 下的 <summary> 元素（供概要解析与 detached 豁免共用）。 */
function summaryElements(el: Element): Element[] {
  const summariesEl = childElement(el, 'summaries');
  return summariesEl ? childElements(summariesEl, 'summary') : [];
}

/** XML 概要：<summary range topic-id>，标签取同父标签桶（id=topic-id）的 <title>：
 *  真实 XMind 8 把标签 topic 放在 <topics type="summary">（T7 真实文件冒烟实证，
 *  2026-11-14 修复——旧实现只查 detached、真实文件标签全落空串）；detached 桶保留
 *  查找（设计文档阶段的假设形状，既有测试兼容），查无再回落 summary 自身 <title>；
 *  range 非法/逆序/越界计概要。 */
function resolveXmlSummaries(el: Element, summaryEls: Element[], d: DegradedCollector): XmindNode['summaries'] {
  if (summaryEls.length === 0) return undefined;
  const attachedCount = collectTopics(el, 'attached').length;
  const labelTopics = [...collectTopics(el, 'detached'), ...collectTopics(el, 'summary')];
  const out: NonNullable<XmindNode['summaries']> = [];
  for (const sEl of summaryEls) {
    const m = RANGE_RE.exec((sEl.getAttribute('range') ?? '').trim());
    if (!m) {
      d.add('summary');
      continue;
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start > end || end >= attachedCount) {
      d.add('summary');
      continue;
    }
    const topicId = sEl.getAttribute('topic-id') ?? '';
    const labelEl = labelTopics.find((tEl) => tEl.getAttribute('id') === topicId);
    const titleEl = labelEl ? childElement(labelEl, 'title') : childElement(sEl, 'title');
    out.push({ start, end, label: (titleEl?.textContent ?? '').trim() });
  }
  return out.length > 0 ? out : undefined;
}

function walkXmlTopic(
  el: Element,
  d: DegradedCollector,
  resources: XmindResources,
  styles: Map<string, Record<string, string>>,
  isRoot: boolean,
): XmindNode {
  // 降级统计只看本主题的直接子元素，避免把子主题的降级重复计入父级。
  const markerRefs = childElement(el, 'marker-refs');
  let icons: XmindIcons | undefined;
  if (markerRefs) {
    const ids = childElements(markerRefs, 'marker-ref').map((ref) => ref.getAttribute('marker-id') ?? '');
    const mapped = markersToIcons(ids);
    d.add('icon', mapped.dropped); // 仅无对应的 marker 计图标（映射成功不丢）
    if (Object.keys(mapped.icons).length > 0) {
      icons = mapped.icons;
    }
  }
  const labelsEl = childElement(el, 'labels');
  if (labelsEl) d.add('label', countChildren(labelsEl, 'label'));
  if (!isRoot && (el.getAttribute('structure-class') ?? '') !== '') {
    d.add('structureOverride'); // 非根结构类逐个计（spec §四）
  }
  // 样式：style-id → styles.xml 间接表（预解析传入）；缺表逐个计样式属性
  let style: Record<string, string> | undefined;
  const styleId = el.getAttribute('style-id');
  if (styleId) {
    const raw = styles.get(styleId);
    if (!raw) d.add('styleProp', 1);
    else {
      const mapped = applyStyleKeyMap(raw, d);
      if (Object.keys(mapped).length > 0) style = mapped;
    }
  }
  // 超链接：topic 的 xlink:href（非 http/https 计超链接，setHref 会拒，解析层预判）
  let href: string | undefined;
  const rawHref = el.getAttribute('xlink:href');
  if (rawHref) {
    if (/^https?:\/\//i.test(rawHref)) href = rawHref;
    else d.add('link');
  }
  const image = resolveXmlImages(el, resources, d);
  const attachmentsEl = childElement(el, 'attachments');
  if (attachmentsEl) d.add('attachment', countChildren(attachmentsEl, 'attachment'));
  const taskInfoCount = countChildren(el, 'taskinfo') + countChildren(el, 'task-info');
  if (taskInfoCount > 0) d.add('taskInfo', taskInfoCount);
  for (const co of collectTopics(el, 'callout')) d.add('callout', countXmlTree(co)); // 标注按子树节点数（同漂浮口径）
  const boundariesEl = childElement(el, 'boundaries');
  const boundaryEls = boundariesEl ? childElements(boundariesEl, 'boundary') : [];
  if (boundaryEls.length > 0) d.add('boundary', boundaryEls.length);
  const summaryEls = summaryElements(el);
  const summaries = resolveXmlSummaries(el, summaryEls, d);
  // detached 漂浮：被概要/外框 topic-id 引用者豁免（整树不下钻，spec §四）
  const consumed = new Set<string>();
  for (const sEl of summaryEls) {
    const tid = sEl.getAttribute('topic-id');
    if (tid) consumed.add(tid);
  }
  for (const bEl of boundaryEls) {
    const tid = bEl.getAttribute('topic-id');
    if (tid) consumed.add(tid);
  }
  for (const dt of collectTopics(el, 'detached')) {
    const id = dt.getAttribute('id');
    if (id && consumed.has(id)) continue;
    d.add('floating', countXmlTree(dt));
  }

  const titleEl = childElement(el, 'title');
  const notesEl = childElement(el, 'notes');
  const plainEl = notesEl ? childElement(notesEl, 'plain') : null;
  const note = plainEl?.textContent?.trim() || undefined;

  return {
    title: (titleEl?.textContent ?? '').trim(),
    ...(note !== undefined ? { note } : {}),
    ...(icons !== undefined ? { icons } : {}),
    ...(href !== undefined ? { href } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(summaries !== undefined ? { summaries } : {}),
    children: collectTopics(el, 'attached').map((t) => walkXmlTopic(t, d, resources, styles, false)),
  };
}

/**
 * 解析 content.xml（XMind 8）：全部 sheet 逐个产出（多画布计划四，裁定 8）。
 * 根元素非 <map>/<xmap-content>（双形状，见函数内注释）或含解析错误 → CORRUPTED；第一个 sheet 无 topic → EMPTY；
 * 附加 sheet 无 topic → 计空画布降级并跳过。每 sheet：theme 属性与子元素都**不再计入**、
 * legend 忽略、根 structure-class 映射 structureType。
 */
export function parseContentXml(
  data: Uint8Array,
  resources: XmindResources,
  styles: Map<string, Record<string, string>>,
): { sheets: XmindSheet[]; degraded: DegradedItem[] } {
  const text = new TextDecoder().decode(data);
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const rootEl = doc.documentElement;
  const hasParserError = doc.getElementsByTagName('parsererror').length > 0;
  // 根元素双形状（2026-11-14 T7 真实文件冒烟暴露的既有缺陷修复）：真实 XMind 8 文件
  // 根元素是 <xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">，旧检查只认 <map>
  // （M4 合成夹具自造形状）→ 真实文件全被误判 CORRUPTED。两种根都接受，其余逻辑
  // 命名空间无关不受影响。
  if (!rootEl || (rootEl.localName !== 'map' && rootEl.localName !== 'xmap-content') || hasParserError) {
    throw new XmindParseError('CORRUPTED', 'content.xml 不是合法的 XMind 8 XML');
  }

  const sheetEls = Array.from(doc.getElementsByTagName('sheet'));
  const firstSheet = sheetEls[0] as Element | undefined;
  const rootTopicEl = firstSheet ? childElement(firstSheet, 'topic') : null;
  if (!rootTopicEl) {
    throw new XmindParseError('EMPTY', 'content.xml 第一个 sheet 缺少 topic');
  }

  const d = new DegradedCollector();
  const out: XmindSheet[] = [];
  sheetEls.forEach((sheetEl, i) => {
    const topicEl = childElement(sheetEl, 'topic');
    if (!topicEl) {
      if (i > 0) d.add('sheet', 1); // 附加 sheet 缺 topic：计空画布并跳过
      return;
    }
    // sheet theme（属性/子元素）不再计入（2026-11-14 需求方拍板：主题由 Gmind 自有主题
    // 替换呈现，属有意替换非内容丢失）
    const structureType = structureTypeOf(topicEl.getAttribute('structure-class'), d);
    const titleEl = childElement(sheetEl, 'title');
    out.push({
      title: titleEl?.textContent ?? '',
      root: walkXmlTopic(topicEl, d, resources, styles, true), // 每 sheet 的根都按根处理
      ...(structureType !== undefined ? { structureType } : {}),
    });
  });
  return { sheets: out, degraded: d.items() };
}
