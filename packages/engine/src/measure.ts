import {
  TASK_META_FONT_SIZE,
  TASK_PROGRESS_W,
  TASK_ROW_H,
  taskRowContentWidth,
  type TaskRowSlots,
} from './taskvisual';
import type { MeasureAdapter, TextStyle, ThemeTokens } from './types';

export interface MeasureNodeBoxOptions {
  /** 测量适配器（宽度来源）；不传时按每字符 1px 退化估算。 */
  adapter?: MeasureAdapter;
  /** 左侧图标数，宽度累加 iconCount × theme.iconSlotWidth。 */
  iconCount?: number;
  /**
   * 节点图片高度（px）。T6 carry-in 裁决（Task 12 落地）：布局盒高必须计入图片——
   * h = max(文本高, imageH)，否则图片与文本/兄弟节点重叠。缺省（无图）不变。
   */
  imageH?: number;
  /**
   * 节点图片宽度（px）。图片自左内边距起绘制，宽度下限 = imageW + 2×nodePaddingX。
   * 缺省（无图）不参与。
   */
  imageW?: number;
  /**
   * 任务信息行槽位（M7c-C2，只增不改）：有任务信息时盒高加一行（TASK_ROW_H，
   * 第二行区域——与 R1 description 行同槽位，布局不写死单行）、盒宽下限容纳
   * 任务行内容（taskRowContentWidth）。缺省（无任务信息）完全不参与——
   * 既有节点几何逐字节不变（金样锁定）。
   */
  taskRow?: TaskRowSlots;
  /**
   * 节点描述（M7c-C1，只增不改）：任务的一句话描述（区别于 note 备注）。非空时
   * 盒高加一行（TASK_ROW_H，与任务行同条带高度、任务行上方）；超出
   * theme.maxTextWidth 按测量逐字符截断并追加省略号（单行省略，截断结果经
   * NodeBoxMeasure.descLine 交渲染直绘）。缺省/空串完全不参与——既有节点几何
   * 逐字节不变（金样锁定）。
   */
  description?: string;
  /**
   * 简洁模式（M7b 补课，mindgrid 账号级显示偏好「脑图简洁模式」）：true 时节点盒
   * 收敛为「标题 + 标记 + 内联进度」紧凑盒——描述行不产出（descLine 恒缺省）、
   * 任务行槽位不计入盒高/盒宽（任务详情由渲染层改为内联小字，见 render.ts
   * gm-task-progress-inline）。有任务信息（taskRow 槽位存在）时盒宽下限追加
   * TASK_PROGRESS_W（mindgrid COMPACT.PROGRESS_W=30 同值）为内联百分数预留槽位，
   * 长标题不与其重叠。缺省 false = 原路径，输出逐字节不变（金样锁定）。
   */
  compact?: boolean;
}

export interface NodeBoxMeasure {
  w: number;
  h: number;
  lines: string[];
  /** 描述行（M7c-C1）：测量截断后的单行文本；无描述时缺省（字段不出现，金样锁定）。 */
  descLine?: string;
}

/** 描述行字号（M7c-C1，企微灰字第二行；测量截断与 render 绘制同源单值）。 */
export const DESC_FONT_SIZE = 12;
/** 描述行省略号字符（截断时追加，与截断字符一并计入测量宽度）。 */
const DESC_ELLIPSIS = '…';

/**
 * 计算节点盒尺寸与最终文本行：
 * - 按 '\n' 分行；单行超 theme.maxTextWidth 时逐字符贪心断行（中英文通用），
 *   在即将溢出的字符前断开，绝不产生空尾行（空文本除外）。
 * - 行高 = fontSize × theme.lineHeightRatio，文本高 = 行数 × 行高。
 * - h = max(文本高 + 任务行高 + 描述行高, imageH ?? 0)（各行仅在对应信息存在时计入；
 *   T6 carry-in 裁决：盒高计入图片高度）。
 * - w = max(最宽行宽 + 2×nodePaddingX + iconCount×iconSlotWidth,
 *   imageW !== undefined ? imageW + 2×nodePaddingX : 0,
 *   taskRowContentWidth(taskRow)（有任务信息时）,
 *   截断描述行宽 + 2×nodePaddingX + iconCount×iconSlotWidth（有描述时）, minNodeWidth)。
 * - compact=true（M7b 补课，简洁模式）：描述行不产出、任务行槽位不计高宽，盒宽下限
 *   追加内联进度槽（TASK_PROGRESS_W，有任务信息时）——紧凑盒=标题+标记+内联进度。
 * 纯函数、确定性：同一输入恒得同一输出。
 */
export function measureNodeBox(
  text: string,
  style: TextStyle,
  theme: ThemeTokens,
  options: MeasureNodeBoxOptions = {},
): NodeBoxMeasure {
  const adapter: MeasureAdapter = options.adapter ?? defaultAdapter;
  const iconCount = options.iconCount ?? 0;
  // 简洁模式（M7b 补课）：分支收口在本函数——描述行与任务行槽位零参与几何，
  // 宿主（layout.ts）透传原值即可，紧凑口径不外溢调用侧。缺省 false 走原路径。
  const compact = options.compact ?? false;
  const physicalLines = text.split('\n');
  const lines = physicalLines.flatMap((line) => wrapLine(line, adapter, style, theme.maxTextWidth));
  const lineHeight = style.fontSize * theme.lineHeightRatio;
  const textH = lines.length * lineHeight;
  // 描述行（M7c-C1）：单行省略——超宽先按测量截断（追加省略号一并计宽），截断
  // 结果随 descLine 输出（渲染直绘，不再自行测量）。无描述零参与；简洁模式恒
  // 不产出（紧凑盒无描述行，渲染侧同裁定隐藏 gm-desc）。
  const descRaw = compact ? '' : (options.description ?? '');
  const descStyle: TextStyle = { fontSize: DESC_FONT_SIZE, fontWeight: 400, fontFamily: style.fontFamily };
  const descLine = descRaw !== '' ? truncateWithEllipsis(descRaw, descStyle, adapter, theme.maxTextWidth) : undefined;
  // 任务行槽位（M7c-C2）：简洁模式不计入盒高（任务行条带由渲染侧隐藏、进度内联）。
  const taskRowH = !compact && options.taskRow ? TASK_ROW_H : 0;
  const descRowH = descLine !== undefined ? TASK_ROW_H : 0;
  const h = Math.max(textH + taskRowH + descRowH, options.imageH ?? 0);

  let maxLineW = 0;
  for (const line of lines) {
    const w = adapter.measureTextLine(line, style);
    if (w > maxLineW) maxLineW = w;
  }
  const imageW = options.imageW !== undefined ? options.imageW + theme.nodePaddingX * 2 : 0;
  // 任务行宽（2026-10-10 mindgrid 对齐）：左=负责人文字（adapter 实测，不可常量
  // 估算）、右=百分比槽；日期为盒外悬浮标签不占行宽。
  const taskMetaStyle: TextStyle = {
    fontSize: TASK_META_FONT_SIZE,
    fontWeight: 400,
    fontFamily: style.fontFamily,
  };
  const taskRowW =
    !compact && options.taskRow
      ? taskRowContentWidth(
          options.taskRow,
          options.taskRow.ownerLabel !== ''
            ? adapter.measureTextLine(options.taskRow.ownerLabel, taskMetaStyle)
            : 0,
        )
      : 0;
  // 简洁模式内联进度槽宽（mindgrid COMPACT.PROGRESS_W=30 同值）：有任务信息
  // （taskRow 槽位存在 = hasTaskInfo 口径）时盒宽下限追加槽宽——内联百分数画在
  // 标题行右缘（渲染侧右对齐同值），长标题不与其重叠；无任务信息零参与。
  const inlineProgressW = compact && options.taskRow ? TASK_PROGRESS_W : 0;
  const descW =
    descLine !== undefined
      ? adapter.measureTextLine(descLine, descStyle) + theme.nodePaddingX * 2 + iconCount * theme.iconSlotWidth
      : 0;
  const w = Math.max(
    maxLineW + theme.nodePaddingX * 2 + iconCount * theme.iconSlotWidth + inlineProgressW,
    imageW,
    taskRowW,
    descW,
    theme.minNodeWidth,
  );
  return descLine !== undefined ? { w, h, lines, descLine } : { w, h, lines };
}

/** 单行截断（M7c-C1）：超 maxW 时逐码点贪心保留可容纳前缀并追加省略号（省略号
 *  计入测量，保证截断结果 ≤ maxW；与 wrapLine 同款码点迭代，emoji 不拆断）。 */
function truncateWithEllipsis(
  text: string,
  style: TextStyle,
  adapter: MeasureAdapter,
  maxW: number,
): string {
  if (adapter.measureTextLine(text, style) <= maxW) return text;
  let out = '';
  for (const ch of text) {
    if (adapter.measureTextLine(out + ch + DESC_ELLIPSIS, style) > maxW) break;
    out += ch;
  }
  return out + DESC_ELLIPSIS;
}

/** 单行 → 若超 maxTextWidth 则逐字符贪心断行；空行原样保留为一行。 */
function wrapLine(
  line: string,
  adapter: MeasureAdapter,
  style: TextStyle,
  maxTextWidth: number,
): string[] {
  if (line === '') return [''];
  const out: string[] = [];
  let current = '';
  // 按码点迭代，代理对（emoji 等）不被拆断。
  for (const ch of line) {
    const candidate = current + ch;
    if (current !== '' && adapter.measureTextLine(candidate, style) > maxTextWidth) {
      out.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** 退化适配器：每码点 1px。仅作无适配器时的确定性兜底，宿主应传入真实测量。 */
const defaultAdapter: MeasureAdapter = {
  measureTextLine: (text) => [...text].length,
};
