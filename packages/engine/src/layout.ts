/**
 * 三结构确定性布局（mindmap 左右分布 / logic 向右 / org 向下）— M1b Task 4。
 *
 * 绑定裁决（FR-EDT-011/017）：
 * - 纯函数、全序确定：遍历一律按文档序（DocReader.childrenIds），无随机、无时钟，
 *   同一输入恒得同一输出（金样逐字节锁定）。
 * - 从 'root' 收集存活树：getNode/childrenIds 语义；deleted 节点连同其子树整体跳过；
 *   折叠节点按叶子渲染（不下钻），collapsedCounts[id] = 被隐藏的存活后代数。
 * - 盒子经 measureNodeBox：图标按键数预留 iconSlotWidth 槽位；样式由 styleOf 提供
 *   （缺省按深度取主题分级派生：根 / 一级 / 二级及更深，字号/字重/字族全由主题 token 驱动）；
 *   节点含图片时盒高计入图片高度（T6 carry-in 裁决，Task 12 落地：h = max(文本高, 图高)）。
 * - 垂直（mindmap/logic）：子树高 = max(自身高, Σ子树高 + V_GAP×(n-1))；一节点之子
 *   自 parentY + parentH/2 − 子带高/2 起顶对齐堆叠，父垂直居中于子带（经典脑图）。
 * - 水平（org）：子树宽 = max(自身宽, Σ子树宽 + H_GAP×(n-1))；兄弟水平排布，
 *   父水平居中于子带上方，层间 V_GAP。
 * - mindmap 分侧（绑定规则，fix r1 改预检查/断行语义）：一级子树按文档序依次装箱——
 *   分配前判断累计 + 当前子树高是否超过总高之半，超过则自该子树起全部 LEFT，
 *   否则 RIGHT（两等高分支得 1 右 1 左，符合惯例）；首个子树恒 RIGHT（断行语义
 *   不留空行，单分支布局在右）；两侧各自自上而下、保文档序；更深后代恒与其一级
 *   祖先同侧。
 * - 边锚点：mindmap/logic 取父/子相向侧中点，bezier 控制点水平外伸
 *   max(60, dx×0.5)；org 取父下中点/子上中点，elbow。折叠节点无子边。
 * - 根盒中心恒为 (0,0)；输出 bbox 宽高为全部节点盒的极差。
 */
import { measureNodeBox } from './measure';
import { themeTextStyleOf } from './themes';
import type {
  DocReader,
  EdgeRoute,
  LayoutResult,
  MeasureAdapter,
  NodeBox,
  Point,
  StructureType,
  ThemeTokens,
  TextStyle,
} from './types';

/** bezier 控制点水平外伸下限；超出时取 dx×0.5（Task 4 绑定解释）。 */
const BEZIER_MIN_EXTEND = 60;

/** 布局内部树节点：盒子尺寸收集期确定，坐标放置期回填。 */
interface LayoutNode {
  id: string;
  depth: number;
  w: number;
  h: number;
  x: number;
  y: number;
  side: NodeBox['side'];
  children: LayoutNode[];
  /** 仅折叠节点有：被隐藏的存活后代数（可为 0）。 */
  collapsedCount?: number;
  /** 子树带高：max(自身高, Σ子带高 + V_GAP×(n-1))。 */
  subtreeH: number;
  /** 子树带宽：max(自身宽, Σ子带宽 + H_GAP×(n-1))。 */
  subtreeW: number;
}

export interface LayoutOptions {
  structure: StructureType;
  theme: ThemeTokens;
  measure: MeasureAdapter;
  /** 缺省时按深度取主题派生样式（根/一级/二级+，字号/字重/字族全由 theme token 驱动）。 */
  styleOf?: (id: string, depth: number) => TextStyle;
}

/** 统计折叠节点之下被隐藏的存活后代数（跳过墓碑；visited 防环）。 */
function countHiddenDescendants(reader: DocReader, id: string): number {
  let count = 0;
  const seen = new Set<string>([id]);
  const walk = (nodeId: string): void => {
    for (const childId of reader.childrenIds(nodeId)) {
      if (seen.has(childId)) continue;
      seen.add(childId);
      const snap = reader.getNode(childId);
      if (!snap || snap.deleted) continue;
      count += 1;
      walk(childId);
    }
  };
  walk(id);
  return count;
}

/** 从 'root' 收集存活树并测量盒子（先序；visited 防御重复/环）。 */
function collectTree(
  reader: DocReader,
  theme: ThemeTokens,
  measure: MeasureAdapter,
  styleOf: (id: string, depth: number) => TextStyle,
): LayoutNode | null {
  const visited = new Set<string>();
  const build = (id: string, depth: number): LayoutNode | null => {
    if (visited.has(id)) return null;
    visited.add(id);
    const snap = reader.getNode(id);
    if (!snap || snap.deleted) return null;
    const iconCount = snap.icons ? Object.keys(snap.icons).length : 0;
    // T6 carry-in 裁决（Task 12 落地）：盒高计入图片高度。图片尺寸就在树遍历已取的
    // snap 上（reader.getNode），无需新增布局入参——直接作为测量选项下传。
    const image = snap.image ?? null;
    const box = measureNodeBox(snap.text, styleOf(id, depth), theme, {
      adapter: measure,
      iconCount,
      imageH: image ? image.h : undefined,
      imageW: image ? image.w : undefined,
    });
    const node: LayoutNode = {
      id,
      depth,
      w: box.w,
      h: box.h,
      x: 0,
      y: 0,
      side: 'right',
      children: [],
      subtreeH: box.h,
      subtreeW: box.w,
    };
    if (snap.collapsed) {
      // 折叠节点按叶子：不下钻，仅统计隐藏后代。
      node.collapsedCount = countHiddenDescendants(reader, id);
      return node;
    }
    for (const childId of reader.childrenIds(id)) {
      const child = build(childId, depth + 1);
      if (child) node.children.push(child);
    }
    return node;
  };
  return build('root', 0);
}

/** 自底向上累加子树带高/宽（叶 = 自身盒尺寸）。 */
function computeMetrics(node: LayoutNode, theme: ThemeTokens): void {
  if (node.children.length === 0) {
    node.subtreeH = node.h;
    node.subtreeW = node.w;
    return;
  }
  let sumH = 0;
  let sumW = 0;
  for (const child of node.children) {
    computeMetrics(child, theme);
    sumH += child.subtreeH;
    sumW += child.subtreeW;
  }
  sumH += theme.V_GAP * (node.children.length - 1);
  sumW += theme.H_GAP * (node.children.length - 1);
  node.subtreeH = Math.max(node.h, sumH);
  node.subtreeW = Math.max(node.w, sumW);
}

/** 子带总高/总宽（兄弟带间距已计入）。 */
function childrenHeight(children: LayoutNode[], vGap: number): number {
  let sum = 0;
  for (const child of children) sum += child.subtreeH;
  return children.length > 0 ? sum + vGap * (children.length - 1) : 0;
}
function childrenWidth(children: LayoutNode[], hGap: number): number {
  let sum = 0;
  for (const child of children) sum += child.subtreeW;
  return children.length > 0 ? sum + hGap * (children.length - 1) : 0;
}

/**
 * mindmap 分侧（预检查，断行语义）：分配前判断累计 + 当前子树高是否超过总高之半，
 * 超过则自该子树起全部 LEFT，否则 RIGHT；首个子树恒 RIGHT（断行不留空行，
 * 单分支/首支超半时仍居右）。保序：右侧取文档序前段，左侧取其余。
 */
function assignMindmapSides(children: LayoutNode[], theme: ThemeTokens): Array<'left' | 'right'> {
  const total = childrenHeight(children, theme.V_GAP);
  const half = total / 2;
  let cum = 0;
  let flipped = false;
  return children.map((child, i) => {
    if (flipped) return 'left';
    if (i > 0 && cum + child.subtreeH > half) {
      flipped = true;
      return 'left';
    }
    cum += child.subtreeH;
    return 'right';
  });
}

/** 同侧子树横向延伸：子带以父垂直中线为带心顶对齐堆叠，层级间 H_GAP。 */
function placeHorizontal(node: LayoutNode, side: 'left' | 'right', theme: ThemeTokens): void {
  let cursor = node.y + node.h / 2 - childrenHeight(node.children, theme.V_GAP) / 2;
  for (const child of node.children) {
    child.x = side === 'right' ? node.x + node.w + theme.H_GAP : node.x - theme.H_GAP - child.w;
    child.y = cursor + child.subtreeH / 2 - child.h / 2;
    child.side = side;
    placeHorizontal(child, side, theme);
    cursor += child.subtreeH + theme.V_GAP;
  }
}

/** 根的一级子树：mindmap 分侧 / logic 全右；统一一条自上而下的文档序带。 */
function placeRootChildren(root: LayoutNode, structure: Exclude<StructureType, 'org'>, theme: ThemeTokens): void {
  const sides =
    structure === 'logic'
      ? root.children.map((): 'left' | 'right' => 'right')
      : assignMindmapSides(root.children, theme);
  let cursor = root.y + root.h / 2 - childrenHeight(root.children, theme.V_GAP) / 2;
  root.children.forEach((child, i) => {
    const side = sides[i] as 'left' | 'right';
    child.x = side === 'right' ? root.x + root.w + theme.H_GAP : root.x - theme.H_GAP - child.w;
    child.y = cursor + child.subtreeH / 2 - child.h / 2;
    child.side = side;
    placeHorizontal(child, side, theme);
    cursor += child.subtreeH + theme.V_GAP;
  });
}

/** org：兄弟水平排布（子带以父水平中线为带心），父居子带上方，层间 V_GAP。 */
function placeOrg(node: LayoutNode, theme: ThemeTokens): void {
  let cursor = node.x + node.w / 2 - childrenWidth(node.children, theme.H_GAP) / 2;
  for (const child of node.children) {
    child.x = cursor + child.subtreeW / 2 - child.w / 2;
    child.y = node.y + node.h + theme.V_GAP;
    child.side = 'down';
    placeOrg(child, theme);
    cursor += child.subtreeW + theme.H_GAP;
  }
}

/** 亲子边：mindmap/logic 相向侧中点 + bezier 控制点；org 下/上中点 + elbow。 */
function makeEdge(parent: LayoutNode, child: LayoutNode, structure: StructureType): EdgeRoute {
  const id = `${parent.id}->${child.id}`;
  if (structure === 'org') {
    return {
      id,
      from: { x: parent.x + parent.w / 2, y: parent.y + parent.h },
      to: { x: child.x + child.w / 2, y: child.y },
      kind: 'elbow',
    };
  }
  const right = child.side !== 'left';
  const from: Point = { x: right ? parent.x + parent.w : parent.x, y: parent.y + parent.h / 2 };
  const to: Point = { x: right ? child.x : child.x + child.w, y: child.y + child.h / 2 };
  const extend = Math.max(BEZIER_MIN_EXTEND, Math.abs(to.x - from.x) * 0.5);
  return {
    id,
    from,
    to,
    kind: 'bezier',
    controls: [
      { x: from.x + (right ? extend : -extend), y: from.y },
      { x: to.x + (right ? -extend : extend), y: to.y },
    ],
  };
}

function buildEdges(node: LayoutNode, structure: StructureType, out: EdgeRoute[]): void {
  for (const child of node.children) {
    out.push(makeEdge(node, child, structure));
    buildEdges(child, structure, out);
  }
}

/** 先序展平（根先、文档序），回填折叠计数与 parentId（根无 parentId；Task 8 只增不改）。 */
function flatten(
  node: LayoutNode,
  depth: number,
  parentId: string | undefined,
  boxes: NodeBox[],
  collapsed: Map<string, number>,
): void {
  boxes.push({ id: node.id, x: node.x, y: node.y, w: node.w, h: node.h, side: node.side, depth, parentId });
  if (node.collapsedCount !== undefined) collapsed.set(node.id, node.collapsedCount);
  for (const child of node.children) flatten(child, depth + 1, node.id, boxes, collapsed);
}

/**
 * 三结构确定性布局。同一 (reader 快照, opts) 恒得同一 LayoutResult；
 * 根盒中心 (0,0)，坐标可为负；bbox 宽高为节点盒极差（空树为 0）。
 */
export function layout(reader: DocReader, opts: LayoutOptions): LayoutResult {
  const { structure, theme, measure } = opts;
  // 缺省样式：主题分级派生（Task 5 主题系统；页面层闭合文档传 styleOf 以叠加 nodeStyle）。
  const styleOf = opts.styleOf ?? ((_id: string, depth: number) => themeTextStyleOf(theme, depth));

  const root = collectTree(reader, theme, measure, styleOf);
  if (!root) return { nodes: [], edges: [], collapsedCounts: new Map(), width: 0, height: 0 };
  computeMetrics(root, theme);

  if (structure === 'org') {
    root.x = -root.w / 2;
    root.y = -root.h / 2;
    root.side = 'down';
    placeOrg(root, theme);
  } else if (structure === 'mindmap' || structure === 'logic') {
    root.x = -root.w / 2;
    root.y = -root.h / 2;
    root.side = 'right';
    placeRootChildren(root, structure, theme);
  } else {
    throw new Error(`layout: 未知结构类型 ${String(structure)}`);
  }

  const nodes: NodeBox[] = [];
  const collapsedCounts = new Map<string, number>();
  flatten(root, 0, undefined, nodes, collapsedCounts);
  const edges: EdgeRoute[] = [];
  buildEdges(root, structure, edges);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y < minY) minY = n.y;
    if (n.y + n.h > maxY) maxY = n.y + n.h;
  }

  return {
    nodes,
    edges,
    collapsedCounts,
    width: nodes.length > 0 ? maxX - minX : 0,
    height: nodes.length > 0 ? maxY - minY : 0,
  };
}
