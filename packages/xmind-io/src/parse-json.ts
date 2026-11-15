// parse-json.ts：XMind 2020+ content.json 解析（2026-11-14 导入保真 v2）——
// 提取层级/文本/备注/标记 + href/图片/概要/样式/折叠/结构；未导入特性按 DegradedKey
// 命名制逐项计数（目录序见 types.ts DEGRADED_LABELS）。形状真值以 spec §二/§四 为准：
// `markers:[{markerId}]`、概要两段式（标签文本在 `children.summary:[{id,title}]`，父节点
// `summaries:[{id,topicId,range:"(s,e)"}]` 引用）、`branch:"folded"` 折叠态、根 `structureClass`。
// 2026-11-15 分侧忠实还原：根 `extensions` provider=org.xmind.ui.map.unbalanced 的
// right-number → sheet.rightCount（仅根有效；未知 provider/无 right-number 忽略不计降级）。
// 共享工具（DegradedCollector/applyStyleKeyMap/structureTypeOf/rightNumberOf）由 parse-xml 复用。
import type {
  DegradedItem,
  DegradedKey,
  JsonSheet,
  JsonTopic,
  XmindIcons,
  XmindNode,
  XmindResources,
  XmindSheet,
  XmindStructureType,
} from './types';
import { DEGRADED_LABELS, XmindParseError } from './types';
import { markersToIcons } from './markers';

/** 降级聚合器（v2 命名制）：按 key 求和，count<=0 忽略；items 恒按目录序、count=0 不输出。 */
export class DegradedCollector {
  private counts: Partial<Record<DegradedKey, number>> = {};

  add(key: DegradedKey, count = 1): void {
    if (count <= 0) return;
    this.counts[key] = (this.counts[key] ?? 0) + count;
  }

  items(): DegradedItem[] {
    return (Object.keys(DEGRADED_LABELS) as DegradedKey[])
      .filter((k) => (this.counts[k] ?? 0) > 0)
      .map((k) => ({ key: k, count: this.counts[k] as number }));
  }
}

/** realHTML 备注 → 纯文本：剥标签、解常见命名实体、折叠空白。 */
export function stripHtml(html: string): string {
  const namedEntities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  };
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => namedEntities[m])
    .replace(/\s+/g, ' ')
    .trim();
}

const isTopicLike = (v: unknown): v is JsonTopic =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** unknown 数组 → topic 形状数组（忽略非对象项）。 */
const topicsOf = (v: unknown): JsonTopic[] => (Array.isArray(v) ? v.filter(isTopicLike) : []);

/** 概要/外框 range 真值形状：`(s,e)`（children 下标闭区间；spec §四）。与 parse-xml 共用（评审 Minor#1：单源防口径分叉）。 */
export const RANGE_RE = /^\((\d+),(\d+)\)$/;

/** 图片 align 四值白名单（spec §四），与 parse-xml 共用。 */
export const IMG_ALIGNS = ['top', 'bottom', 'left', 'right'] as const;

export type ImageAlign = (typeof IMG_ALIGNS)[number];

const IMG_ALIGN_OF = (v: unknown): ImageAlign | undefined =>
  typeof v === 'string' && (IMG_ALIGNS as readonly string[]).includes(v) ? (v as ImageAlign) : undefined;

/** 递归收集 attached/detached 下的子主题（忽略非对象项；callout/summary/boundary 桶不属树）。 */
function childTopics(t: JsonTopic): JsonTopic[] {
  const attached = t.children?.attached;
  const detached = t.children?.detached;
  return [...(Array.isArray(attached) ? attached : []), ...(Array.isArray(detached) ? detached : [])].filter(
    isTopicLike,
  );
}

/** 统计一棵漂浮子树的全部节点数（含自身，attached+detached 一并计入）。 */
function countTopicTree(t: JsonTopic): number {
  return 1 + childTopics(t).reduce((sum, c) => sum + countTopicTree(c), 0);
}

// ---------------------------------------------------------------------------
// 样式四键映射（spec §四：JSON style.properties 直读 / XML 经 styles.xml 间接表，共用此处）
// ---------------------------------------------------------------------------

/** XMind 样式属性名 → XmindNode.style 键；表外键不支持（逐键计 styleProp）。 */
const STYLE_KEY_MAP: Record<string, string> = {
  'fo:color': 'color',
  'svg:fill': 'fill',
  'svg:stroke-color': 'border',
  'fo:font-size': 'fontSize',
};

/** 原始属性表 → 四键映射（非法/不支持的键逐键计 styleProp）。两个解析器共用。 */
export function applyStyleKeyMap(raw: Record<string, string>, d: DegradedCollector): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const target = STYLE_KEY_MAP[name];
    if (!target) {
      d.add('styleProp'); // 不支持的键（fo:font-family/线宽/行高/对齐…）逐键计
      continue;
    }
    if (target === 'fontSize') {
      const m = /^(\d+(?:\.\d+)?)(px|pt)?$/.exec(value.trim());
      const n = m ? Math.round(Number(m[1])) : 0;
      if (!m || !Number.isFinite(n) || n <= 0) {
        d.add('styleProp'); // 非法/≤0 计样式属性
        continue;
      }
      out.fontSize = String(n); // 去 px/pt 取整："14px" → "14"
    } else if (value !== '') {
      out[target] = value;
    } else {
      d.add('styleProp'); // 支持键但空值无法使用
    }
  }
  return out;
}

/** 根 structureClass → structureType（spec §四）；未指定返回 undefined（零计数）；不认识的值计 structureOverride 落缺省。 */
export function structureTypeOf(raw: unknown, d: DegradedCollector): XmindStructureType | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  if (raw === 'org.xmind.ui.logic.right') return 'logic';
  if (raw.startsWith('org.xmind.ui.map.')) return 'mindmap';
  if (raw.startsWith('org.xmind.ui.org-chart.')) return 'org';
  d.add('structureOverride');
  return undefined;
}

/** 分侧扩展 provider 真值（2026-11-15 分侧忠实还原，11 份本机真实文件实证）：根主题扩展
 *  `org.xmind.ui.map.unbalanced` 的 right-number = attached 文档序**前 N 支居右**计数。 */
export const UNBALANCED_PROVIDER = 'org.xmind.ui.map.unbalanced';

/** right-number 文本 → 计数：parseInt 后非负整数才返回，否则 undefined（不产键）。
 *  与 parse-xml 共用（单源防口径分叉）。 */
export function rightNumberOf(text: string): number | undefined {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** 根扩展 right-number（分侧真值，仅根主题上的扩展有效）：`extensions:[{provider,
 *  content:[{name,content}]}]`——provider 恰为 map.unbalanced 且 content 数组中
 *  name==='right-number' 项的 content 字符串 parseInt；不认识的 provider / 无
 *  right-number / 非法值一律不产键，也不计降级（与 theme 同口径）。 */
function resolveJsonRightCount(root: JsonTopic): number | undefined {
  if (!Array.isArray(root.extensions)) return undefined;
  for (const e of root.extensions) {
    if (!isTopicLike(e)) continue;
    const { provider, content } = e as { provider?: unknown; content?: unknown };
    if (provider !== UNBALANCED_PROVIDER || !Array.isArray(content)) continue;
    for (const item of content) {
      if (!isTopicLike(item)) continue;
      const { name, content: value } = item as { name?: unknown; content?: unknown };
      if (name === 'right-number' && typeof value === 'string') {
        const n = rightNumberOf(value);
        if (n !== undefined) return n;
      }
    }
  }
  return undefined;
}

/** JSON style.properties 直读（spec §四）：properties 缺失计 styleProp（整份无法读取）。 */
function resolveJsonStyle(t: JsonTopic, d: DegradedCollector): Record<string, string> | undefined {
  if (t.style == null) return undefined;
  const props = isTopicLike(t.style) ? t.style.properties : undefined;
  if (!isTopicLike(props)) {
    d.add('styleProp');
    return undefined;
  }
  const raw: Record<string, string> = {};
  for (const [name, value] of Object.entries(props)) {
    if (typeof value === 'string') raw[name] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) raw[name] = String(value);
    else d.add('styleProp');
  }
  const mapped = applyStyleKeyMap(raw, d);
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/** JSON 图片：`image.src` 剥 `xap:` 查 resources 表；查无键（zip 缺失/魔数不符未入表）计图片跳过；w/h float 取整。 */
function resolveJsonImage(t: JsonTopic, resources: XmindResources, d: DegradedCollector): XmindNode['image'] {
  if (t.image == null) return undefined;
  const img = t.image as { src?: unknown; width?: unknown; height?: unknown; align?: unknown };
  const src = typeof img.src === 'string' && img.src !== '' ? img.src : undefined;
  if (!src) {
    d.add('image');
    return undefined;
  }
  const path = src.startsWith('xap:') ? src.slice(4) : src;
  if (!resources[path]) {
    d.add('image'); // zip 查无键（或白名单外未入表）
    return undefined;
  }
  const w = typeof img.width === 'number' && Number.isFinite(img.width) ? Math.round(img.width) : undefined;
  const h = typeof img.height === 'number' && Number.isFinite(img.height) ? Math.round(img.height) : undefined;
  const align = IMG_ALIGN_OF(img.align);
  return {
    path,
    ...(w !== undefined ? { w } : {}),
    ...(h !== undefined ? { h } : {}),
    ...(align !== undefined ? { align } : {}),
  };
}

/** 概要两段式（spec §二真值）：标签文本按 children.summary[].id ↔ summaries[].topicId 映射；
 *  range 非法（格式/逆序/越界）计概要不产条目；标签查无产条目、label 空串。 */
function resolveJsonSummaries(t: JsonTopic, d: DegradedCollector): XmindNode['summaries'] {
  const refs = Array.isArray(t.summaries) ? t.summaries.filter(isTopicLike) : [];
  if (refs.length === 0) return undefined;
  const labelById = new Map<string, string>();
  for (const lbl of topicsOf(t.children?.summary)) {
    if (typeof lbl.id === 'string') labelById.set(lbl.id, typeof lbl.title === 'string' ? lbl.title : '');
  }
  const attachedCount = topicsOf(t.children?.attached).length;
  const out: NonNullable<XmindNode['summaries']> = [];
  for (const ref of refs) {
    const m = typeof ref.range === 'string' ? RANGE_RE.exec(ref.range.trim()) : null;
    if (!m) {
      d.add('summary');
      continue;
    }
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (start > end || end >= attachedCount) {
      d.add('summary'); // 逆序（如 (2,1)）/越界
      continue;
    }
    const topicId = typeof ref.topicId === 'string' ? ref.topicId : '';
    out.push({ start, end, label: labelById.get(topicId) ?? '' });
  }
  return out.length > 0 ? out : undefined;
}

function walkTopic(t: JsonTopic, d: DegradedCollector, resources: XmindResources, isRoot: boolean): XmindNode {
  // 标记：markers:[{markerId}]（未映射/被吞 id 由 Task 1 v2 dropped 计图标）
  let icons: XmindIcons | undefined;
  if (Array.isArray(t.markers)) {
    const ids = t.markers.map((m) => (isTopicLike(m) && typeof (m as { markerId?: unknown }).markerId === 'string'
      ? ((m as { markerId: string }).markerId)
      : ''));
    const mapped = markersToIcons(ids);
    d.add('icon', mapped.dropped);
    if (Object.keys(mapped.icons).length > 0) {
      icons = mapped.icons;
    }
  }
  if (Array.isArray(t.labels)) d.add('label', t.labels.length);
  if (!isRoot && typeof t.structureClass === 'string' && t.structureClass !== '') {
    d.add('structureOverride'); // 非根结构类逐个计（spec §四）
  }
  // 超链接：非 http/https（xapp:/相对路径）setHref 会拒，解析层预判丢弃
  let href: string | undefined;
  if (typeof t.href === 'string' && t.href !== '') {
    if (/^https?:\/\//i.test(t.href)) href = t.href;
    else d.add('link');
  }
  const style = resolveJsonStyle(t, d);
  const image = resolveJsonImage(t, resources, d);
  if (Array.isArray(t.attachments)) d.add('attachment', t.attachments.length);
  if (t.taskInfo != null) d.add('taskInfo');
  for (const co of topicsOf(t.children?.callout)) d.add('callout', countTopicTree(co)); // 标注按子树节点数（同漂浮口径）
  const boundaryEntries = topicsOf(t.children?.boundary);
  if (boundaryEntries.length > 0) d.add('boundary', boundaryEntries.length);
  const summaries = resolveJsonSummaries(t, d);
  // detached 漂浮：被概要/外框 topicId 引用（命中 detached id）者豁免，整树不下钻（spec §四）
  const consumed = new Set<string>();
  for (const ref of topicsOf(t.summaries)) {
    if (typeof ref.topicId === 'string') consumed.add(ref.topicId);
  }
  for (const b of boundaryEntries) {
    if (typeof b.topicId === 'string') consumed.add(b.topicId);
  }
  for (const dt of detachedTopicsOf(t)) {
    if (typeof dt.id === 'string' && consumed.has(dt.id)) continue;
    d.add('floating', countTopicTree(dt));
  }

  // 备注：plain 优先，其次 realHTML 剥标签（realHTML 含 <img> 计备注图片，与 plain 是否在场无关——
  // XMind 常同时写两份同一备注）。
  const html = t.notes?.realHTML?.content;
  if (typeof html === 'string' && /<img[\s>]/i.test(html)) d.add('noteImage');
  const plain = t.notes?.plain?.content;
  const note =
    typeof plain === 'string' ? plain : typeof html === 'string' ? stripHtml(html) : undefined;

  // 描述（M7c-C1）：Gmind 自定义键读回（string 且非空才携带）；他方文件无此键零影响，
  // 也不计降级（本包自产自销的往返字段，见 types.ts XmindNode 头注）。
  const description = typeof t.description === 'string' && t.description !== '' ? t.description : undefined;

  // 折叠态（spec §四）：仅 `branch === "folded"` 产 folded:true，无键不落键。
  const folded = t.branch === 'folded' ? true : undefined;

  const attached = t.children?.attached;
  return {
    title: typeof t.title === 'string' ? t.title : '',
    ...(note !== undefined ? { note } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icons !== undefined ? { icons } : {}),
    ...(href !== undefined ? { href } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(style !== undefined ? { style } : {}),
    ...(summaries !== undefined ? { summaries } : {}),
    ...(folded ? { folded: true } : {}),
    children: (Array.isArray(attached) ? attached : []).filter(isTopicLike).map((c) => walkTopic(c, d, resources, false)),
  };
}

function detachedTopicsOf(t: JsonTopic): JsonTopic[] {
  const detached = t.children?.detached;
  return (Array.isArray(detached) ? detached : []).filter(isTopicLike);
}

/**
 * 解析 content.json：全部 sheet 逐个产出（多画布计划四，裁定 8——不再取 [0] 拍平）。
 * 第一个 sheet 缺 rootTopic（或数组为空）→ EMPTY；附加 sheet 缺 rootTopic → 计
 * 空画布降级并跳过；顶层不是数组 → CORRUPTED。每 sheet：theme 键**不再计入**（2026-11-14
 * 需求方拍板）、根 structureClass 映射 structureType（legend 忽略不计）。
 */
export function parseContentJson(
  data: Uint8Array,
  resources: XmindResources,
): { sheets: XmindSheet[]; degraded: DegradedItem[] } {
  const text = new TextDecoder().decode(data);
  let sheets: JsonSheet[];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('content.json 顶层不是 sheet 数组');
    sheets = parsed as JsonSheet[];
  } catch (e) {
    throw new XmindParseError(
      'CORRUPTED',
      `content.json 无法按 XMind 2020+ 格式解析：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const first = sheets[0] as JsonSheet | undefined;
  if (!isTopicLike(first?.rootTopic)) {
    throw new XmindParseError('EMPTY', 'content.json 第一个 sheet 缺少 rootTopic');
  }
  const d = new DegradedCollector();
  const out: XmindSheet[] = [];
  sheets.forEach((s, i) => {
    if (!isTopicLike(s.rootTopic)) {
      if (i > 0) d.add('sheet', 1); // 附加 sheet 缺根：计空画布并跳过（首 sheet 缺根已在上方 EMPTY）
      return;
    }
    // sheet theme 不再计入（2026-11-14 需求方拍板：主题由 Gmind 自有主题替换呈现，
    // 属有意替换非内容丢失；legend 忽略不计口径不变）
    const root = s.rootTopic as JsonTopic;
    const structureType = structureTypeOf(root.structureClass, d);
    const rightCount = resolveJsonRightCount(root); // 分侧计数仅看根扩展（子主题忽略）
    out.push({
      title: typeof s.title === 'string' ? s.title : '',
      root: walkTopic(root, d, resources, true), // 每 sheet 的根都按根处理（结构类可映射）
      ...(structureType !== undefined ? { structureType } : {}),
      ...(rightCount !== undefined ? { rightCount } : {}),
    });
  });
  return { sheets: out, degraded: d.items() };
}
