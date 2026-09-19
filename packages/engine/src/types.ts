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
 * 主题令牌（渲染 + 布局完整集；Task 3 最小集，Task 5 只增不改补全）。
 * 所有键必须有值——Task 6 渲染器将逐个消费。
 */
export interface ThemeTokens {
  // —— 布局度量（Task 3/4 既有键，沿用）——
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
  // —— 分级节点样式：root / level1 / level2+（depth ≥2 统一用 level2）——
  /** 根节点填充色。 */
  rootFill: string;
  /** 根节点边框色。 */
  rootBorderColor: string;
  /** 根节点文字色。 */
  rootTextColor: string;
  /** 根节点字号（绑定缺省 20）。 */
  rootFontSize: number;
  /** 根节点字重。 */
  rootFontWeight: number;
  /** 根节点字族（系统字体栈字符串）。 */
  rootFontFamily: string;
  /** 一级节点填充色。 */
  level1Fill: string;
  /** 一级节点边框色。 */
  level1BorderColor: string;
  /** 一级节点文字色。 */
  level1TextColor: string;
  /** 一级节点字号（绑定缺省 16）。 */
  level1FontSize: number;
  /** 一级节点字重。 */
  level1FontWeight: number;
  /** 一级节点字族（系统字体栈字符串）。 */
  level1FontFamily: string;
  /** 二级及更深节点填充色。 */
  level2Fill: string;
  /** 二级及更深节点边框色。 */
  level2BorderColor: string;
  /** 二级及更深节点文字色。 */
  level2TextColor: string;
  /** 二级及更深节点字号（绑定缺省 14）。 */
  level2FontSize: number;
  /** 二级及更深节点字重。 */
  level2FontWeight: number;
  /** 二级及更深节点字族（系统字体栈字符串）。 */
  level2FontFamily: string;
  // —— 画布与连接线 ——
  /** 画布背景色。 */
  canvasBackground: string;
  /** 连接线颜色。 */
  edgeColor: string;
  /** 连接线宽度（px）。 */
  edgeWidth: number;
  // —— 节点盒外观 ——
  /** 节点盒圆角半径（px）。 */
  nodeBorderRadius: number;
  /** 节点盒边框宽度（px）。 */
  nodeBorderWidth: number;
  // —— 折叠徽标 ——
  /** 折叠徽标背景色。 */
  collapseBadgeBg: string;
  /** 折叠徽标前景（文字）色。 */
  collapseBadgeFg: string;
}

/** 主题标识：core meta `themeId` 的合法值域（'gmind-light' 为解析期别名，见 resolveThemeId）。 */
export type ThemeId = 'gmind-blue' | 'gmind-warm' | 'gmind-accessible';

/**
 * 节点最终解析样式：主题分级派生 + 节点级 nodeStyle 覆盖后的渲染输入
 * （Task 6 渲染器只读本结构，不再自行兜底颜色）。
 */
export interface ResolvedNodeStyle {
  /** 节点填充色。 */
  fill: string;
  /** 节点边框色。 */
  border: string;
  /** 文字色。 */
  textColor: string;
  /** 文本三元组（fontSize/fontWeight/fontFamily），与测量、DOM/Canvas 字体一一对应。 */
  textStyle: TextStyle;
  /** 解析后字号（textStyle.fontSize 的冗余直读形式）。 */
  fontSize: number;
  /** 解析后字族（textStyle.fontFamily 的冗余直读形式）。 */
  fontFamily: string;
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
  /** 父节点 id（根节点无此字段）；Task 8 siblingEnd 同级首末判定用（只增不改）。 */
  parentId?: string;
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
  // —— 富字段（Task 10 只增不改：仅剪贴板层消费；core NodeSnapshot 结构兼容，
  //    布局/测量不读它们。icons 值放宽为 unknown，剪贴板层复制时收敛为 string）——
  /** 节点备注。 */
  note?: string;
  /** 超链接。 */
  href?: string;
  /** 图片资源（对象存储 key + 原始宽高）。 */
  image?: { key: string; w: number; h: number } | null;
  /** 节点级样式覆盖（键值对）。 */
  style?: Record<string, string>;
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
