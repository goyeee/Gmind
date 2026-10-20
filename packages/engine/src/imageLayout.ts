/**
 * imageLayout.ts — 节点「图文四槽位」几何单源（需求方 2026-10-20）。
 *
 * 背景：既有实现把节点图片画在 `x = nodePaddingX, y = 0`，与标题文本**重叠**，盒高
 * `h = max(文本高, 图高)`（docs/m1-acceptance.md FR-EDT-020 登记的「图与文本节点内
 * 堆叠视觉」既有后置项）。本模块清偿该项：图片可在文字的上/下/左/右四侧，**默认
 * 文字在上、图片在下**（`bottom`）。
 *
 * 单源纪律：measure（定盒宽高）与 render（定文字/图片/描述/标记坐标）都调用本模块，
 * 避免两处各写一套偏移而漂移。engine 不 import core（既有裁定），故 placement 类型
 * 在引擎侧独立声明（值域与 core `NodeImagePlacement` 一致，改动需两处同步）。
 *
 * 兼容：**无图节点不调用本模块**（测量/渲染走原路径），既有几何与 DOM 逐字节不变。
 */

/** 图文间距（px，需求方 2026-10-20 裁定固定 8px，本轮不做可拖拽调边距）。 */
export const IMAGE_TEXT_GAP = 8;

/** 图片相对文字的位置。 */
export type ImagePlacement = 'top' | 'bottom' | 'left' | 'right';

/** 缺省位置：文字在上、图片在下（旧数据无 placement 键时的归一锚点）。 */
export const DEFAULT_IMAGE_PLACEMENT: ImagePlacement = 'bottom';

const PLACEMENTS: readonly ImagePlacement[] = ['top', 'bottom', 'left', 'right'];

/** 读侧归一：非四值（缺键 / 远端坏数据）→ 缺省 bottom。 */
export function imagePlacementOf(image: { placement?: string } | null | undefined): ImagePlacement {
  const p = image?.placement;
  return typeof p === 'string' && (PLACEMENTS as readonly string[]).includes(p)
    ? (p as ImagePlacement)
    : DEFAULT_IMAGE_PLACEMENT;
}

export interface PackNodeContentInput {
  /** 文字块宽（标题最长行与描述行的较大者 + iconCount×iconSlotWidth；不含内边距）。 */
  textW: number;
  /** 文字块高（标题行高合计 + 描述行高）。 */
  textH: number;
  /** 描述行高（0 或 TASK_ROW_H；仅用于把文字块切成标题区/描述区）。 */
  descH: number;
  image: { w: number; h: number; placement?: string } | null;
  /** 节点左内边距（theme.nodePaddingX）。 */
  padX: number;
  /** 盒宽下限（theme.minNodeWidth）。 */
  minWidth: number;
  /** 任务行行高（0 或 TASK_ROW_H）：恒贴盒底、通栏，不参与图片换位。 */
  taskRowH: number;
}

export interface PackedNodeContent {
  w: number;
  h: number;
  /** 文字/描述/标记块的左缘（盒内 x）。 */
  textX: number;
  /** 文字块顶（盒内 y）。 */
  textTop: number;
  /** 标题行集垂直中心（盒内 y，tspan 基线/标记徽标共用）。 */
  titleCenter: number;
  /** 描述行垂直中心（盒内 y；无描述时 = 标题区底 + descH/2，调用方不绘制）。 */
  descCenter: number;
  /** 图片左缘/顶（盒内坐标）；无图时缺省。 */
  imageX?: number;
  imageTop?: number;
  /** 任务行顶（盒内 y；= h - taskRowH，无任务行时 0）。 */
  taskRowTop: number;
}

/**
 * 计算节点内容几何（纯函数、确定性）。四种 placement：
 * - `bottom`（默认）：文字在上、图在下（图片左对齐，裁定 7）；
 * - `top`：图在上、文字在下；
 * - `left` / `right`：图文左右并排，各自在内容行内垂直居中；
 * - 任务行恒最底通栏；`h` 已含任务行。
 */
export function packNodeContent(input: PackNodeContentInput): PackedNodeContent {
  const { textW, textH, descH, image, padX, minWidth, taskRowH } = input;
  const gap = IMAGE_TEXT_GAP;
  const titleH = Math.max(0, textH - descH);
  const placement = imagePlacementOf(image);
  const imgW = image ? image.w : 0;
  const imgH = image ? image.h : 0;

  const stack = placement === 'top' || placement === 'bottom';
  const contentH = stack ? textH + gap + imgH : Math.max(textH, imgH);
  const w = stack
    ? Math.max(textW, imgW) + padX * 2
    : imgW + gap + textW + padX * 2;
  const h = contentH + taskRowH;

  const textTop = stack ? (placement === 'top' ? imgH + gap : 0) : (contentH - textH) / 2;
  const imageTop = stack ? (placement === 'top' ? 0 : textH + gap) : (contentH - imgH) / 2;
  const textX = placement === 'left' ? padX + imgW + gap : padX;
  const imageX = placement === 'right' ? padX + textW + gap : padX;

  const out: PackedNodeContent = {
    w: Math.max(w, minWidth),
    h,
    textX,
    textTop,
    titleCenter: textTop + titleH / 2,
    descCenter: textTop + titleH + descH / 2,
    taskRowTop: h - taskRowH,
  };
  if (image) {
    out.imageX = imageX;
    out.imageTop = imageTop;
  }
  return out;
}
