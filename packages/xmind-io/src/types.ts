// types.ts：对外的统一树节点 / 降级条目 / 错误契约，以及 content.json（2020+）的宽松原始形状。

/** 解析后的统一树节点：只保留层级/文本/备注。title 允许空串（xmind 源文件可缺 title）。 */
export interface XmindNode {
  title: string;
  note?: string;
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
