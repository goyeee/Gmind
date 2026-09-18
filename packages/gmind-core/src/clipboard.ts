import type * as Y from 'yjs';
import { getNode, requireAliveNode } from './read';
import { addChild, type AddChildOptions } from './operations';
import { ORIGIN_USER, type WriteOrigin } from './undo';

/**
 * 剪贴板数据层（FR-EDT-009/010 内核）：子树 ⇄ 缩进大纲纯文本。
 * M1b 的浏览器剪贴板事件层组合这三个函数 + 系统剪贴板
 * （内部结构化格式用 JSON 序列化的 spec + 资源清单，不在此层）。
 */

/** 大纲/spec 节点：纯数据树（无 id），children 恒为数组（insertSpec 对缺省运行时容错为空）。 */
export interface SpecNode {
  text: string;
  children: SpecNode[];
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
 * 跳过空行/纯空白行。反常缩进不抛错、确定性钳制：缩进跳深超过一层 → 挂到上一行节点的
 * 子级；回退跳过若干层级 → 弹栈挂到最近合法祖先，弹空则成为森林新根。
 */
export function outlineToSpec(text: string): SpecNode[] {
  const forest: SpecNode[] = [];
  // 栈内为当前路径（自根至上一行），level 为该节点的实际（钳制后）层级
  const stack: { node: SpecNode; level: number }[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.trim() === '') continue;
    const node: SpecNode = { text: rawLine.replace(/^[ \t]+/, ''), children: [] };
    const level = indentLevel(rawLine);
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length === 0) forest.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ node, level: stack.length === 0 ? 0 : stack[stack.length - 1].level + 1 });
  }
  return forest;
}

/**
 * 将森林 spec 逐层插入 parent 下（FR-EDT-010 粘贴）：按 addChild 递归插入，
 * 返回全部新建节点 id（先序）。parent 校验同 addChild 且先于任何写入
 * （缺失 NODE_NOT_FOUND / 墓碑 NODE_DELETED，拒绝即零变更）；
 * index 为首个 spec 根在 parent children 中的位置，后续兄弟 spec 依次紧随其后。
 */
export function insertSpec(
  doc: Y.Doc,
  parentId: string,
  index: number,
  spec: SpecNode[],
  origin: WriteOrigin = ORIGIN_USER,
): string[] {
  requireAliveNode(doc, parentId);
  const ids: string[] = [];
  let cursor = index;
  for (const rootSpec of spec) {
    cursor = insertSpecNode(doc, parentId, cursor, rootSpec, ids, origin);
  }
  return ids;
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
  let childCursor = 0;
  for (const childSpec of spec.children ?? []) {
    childCursor = insertSpecNode(doc, id, childCursor, childSpec, ids, origin);
  }
  return index + 1;
}
