import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { StructureType } from '@gmind/shared';
import {
  MAX_CANVAS_NAME_LENGTH,
  canvasOrderArr,
  canvasesMap,
} from './canvas';
import { GmindCoreError } from './errors';
import { withTransaction } from './operations';
import { ORIGIN_SYSTEM, ORIGIN_USER, type WriteOrigin } from './undo';

/** 画布管理写操作（web 计划三的唯一接口面）。
 *
 * 撤销语义（默认假设 6，设计依据写明）：内容型操作（add/rename/delete/reorder）
 * 走 user origin 可撤销路径，但 UndoManager scope = 画布子图（Y.Map，需求方
 * 2026-10-21 裁定 2），而画布管理写的全部是 doc 级根类型（canvases / canvasOrder /
 * meta.activeCanvasId），天然不在任何画布撤销栈的 scope 内——故「画布管理不进撤销
 * 栈」无需任何特殊处理即成立，此处不加绕过逻辑。setActiveCanvas 是视图态，显式
 * ORIGIN_SYSTEM（同折叠语义）。
 *
 * 校验先于事务：name 校验、index 钳制、默认名/存活数计算、active 回退目标计算
 * 全部在 withTransaction 之外完成（Yjs 事务内抛错不回滚）。
 *
 * crafted 状态防御：canvases 的值可能不是 Y.Map（crafted doc_state 可注入），
 * 读路径沿用 repair 层同款 instanceof Y.Map 口径（畸形值按墓碑确定性跳过）。
 */

export interface AddCanvasOptions {
  name?: string;
  structureType?: StructureType;
  themeId?: string;
}

/** 存活画布 id 列表（按 canvasOrder 顺序；墓碑与畸形值跳过——repair 层同款口径）。 */
function aliveCanvasIds(doc: Y.Doc): string[] {
  const canvases = canvasesMap(doc);
  return canvasOrderArr(doc)
    .toArray()
    .filter((id) => {
      const c = canvases.get(id);
      return c instanceof Y.Map && c.get('deleted') !== true;
    });
}

/** 画布须存在且存活（非 Y.Map 畸形值按不存在处理），否则抛 CANVAS_NOT_FOUND。 */
function requireAliveCanvas(doc: Y.Doc, canvasId: string): Y.Map<unknown> {
  const c = canvasesMap(doc).get(canvasId);
  if (!(c instanceof Y.Map) || c.get('deleted') === true) {
    throw new GmindCoreError('CANVAS_NOT_FOUND', '画布不存在，请刷新后重试');
  }
  return c;
}

/** name 校验（先于事务，addCanvas/renameCanvas 共用）：trim 后空名/超长抛错。 */
function assertValidName(trimmed: string): void {
  if (trimmed === '') {
    throw new GmindCoreError('CANVAS_NAME_EMPTY', '画布名称不能为空，请输入名称');
  }
  if (trimmed.length > MAX_CANVAS_NAME_LENGTH) {
    throw new GmindCoreError('CANVAS_NAME_TOO_LONG', '画布名称长度已达上限');
  }
}

/**
 * 新增画布，返回新 canvasId。rootId=ulid（新建路径允许，与迁移路径的确定性常量
 * 纪律区分）；root 文本「中心主题」（需求方 2026-10-09 裁定，沿用新建空白文档先例）。
 * name 缺省 = `画布 ${存活数+1}`（事务外计算）；追加 order 末尾；同事务置
 * meta.activeCanvasId=新 id（system 语义并入同事务，不做两次提交）。
 */
export function addCanvas(
  doc: Y.Doc,
  opts: AddCanvasOptions = {},
  origin: WriteOrigin = ORIGIN_USER,
): string {
  const name = (opts.name ?? `画布 ${aliveCanvasIds(doc).length + 1}`).trim();
  assertValidName(name); // 校验先于事务
  const canvasId = ulid();
  const rootId = ulid();
  withTransaction(doc, origin, () => {
    const canvas = new Y.Map<unknown>();
    canvas.set('name', name);
    canvas.set('rootId', rootId);
    canvas.set('structureType', opts.structureType ?? 'mindmap');
    canvas.set('themeId', opts.themeId ?? 'gmind-light');
    const nodes = new Y.Map<unknown>();
    const root = new Y.Map<unknown>();
    root.set('text', '中心主题'); // 2026-10-09 裁定先例
    root.set('parentId', '');
    root.set('children', new Y.Array<string>());
    nodes.set(rootId, root);
    canvas.set('nodes', nodes);
    canvas.set('summaries', new Y.Map<unknown>());
    canvasesMap(doc).set(canvasId, canvas);
    canvasOrderArr(doc).push([canvasId]);
    doc.getMap('meta').set('activeCanvasId', canvasId);
  });
  return canvasId;
}

/** 重命名画布（trim 存储）。同值幂等：已同名（含 trim 后同名）不开事务。 */
export function renameCanvas(
  doc: Y.Doc,
  canvasId: string,
  name: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  const trimmed = name.trim();
  assertValidName(trimmed); // 校验先于事务
  const canvas = requireAliveCanvas(doc, canvasId);
  if (canvas.get('name') === trimmed) return; // 同值幂等，零事务
  withTransaction(doc, origin, () => {
    canvas.set('name', trimmed);
  });
}

/**
 * 删除画布：置墓碑 deleted=true + 移出 order；nodes/summaries 内容不动
 * （墓碑画布冻结不变量）。activeCanvasId 指向被删画布时改指 order 首个存活
 * （事务外计算回退目标）。最后一张存活画布禁止删除（默认假设 5）。
 */
export function deleteCanvas(
  doc: Y.Doc,
  canvasId: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  requireAliveCanvas(doc, canvasId);
  const alive = aliveCanvasIds(doc);
  if (alive.length <= 1) {
    throw new GmindCoreError('CANVAS_LAST_FORBIDDEN', '至少保留一张画布，无法删除');
  }
  const rest = alive.filter((id) => id !== canvasId);
  const meta = doc.getMap('meta');
  const activeFallback =
    meta.get('activeCanvasId') === canvasId ? (rest[0] as string) : undefined;
  withTransaction(doc, origin, () => {
    const canvas = canvasesMap(doc).get(canvasId) as Y.Map<unknown>;
    canvas.set('deleted', true); // 墓碑；子图内容冻结不动
    const order = canvasOrderArr(doc);
    const raw = order.toArray();
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i] === canvasId) order.delete(i, 1); // 防御重复条目，全部摘除
    }
    if (activeFallback !== undefined) meta.set('activeCanvasId', activeFallback);
  });
}

/**
 * 画布排序：canvasId 移到存活序列的 toIndex（钳制 [0, len-1]，事务外计算）。
 * 墓碑不占位（listCanvases 口径）；同位幂等零事务。插入锚点 = 目标位置当前存活
 * 画布（摘除自身后），锚点缺失（crafted order）时防御性追加末尾。
 */
export function reorderCanvases(
  doc: Y.Doc,
  canvasId: string,
  toIndex: number,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  const alive = aliveCanvasIds(doc);
  const from = alive.indexOf(canvasId);
  if (from === -1) {
    throw new GmindCoreError('CANVAS_NOT_FOUND', '画布不存在，请刷新后重试');
  }
  const to = Math.min(Math.max(toIndex, 0), alive.length - 1);
  if (from === to) return; // 同位幂等，零事务
  // 目标存活序列：摘除自身后在 to 位插回（纯计算，事务外）
  const next = alive.filter((id) => id !== canvasId);
  next.splice(to, 0, canvasId);
  withTransaction(doc, origin, () => {
    const order = canvasOrderArr(doc);
    const raw = order.toArray();
    for (let i = raw.length - 1; i >= 0; i--) {
      if (raw[i] === canvasId) order.delete(i, 1);
    }
    // 插入锚点 = 目标位置的后继元素（插到它前面）；无后继/锚点缺失（crafted
    // order）时防御性追加末尾。
    const successor = next[to + 1];
    const idx = successor === undefined ? -1 : order.toArray().indexOf(successor);
    if (idx === -1) order.push([canvasId]);
    else order.insert(idx, [canvasId]);
  });
}

/** 切换当前画布：meta.activeCanvasId LWW。视图态显式 ORIGIN_SYSTEM，不进撤销栈。 */
export function setActiveCanvas(doc: Y.Doc, canvasId: string): void {
  requireAliveCanvas(doc, canvasId);
  withTransaction(doc, ORIGIN_SYSTEM, () => {
    doc.getMap('meta').set('activeCanvasId', canvasId);
  });
}
