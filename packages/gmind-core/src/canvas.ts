import * as Y from 'yjs';
import type { StructureType } from '@gmind/shared';
import { GmindCoreError } from './errors';
import { ROOT_NODE_ID } from './doc';

/** 迁移画布 id：确定性常量（副本一致纪律——迁移路径禁止 ulid）。 */
export const LEGACY_CANVAS_ID = 'canvas-1';
/** 画布名长度上限（校验先于事务，renameCanvas/addCanvas 共用）。 */
export const MAX_CANVAS_NAME_LENGTH = 50;

export interface CanvasInfo {
  id: string;
  name: string;
  rootId: string;
  structureType: StructureType;
  themeId: string;
}

export function canvasesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('canvases') as Y.Map<Y.Map<unknown>>;
}

export function canvasOrderArr(doc: Y.Doc): Y.Array<string> {
  return doc.getArray('canvasOrder');
}

function aliveOrder(doc: Y.Doc): string[] {
  const canvases = canvasesMap(doc);
  return canvasOrderArr(doc).toArray().filter((id) => {
    const c = canvases.get(id);
    // crafted 值防御：非 Y.Map 视为不存在（墓碑语义，确定性跳过，对齐 repair 层裁定）
    return c instanceof Y.Map && c.get('deleted') !== true;
  });
}

/** 画布 id 解析：显式 > meta.activeCanvasId > 首个存活 > LEGACY 常量。全部不存活时返回 LEGACY_CANVAS_ID 常量。 */
export function resolveCanvasId(doc: Y.Doc, canvasId?: string): string {
  const order = aliveOrder(doc);
  const candidates = [
    canvasId,
    doc.getMap('meta').get('activeCanvasId') as string | undefined,
    order[0],
    LEGACY_CANVAS_ID,
  ];
  for (const c of candidates) {
    if (c === undefined) continue;
    const m = canvasesMap(doc).get(c);
    if (m instanceof Y.Map && m.get('deleted') !== true) return c;
  }
  return LEGACY_CANVAS_ID; // 空文档/迁移前：由调用方决定是否需要真实存在
}

/**
 * 画布级 Y.Map 访问器。显式传入 canvasId 时不存在或已删除即抛 CANVAS_NOT_FOUND
 * （禁止静默回退）；缺省（undefined）时经 resolveCanvasId 回退链解析，解析落空同样抛错。
 */
export function canvasMapOf(doc: Y.Doc, canvasId?: string): Y.Map<unknown> {
  if (canvasId !== undefined) {
    const m = canvasesMap(doc).get(canvasId);
    if (!(m instanceof Y.Map) || m.get('deleted') === true) {
      throw new GmindCoreError('CANVAS_NOT_FOUND', '画布不存在');
    }
    return m;
  }
  const id = resolveCanvasId(doc);
  const m = canvasesMap(doc).get(id);
  if (!(m instanceof Y.Map) || m.get('deleted') === true) {
    throw new GmindCoreError('CANVAS_NOT_FOUND', '画布不存在');
  }
  return m;
}

/** 防尽取画布内子图：键缺失/类型不符即补建（装载容错与 repair 共用，读取绝不抛错）。 */
export function ensureCanvasShape(
  canvas: Y.Map<unknown>,
): { nodes: Y.Map<Y.Map<unknown>>; summaries: Y.Map<Y.Map<unknown>> } {
  let nodes = canvas.get('nodes') as Y.Map<Y.Map<unknown>> | undefined;
  if (!(nodes instanceof Y.Map)) {
    nodes = new Y.Map<Y.Map<unknown>>();
    canvas.set('nodes', nodes);
  }
  let summaries = canvas.get('summaries') as Y.Map<Y.Map<unknown>> | undefined;
  if (!(summaries instanceof Y.Map)) {
    summaries = new Y.Map<Y.Map<unknown>>();
    canvas.set('summaries', summaries);
  }
  return { nodes, summaries };
}

export function canvasNodesMap(doc: Y.Doc, canvasId?: string): Y.Map<Y.Map<unknown>> {
  return ensureCanvasShape(canvasMapOf(doc, canvasId)).nodes;
}

export function canvasSummariesMap(doc: Y.Doc, canvasId?: string): Y.Map<Y.Map<unknown>> {
  return ensureCanvasShape(canvasMapOf(doc, canvasId)).summaries;
}

export function rootIdOf(doc: Y.Doc, canvasId?: string): string {
  const r = canvasMapOf(doc, canvasId).get('rootId');
  return typeof r === 'string' && r !== '' ? r : ROOT_NODE_ID;
}

export function listCanvases(doc: Y.Doc): CanvasInfo[] {
  const canvases = canvasesMap(doc);
  return aliveOrder(doc).map((id) => {
    const c = canvases.get(id) as Y.Map<unknown>;
    const name = c.get('name');
    const rootId = c.get('rootId');
    const structureType = c.get('structureType');
    const themeId = c.get('themeId');
    return {
      id,
      name: typeof name === 'string' && name !== '' ? name : '画布',
      rootId: typeof rootId === 'string' && rootId !== '' ? rootId : ROOT_NODE_ID,
      structureType: (structureType as StructureType | undefined) ?? 'mindmap',
      themeId: typeof themeId === 'string' && themeId !== '' ? themeId : 'gmind-light',
    };
  });
}
