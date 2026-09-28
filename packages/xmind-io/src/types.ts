// types.ts：对外的统一树节点 / 降级条目 / 错误契约，以及 content.json（2020+）的宽松原始形状。

/**
 * 节点标记（M7a-T1 三组制子集，与 @gmind/core 值目录一致；本包零依赖 gmind/*，
 * 故本地定义同形结构）：priority '1'-'7' / icon 10 slug（done/cancel/important/flag/
 * question/alert/idea/like/link/clock）/ emoji 10 字符。
 */
export interface XmindIcons {
  priority?: string;
  icon?: string;
  emoji?: string;
}

/** 解析后的统一树节点：只保留层级/文本/备注/标记。title 允许空串（xmind 源文件可缺 title）。 */
export interface XmindNode {
  title: string;
  note?: string;
  /** XMind 标记（导入映射产物 / 导出输入），见 markers.ts 的双向映射口径。 */
  icons?: XmindIcons;
  children: XmindNode[];
}

/** 降级类别：style=标记/标签/主题与样式属性；media=图片/附件/备注内图片；structure=漂浮主题/概要/额外 sheet。 */
export type DegradedKind = 'style' | 'media' | 'structure';

/** 聚合后的降级条目（按 kind 求和，count=0 的 kind 不输出）。 */
export interface DegradedItem {
  kind: DegradedKind;
  count: number;
}

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
  title?: unknown;
  notes?: JsonNotes;
  markers?: unknown[];
  labels?: unknown[];
  image?: unknown;
  attachments?: unknown[];
  style?: unknown;
  summaries?: unknown[];
  children?: { attached?: unknown[]; detached?: unknown[] };
}

export interface JsonSheet {
  class?: unknown;
  title?: unknown;
  theme?: unknown;
  rootTopic?: unknown;
}
