// types.ts：对外的统一树节点 / 降级条目（2026-11-14 v2 命名制）/ 错误契约 / zip 资源表，
// 以及 content.json（2020+）的宽松原始形状。

/**
 * 节点标记（M7b-W1 八组制多值，与 @gmind/core 值目录一致；本包零依赖 gmind/*，
 * 故本地定义同形结构）：组键 ∈ 八组制（mood/priority/number/arrow/flag/progress/
 * other/emoji），每组值为 slug/字符数组（单选组至多 1 枚、多选组至多 8 枚）。
 * 2026-11-14 v2 导入产 priority/flag/progress/mood/arrow/other 六组（emoji/number 无
 * 原生源仍不产），映射口径见 markers.ts 头注。
 */
export interface XmindIcons {
  mood?: string[];
  priority?: string[];
  number?: string[];
  arrow?: string[];
  flag?: string[];
  progress?: string[];
  other?: string[];
  emoji?: string[];
}

/** 解析后的统一树节点：只保留层级/文本/备注/标记。title 允许空串（xmind 源文件可缺 title）。
 *  description（M7c-C1）：节点任务一句话描述，非 XMind 官方字段——2020+ JSON 侧以
 *  自定义 `description` 键导出/读回（宽容 JSON，未知键不致损坏），XML（XMind 8
 *  content.xml）侧无对应标签，登记不映射（导入丢描述、导出不产出）。
 *  2026-11-14 导入保真 v2 增字段（既有字段一律不动）：href（仅 http/https，其余解析层
 *  计超链接降级丢弃）、image（zip 内资源，path 为 resources 表键）、summaries（概要条目，
 *  挂在被覆盖的父节点上）、style（四键映射产物）、folded（折叠态）。 */
export interface XmindNode {
  title: string;
  note?: string;
  /** 任务一句话描述（M7c-C1，自定义键；见接口头注的双侧映射裁定）。 */
  description?: string;
  /** XMind 标记（导入映射产物 / 导出输入），见 markers.ts 的双向映射口径。 */
  icons?: XmindIcons;
  /** 节点超链接（仅 http/https 透传；xapp:/相对路径在解析层计 link 降级丢弃）。 */
  href?: string;
  /** 节点图片：path=zip 资源键（parseXmind 返回的 resources 表键）；w/h 取整；
   *  align ∈ top/bottom/left/right（源缺省时落缺省键，由导入胶水按 bottom 处理）。 */
  image?: { path: string; w?: number; h?: number; align?: 'top' | 'bottom' | 'left' | 'right' };
  /** 概要条目：start/end=attached 子节点下标（闭区间，如 (0,2) 覆盖第 1~3 个）；label=标签文本（查无引用时空串）。 */
  summaries?: { start: number; end: number; label: string }[];
  /** 主题样式（四键映射产物：color/fill/border/fontSize；字号已去 px/pt 取整）。 */
  style?: Record<string, string>;
  /** 折叠态（2020+ JSON `branch:"folded"`；XMind 8 XML 无此概念恒缺省）。 */
  folded?: boolean;
  children: XmindNode[];
}

/** 画布结构类型（根 structureClass/structure-class 映射产物）。 */
export type XmindStructureType = 'logic' | 'mindmap' | 'org';

/** 解析出的单个 Sheet（多画布计划四，裁定 8）：title 允许空串（xmind 源文件可缺）。
 *  structureType：根结构类映射（2026-11-14 v2）；未指定或无法识别的值缺省键=导入胶水落画布默认布局，后者计 structureOverride 降级。 */
export interface XmindSheet {
  title: string;
  root: XmindNode;
  structureType?: XmindStructureType;
  /** 根扩展 right-number=attached 文档序前 N 支居右计数（2026-11-15 分侧忠实还原；
   *  provider=org.xmind.ui.map.unbalanced，仅根主题上的扩展有效，子主题忽略）。解析层
   *  只在合法非负整数时产键（否则不产），越界 clamp 到 [0, attached 数] 由导入胶水层做，
   *  此处原样透传数字。 */
  rightCount?: number;
}

/** 降级目录键（v2 命名制；键序=DEGRADED_LABELS 目录序=「未导入：…」提示文案顺序）。
 *  'theme'（画布主题）已于 2026-11-14 经需求方拍板移出目录——主题由 Gmind 自有主题
 *  替换呈现，属有意替换非内容丢失，不再计入「未导入」提示。 */
export type DegradedKey =
  | 'icon'
  | 'label'
  | 'styleProp'
  | 'image'
  | 'attachment'
  | 'noteImage'
  | 'link'
  | 'callout'
  | 'boundary'
  | 'floating'
  | 'taskInfo'
  | 'structureOverride'
  | 'summary'
  | 'sheet';

/** 聚合后的降级条目（按 key 求和，count=0 的 key 不输出；items 恒按目录序排列）。 */
export interface DegradedItem {
  key: DegradedKey;
  count: number;
}

/** 降级目录（键序=目录序，2026-11-14 裁定 3：逐项点名按此排序）。 */
export const DEGRADED_LABELS: Record<DegradedKey, string> = {
  icon: '图标',
  label: '标签',
  styleProp: '样式属性',
  image: '图片',
  attachment: '附件',
  noteImage: '备注图片',
  link: '超链接',
  callout: '标注',
  boundary: '外框',
  floating: '漂浮主题',
  taskInfo: '任务信息',
  structureOverride: '结构覆盖',
  summary: '概要',
  sheet: '空画布',
};

/** zip 内资源（魔数白名单嗅探通过才入表；path=zip 条目键，如 `resources/<uuid>.png`）。 */
export interface XmindResource {
  bytes: Uint8Array;
  mime: string;
}

/** parseXmind 返回的资源表（additive：白名单外/目录条目不入表）。 */
export type XmindResources = Record<string, XmindResource>;

export type XmindErrorCode = 'UNSUPPORTED_FORMAT' | 'CORRUPTED' | 'EMPTY';

/** 解析失败：CORRUPTED（zip/JSON/XML 无法解析）、UNSUPPORTED_FORMAT（容器缺 content.*）、EMPTY（无根主题）。 */
export class XmindParseError extends Error {
  readonly code: XmindErrorCode;

  constructor(code: XmindErrorCode, message: string) {
    super(message);
    this.name = 'XmindParseError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 2020+ content.json 的宽松原始形状：字段一律视为可能缺失/类型不符，取值处逐个收窄。
// ---------------------------------------------------------------------------

export interface JsonNotes {
  plain?: { content?: unknown };
  realHTML?: { content?: unknown };
}

export interface JsonTopic {
  class?: unknown;
  id?: unknown;
  title?: unknown;
  /** 非官方扩展键（M7c-C1）：Gmind 导出的任务描述，读回时 string 且非空才携带。 */
  description?: unknown;
  /** 超链接（http/https 透传，其余计 link 降级）。 */
  href?: unknown;
  /** 折叠态真值（spec §二）：仅 `"folded"` 视为折叠。 */
  branch?: unknown;
  /** 结构类（spec §二真值：rootTopic `structureClass`；非根出现计 structureOverride）。 */
  structureClass?: unknown;
  notes?: JsonNotes;
  markers?: unknown[];
  labels?: unknown[];
  /** 图片（spec §二真值：`{src:"xap:resources/…",width,height,align}`，width 可为 float）。 */
  image?: unknown;
  attachments?: unknown[];
  style?: unknown;
  /** 概要引用（spec §二真值两段式：`[{id,topicId,range:"(6,6)"}]`，标签文本在 children.summary）。 */
  summaries?: unknown[];
  /** 概要/外框引用的标签 topic id（外框条目 `children.boundary:[{topicId,range}]` 同形）。 */
  topicId?: unknown;
  /** 概要/外框 range（spec §四真值形状 `"(s,e)"`，children 下标闭区间）。 */
  range?: unknown;
  /** 样式属性表（2020+ JSON：`style:{properties:{…}}`）。 */
  properties?: unknown;
  /** 根主题扩展（2026-11-15 分侧真值：`extensions:[{provider,content:[{name,content}]}]`，
   *  仅根主题上的有效——子主题的 extensions 解析层忽略）。 */
  extensions?: unknown[];
  /** 任务信息（v2 起计数丢弃）。 */
  taskInfo?: unknown;
  children?: {
    attached?: unknown[];
    detached?: unknown[];
    /** 概要标签文本桶（spec §二真值：`[{id,title}]`，经 summaries[].topicId 引用）。 */
    summary?: unknown[];
    /** 标注桶（计子树节点数丢弃）。 */
    callout?: unknown[];
    /** 外框桶（逐个计数丢弃）。 */
    boundary?: unknown[];
  };
}

export interface JsonSheet {
  class?: unknown;
  title?: unknown;
  theme?: unknown;
  rootTopic?: unknown;
}
