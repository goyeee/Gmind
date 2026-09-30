/**
 * 节点拖拽：换父 / 同级排序插入 — M1b Task 9 起步，M7c-D1 按企微对标 spec P0-2 重做，
 * M7c-D3（需求方 2026-09-30 企微拖动实测对齐）升级为「芯片跟随 + 原位占位 + 真实边
 * 落位预览」。
 *
 * M7c-D1 落点三分语义（需求方原话「拖动的功能简直糟糕透了，我都没看懂逻辑是啥」）：
 * - 拖到目标节点**本体**（盒中线 ±25% 区域）= 变其子级（追加末尾，M1b 语义保留）；
 * - 拖到盒子**边缘插入带**（上下各 25%；side='down' 的 org 结构兄弟横排，带在左右）
 *   = 同级插入：释放调 core moveNode(id, anchor.parentId, index) 按落点排序——
 *   index 由 childrenIdsOf 文档序 + 锚点位次结算，同父移动做「先移除后插入」的
 *   前移修正（纪律#2：纯计算，全部在事务之外）；
 * - 拖到**空白** = 移为 root 子级末尾（现状保留）。
 * - 自身/自身后代仍是禁止目标（fix round 1）：整盒含边缘带一律 drop-forbidden、
 *   释放静默取消不回调（否则 self 落 null 分支会把整枝浮动成根主题，破坏性）。
 * - 根节点无 parentId：整盒 = 变其子级（根不可作兄弟锚点）。
 *
 * M7c-D3 企微拖动对齐（实测录像 wecom-drag-a|b|c 抽帧结论）：
 * - **拾起**：过阈值激活即在悬浮层建 `g.gm-drag-ghost` 芯片（被拖节点盒大小的圆角
 *   矩形 + 居中文字），逐帧定位到「指针 − 抓取偏移」（按下点 − 被拖盒左上角，芯片
 *   不跳变）；被拖节点原位挂 `gm-drag-origin`（与 gm-dragging 并挂）——虚线淡出成
 *   占位框，树其余部分不回流。
 * - **落位预览 = 真实连线**（需求方原话「吸附效果应该有一条线和被吸附节点连着，
 *   放开后就真正吸附上去」）：sibling 落点悬停点亮后画 `path.gm-drop-edge`（候选父
 *   盒边中点 → 落位槽盒边中点，render.ts 同款 bezier 公式——这条线就是松手后会
 *   出现的边）+ `rect.gm-drop-slot`（落位槽虚线框）。child 落点仍是目标盒蓝描边
 *   （drop-target）、禁止仍红描边（drop-forbidden），旧横向指示线 gm-drop-indicator
 *   整体移除（被「边+槽」取代）。
 * - **所见即所得 + 预览/释放一致性**：classify→resolve→槽计算收敛为单一结算路径
 *   （computeResolved），逐帧缓存于 pending；释放点 = 最后悬停点（常态）时直接复用
 *   缓存提交，绝不二次计算造成预览与落点分叉；释放点 ≠ 最后悬停点（svg 外兜底
 *   释放等）才用**同一函数**现算——同点必同果。
 * - **根级侧别仿真（「松手跳左侧」根治）**：layout 的 assignMindmapSides 把 root
 *   直接子级按文档序做「累计子树带高过半即翻左」的前缀切分，拖放插入改变文档序后
 *   重排，被拖节点可能被分到对侧。resolveDropSlot 纯函数（从盒子集合计算，不 import
 *   layout.ts——不动布局与金样）复刻该半分逻辑：几何 index 仿真到对侧时，在同侧
 *   兄弟中按 y 找最接近芯片 y 的插入位修正 index，释放与槽共用修正结果。仅 root
 *   直接子级且现有兄弟含 left 侧（mindmap 双侧文档）启用——logic 全右/单侧文档无
 *   翻转证据，几何 index 即最终 index（org 另有横排分支）。
 *
 * 反馈时机（300ms → 100ms，spec P0-2）：同一落点悬停满 100ms 才点亮高亮/预览；
 * 切换落点立即摘除并重置计时。**释放裁决不再要求悬停时长**——指针在哪里松开，
 * 落点就按哪里结算（企微/XMind 通例）。芯片跟随不受 100ms 门控（逐帧）。
 *
 * 被拖节点视觉反馈（需求方「拖动节点时被拖节点零反馈」）：激活瞬间（activate，
 * 过 4px 阈值那一步）给被拖节点 g 挂 `gm-dragging` + `gm-drag-origin` 类，视觉由
 * 页面 CSS 落地；所有结束路径（释放成功、禁止目标静默取消、pointercancel、svg 外
 * pointerup 兜底、destroy）统一经 clearHighlights 摘除——挂/摘以 draggingVisualId
 * 字段配对，不依赖 this.drag 的清空时序，任何路径不残留类。
 *
 * 原生文字拖选根治（需求方「点击节点拖动时竟然把文字选中了」）：web 侧
 * user-select:none（editor.css .editor-canvas）之外，engine 在候选 pointerdown 与
 * 激活 move 上 e.preventDefault()——按 Pointer Events 规范，取消 pointerdown 抑制
 * 其默认动作（含文本选择起锚与兼容 mousedown 派发），click/dblclick/contextmenu
 * 合成不受影响（页面 onSvgClick / 双击编辑 / justDragged 防抖链路不变）。jsdom
 * 无法复现原生拖选，测试以 event.defaultPrevented 断言；真机由浏览器默认动作
 * 语义保证 + CSS 双保险。
 *
 * 生命周期绑定裁决（沿用 M1b Task 9 + fix round 1）：
 * - pointerdown 命中 <g data-node-id>（主键）才登记候选；折叠徽标 <g data-for-id>
 *   与标记徽标 <g data-marker-group> 嵌在节点 g 内，先排除——点击归页面层。
 * - 位移阈值 4px（screen px）之前不激活：click 仍是 click；激活时记录拖拽 id 与
 *   ghost 偏移（指针场景点 − 节点盒左上角）。
 * - 拖动中每帧命中检测：viewport.toSceneFromEvent → classifyAt 落点分类。
 * - 候选/拖拽期间挂 window 级 pointerup/pointercancel 兜底：svg 外释放（如拖出
 *   窗口）不走 svg 处理器，防候选/拖拽卡死；svg 内释放先冒泡过 svg 处理器（状态
 *   已清），window 处理器成 no-op，天然幂等。
 * - pointercancel 视为取消；setPointerCapture 特性探测 + try/catch（T7 先例）；
 *   destroy() 全解绑、释放捕获、清反馈（不回调 onDrop）。
 * - 给页面的注记：拖拽激活后的释放**不会拦截**浏览器随后合成的 click 事件（本控
 *   制器只在 pointerdown/move 上 preventDefault）——页面仍需 justDragged 防抖
 *   「刚拖拽完」的合成 click（EditorPage 现状）。
 */
import type { NodeBox, Point } from './types';
import type { Viewport } from './viewport';

/** 拖拽激活位移阈值（screen px）。 */
export const DRAG_THRESHOLD_PX = 4;
/** 落点反馈确认时长（同一落点累计悬停 ≥ 此值才点亮高亮/预览；纯视觉时机，不裁决释放）。 */
export const DROP_HOVER_MS = 100;
/** 边缘插入带占比：盒高（org 为宽）两侧各此比例为「插入带」，其余为本体（变子级）。 */
export const SIBLING_BAND_RATIO = 0.25;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 企微蓝（芯片描边/落位槽描边）。 */
const ACCENT = '#3370ff';
/** 主题边色取不到（画布暂无边 path）时的预览边兜底灰。 */
const EDGE_COLOR_FALLBACK = '#a6b0bf';
/** 垂直兄弟间距实测不到（同侧兄弟 <2）时的槽位兜底（px）。 */
const V_GAP_FALLBACK = 20;
/** 水平列间距实测不到（父级暂无同侧子级）时的槽位兜底（px，企微留白量级）。 */
const H_GAP_FALLBACK = 60;

/** 悬停中的几何落点（未含文档序 index——index 仅在释放时按 childrenIdsOf 结算）。 */
export type DropPlacement =
  | { kind: 'child'; nodeId: string }
  | { kind: 'sibling'; anchorId: string; position: 'before' | 'after' };

/**
 * 释放落点（onDrop 第二参，M7c-D1 三分）：
 * - `{kind:'child'}` = 变 nodeId 子级（追加末尾）；
 * - `{kind:'sibling'}` = 插为 parentId 的第 index 个子级（core moveNode 直用；
 *   anchorId/position 为落点意图，供测试/调试，页面可忽略。index 为**最终**文档序
 *   index——mindmap 根级落点经侧别仿真修正（见 resolveDropSlot），可能与几何位次
 *   不同，预览与释放共用同一值）；
 * - `null` = 空白 → 页面层移为 root 子级（现状语义）。
 */
export type DropTarget =
  | { kind: 'child'; nodeId: string }
  | {
      kind: 'sibling';
      parentId: string;
      index: number;
      anchorId: string;
      position: 'before' | 'after';
    }
  | null;

/** 落位槽预览（M7c-D3）：松手后节点将出现的盒（场景坐标）+ 预览边两端几何。 */
export interface DropSlotPreview {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 槽所在侧（mindmap 根级 = 侧别仿真结果；非 root = 父级侧；org = 'down'）。 */
  side: NodeBox['side'];
  /** 预览边几何：与 layout.makeEdge 同构（bezier 恒 2 控制点；org 为 elbow）。 */
  edge: { from: Point; to: Point; kind: 'bezier' | 'elbow'; controls?: Point[] };
}

/** 落位槽结算：槽几何 + 最终文档序 index（侧别仿真可能修正几何 index）。 */
export interface DropSlotResolution {
  slot: DropSlotPreview;
  index: number;
}

/**
 * 落位预览结算（M7c-D3 纯函数，从 boxes 计算、不 import layout.ts——不动布局与金样）：
 * 输入 sibling 目标的几何 index，输出落位槽与最终 index；父盒/被拖盒缺失（协同删除
 * 窗口期）返回 null（无预览，释放仍按原 target 结算）。
 *
 * 根级侧别仿真（「松手跳左侧」根治，详见文件头注）：
 * - 子树垂直带 = 子盒 + 全部可见后代盒的 min y..max y（与布局 subtreeH 同源，折叠
 *   子树不在盒集）；带间距自相邻文档序带实测（= 布局 V_GAP），兜底 20；
 * - 半分逻辑逐字复刻 assignMindmapSides：累计带高 + 当前带高过半（>）即自该子树起
 *   全部翻左，首个恒右——因此右侧恒为文档序前缀，同侧插入位 p 可直接映射文档序
 *   index（芯片在右：index=p；在左：index=右侧数+p）；
 * - 几何 index 仿真到对侧 → 在同侧（side === 芯片侧）兄弟中按 y 找最接近芯片 y 的
 *   插入位，并复核仿真——仍到不了芯片侧时如实按仿真侧画槽（所见即所得优先）；
 * - 门控：仅 root 直接子级且现有兄弟含 left 侧（mindmap 双侧文档）仿真；logic 全右
 *   /单侧文档无翻转证据，芯片侧即槽侧、index 按几何。非 root 父级：side=父级侧、
 *   index 按几何（placeHorizontal 后代继承父侧，无重排）。
 *
 * 槽几何：x = 父盒同侧列（水平间距 = 父盒与首个同侧子级的 x 差，兜底 60）；y = 按
 * index 插入同侧兄弟堆——插中间 = 相邻两盒垂直中点；插首 = 首盒上方（首盒 y −
 * 间距/2）但不高于父盒中线；插尾 = 末盒下方对称；无兄弟 = 父盒垂直居中。org
 * （side 'down'）兄弟横排：槽取水平插入位（镜像同款公式），边为竖直 elbow。
 */
export function resolveDropSlot(args: {
  boxes: NodeBox[];
  /** 目标父级的文档子级序（childrenIdsOf）。 */
  childrenIds: string[];
  draggedId: string;
  parentId: string;
  /** resolveTarget 结算的几何 index（同父移除修正后的文档序位次）。 */
  index: number;
  /** 芯片盒（场景坐标左上角 + 被拖盒 w/h）——侧别与最近插入位判定输入。 */
  chipBox: { x: number; y: number; w: number; h: number };
}): DropSlotResolution | null {
  const { boxes, childrenIds, draggedId, parentId, index, chipBox } = args;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const parentBox = byId.get(parentId);
  const draggedBox = byId.get(draggedId);
  if (!parentBox || !draggedBox) return null;

  // parent→children 邻接（盒自带 parentId，反建映射即可算子树带；盒子来自 layout，无环）。
  const kidsOf = new Map<string, NodeBox[]>();
  for (const b of boxes) {
    if (b.parentId === undefined) continue;
    const list = kidsOf.get(b.parentId);
    if (list) list.push(b);
    else kidsOf.set(b.parentId, [b]);
  }
  /** 子树垂直带：盒 + 全部可见后代盒的 min y..max y（= 布局 subtreeH）。 */
  const bandOf = (id: string): { top: number; bottom: number } => {
    const box = byId.get(id);
    if (!box) return { top: 0, bottom: 0 };
    let top = box.y;
    let bottom = box.y + box.h;
    const walk = (nid: string): void => {
      for (const k of kidsOf.get(nid) ?? []) {
        if (k.y < top) top = k.y;
        if (k.y + k.h > bottom) bottom = k.y + k.h;
        walk(k.id);
      }
    };
    walk(id);
    return { top, bottom };
  };
  const bandH = (id: string): number => {
    const band = bandOf(id);
    return band.bottom - band.top;
  };

  // 文档序兄弟堆（去被拖节点；盒缺失跳过）。横向布局下文档序即 y 序（布局单带堆叠）。
  const stack = childrenIds
    .filter((id) => id !== draggedId)
    .map((id) => byId.get(id))
    .filter((b): b is NodeBox => b !== undefined);
  const docPos = new Map(stack.map((b, i) => [b.id, i] as const));
  const gi = Math.max(0, Math.min(index, stack.length));

  // —— org（side 'down'）：兄弟横排，槽取水平插入位，边竖直 elbow ——
  if (parentBox.side === 'down') {
    const parentCx = parentBox.x + parentBox.w / 2;
    const gapX =
      stack.length >= 2
        ? Math.max(
            0,
            Math.min(...stack.slice(1).map((b, i) => b.x - (stack[i]!.x + stack[i]!.w))),
          )
        : V_GAP_FALLBACK;
    const vGap =
      stack.length > 0 ? Math.max(0, stack[0]!.y - (parentBox.y + parentBox.h)) : V_GAP_FALLBACK;
    let cx: number;
    if (stack.length === 0) {
      cx = parentCx;
    } else if (gi === 0) {
      // 首位左侧：不左于父盒水平中线（与横向布局「不高于父盒中线」镜像）。
      cx = Math.max(parentCx, stack[0]!.x - gapX / 2 - draggedBox.w / 2);
    } else if (gi >= stack.length) {
      const last = stack[stack.length - 1]!;
      cx = last.x + last.w + gapX / 2 + draggedBox.w / 2;
    } else {
      const prev = stack[gi - 1]!;
      const next = stack[gi]!;
      cx = (prev.x + prev.w + next.x) / 2;
    }
    const y = parentBox.y + parentBox.h + vGap;
    return {
      index: gi,
      slot: {
        x: cx - draggedBox.w / 2,
        y,
        w: draggedBox.w,
        h: draggedBox.h,
        side: 'down',
        edge: {
          from: { x: parentCx, y: parentBox.y + parentBox.h },
          to: { x: cx, y },
          kind: 'elbow',
        },
      },
    };
  }

  // —— 横向（mindmap/logic）：兄弟纵排，槽在父同侧列 ——
  const chipCx = chipBox.x + chipBox.w / 2;
  const parentCx = parentBox.x + parentBox.w / 2;
  const chipSide: 'left' | 'right' = chipCx >= parentCx ? 'right' : 'left';
  const isRootLevel = parentBox.parentId === undefined;

  /** 带间距：相邻文档序兄弟带实测（= 布局 V_GAP；不可得兜底 20）。 */
  const vGap =
    stack.length >= 2
      ? Math.max(
          0,
          Math.min(
            ...stack.slice(1).map((b, i) => bandOf(b.id).top - bandOf(stack[i]!.id).bottom),
          ),
        )
      : V_GAP_FALLBACK;

  /** 复刻 assignMindmapSides 的半分切分，返回被拖节点插入后的侧别。 */
  const simulateDraggedSide = (insertAt: number): 'left' | 'right' => {
    const ids = stack.map((b) => b.id);
    ids.splice(insertAt, 0, draggedId);
    const heights = ids.map(bandH);
    const total = heights.reduce((s, h) => s + h, 0) + vGap * (ids.length - 1);
    const half = total / 2;
    let cum = 0;
    let flipped = false;
    const sides: Array<'left' | 'right'> = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (!flipped && i > 0 && cum + heights[i]! > half) flipped = true;
      sides.push(flipped ? 'left' : 'right');
      if (!flipped) cum += heights[i]!;
    }
    return sides[ids.indexOf(draggedId)] ?? 'right';
  };

  let finalIndex = gi;
  let side: 'left' | 'right';
  if (isRootLevel && stack.some((b) => b.side === 'left')) {
    let sim = simulateDraggedSide(gi);
    if (sim !== chipSide) {
      // 同侧兄弟按 y 找最接近芯片 y 的插入位（同侧兄弟恒为文档序前缀/后缀：
      // 右侧位 p ↔ index p；左侧位 p ↔ index 右侧数 + p）。
      const sideSibs = stack.filter((b) => b.side === chipSide);
      const chipCy = chipBox.y + chipBox.h / 2;
      let bestP = 0;
      let bestDist = Infinity;
      for (let p = 0; p <= sideSibs.length; p += 1) {
        const cy = insertCenterY(sideSibs, p, draggedBox.h, vGap, parentBox);
        const dist = Math.abs(cy - chipCy);
        if (dist < bestDist) {
          bestDist = dist;
          bestP = p;
        }
      }
      finalIndex = chipSide === 'right' ? bestP : rightCountOf(stack) + bestP;
      sim = simulateDraggedSide(finalIndex); // 复核：仍到不了芯片侧则如实按仿真侧
    }
    side = sim;
  } else if (isRootLevel) {
    side = chipSide; // logic / 单侧 mindmap 根级：无翻转证据，芯片侧即槽侧
  } else {
    side = parentBox.side === 'left' ? 'left' : 'right'; // 非 root：继承父侧
  }

  // 槽所在侧的兄弟列（同父兄弟同侧；根级仿真后 = 最终侧兄弟）。
  const sideSibs = stack.filter((b) => b.side === side);
  const p = sideSibs.filter((b) => (docPos.get(b.id) ?? 0) < finalIndex).length;
  const centerY = insertCenterY(sideSibs, p, draggedBox.h, vGap, parentBox);
  // 水平列间距：父盒与首个同侧子级的 x 差（企微列距实测），无同侧子级兜底 60。
  const firstSib = sideSibs[0];
  const hGap = firstSib
    ? Math.max(
        0,
        side === 'right'
          ? firstSib.x - (parentBox.x + parentBox.w)
          : parentBox.x - (firstSib.x + firstSib.w),
      )
    : H_GAP_FALLBACK;
  const slotX =
    side === 'right' ? parentBox.x + parentBox.w + hGap : parentBox.x - hGap - draggedBox.w;
  const slotY = centerY - draggedBox.h / 2;
  return {
    index: finalIndex,
    slot: {
      x: slotX,
      y: slotY,
      w: draggedBox.w,
      h: draggedBox.h,
      side,
      edge: previewEdge(parentBox, { x: slotX, y: slotY, w: draggedBox.w, h: draggedBox.h }, side),
    },
  };
}

/** 右侧兄弟数（根级左插位的文档序映射基数：右侧恒为文档序前缀）。 */
function rightCountOf(stack: NodeBox[]): number {
  return stack.filter((b) => b.side === 'right').length;
}

/** 第 p 个插入位的槽中心 y（同侧兄弟堆；见 resolveDropSlot 槽几何规则）。 */
function insertCenterY(
  sideSibs: NodeBox[],
  p: number,
  nodeH: number,
  vGap: number,
  parentBox: NodeBox,
): number {
  const parentMid = parentBox.y + parentBox.h / 2;
  if (sideSibs.length === 0) return parentMid; // 无兄弟：父盒垂直居中
  if (p === 0) {
    // 首位上方：不高于父盒中线（槽不跑到父级头顶之上）。
    return Math.max(sideSibs[0]!.y - vGap / 2, parentMid);
  }
  if (p >= sideSibs.length) {
    const last = sideSibs[sideSibs.length - 1]!;
    return last.y + last.h + vGap / 2 + nodeH / 2; // 插尾：末盒下方（对称处理）
  }
  const prev = sideSibs[p - 1]!;
  const next = sideSibs[p]!;
  return (prev.y + prev.h + next.y) / 2; // 插中间：相邻两盒垂直中点
}

/** 预览边几何：与 layout.makeEdge 同公式（父盒边中点 → 槽盒边中点，控制点水平外伸 dx/2）。 */
function previewEdge(
  parentBox: NodeBox,
  slot: { x: number; y: number; w: number; h: number },
  side: 'left' | 'right',
): DropSlotPreview['edge'] {
  const right = side !== 'left';
  const from: Point = {
    x: right ? parentBox.x + parentBox.w : parentBox.x,
    y: parentBox.y + parentBox.h / 2,
  };
  const to: Point = { x: right ? slot.x : slot.x + slot.w, y: slot.y + slot.h / 2 };
  const extend = Math.abs(to.x - from.x) * 0.5;
  return {
    from,
    to,
    kind: 'bezier',
    controls: [
      { x: from.x + (right ? extend : -extend), y: from.y },
      { x: to.x + (right ? -extend : extend), y: to.y },
    ],
  };
}

/** 依赖注入：坐标换算与落点写参数由页面侧提供。 */
export interface DragControllerDeps {
  svg: SVGSVGElement;
  viewport: Viewport;
  /** 当前布局节点盒（场景坐标；每次命中检测实时取，拖拽中可被重布局刷新）。 */
  getBoxes(): NodeBox[];
  /** 释放回调：target 见 {@link DropTarget}（空白 null → 页面层 moveNode(id,'root')）。 */
  onDrop(id: string, target: DropTarget): void;
  /** candidateId 是否为 id 的后代（含间接）——后代不可作为落点锚（禁止目标）。 */
  isDescendant(id: string, candidateId: string): boolean;
  /** 文档子级序（页面适配 core childrenIds）：sibling 落点 index 结算输入（事务外纯计算）。 */
  childrenIdsOf(nodeId: string): string[];
  /** 场景坐标悬浮层：芯片/预览边/落位槽宿主（页面在视口 wrapper 内 nodesLayer 之上的 <g>）。 */
  overlayLayer: SVGGElement;
  /** 可选：id 是否允许被换父（页面级门控，如只读态）；缺省允许。 */
  canReparent?(id: string): boolean;
}

/** 拖拽进行中的公开快照（供页面绘制 ghost；offset 为指针场景点 − 盒左上角）。 */
export interface DragSnapshot {
  id: string;
  offsetX: number;
  offsetY: number;
}

/** 落点比较键：落点切换（含同一节点本体↔边缘带互切）即重置反馈计时。 */
function placementKey(p: DropPlacement | null): string | null {
  if (!p) return null;
  return p.kind === 'child' ? `child:${p.nodeId}` : `sibling:${p.anchorId}:${p.position}`;
}

/** 数值 → 属性串：两位小数去尾零（与 render.ts fmt 同口径，输出确定）。 */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * 一次落点结算的完整产物——预览与释放共用的单一计算路径（M7c-D3 一致性裁决：
 * classify→resolve→槽只算一次，释放直接复用，禁止两算分叉）。
 */
interface ResolvedDrop {
  placement: DropPlacement | null;
  forbiddenId: string | null;
  target: DropTarget;
  slot: DropSlotPreview | null;
}

/** 芯片文字宽度估算（无测量适配器）：CJK/全角按 1em、其余按 0.55em 近似。 */
function labelWidthOf(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += fontSize * (ch.charCodeAt(0) > 0xff ? 1 : 0.55);
  return w;
}

/** 芯片文字超宽省略（贪心截断 + 省略号）。 */
function truncateLabel(label: string, maxWidth: number, fontSize: number): string {
  if (labelWidthOf(label, fontSize) <= maxWidth) return label;
  let out = label;
  while (out.length > 0 && labelWidthOf(`${out}…`, fontSize) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

export class DragController {
  private deps: DragControllerDeps | null = null;
  private attached = false;
  /** 阈值前候选：已按下但未激活。 */
  private candidate: { id: string; x: number; y: number; pointerId: number } | null = null;
  /** 激活中的拖拽。 */
  private drag: { id: string; pointerId: number; offsetX: number; offsetY: number } | null = null;
  /** 当前悬停落点（比较键见 placementKey）；空白/禁止为 null。 */
  private hoverPlacement: DropPlacement | null = null;
  /** 落点反馈的 100ms 点亮定时器（离开/切换/结束即撤销）。 */
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** 反馈是否已点亮（点亮后逐帧随 pending 刷新预览，保持与芯片一致）。 */
  private lit = false;
  /** 当前被标 drop-forbidden 的节点 id（自身或后代）。 */
  private hoverForbidden: string | null = null;
  /** 被拖节点当前挂 gm-dragging/gm-drag-origin 的 id（激活挂上、clearHighlights 摘除）。 */
  private draggingVisualId: string | null = null;
  /**
   * 最后一帧落点结算缓存（classify→resolve→槽一次算成）：预览元素由此绘制，释放
   * 直接复用（释放点 = 缓存点时）——预览与落点永不分叉（M7c-D3 一致性裁决）。
   */
  private pending: { at: Point; resolved: ResolvedDrop } | null = null;
  /** 跟随芯片（g.gm-drag-ghost：圆角矩形 + 居中文字；悬浮层场景坐标）。 */
  private ghost: SVGGElement | null = null;
  /** 落位预览边（path.gm-drop-edge）与落位槽（rect.gm-drop-slot）。 */
  private dropEdge: SVGPathElement | null = null;
  private dropSlot: SVGRectElement | null = null;
  /** 候选/拖拽期间挂着的 window 级兜底监听标记。 */
  private windowBound = false;
  /** 已成功捕获的 pointerId（null = 未捕获）；finish/destroy 释放。 */
  private capturedPointerId: number | null = null;

  /** 拖拽进行中的快照；未拖拽为 null。 */
  get dragging(): DragSnapshot | null {
    return this.drag ? { id: this.drag.id, offsetX: this.drag.offsetX, offsetY: this.drag.offsetY } : null;
  }

  /** 绑定指针监听（幂等；可传新 deps 复用）。 */
  attach(deps: DragControllerDeps): void {
    if (this.attached) {
      this.deps = deps;
      return;
    }
    this.attached = true;
    this.deps = deps;
    deps.svg.addEventListener('pointerdown', this.onPointerDown);
    deps.svg.addEventListener('pointermove', this.onPointerMove);
    deps.svg.addEventListener('pointerup', this.onPointerUp);
    deps.svg.addEventListener('pointercancel', this.onPointerCancel);
  }

  /** 解绑全部监听、释放指针捕获并中止进行中的拖拽（不触发 onDrop；幂等）。 */
  destroy(): void {
    if (this.deps) {
      this.deps.svg.removeEventListener('pointerdown', this.onPointerDown);
      this.deps.svg.removeEventListener('pointermove', this.onPointerMove);
      this.deps.svg.removeEventListener('pointerup', this.onPointerUp);
      this.deps.svg.removeEventListener('pointercancel', this.onPointerCancel);
    }
    this.clearHighlights();
    this.releaseCapture();
    this.unbindWindowFallback();
    this.deps = null;
    this.attached = false;
    this.candidate = null;
    this.drag = null;
    this.pending = null; // 结算缓存随销毁作废（复用 attach 从干净态开始）
  }

  // -------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps || this.candidate || this.drag) return;
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    // 折叠徽标（嵌于节点 g 内）优先排除：徽标点击归页面层。
    if (target?.closest('[data-for-id]')) return;
    // 标记徽标（M7b-W3 点击换组）：同折叠徽标让位纪律——徽标上的按下不进节点
    // 拖拽候选（click 归页面层「点徽章弹同组选盘」）。
    if (target?.closest('[data-marker-group]')) return;
    const g = target?.closest('[data-node-id]');
    if (!g) return;
    const id = g.getAttribute('data-node-id');
    if (!id) return;
    // 原生文字拖选根治（M7c-D1）：取消 pointerdown 默认动作——文本选择不再起锚、
    // 兼容 mousedown 不派发；click/dblclick 合成不受影响（页面点击链路不变）。
    e.preventDefault();
    this.candidate = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    // 候选期尚未捕获指针：svg 外释放只在 window 上可见，兜底防候选卡死。
    this.bindWindowFallback();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const scene = deps.viewport.toSceneFromEvent(e);
      this.updateGhost(scene); // 芯片逐帧跟随（不受 100ms 反馈门控）
      this.updateHover(scene);
      return;
    }
    if (!this.candidate || e.pointerId !== this.candidate.pointerId) return;
    const dist = Math.hypot(e.clientX - this.candidate.x, e.clientY - this.candidate.y);
    if (dist < DRAG_THRESHOLD_PX) return;
    this.activate(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.candidate && e.pointerId === this.candidate.pointerId) {
      this.candidate = null; // 未激活即抬起：click，不做任何事
      this.unbindWindowFallback();
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const id = this.drag.id;
    const scene = deps.viewport.toSceneFromEvent(e);
    // 释放结算（M7c-D3 一致性）：常态（释放点 = 最后悬停点）直接复用最后一帧缓存
    // ——所见即所提；仅释放点 ≠ 缓存点（svg 外兜底释放等）才用同一函数现算。
    const resolved =
      this.pending !== null && this.pending.at.x === scene.x && this.pending.at.y === scene.y
        ? this.pending.resolved
        : this.computeResolved(scene, this.classifyAt(scene.x, scene.y, id));
    if (resolved.forbiddenId !== null) {
      this.finish();
      return; // 自身/自身后代：静默取消（fix round 1 裁决沿用）
    }
    this.finish();
    deps.onDrop(id, resolved.target); // 空白 null / child / sibling（含快速释放——见头注）
  };

  private onPointerCancel = (): void => {
    if (!this.candidate && !this.drag) return;
    this.finish();
  };

  /** 过阈值：登记拖拽与 ghost 偏移（可选门控 canReparent 不放行则保持候选不激活）。 */
  private activate(e: PointerEvent): void {
    const deps = this.deps;
    const cand = this.candidate;
    if (!deps || !cand) return;
    if (deps.canReparent && !deps.canReparent(cand.id)) {
      this.candidate = null;
      this.unbindWindowFallback();
      return;
    }
    // 激活即再抑制一次默认动作（拖选拖拽等），与 pointerdown 的抑制双保险。
    e.preventDefault();
    const scene = deps.viewport.toSceneFromEvent(e);
    const box = deps.getBoxes().find((b) => b.id === cand.id);
    // 抓取偏移 = 按下点 − 被拖盒左上角（M7c-D3 企微口径：芯片从原位无跳变起步，
    // 随后逐帧贴指针）。按下点用候选登记时的 client 坐标换算（与 toSceneFromEvent
    // 同一套 rect 数学），不用激活 move 点——慢起手时二者可差很远。
    const rect = deps.svg.getBoundingClientRect();
    const downScene = deps.viewport.toScene(cand.x - rect.left, cand.y - rect.top);
    this.drag = {
      id: cand.id,
      pointerId: cand.pointerId,
      offsetX: box ? downScene.x - box.x : 0,
      offsetY: box ? downScene.y - box.y : 0,
    };
    this.candidate = null;
    // 被拖节点视觉反馈（企微「提起」）：gm-dragging（半透明/cursor）+ gm-drag-origin
    // （虚线占位）并挂，视觉由页面 CSS 落地；摘除统一走 clearHighlights，任何路径
    // 不残留。芯片逐帧定位（指针 − 抓取偏移，芯片不跳变）。
    this.draggingVisualId = cand.id;
    this.setClass(cand.id, 'gm-dragging', true);
    this.setClass(cand.id, 'gm-drag-origin', true);
    this.createGhost(cand.id);
    this.updateGhost(scene);
    if (typeof deps.svg.setPointerCapture === 'function') {
      try {
        deps.svg.setPointerCapture(e.pointerId);
        this.capturedPointerId = e.pointerId;
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 + window 兜底（Task 7 先例） */
      }
    }
    this.updateHover(scene);
  }

  /** 结束拖拽：清反馈、移芯片/预览、释放捕获、卸 window 兜底（onDrop 由调用方决定）。 */
  private finish(): void {
    this.clearHighlights();
    this.pending = null;
    this.candidate = null;
    this.drag = null;
    this.releaseCapture();
    this.unbindWindowFallback();
  }

  private releaseCapture(): void {
    const svg = this.deps?.svg;
    if (
      this.capturedPointerId !== null &&
      svg &&
      typeof svg.releasePointerCapture === 'function'
    ) {
      try {
        svg.releasePointerCapture(this.capturedPointerId);
      } catch {
        /* 指针可能已释放 */
      }
    }
    this.capturedPointerId = null;
  }

  private bindWindowFallback(): void {
    if (this.windowBound) return;
    this.windowBound = true;
    // svg 内释放会先冒泡过 svg 处理器（状态已清），此兜底处理器成 no-op。
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
  }

  private unbindWindowFallback(): void {
    if (!this.windowBound) return;
    this.windowBound = false;
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
  }

  /**
   * 场景点落点分类（M7c-D1 三分）：命中最先匹配的盒（getBoxes 序；盒不重叠）。
   * - 自身/后代 → forbiddenId（整盒含边缘带一律禁止，fix round 1）；
   * - 根（无 parentId）→ 整盒 = 变其子级（根不可作兄弟锚点）；
   * - 其余按边缘插入带切分：横向布局（side left/right，兄弟纵排）取上下 25% 带，
   *   org（side 'down'，兄弟横排）取左右 25% 带；带内 = sibling(before/after)，
   *   带外本体 = child。
   * - 未命中任何盒 → 空白（placement/forbiddenId 双 null）。
   */
  private classifyAt(
    sceneX: number,
    sceneY: number,
    draggedId: string,
  ): { placement: DropPlacement | null; forbiddenId: string | null } {
    const deps = this.deps;
    if (!deps) return { placement: null, forbiddenId: null };
    for (const b of deps.getBoxes()) {
      if (sceneX < b.x || sceneX > b.x + b.w || sceneY < b.y || sceneY > b.y + b.h) continue;
      if (b.id === draggedId || deps.isDescendant(draggedId, b.id)) {
        return { placement: null, forbiddenId: b.id };
      }
      if (b.parentId === undefined) {
        return { placement: { kind: 'child', nodeId: b.id }, forbiddenId: null };
      }
      const vertical = b.side === 'down';
      const rel = vertical ? (sceneX - b.x) / b.w : (sceneY - b.y) / b.h;
      if (rel < SIBLING_BAND_RATIO || rel > 1 - SIBLING_BAND_RATIO) {
        return {
          placement: {
            kind: 'sibling',
            anchorId: b.id,
            position: rel < SIBLING_BAND_RATIO ? 'before' : 'after',
          },
          forbiddenId: null,
        };
      }
      return { placement: { kind: 'child', nodeId: b.id }, forbiddenId: null };
    }
    return { placement: null, forbiddenId: null };
  }

  /**
   * 释放结算：把几何落点换算成文档写参数（纪律#2：纯计算，事务之外）。
   * sibling 的 index = 锚点在 childrenIdsOf(parentId) 的位次（before 取本位、after
   * 取下一位）；同父移动因 moveNode 先移除后插入，移除位次在结算位次之前时 index
   * −1 修正。锚点不在文档序（协同删除窗口期/桩不一致）→ 降级为变其子级，由 core
   * 校验兜底（拒绝即抛错走页面 toast）。sibling 另经 resolveDropSlot 侧别仿真：
   * mindmap 根级落点仿真到对侧时修正 index（预览与释放共用同一修正值）。
   */
  private resolveTarget(draggedId: string, placement: DropPlacement | null): DropTarget {
    const deps = this.deps;
    if (!deps || placement === null) return null;
    if (placement.kind === 'child') return { kind: 'child', nodeId: placement.nodeId };
    const anchor = deps.getBoxes().find((b) => b.id === placement.anchorId);
    if (!anchor || anchor.parentId === undefined) {
      return { kind: 'child', nodeId: placement.anchorId };
    }
    const parentId = anchor.parentId;
    const siblings = deps.childrenIdsOf(parentId);
    const anchorIdx = siblings.indexOf(anchor.id);
    if (anchorIdx === -1) return { kind: 'child', nodeId: anchor.id };
    let index = placement.position === 'before' ? anchorIdx : anchorIdx + 1;
    const dragged = deps.getBoxes().find((b) => b.id === draggedId);
    if (dragged && dragged.parentId === parentId) {
      const curIdx = siblings.indexOf(draggedId);
      if (curIdx !== -1 && curIdx < index) index -= 1; // 先移除自身：后续位次前移
    }
    return { kind: 'sibling', parentId, index, anchorId: anchor.id, position: placement.position };
  }

  /**
   * 单一结算路径（M7c-D3）：classify 结果 → resolveTarget → 落位槽（含根级侧别
   * 仿真修正）。预览绘制与释放提交都只消费本函数产物——同点必同果。
   */
  private computeResolved(
    scene: Point,
    hit: { placement: DropPlacement | null; forbiddenId: string | null },
  ): ResolvedDrop {
    const deps = this.deps;
    const drag = this.drag;
    if (!deps || !drag) {
      return { placement: hit.placement, forbiddenId: hit.forbiddenId, target: null, slot: null };
    }
    let target = this.resolveTarget(drag.id, hit.placement);
    let slot: DropSlotPreview | null = null;
    if (target !== null && target.kind === 'sibling') {
      const boxes = deps.getBoxes();
      const draggedBox = boxes.find((b) => b.id === drag.id);
      if (draggedBox) {
        const resolution = resolveDropSlot({
          boxes,
          childrenIds: deps.childrenIdsOf(target.parentId),
          draggedId: drag.id,
          parentId: target.parentId,
          index: target.index,
          chipBox: {
            x: scene.x - drag.offsetX,
            y: scene.y - drag.offsetY,
            w: draggedBox.w,
            h: draggedBox.h,
          },
        });
        if (resolution === null) {
          slot = null; // 父盒/被拖盒缺失：无预览，释放仍按原 target 结算
        } else {
          if (resolution.index !== target.index) {
            // 侧别仿真修正（不跳左）：槽展示与释放提交用同一修正后 index。
            target = { ...target, index: resolution.index };
          }
          slot = resolution.slot;
        }
      }
    }
    return { placement: hit.placement, forbiddenId: hit.forbiddenId, target, slot };
  }

  /** 悬停反馈状态机：落点切换立即摘除旧反馈并重置计时；满 100ms 点亮；禁止即时。 */
  private updateHover(scene: Point): void {
    const drag = this.drag;
    if (!drag) return;
    const hit = this.classifyAt(scene.x, scene.y, drag.id);
    if (placementKey(hit.placement) !== placementKey(this.hoverPlacement)) {
      this.clearTargetFeedback(); // 离开/切换：立即摘除 + 撤销未触发的点亮定时器
      this.hoverPlacement = hit.placement;
      if (hit.placement !== null) {
        this.hoverTimer = setTimeout(() => {
          this.hoverTimer = null;
          if (placementKey(this.hoverPlacement) === placementKey(hit.placement)) {
            this.applyFeedback();
          }
        }, DROP_HOVER_MS);
      }
    }
    // 单一结算路径逐帧刷新（含同落点内移动：芯片位置实时影响槽位/侧别修正），
    // 释放取最后一帧——与所见严格一致。
    this.pending = { at: scene, resolved: this.computeResolved(scene, hit) };
    // 已点亮的反馈随结算逐帧刷新（槽/边跟随芯片；child 高亮类幂等）。
    if (this.lit && this.hoverPlacement !== null) this.applyFeedback();
    // 自身/后代的禁止反馈即时显隐，不参与 100ms 延迟。
    if (hit.forbiddenId !== this.hoverForbidden) {
      this.setClass(this.hoverForbidden, 'drop-forbidden', false);
      this.hoverForbidden = hit.forbiddenId;
      if (hit.forbiddenId !== null) this.setClass(hit.forbiddenId, 'drop-forbidden', true);
    }
  }

  /** 点亮落点反馈：child=目标盒描边高亮（.drop-target）；sibling=真实边 + 落位槽。 */
  private applyFeedback(): void {
    const p = this.hoverPlacement;
    if (!p || !this.pending) return;
    this.lit = true;
    if (p.kind === 'child') {
      this.setClass(p.nodeId, 'drop-target', true);
      return;
    }
    this.drawDropPreview();
  }

  /** 摘除落点反馈：清定时器、去类/移预览元素、复位点亮标记与落点。 */
  private clearTargetFeedback(): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    const p = this.hoverPlacement;
    if (p && p.kind === 'child') this.setClass(p.nodeId, 'drop-target', false);
    this.removeDropPreview();
    this.lit = false;
    this.hoverPlacement = null;
  }

  /**
   * 跟随芯片（企微「拾起」）：被拖节点盒大小的白底圆角矩形（企微蓝描边 1.5px）+
   * 居中文字（被拖节点文本，超宽省略）。挂悬浮层（场景坐标——与槽/边同坐标系，
   * 缩放平移下视觉一致；该层在 nodesLayer 之上即画布视觉顶层）。文字/圆角取自被
   * 拖节点 DOM（按属性值精确匹配扫描，规避 id 选择器转义问题）。
   */
  private createGhost(id: string): void {
    const deps = this.deps;
    if (!deps || this.ghost) return;
    const box = deps.getBoxes().find((b) => b.id === id);
    if (!box) return;
    let sourceText: SVGTextElement | null = null;
    let rx = '8';
    const all = deps.svg.querySelectorAll<SVGGElement>('[data-node-id]');
    for (let i = 0; i < all.length; i += 1) {
      if (all[i]!.getAttribute('data-node-id') === id) {
        sourceText = all[i]!.querySelector('text.gm-text');
        rx = all[i]!.querySelector('rect')?.getAttribute('rx') ?? rx;
        break;
      }
    }
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'gm-drag-ghost');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '0');
    rect.setAttribute('width', fmt(box.w));
    rect.setAttribute('height', fmt(box.h));
    rect.setAttribute('rx', rx);
    rect.setAttribute('fill', '#ffffff');
    rect.setAttribute('stroke', ACCENT);
    rect.setAttribute('stroke-width', '1.5');
    g.appendChild(rect);
    // 行集合并（多行空格连接）作芯片单行文案；无文字节点（桩/异常）则只有矩形。
    const label = sourceText
      ? Array.from(sourceText.children)
          .map((t) => t.textContent ?? '')
          .join(' ')
          .trim() || (sourceText.textContent ?? '').trim()
      : '';
    if (label !== '') {
      const fontSize = parseFloat(sourceText?.getAttribute('font-size') ?? '14') || 14;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', fmt(box.w / 2));
      text.setAttribute('y', fmt(box.h / 2 + fontSize * 0.35));
      text.setAttribute('text-anchor', 'middle');
      const family = sourceText?.getAttribute('font-family');
      const fill = sourceText?.getAttribute('fill');
      if (family) text.setAttribute('font-family', family);
      if (fill) text.setAttribute('fill', fill);
      text.setAttribute('font-size', fmt(fontSize));
      text.textContent = truncateLabel(label, box.w - 16, fontSize);
      g.appendChild(text);
    }
    deps.overlayLayer.appendChild(g);
    this.ghost = g;
  }

  /** 芯片逐帧定位：指针场景点 − 抓取偏移（= 按下点 − 被拖盒左上角，芯片不跳变）。 */
  private updateGhost(scene: Point): void {
    const drag = this.drag;
    if (!this.ghost || !drag) return;
    this.ghost.setAttribute(
      'transform',
      `translate(${fmt(scene.x - drag.offsetX)}, ${fmt(scene.y - drag.offsetY)})`,
    );
  }

  private removeGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }

  /**
   * 落位预览（M7c-D3 核心）：`path.gm-drop-edge`（候选父盒边中点 → 槽盒边中点，
   * render.ts 同款 bezier/elbow 公式——松手后就是这条边；描边色取画布既有连线，
   * 取不到兜底灰）+ `rect.gm-drop-slot`（槽位虚线圆角框，企微蓝淡填充）。
   */
  private drawDropPreview(): void {
    const deps = this.deps;
    const pending = this.pending;
    if (!deps || !pending || pending.resolved.slot === null) return;
    const slot = pending.resolved.slot;
    if (!this.dropSlot) {
      this.dropSlot = document.createElementNS(SVG_NS, 'rect');
      this.dropSlot.setAttribute('class', 'gm-drop-slot');
      deps.overlayLayer.appendChild(this.dropSlot);
    }
    this.dropSlot.setAttribute('x', fmt(slot.x));
    this.dropSlot.setAttribute('y', fmt(slot.y));
    this.dropSlot.setAttribute('width', fmt(slot.w));
    this.dropSlot.setAttribute('height', fmt(slot.h));
    this.dropSlot.setAttribute(
      'rx',
      deps.svg.querySelector('[data-node-id] rect')?.getAttribute('rx') ?? '8',
    );
    this.dropSlot.setAttribute('fill', 'rgba(51, 112, 255, 0.06)');
    this.dropSlot.setAttribute('stroke', ACCENT);
    this.dropSlot.setAttribute('stroke-width', '1.5');
    this.dropSlot.setAttribute('stroke-dasharray', '5 4');
    if (!this.dropEdge) {
      this.dropEdge = document.createElementNS(SVG_NS, 'path');
      this.dropEdge.setAttribute('class', 'gm-drop-edge');
      deps.overlayLayer.appendChild(this.dropEdge);
    }
    this.dropEdge.setAttribute('d', this.edgePathD(slot.edge));
    this.dropEdge.setAttribute(
      'stroke',
      deps.svg.querySelector('path[data-edge-id]')?.getAttribute('stroke') ?? EDGE_COLOR_FALLBACK,
    );
    this.dropEdge.setAttribute('stroke-width', '2');
  }

  /** 边 path d：与 render.ts edgeD 同公式——预览边与真实连线同形（验收口径）。 */
  private edgePathD(edge: DropSlotPreview['edge']): string {
    const { from, to } = edge;
    if (edge.kind === 'bezier') {
      const c1 = edge.controls?.[0] ?? from;
      const c2 = edge.controls?.[1] ?? to;
      return `M ${fmt(from.x)} ${fmt(from.y)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`;
    }
    const mid = (from.y + to.y) / 2;
    return `M ${fmt(from.x)} ${fmt(from.y)} L ${fmt(from.x)} ${fmt(mid)} L ${fmt(to.x)} ${fmt(mid)} L ${fmt(to.x)} ${fmt(to.y)}`;
  }

  private removeDropPreview(): void {
    this.dropEdge?.remove();
    this.dropEdge = null;
    this.dropSlot?.remove();
    this.dropSlot = null;
  }

  private clearHighlights(): void {
    this.clearTargetFeedback();
    this.setClass(this.hoverForbidden, 'drop-forbidden', false);
    this.hoverForbidden = null;
    // 被拖节点反馈兜底摘除：finish/destroy 全走这里（激活与收尾配对，见头注）。
    this.setClass(this.draggingVisualId, 'gm-dragging', false);
    this.setClass(this.draggingVisualId, 'gm-drag-origin', false);
    this.draggingVisualId = null;
    // 芯片/预览兜底移除：任何结束路径（释放/取消/destroy/svg 外 pointerup）不残留。
    this.removeGhost();
    this.removeDropPreview();
  }

  private setClass(id: string | null, cls: string, on: boolean): void {
    const svg = this.deps?.svg;
    if (!svg || id === null) return;
    // 按属性值精确匹配（不用选择器插值，避免 id 含特殊字符时的转义问题）。
    const all = svg.querySelectorAll<SVGGElement>('[data-node-id]');
    for (let i = 0; i < all.length; i += 1) {
      const g = all[i] as SVGGElement;
      if (g.getAttribute('data-node-id') === id) {
        if (on) g.classList.add(cls);
        else g.classList.remove(cls);
        return;
      }
    }
  }
}
