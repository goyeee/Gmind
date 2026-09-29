// parse-json.ts：XMind 2020+ content.json 解析——取层级/文本/备注/标记（M7a-T1 三组映射），
// 其余字段计降级（markers 中无对应者计入 style）。
import type { DegradedItem, DegradedKind, JsonSheet, JsonTopic, XmindIcons, XmindNode } from './types';
import { XmindParseError } from './types';
import { markersToIcons } from './markers';

/** 降级聚合器：按 kind 求和，count=0 的 kind 不输出。 */
export class DegradedCollector {
  private counts: Partial<Record<DegradedKind, number>> = {};

  add(kind: DegradedKind, count = 1): void {
    if (count <= 0) return;
    this.counts[kind] = (this.counts[kind] ?? 0) + count;
  }

  items(): DegradedItem[] {
    return (['style', 'media', 'structure'] as const)
      .filter((k) => (this.counts[k] ?? 0) > 0)
      .map((k) => ({ kind: k, count: this.counts[k] as number }));
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

/** 递归收集 attached/detached 下的子主题（忽略非对象项）。 */
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

function walkTopic(t: JsonTopic, d: DegradedCollector): XmindNode {
  // style：markers（M7a-T1：无对应的才计降级）/ labels / 主题与样式属性
  let icons: XmindIcons | undefined;
  if (Array.isArray(t.markers)) {
    const ids = t.markers.map((m) => (isTopicLike(m) && typeof (m as { markerId?: unknown }).markerId === 'string'
      ? ((m as { markerId: string }).markerId)
      : ''));
    const mapped = markersToIcons(ids);
    d.add('style', mapped.dropped);
    if (Object.keys(mapped.icons).length > 0) {
      icons = mapped.icons;
    }
  }
  if (Array.isArray(t.labels)) d.add('style', t.labels.length);
  if (t.style != null) d.add('style', 1);
  // media：图片 / 附件 / 备注内图片
  if (t.image != null) d.add('media', 1);
  if (Array.isArray(t.attachments)) d.add('media', t.attachments.length);
  // structure：漂浮主题（计整棵子树）/ 概要
  for (const dt of detachedTopicsOf(t)) {
    d.add('structure', countTopicTree(dt));
  }
  if (Array.isArray(t.summaries)) d.add('structure', t.summaries.length);

  // 备注：plain 优先，其次 realHTML 剥标签（realHTML 含 <img> 记 media，与 plain 是否在场无关——
  // XMind 常同时写两份同一备注）。
  const html = t.notes?.realHTML?.content;
  if (typeof html === 'string' && /<img[\s>]/i.test(html)) d.add('media', 1);
  const plain = t.notes?.plain?.content;
  const note =
    typeof plain === 'string' ? plain : typeof html === 'string' ? stripHtml(html) : undefined;

  // 描述（M7c-C1）：Gmind 自定义键读回（string 且非空才携带）；他方文件无此键零影响，
  // 也不计降级（本包自产自销的往返字段，见 types.ts XmindNode 头注）。
  const description = typeof t.description === 'string' && t.description !== '' ? t.description : undefined;

  const attached = t.children?.attached;
  return {
    title: typeof t.title === 'string' ? t.title : '',
    ...(note !== undefined ? { note } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(icons !== undefined ? { icons } : {}),
    children: (Array.isArray(attached) ? attached : []).filter(isTopicLike).map((c) => walkTopic(c, d)),
  };
}

function detachedTopicsOf(t: JsonTopic): JsonTopic[] {
  const detached = t.children?.detached;
  return (Array.isArray(detached) ? detached : []).filter(isTopicLike);
}

/**
 * 解析 content.json：sheet 数组取 [0]，其余 sheet 计 structure 降级；第一个 sheet
 * 缺 rootTopic（或数组为空）→ EMPTY；顶层不是数组 → CORRUPTED。
 */
export function parseContentJson(data: Uint8Array): { root: XmindNode; degraded: DegradedItem[] } {
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
  if (sheets.length > 1) d.add('structure', sheets.length - 1);
  if (first.theme != null) d.add('style', 1);
  return { root: walkTopic(first.rootTopic as JsonTopic, d), degraded: d.items() };
}
