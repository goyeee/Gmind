import { packNodeContent, type ImagePlacement, type PackedNodeContent } from './imageLayout';
import {
  TASK_META_FONT_SIZE,
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
   * 节点图片高度（px）。2026-10-20 图文四槽位起：图片不再与文本重叠，盒高按
   * packNodeContent 堆叠（上/下）或并排（左/右）计算。缺省（无图）不变。
   */
  imageH?: number;
  /**
   * 节点图片宽度（px）。垂直堆叠时盒宽下限 = max(文字块宽, imageW) + 2×nodePaddingX；
   * 左右并排时 = imageW + gap + 文字块宽 + 2×nodePaddingX。缺省（无图）不参与。
   */
  imageW?: number;
  /**
   * 图片相对文字的位置（2026-10-20 四槽位）：缺省/非法 = 'bottom'（文字在上、图在下）。
   * 仅在有图时参与几何。
   */
  imagePlacement?: ImagePlacement;
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
   * 收敛为「标题 + 标记」紧凑盒——描述行不产出（descLine 恒缺省）、任务行槽位
   * 不计入盒高/盒宽。内联进度槽宽预留已随渲染侧一并退役（2026-10-11 需求方裁定
   * 「简洁模式不用展示百分比」）。缺省 false = 原路径，输出逐字节不变（金样锁定）。
   */
  compact?: boolean;
}

export interface NodeBoxMeasure {
  w: number;
  h: number;
  lines: string[];
  /** 描述行（M7c-C1）：测量截断后的单行文本；无描述时缺省（字段不出现，金样锁定）。 */
  descLine?: string;
  /**
   * 图文四槽位内容几何（2026-10-20，只增）：**仅含图节点**产出，随盒透传给渲染
   * 直用（文字/描述/标记/图片坐标单源 = 本测量）。无图节点缺省（字段不出现，
   * 既有几何与 DOM 逐字节不变）。
   */
  content?: PackedNodeContent;
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
 * - 无图：h = 文本高 + 任务行高 + 描述行高；
 *   w = max(文字块宽 + 2×nodePaddingX, taskRowContentWidth(taskRow), minNodeWidth)。
 * - 含图（2026-10-20 图文四槽位，见 imageLayout.packNodeContent）：盒宽高按
 *   placement（top/bottom 堆叠、left/right 并排）计算，内容坐标随 `content` 输出
 *   交渲染直用；任务行恒贴底。
 * - compact=true（M7b 补课，简洁模式）：描述行不产出、任务行槽位不计高宽——
 *   紧凑盒=标题+标记（内联进度槽 2026-10-11 裁定退役，简洁模式不展示百分比）。
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

  let maxLineW = 0;
  for (const line of lines) {
    const w = adapter.measureTextLine(line, style);
    if (w > maxLineW) maxLineW = w;
  }
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
  // 简洁模式内联进度槽宽已退役（2026-10-11 裁定：紧凑盒不含任务文字，零槽宽预留）。
  const descLineW = descLine !== undefined ? adapter.measureTextLine(descLine, descStyle) : 0;
  // 文字块宽（不含内边距）= 标题最长行与描述行的较大者 + 图标槽；与旧版
  // `max(maxLineW+2pad+icons, descW)` 恒等（旧 descW = descLineW+2pad+icons）。
  const textBlockW = Math.max(maxLineW, descLineW) + iconCount * theme.iconSlotWidth;
  const textBlockH = textH + descRowH;
  const hasImage = options.imageW !== undefined || options.imageH !== undefined;
  // 含图（2026-10-20 四槽位）：盒宽高由 packNodeContent 单源产出，内容坐标随盒透传
  // 渲染；无图走原公式（逐字节不变，金样锁定）。
  if (hasImage) {
    const content = packNodeContent({
      textW: textBlockW,
      textH: textBlockH,
      descH: descRowH,
      image: { w: options.imageW ?? 0, h: options.imageH ?? 0, placement: options.imagePlacement },
      padX: theme.nodePaddingX,
      minWidth: theme.minNodeWidth,
      taskRowH,
    });
    const w = Math.max(content.w, taskRowW, theme.minNodeWidth);
    const out: NodeBoxMeasure = { w, h: content.h, lines, content };
    if (descLine !== undefined) out.descLine = descLine;
    return out;
  }
  const h = textH + taskRowH + descRowH;
  const w = Math.max(
    textBlockW + theme.nodePaddingX * 2,
    taskRowW,
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
