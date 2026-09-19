/**
 * 选择模型 / 框选 / 方向键几何导航（M1b Task 8，FR-EDT-006/008）。
 *
 * 绑定裁决：
 * - 全部几何在 SCENE 坐标（页面用 viewport.toScene 换算后再传入），本模块不做视口换算。
 * - SelectionModel.onChange 只在「选择集实际发生变化」时触发一次，参数为副本；
 *   框选拖动过程（beginMarquee/updateMarquee）不触发——矩形由页面自绘，
 *   endMarquee 一次性替换选区（相交即入选，含边界，FR-EDT-008）。
 * - navigate 为纯函数：候选 = 前向投影距离 dc > 4px 容差、且在移动轴上与当前盒
 *   「完全让位」（无重叠，同带兄弟/同带节点不算方向目标）者；按
 *   (dc, lateralPenalty, 文档序) 取最小——primary = 方向前向距离，secondary = 横向
 *   偏移惩罚（lateral > 80 记双倍）。结构细化：
 *     · mindmap 上下移动限同侧（side 字段；跨侧垂直移动使人迷失）；
 *     · org 左右移动限同层（depth 相等，即兄弟带内移动）。
 *   规格中 (lateralPenalty, forward) 若按字面以惩罚为主键，则「root 向右 → 一级子」
 *   在金样几何上即不成立（孙子节点 lateral 更小必胜），故采 primary=forward 的文字
 *   为主键、lateralPenalty 为次键（同距时横向惩罚才参与，org 子向上寻父正是此情形）。
 * - 无候选返回 null（无匹配不动）；null 焦点回 'root'。
 * - siblingEnd 依 NodeBox.parentId（Task 8 起布局回填，根无此字段）取同级首末；
 *   boxes 为先序文档序，同级在其间连续出现，过滤保序即文档序。
 */
import type { NodeBox, StructureType } from './types';

/** 方向键方向（场景几何方向，非文档语义）。 */
export type Direction = 'up' | 'down' | 'left' | 'right';

/** 前向 4px 容差：投影距离不超过它不算「在该方向上」。 */
const FORWARD_TOLERANCE = 4;
/** 横向偏移超过此值记双倍惩罚（绑定裁决）。 */
const LATERAL_PENALTY_THRESHOLD = 80;
/** 浮点比较容差（边界相接仍算完全让位/相交）。 */
const EPS = 1e-6;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function centerOf(b: NodeBox): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

function boxRect(b: NodeBox): Rect {
  return { x: b.x, y: b.y, w: b.w, h: b.h };
}

/** 矩形相交（含边界相接，FR-EDT-008 相交即入选）。 */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
}

/**
 * 多选模型：selected 为只读视图；onChange 在每次实际变化后以副本触发一次
 * （框选拖动过程除外）。全部方法接收/维护 SCENE 坐标。
 */
export class SelectionModel {
  private readonly ids = new Set<string>();
  private marqueeAnchor: { x: number; y: number } | null = null;
  private marqueeCurrent: { x: number; y: number } | null = null;

  /** 选择变化回调（可随时赋值/替换；参数为副本，外部改动不回灌模型）。 */
  onChange?: (selected: Set<string>) => void;

  /** 当前选中集（只读视图）。 */
  get selected(): ReadonlySet<string> {
    return this.ids;
  }

  /** 是否正在框选拖动中。 */
  get isMarquee(): boolean {
    return this.marqueeAnchor !== null;
  }

  private emit(): void {
    if (this.onChange) this.onChange(new Set(this.ids));
  }

  /** 整体替换选区；内容（集合意义，与顺序无关）未变则不触发。返回是否发生变化。 */
  private replace(next: Iterable<string>): boolean {
    const incoming = next instanceof Set ? next : new Set(next);
    if (incoming.size === this.ids.size) {
      let same = true;
      for (const id of incoming) {
        if (!this.ids.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }
    this.ids.clear();
    for (const id of incoming) this.ids.add(id);
    return true;
  }

  /** 整体替换选区。 */
  set(ids: string[]): void {
    if (this.replace(ids)) this.emit();
  }

  /** 单选替换。 */
  selectOnly(id: string): void {
    if (this.replace([id])) this.emit();
  }

  /** 加减选：在集中则移除，不在则加入（恒为变化，恒触发）。 */
  toggle(id: string): void {
    if (this.ids.has(id)) this.ids.delete(id);
    else this.ids.add(id);
    this.emit();
  }

  /** 清空（空上清空为无操作）。 */
  clear(): void {
    if (this.ids.size === 0) return;
    this.ids.clear();
    this.emit();
  }

  /** 开始框选（锚点，SCENE 坐标）。 */
  beginMarquee(sceneX: number, sceneY: number): void {
    this.marqueeAnchor = { x: sceneX, y: sceneY };
    this.marqueeCurrent = { x: sceneX, y: sceneY };
  }

  /** 拖动更新（仅记录矩形，不触发 onChange——页面自绘）。 */
  updateMarquee(sceneX: number, sceneY: number): void {
    if (!this.marqueeAnchor) return;
    this.marqueeCurrent = { x: sceneX, y: sceneY };
  }

  /** 当前框选矩形（归一化：x/y 为左上角）；未在拖动中为 null。 */
  marqueeRect(): Rect | null {
    if (!this.marqueeAnchor || !this.marqueeCurrent) return null;
    const a = this.marqueeAnchor;
    const c = this.marqueeCurrent;
    return {
      x: Math.min(a.x, c.x),
      y: Math.min(a.y, c.y),
      w: Math.abs(c.x - a.x),
      h: Math.abs(c.y - a.y),
    };
  }

  /**
   * 结束框选：bbox 与矩形相交（含边界）者入选，整体替换旧选区并触发 onChange；
   * 返回按 boxes 文档序的入选 id。未 begin 过则为无操作（返回当前选区）。
   */
  endMarquee(boxes: NodeBox[]): string[] {
    if (!this.marqueeAnchor) return [...this.ids];
    const rect = this.marqueeRect() as Rect;
    this.marqueeAnchor = null;
    this.marqueeCurrent = null;
    const hits: string[] = [];
    for (const b of boxes) {
      if (rectsIntersect(boxRect(b), rect)) hits.push(b.id);
    }
    if (this.replace(hits)) this.emit();
    return hits;
  }
}

/**
 * 方向键几何导航（FR-EDT-006）：从 currentId 出发，返回结构几何方向 d 上
 * 「前向最近、横向偏移最小」的节点 id；无候选（或焦点不在盒集）返回 null，
 * null 焦点回 'root'。boxes 为布局产出的场景坐标盒（先序文档序，用于稳定平局）。
 */
export function navigate(
  currentId: string | null,
  direction: Direction,
  boxes: NodeBox[],
  structure: StructureType,
): string | null {
  if (currentId === null) return 'root';
  const myIndex = boxes.findIndex((b) => b.id === currentId);
  if (myIndex < 0) return null;
  const my = boxes[myIndex] as NodeBox;
  const myCenter = centerOf(my);

  const vertical = direction === 'up' || direction === 'down';
  const forwardSign = direction === 'right' || direction === 'down' ? 1 : -1;
  const axis = vertical ? ('y' as const) : ('x' as const);
  const lateralAxis = vertical ? ('x' as const) : ('y' as const);

  let best: { id: string; dc: number; penalty: number; index: number } | null = null;
  for (let i = 0; i < boxes.length; i += 1) {
    const cand = boxes[i] as NodeBox;
    if (cand.id === my.id) continue;
    // 结构细化：mindmap 上下限同侧；org 左右限同层（兄弟带）。
    if (structure === 'mindmap' && vertical && cand.side !== my.side) continue;
    if (structure === 'org' && !vertical && cand.depth !== my.depth) continue;

    const candCenter = centerOf(cand);
    const dc = (candCenter[axis] - myCenter[axis]) * forwardSign;
    if (dc <= FORWARD_TOLERANCE) continue; // 必须严格前向（4px 容差）
    // 移动轴上完全让位（无重叠）：同带节点不算方向目标。
    if (vertical) {
      const clear = forwardSign > 0 ? cand.y >= my.y + my.h - EPS : cand.y + cand.h <= my.y + EPS;
      if (!clear) continue;
    } else {
      const clear =
        forwardSign > 0 ? cand.x >= my.x + my.w - EPS : cand.x + cand.w <= my.x + EPS;
      if (!clear) continue;
    }

    const lateral = Math.abs(candCenter[lateralAxis] - myCenter[lateralAxis]);
    const penalty = lateral > LATERAL_PENALTY_THRESHOLD ? lateral * 2 : lateral;
    if (
      best === null ||
      dc < best.dc ||
      (dc === best.dc && (penalty < best.penalty || (penalty === best.penalty && i < best.index)))
    ) {
      best = { id: cand.id, dc, penalty, index: i };
    }
  }
  return best !== null ? best.id : null;
}

/**
 * Home/End 同级首末：与 currentId 同 parentId 的节点中，按 boxes 文档序
 * （先序 = mindmap/logic 纵向序、org 横向序）取首个/末个；根与未知 id 返回 null。
 */
export function siblingEnd(currentId: string, boxes: NodeBox[], which: 'first' | 'last'): string | null {
  const my = boxes.find((b) => b.id === currentId);
  if (!my || my.parentId === undefined) return null;
  const siblings = boxes.filter((b) => b.parentId === my.parentId);
  if (siblings.length === 0) return null;
  const target = which === 'first' ? siblings[0] : siblings[siblings.length - 1];
  return (target as NodeBox).id;
}
