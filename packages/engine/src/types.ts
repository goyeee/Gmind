/**
 * @gmind/engine 数据结构与适配器契约（M1b Task 3，Task 4 只增不改）。
 *
 * 绑定裁决：engine 不 import yjs，也不 import core 的 NodeSnapshot/DocMeta 类型；
 * 布局/渲染 API 通过 DocReader（结构化本地类型 DocMetaLike / NodeSnapshotLike）
 * 读取文档快照，由 apps/web 侧的适配函数从 @gmind/core 桥接。
 */
export type { StructureType } from '@gmind/shared';

/** 文本样式（与 DOM/Canvas 字体三元组一一对应）。 */
export interface TextStyle {
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
}

/**
 * 测量适配器：返回单行文本宽度（px）。引擎自算行高（fontSize × lineHeightRatio），
 * 适配器只负责宽度——由宿主环境（Canvas measureText / DOM / 测试桩）实现。
 */
export interface MeasureAdapter {
  measureTextLine(text: string, style: TextStyle): number;
}

/**
 * 主题度量令牌（Task 3 最小集，Task 5 按主题系统扩展；只增不改）。
 */
export interface ThemeTokens {
  /** 节点盒水平内边距（左右各一份）。 */
  nodePaddingX: number;
  /** 单个图标槽的宽度（图标区位于节点盒左侧）。 */
  iconSlotWidth: number;
  /** 行高倍率：行高 = fontSize × lineHeightRatio。 */
  lineHeightRatio: number;
  /** 单行文本超此宽度即逐字符贪心断行（中英文通用）。 */
  maxTextWidth: number;
  /** 节点盒最小宽度下限。 */
  minNodeWidth: number;
  /** 垂直布局兄弟子树带间距（mindmap/logic 纵向、org 层级间纵向）。 */
  V_GAP: number;
  /** 水平布局兄弟子树带间距（mindmap/logic 层级间横向、org 横向）。 */
  H_GAP: number;
}

/** 场景坐标点（中心主题 (0,0) 居中）。 */
export interface Point {
  x: number;
  y: number;
}

/** 节点盒：布局产出的场景坐标矩形。 */
export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  side: 'left' | 'right' | 'down';
  depth: number;
}

/** 边路由：两端锚点 + 线型。 */
export interface EdgeRoute {
  id: string;
  from: Point;
  to: Point;
  kind: 'bezier' | 'elbow';
  /** bezier 控制点（恒 2 个，kind='bezier' 时提供；水平外伸 max(60, dx×0.5)）。elbow 无。 */
  controls?: Point[];
}

/** 布局结果：collapsedCounts 记录各折叠节点被隐藏的后代数。 */
export interface LayoutResult {
  nodes: NodeBox[];
  edges: EdgeRoute[];
  collapsedCounts: Map<string, number>;
  width: number;
  height: number;
}

/** 文档元信息结构子集（core 的 DocMeta 结构兼容；structureType 用 string 放宽）。 */
export interface DocMetaLike {
  title: string;
  structureType: string;
  themeId: string;
}

/** 节点快照结构子集（core 的 NodeSnapshot 结构兼容；按需只增不改）。 */
export interface NodeSnapshotLike {
  id: string;
  text: string;
  parentId: string;
  childIds: string[];
  collapsed: boolean;
  deleted: boolean;
  /** 图标组（Task 4 布局按键数预留 iconSlotWidth 槽位；Task 6 渲染）。 */
  icons?: Record<string, unknown>;
}

/**
 * 只读文档读取器：布局/渲染访问文档的唯一通道。
 * apps/web 将 @gmind/core 的 getMeta/getNode/childrenIds 适配成本接口。
 */
export interface DocReader {
  getMeta(): DocMetaLike;
  getNode(id: string): NodeSnapshotLike | null;
  childrenIds(id: string): string[];
}
