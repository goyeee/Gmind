import type * as Y from 'yjs';
import { getNode, requireAliveNode } from './read';
import { addChild, sanitizeCustomForDoc, setCustomField, type AddChildOptions } from './operations';
import { ORIGIN_USER, type WriteOrigin } from './undo';
import { MAX_TEXT_LENGTH } from './constants';
import { GmindCoreError } from './errors';

/**
 * 剪贴板数据层（FR-EDT-009/010 内核）：子树 ⇄ 缩进大纲纯文本。
 * M1b 的浏览器剪贴板事件层组合这三个函数 + 系统剪贴板
 * （内部结构化格式用 JSON 序列化的 spec + 资源清单，不在此层）。
 */

/** 大纲/spec 节点：纯数据树（无 id），children 恒为数组（insertSpec 对缺省运行时容错为空）。 */
export interface SpecNode {
  text: string;
  children: SpecNode[];
  /**
   * 自定义列值（表格自定义列，结构化格式专用）：Record<colId, 值>——副本带值
   * 透传；粘贴时按**目标文档**当前 schema 过滤（未知列/值类型不符静默丢弃，
   * sanitizeCustomForDoc），列 schema 是 doc 级、不随粘贴创建。大纲纯文本路径
   * （subtreeToOutlineText → outlineToSpec）不携带本字段（文本行无法承载）。
   */
  custom?: Record<string, unknown>;
}

/**
 * 导出子树为 Tab 按层级缩进的纯文本大纲：子树根 0 个 Tab，每深一层加 1 个 Tab。
 * 存活校验同 addChild（缺失 NODE_NOT_FOUND / 墓碑 NODE_DELETED）。
 * 文档化限制：节点 text 内的换行折叠为单个空格——多行文本会破坏行级缩进语义，
 * 折叠是有损的（回车不保真，其余文本保真）。
 */
export function subtreeToOutlineText(doc: Y.Doc, id: string): string {
  requireAliveNode(doc, id);
  const lines: string[] = [];
  const walk = (nodeId: string, depth: number): void => {
    const node = getNode(doc, nodeId);
    if (!node) return; // 防御：requireAliveNode 已校验根，正常不可达
    lines.push('\t'.repeat(depth) + collapseNewlines(node.text));
    for (const childId of node.childIds) walk(childId, depth + 1);
  };
  walk(id, 0);
  return lines.join('\n');
}

/** 内部：换行（含 \r\n 与连续换行及其两侧空白）折叠为单个空格。 */
function collapseNewlines(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

/** 内部：量取一行的前导缩进层级。Tab 优先（含 Tab 即按 Tab 数）；否则空格数 ÷2 向下取整。 */
function indentLevel(line: string): number {
  const m = /^[ \t]*/.exec(line)![0];
  const tabs = (m.match(/\t/g) ?? []).length;
  if (tabs > 0) return tabs;
  const spaces = m.length;
  return Math.floor(spaces / 2);
}

/**
 * 解析缩进大纲为森林 spec（可能多个根）：Tab 或偶数空格缩进（空格数 ÷2 取整为层级）；
 * 跳过空行/纯空白行；入口先归一化 CRLF/CR 为 \n（避免行尾残留 \r）。
 * 栈内保存原始缩进层级：缩进跳深超过一层 → 挂到上一行节点的子级（钳制）；
 * 回退则弹栈挂到最近更浅祖先——弹空（含首行即缩进、后续同层行）成为森林新根。
 * 全程不抛错、确定。
 */
export function outlineToSpec(text: string): SpecNode[] {
  const forest: SpecNode[] = [];
  // 栈内为当前路径（自根至上一行），level 为该节点的原始缩进层级
  const stack: { node: SpecNode; level: number }[] = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (rawLine.trim() === '') continue;
    const node: SpecNode = { text: rawLine.replace(/^[ \t]+/, ''), children: [] };
    const level = indentLevel(rawLine);
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length === 0) forest.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level });
  }
  return forest;
}

/**
 * 将森林 spec 逐层插入 parent 下（FR-EDT-010 粘贴）：按 addChild 递归插入，
 * 返回全部新建节点 id（先序）。校验先于任何写入、拒绝即零变更——parent 校验同 addChild
 * （缺失 NODE_NOT_FOUND / 墓碑 NODE_DELETED），并对整个 spec 递归预校验
 * （任一节点 text 超 MAX_TEXT_LENGTH 抛 TEXT_TOO_LONG，同 setText 规则；children
 * 非数组 / custom 非对象抛 TypeError）。全量预校验后逐点 addChild：循环内仅剩不可能失败的写入，
 * 从而整次插入 all-or-nothing。index 为首个 spec 根在 parent children 中的位置，
 * 后续兄弟 spec 依次紧随其后。
 */
export function insertSpec(
  doc: Y.Doc,
  parentId: string,
  index: number,
  spec: SpecNode[],
  origin: WriteOrigin = ORIGIN_USER,
): string[] {
  requireAliveNode(doc, parentId);
  for (const rootSpec of spec) assertSpecValid(rootSpec);
  const ids: string[] = [];
  let cursor = index;
  for (const rootSpec of spec) {
    cursor = insertSpecNode(doc, parentId, cursor, rootSpec, ids, origin);
  }
  return ids;
}

/** 内部：递归预校验 spec 节点（text 长度、children/custom 形状）；违规即抛，未做任何写入。 */
function assertSpecValid(spec: SpecNode): void {
  if (spec.text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  if (spec.children !== undefined && !Array.isArray(spec.children)) {
    throw new TypeError('insertSpec: spec.children 必须为数组');
  }
  if (
    spec.custom !== undefined &&
    (typeof spec.custom !== 'object' || spec.custom === null || Array.isArray(spec.custom))
  ) {
    throw new TypeError('insertSpec: spec.custom 必须为对象');
  }
  for (const child of spec.children ?? []) assertSpecValid(child);
}

/** 内部：在 parent 的 index 处插入 spec 节点及全部后代，返回下一个兄弟的插入位置。 */
function insertSpecNode(
  doc: Y.Doc,
  parentId: string,
  index: number,
  spec: SpecNode,
  ids: string[],
  origin: WriteOrigin,
): number {
  const opts: AddChildOptions = { index, text: spec.text };
  const id = addChild(doc, parentId, opts, origin);
  ids.push(id);
  // 自定义列值透传（副本带值）：按目标文档 schema 过滤后经 setCustomField 落写
  //（过滤保证后续不抛——未知列/值类型不符已静默丢弃，与 repair 孤儿清理口径一致）。
  if (spec.custom !== undefined) {
    const sanitized = sanitizeCustomForDoc(doc, spec.custom);
    if (sanitized !== null) {
      for (const [colId, value] of Object.entries(sanitized)) {
        setCustomField(doc, id, colId, value, origin);
      }
    }
  }
  let childCursor = 0;
  for (const childSpec of spec.children ?? []) {
    childCursor = insertSpecNode(doc, id, childCursor, childSpec, ids, origin);
  }
  return index + 1;
}
