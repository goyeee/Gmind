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
 * - mindmap 分侧（逆时针定侧，需求方 2026-09-30 裁定，高度半分逻辑退役）：root 直接
 *   子级有持久 side（core addChild/setNodeSide 写入、快照透传）→ 用持久值；无 side
 *   按文档序计数兜底（index 0-2 → right、≥3 → left，即第 1~3 个右、第 4 个起左——
 *   与 core addChild 定侧配额同值）。混合文档逐节点独立判定；更深后代恒与其一级祖先
 *   同侧；logic 全右、org 向下。
 * - 顺时针落位（需求方 2026-10-09 裁定）：root 一级子树左右两带各自独立垂直居中于
 *   root 中线；右列 = 文档序自上而下，左列 = 文档序自下而上（视觉反序——先建的沉
 *   左列底、后建的往左上角长，围绕中心顺时针）。logic 全右 = 单条右带（行为不变）。
 * - 边锚点：mindmap/logic 父侧沿父边向子偏移（钳制父盒内）、子侧取相向边中点，
 *   bezier 控制点水平外伸 max(60, dx×0.5)；org 取父下中点/子上中点，elbow。折叠节点无子边。
 * - 根盒中心恒为 (0,0)；输出 bbox 宽高为全部节点盒的极差。
 */
import { markerCountOf } from './markers';
import { measureNodeBox } from './measure';
// 概要标签避让/chip 几何（M7b → 2026-10-01 反馈任务 1）：字号/基线偏移/chip 矩形
// 尺寸与渲染单源（render 不反向依赖本模块，无环；export.ts 同款先例——导出边界也
// 消费 render 常量）。
import {
  SUMMARY_CHIP_H,
  SUMMARY_CHIP_PAD_X,
  SUMMARY_FONT_SIZE,
} from './render';
import { taskRowSlotsOf } from './taskvisual';
import { themeTextStyleOf } from './themes';
import type {
  DocReader,
  EdgeRoute,
  LayoutResult,
  MeasureAdapter,
  NodeBox,
  Point,
  StructureType,
  SummaryBox,
  ThemeTokens,
  TextStyle,
} from './types';

/**
 * 右侧常驻配额（逆时针定侧，需求方 2026-09-30）：无持久 side 的 root 直接子级按
 * 文档序计数兜底——index 0-2 → right、≥3 → left。与 @gmind/core addChild 定侧配额
 * 同值（引擎不依赖 core，改动需两处同步）。
 */
const ROOT_SIDE_RIGHT_QUOTA = 3;

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
  /**
   * 持久侧别（逆时针定侧）：core NodeSnapshot.side 透传（left/right 之外的值按
   * 缺省处理）。仅 root 直接子级被 assignMindmapSides 消费；更深节点的该字段忽略
   * （侧别恒继承一级祖先）。
   */
  persistedSide?: 'left' | 'right';
  /** 仅折叠节点有：被隐藏的存活后代数（可为 0）。 */
  collapsedCount?: number;
  /** 描述行（M7c-C1）：测量截断后的单行（无描述缺省，几何零参与）。 */
  descLine?: string;
  /** 断行行集（长文本溢出修复）：测量贪心断行结果（未断行缺省），随盒透传渲染。 */
  lines?: string[];
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
  /**
   * 简洁模式（M7b 补课，mindgrid 账号级显示偏好）：true 时测量以紧凑口径执行
   * （描述行不产出、任务行槽位不计入盒高/宽，见 measureNodeBox compact 选项——
   * 分支收口在测量侧，本模块只透传）；渲染侧内联进度走 SceneInput.compact。
   * 缺省 false = 原路径，布局输出逐字节不变（金样锁定）。
   */
  compact?: boolean;
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
  compact: boolean,
): LayoutNode | null {
  const visited = new Set<string>();
  const build = (id: string, depth: number): LayoutNode | null => {
    if (visited.has(id)) return null;
    visited.add(id);
    const snap = reader.getNode(id);
    if (!snap || snap.deleted) return null;
    // M7b-W1 多值标记：槽位数 = 各组值数组元素总数（markerCountOf 防御非数组形状）。
    const iconCount = markerCountOf(snap.icons);
    // T6 carry-in 裁决（Task 12 落地）：盒高计入图片高度。图片尺寸就在树遍历已取的
    // snap 上（reader.getNode），无需新增布局入参——直接作为测量选项下传。
    const image = snap.image ?? null;
    // M7c-C2 任务信息行（只增不改）：槽位判定需要「有无存活子节点」（父节点恒
    // 预留 Σ 进度槽），故先递归建子树再测量。测量与递归无数据耦合，顺序调换
    // 不影响既有输出——无任务信息时 taskRow 为 undefined，measureNodeBox 选项
    // 与旧版逐项一致（金样锁定）。折叠节点按叶子口径（隐藏子树不参与）。
    const children: LayoutNode[] = [];
    let collapsedCount: number | undefined;
    if (snap.collapsed) {
      // 折叠节点按叶子：不下钻，仅统计隐藏后代。
      collapsedCount = countHiddenDescendants(reader, id);
    } else {
      for (const childId of reader.childrenIds(id)) {
        const child = build(childId, depth + 1);
        if (child) children.push(child);
      }
    }
    const taskRow = taskRowSlotsOf(snap.task, children.length > 0, depth);
    // 描述（M7c-C1，只增不改）：快照 description 透传测量（非空时第二行 + 高度自适应，
    // 截断产物 box.descLine 随盒输出）。缺省时选项与旧版逐项一致（金样锁定）。
    // 简洁模式（M7b 补课）：原值照传，紧凑口径由测量侧 compact 分支收口（描述行
    // 不产出、任务行槽位不计高宽，内联进度槽宽代偿）。
    const box = measureNodeBox(snap.text, styleOf(id, depth), theme, {
      adapter: measure,
      iconCount,
      imageH: image ? image.h : undefined,
      imageW: image ? image.w : undefined,
      taskRow,
      description: snap.description,
      compact,
    });
    // 断行行集（长文本溢出修复，只增不改）：测量行集与显式 '\n' 分行不一致（发生
    // 贪心断行）才随盒透传——渲染 tspan 行结构单源 = 测量；未断行字段不出现，
    // 既有盒输出逐字节不变（金样锁定）。
    const rawLines = snap.text.split('\n');
    const wrapped =
      box.lines.length !== rawLines.length || box.lines.some((line, i) => line !== rawLines[i]);
    // 持久侧别（逆时针定侧）：left/right 之外的值（远端坏数据）按缺省处理。
    const persistedSide: 'left' | 'right' | undefined =
      snap.side === 'left' || snap.side === 'right' ? snap.side : undefined;
    const node: LayoutNode = {
      id,
      depth,
      w: box.w,
      h: box.h,
      x: 0,
      y: 0,
      side: 'right',
      children,
      subtreeH: box.h,
      subtreeW: box.w,
      ...(box.descLine !== undefined ? { descLine: box.descLine } : {}),
      ...(wrapped ? { lines: box.lines } : {}),
      ...(persistedSide !== undefined ? { persistedSide } : {}),
    };
    if (collapsedCount !== undefined) node.collapsedCount = collapsedCount;
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
 * mindmap 分侧（逆时针定侧，需求方 2026-09-30）：root 直接子级侧别 =
 * ① 持久 side（core addChild 自动定侧 / setNodeSide 手动调整写入）优先；
 * ② 无持久 side 按文档序计数兜底：index 0-2 → right、≥3 → left（第 1~3 个右、
 *    第 4 个起左，与 core addChild 定侧配额同值——引擎不依赖 core，改动需两处同步）。
 * 旧「累计子树带高过半即翻左」的高度半分逻辑退役：侧别不再随几何漂移，布局恒
 * 尊重文档持久状态；混合文档（部分有 side）逐节点独立判定，互不影响。
 * 注意：本函数只决定侧别；y 排布由 placeRootChildren 按左右两带独立结算（左列视觉
 * 反序，2026-10-09 顺时针落位）。
 */
function assignMindmapSides(children: LayoutNode[]): Array<'left' | 'right'> {
  return children.map((child, i) => child.persistedSide ?? (i < ROOT_SIDE_RIGHT_QUOTA ? 'right' : 'left'));
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

/**
 * 根的一级子树：mindmap 左右两带独立垂直居中于 root 中线（顺时针落位，需求方
 * 2026-10-09）——右列 = 文档序自上而下、左列 = 文档序自下而上（视觉反序，先建的沉
 * 列底、后建的往列顶长）；logic 全右退化为单条右带（文档序自上而下，行为与旧共享
 * 单带一致）。更深后代恒与一级祖先同侧（placeHorizontal 递归传导）。
 */
function placeRootChildren(root: LayoutNode, structure: Exclude<StructureType, 'org'>, theme: ThemeTokens): void {
  const sides =
    structure === 'logic'
      ? root.children.map((): 'left' | 'right' => 'right')
      : assignMindmapSides(root.children);
  const rightChildren: LayoutNode[] = [];
  const leftChildren: LayoutNode[] = [];
  root.children.forEach((child, i) => {
    (sides[i] === 'right' ? rightChildren : leftChildren).push(child);
  });
  placeRootBand(root, rightChildren, 'right', theme);
  // 左列视觉序 = 文档序倒排（reverse 生成新数组，不动 root.children 文档序）。
  placeRootBand(root, [...leftChildren].reverse(), 'left', theme);
}

/** 单侧一级子带：以 root 垂直中线为带心自上而下堆叠（bandChildren 已按该侧视觉序排列）。 */
function placeRootBand(root: LayoutNode, bandChildren: LayoutNode[], side: 'left' | 'right', theme: ThemeTokens): void {
  let cursor = root.y + root.h / 2 - childrenHeight(bandChildren, theme.V_GAP) / 2;
  for (const child of bandChildren) {
    child.x = side === 'right' ? root.x + root.w + theme.H_GAP : root.x - theme.H_GAP - child.w;
    child.y = cursor + child.subtreeH / 2 - child.h / 2;
    child.side = side;
    placeHorizontal(child, side, theme);
    cursor += child.subtreeH + theme.V_GAP;
  }
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

/** 亲子边：mindmap/logic 父侧锚点沿父边向子偏移 + bezier；org 下/上中点 + elbow。 */
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
  const parentMidY = parent.y + parent.h / 2;
  const childMidY = child.y + child.h / 2;
  // 父侧锚点向子方向偏移（钳制在父盒侧边内，留 2px 不贴角）：同一父的多条边
  // 从侧边不同点扇出——修复全部边共用父中心横线导致的重叠/视觉穿插
  // （2026-09-27 GUI 走查问瓆 2：连线乱、交叉）。
  const bias = Math.max(
    -parent.h / 2 + 2,
    Math.min(parent.h / 2 - 2, (childMidY - parentMidY) * 0.5),
  );
  const from: Point = { x: right ? parent.x + parent.w : parent.x, y: parentMidY + bias };
  const to: Point = { x: right ? child.x : child.x + child.w, y: childMidY };
  // 控制点外伸恒取 dx×0.5（c1.x 落 to.x、c2.x 落 from_x）：x(t) 保持在
  // [from.x, to.x] 凸包内单调行进、绝不折返。旧实现 max(60, dx×0.5) 在列距
  // 小于 120（如 H_GAP=40）时控制点互相越过对端端点，曲线先冲过头再折回，
  // 多边叠加成涡流状交叉（2026-09-27 用户截图实锤，第二次连线修复）。
  const extend = Math.abs(to.x - from.x) * 0.5;
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

/**
 * 概要几何常量。
 * - 横括线（bracket 形态，M6 Task 6；跨侧概要 / org 结构沿用）：片段盒下方 12px、
 *   每侧外扩 8px。
 * - 竖向花括号（brace 形态，2026-10-01 需求方反馈任务 1 企微对标；同侧概要）：
 *   V_EXTEND=带上下各外扩 6px（成员盒带跨度含外扩）；BRACE_GAP=同侧最外成员盒缘
 *   到括号脊线的间隙 6px；BRACE_DEPTH=脊线到尖端探出深 10px。
 * - 标签 chip：LABEL_GAP_OUT=尖端到 chip 矩形的间隙 6px（chip 尺寸常量单源在
 *   render.ts：SUMMARY_CHIP_H / SUMMARY_CHIP_PAD_X）。
 */
const SUMMARY_GAP_Y = 12;
const SUMMARY_OUT_X = 8;
const SUMMARY_V_EXTEND = 6;
const SUMMARY_BRACE_GAP = 6;
const SUMMARY_BRACE_DEPTH = 10;
const SUMMARY_LABEL_GAP_OUT = 6;

/**
 * 占位矩形与节点盒求交（M7b 引入，R9c 让位循环共用判定）：返回与 [l,r]×[top,bottom]
 * 相交的节点盒（浮点比较用严格不等，边界相接不算相交——与 selection 的「完全让位」
 * 同口径）。
 */
function summaryLabelHits(boxes: NodeBox[], l: number, r: number, top: number, bottom: number): NodeBox[] {
  return boxes.filter((b) => b.y < bottom && b.y + b.h > top && b.x < r && b.x + b.w > l);
}

/** 外向让位公共骨架：占位带 [l,r]×[top,bottom] 与节点盒相交则沿 dir 跳过遮挡盒
 *  外缘再留 gap，循环至完全让位。每次迭代至少越过一盒边缘、盒数有限必终止；防御
 *  性 guard（next 不再前进时原地收手）保证浮点异常下输出仍确定。 */
function yieldOutward(
  start: number,
  dir: 'left' | 'right',
  width: number,
  top: number,
  bottom: number,
  boxes: NodeBox[],
  gap: number,
): number {
  let pos = start;
  for (;;) {
    const l = dir === 'right' ? pos : pos - width;
    const r = dir === 'right' ? pos + width : pos;
    const blocking = summaryLabelHits(boxes, l, r, top, bottom);
    if (blocking.length === 0) break;
    const next =
      dir === 'right'
        ? Math.max(...blocking.map((b) => b.x + b.w)) + gap
        : Math.min(...blocking.map((b) => b.x)) - gap;
    if (dir === 'right' ? next <= pos : next >= pos) break;
    pos = next;
  }
  return pos;
}

/**
 * 同侧概要的企微竖向花括号几何（2026-10-01 需求方反馈任务 1）：
 * - 带（括号高度）：成员盒 y 极差上下各外扩 SUMMARY_V_EXTEND；
 * - 括号：脊线起于同侧最外成员盒缘 + SUMMARY_BRACE_GAP，深 SUMMARY_BRACE_DEPTH
 *   （右列 → 脊线贴锚定盒 x=0、尖端 x=w；左列镜像，绘制范围恒 [x, x+w]）；
 * - 标签 chip：挂在尖端外侧 SUMMARY_LABEL_GAP_OUT 处，垂直居中于带；文本宽经
 *   测量适配器实测（字号单源 SUMMARY_FONT_SIZE、字族取主题根级 token 近似），
 *   chip 全宽 = labelW + 2×SUMMARY_CHIP_PAD_X；
 * - 碰撞让位（R9c 外向循环同款）：括号带与 chip 矩形各自沿外向逐盒让位至与任何
 *   节点盒不相交（更深层节点横向压过外置位时外推，见 yieldOutward）。
 * 输出：brace 朝向 + 锚定盒 (x,y,w,h) + chip 文本锚（labelX/labelAnchor/labelW）。
 */
function braceSummaryOf(
  s: { id: string; label: string },
  members: NodeBox[],
  side: 'left' | 'right',
  boxes: NodeBox[],
  measure: MeasureAdapter,
  theme: ThemeTokens,
): SummaryBox {
  const top = Math.min(...members.map((b) => b.y)) - SUMMARY_V_EXTEND;
  const bottom = Math.max(...members.map((b) => b.y + b.h)) + SUMMARY_V_EXTEND;
  const h = bottom - top;
  const labelW = measure.measureTextLine(s.label, {
    fontSize: SUMMARY_FONT_SIZE,
    fontWeight: 400,
    fontFamily: theme.rootFontFamily,
  });
  const chipW = labelW + SUMMARY_CHIP_PAD_X * 2;
  const chipTop = (top + bottom) / 2 - SUMMARY_CHIP_H / 2;
  const chipBottom = (top + bottom) / 2 + SUMMARY_CHIP_H / 2;
  if (side === 'right') {
    // 右列概要：括号在成员右侧、开口朝左（尖朝右），chip 在括号右旁。
    const spine = yieldOutward(
      Math.max(...members.map((b) => b.x + b.w)) + SUMMARY_BRACE_GAP,
      'right',
      SUMMARY_BRACE_DEPTH,
      top,
      bottom,
      boxes,
      SUMMARY_BRACE_GAP,
    );
    const chipLeft = yieldOutward(
      spine + SUMMARY_BRACE_DEPTH + SUMMARY_LABEL_GAP_OUT,
      'right',
      chipW,
      chipTop,
      chipBottom,
      boxes,
      SUMMARY_LABEL_GAP_OUT,
    );
    return {
      id: s.id,
      x: spine,
      y: top,
      w: SUMMARY_BRACE_DEPTH,
      h,
      label: s.label,
      brace: 'right',
      labelX: chipLeft + SUMMARY_CHIP_PAD_X - spine,
      labelAnchor: 'start',
      labelW,
    };
  }
  // 左列镜像：括号在成员左侧、开口朝右（尖朝左），chip 在括号左旁。
  const spine = yieldOutward(
    Math.min(...members.map((b) => b.x)) - SUMMARY_BRACE_GAP,
    'left',
    SUMMARY_BRACE_DEPTH,
    top,
    bottom,
    boxes,
    SUMMARY_BRACE_GAP,
  );
  const chipRight = yieldOutward(
    spine - SUMMARY_BRACE_DEPTH - SUMMARY_LABEL_GAP_OUT,
    'left',
    chipW,
    chipTop,
    chipBottom,
    boxes,
    SUMMARY_LABEL_GAP_OUT,
  );
  return {
    id: s.id,
    x: spine - SUMMARY_BRACE_DEPTH,
    y: top,
    w: SUMMARY_BRACE_DEPTH,
    h,
    label: s.label,
    brace: 'left',
    labelX: chipRight - SUMMARY_CHIP_PAD_X - (spine - SUMMARY_BRACE_DEPTH),
    labelAnchor: 'end',
    labelW,
  };
}

/**
 * 概要盒（M6 Task 6 → 2026-10-01 需求方反馈任务 1 企微对标改版）：按成员盒侧别
 * 分派形态——
 * - 成员盒全左/全右（同侧概要）→ braceSummaryOf 竖向花括号（企微式：括号在成员
 *   列外侧、尖端旁挂标签 chip，双外向让位循环）；
 * - 跨侧概要（成员跨左右列）/ org（side='down'，无左右列概念）→ 旧横括线退化
 *   形态（片段包围盒外扩：x=左-8、w=宽+16、y=底+12），标签居中（无锚点字段，
 *   输出与旧版逐字节一致）。取舍见 types.ts SummaryBox 头注。
 * 成员盒全缺（墓碑/折叠隐藏）→ 不输出；输出按 id 升序（确定性）。
 */
function buildSummaries(
  reader: DocReader,
  boxes: NodeBox[],
  measure: MeasureAdapter,
  theme: ThemeTokens,
): SummaryBox[] {
  const entries = reader.summaries?.() ?? [];
  if (entries.length === 0) return [];
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  const out: SummaryBox[] = [];
  for (const s of entries) {
    const members: NodeBox[] = [];
    for (const nodeId of s.nodeIds) {
      const b = boxById.get(nodeId);
      if (b) members.push(b);
    }
    if (members.length === 0) continue;
    const side = members[0]?.side;
    const sameSide =
      side === 'left' || side === 'right' ? (members.every((m) => m.side === side) ? side : null) : null;
    if (sameSide !== null) {
      out.push(braceSummaryOf(s, members, sameSide, boxes, measure, theme));
      continue;
    }
    const minX = Math.min(...members.map((b) => b.x));
    const maxR = Math.max(...members.map((b) => b.x + b.w));
    const maxB = Math.max(...members.map((b) => b.y + b.h));
    out.push({
      id: s.id,
      x: minX - SUMMARY_OUT_X,
      y: maxB + SUMMARY_GAP_Y,
      w: maxR - minX + SUMMARY_OUT_X * 2,
      label: s.label,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** 先序展平（根先、文档序），回填折叠计数与 parentId（根无 parentId；Task 8 只增不改）。 */
function flatten(
  node: LayoutNode,
  depth: number,
  parentId: string | undefined,
  boxes: NodeBox[],
  collapsed: Map<string, number>,
): void {
  boxes.push({
    id: node.id,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    side: node.side,
    depth,
    parentId,
    // 描述行（M7c-C1，只增不改）：无描述时字段不出现（金样逐字节不变）。
    ...(node.descLine !== undefined ? { descLine: node.descLine } : {}),
    // 断行行集（长文本溢出修复，只增不改）：发生贪心断行才随盒输出（渲染直绘，
    // 行结构单源 = 测量）；未断行字段不出现（金样逐字节不变）。
    ...(node.lines !== undefined ? { lines: node.lines } : {}),
  });
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

  const root = collectTree(reader, theme, measure, styleOf, opts.compact ?? false);
  if (!root) return { nodes: [], edges: [], collapsedCounts: new Map(), summaries: [], width: 0, height: 0 };
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

  // 概要（M6 T6 横括线 → 2026-10-01 反馈任务 1 同侧改企微竖向花括号）：bbox 仍只
  // 按节点盒计算（概要不扩画布边界）。形态分派与避让见 buildSummaries。
  const summaries = buildSummaries(reader, nodes, measure, theme);

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
    summaries,
    width: nodes.length > 0 ? maxX - minX : 0,
    height: nodes.length > 0 ? maxY - minY : 0,
  };
}
