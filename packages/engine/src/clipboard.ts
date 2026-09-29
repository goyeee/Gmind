/**
 * 浏览器剪贴板层 — M1b Task 10（FR-EDT-009/010）。
 *
 * 在 core 的剪贴板数据层（subtreeToOutlineText / outlineToSpec / insertSpec）之上，
 * 提供浏览器侧的复制 / 粘贴 / 剪切与系统剪贴板读写：
 * - 内部格式：结构化 payload（v:1 森林，含 text/note/href/image/icons/style 富内容），
 *   同应用粘贴重建全部富字段，id 全部新建。
 * - 文本格式：Tab 缩进大纲纯文本（跨应用；粘贴走 outlineToSpec → addChild 镜像
 *   core insertSpec 的 cursor 语义与 ≤500 预校验）。
 *
 * 绑定裁决（M1b 计划 Task 10）：
 * - engine 自本任务起可 import @gmind/core 运行时值（outlineToSpec / MAX_TEXT_LENGTH）；
 *   不 import yjs 的纪律不变（core 内部用 yjs，engine 源码不触碰）。
 * - 写通道走 IDocHandle 微适配器：页面用 @gmind/core 的 addChild/setText/setNote/…
 *   绑定自身 doc 构造该对象，engine 测试用内存树桩实现——engine 不持有 Y.Doc 类型。
 * - parent 缺失/墓碑抛 Error('PARENT_INVALID')、超长抛 Error('TEXT_TOO_LONG')
 *   （engine 无 errors 模块，页面按 message 映射提示文案）。
 * - 系统剪贴板一次写入两 MIME：'text/plain' + 'web application/vnd.gmind+json'
 *   （ClipboardItem）。任一失败（jsdom / 无 API / 权限拒绝）→ false，页面以内存
 *   兜底 lastInternal 保证应用内粘贴始终可用（跨应用文本路径降级，见 README）。
 * - cut = copy + delete 两个连续 user 写事务（Yjs captureTimeout 500ms 内自动合并
 *   为一个撤销单元，一次 Ctrl+Z 撤销剪切）；本层 copy 先读后调页面传入的 deleteFn。
 */

import {
  ICON_GROUPS,
  MARKER_GROUP_MODE,
  MARKER_MULTI_MAX,
  MAX_TEXT_LENGTH,
  iconValuesOf,
  outlineToSpec,
  type IconGroup,
  type SpecNode,
} from '@gmind/core';
import type { DocReader, NodeSnapshotLike } from './types';

/** 内部格式：payload 森林（v:1）。 */
export interface ClipboardPayload {
  v: 1;
  roots: PayloadNode[];
}

/** 内部格式节点：富字段全量快照（id 仅为调试/溯源携带，粘贴时全部新建，不复用）。 */
export interface PayloadNode {
  id: string;
  text: string;
  note: string;
  href: string;
  image: { key: string; w: number; h: number } | null;
  /** 图标组值数组（M7b-W1 多值；组键 ∈ core ICON_GROUPS）。 */
  icons: Record<string, string[]>;
  style: Record<string, string>;
  children: PayloadNode[];
}

/**
 * 文档写通道微适配器：页面用 @gmind/core 的同名操作函数绑定其 doc 实现本接口
 * （origin 缺省 ORIGIN_USER）；engine 测试用内存树桩。只读面继承 DocReader
 * （getMeta/getNode/childrenIds——cutNodes 复用 copyNodes 需要它）。
 */
export interface IDocHandle extends DocReader {
  addChild(parentId: string, opts?: { index?: number; text?: string }, origin?: string): string;
  setText(id: string, text: string, origin?: string): void;
  setNote(id: string, note: string, origin?: string): void;
  setHref(id: string, href: string, origin?: string): void;
  setImage(id: string, image: { key: string; w: number; h: number } | null, origin?: string): void;
  setIcon(id: string, group: string, value: string | null, origin?: string): void;
  setStyle(id: string, patch: Record<string, string | number | null>, origin?: string): void;
}

/** 复制结果：internal（同应用结构化）+ text（跨应用纯文本大纲）。 */
export interface CopyResult {
  internal: ClipboardPayload;
  text: string;
}

// ─────────────────────────── copy ───────────────────────────

/**
 * 复制 ids 对应的子树森林：alive 者建 payload 子树（getNode + childIds 递归），
 * 缺失/墓碑 id 跳过（copy 不抛错）。fix round 1：框选可产生「祖先+后代同时入选」，
 * 后代 id 在建 payload 前裁剪（hasCopiedAncestor）——子树只随其最近被复制的祖先
 * 携带一次，不会重复出现；输入重复 id 同样去重。cutNodes 的删除侧不受影响
 * （deleteFn 仍收到原 ids）。text 为各根的大纲文本以 \n 拼接（语义镜像 core
 * subtreeToOutlineText：根 0 个 Tab、逐层 +1、text 内换行折叠为单个空格——
 * collapseNewlines 保持同步）。
 */
export function copyNodes(reader: DocReader, ids: string[]): CopyResult {
  const copied = new Set(ids);
  const emitted = new Set<string>();
  const roots: PayloadNode[] = [];
  const texts: string[] = [];
  for (const id of ids) {
    if (emitted.has(id)) continue; // 输入重复 id 去重
    const snap = reader.getNode(id);
    if (!snap || snap.deleted) continue;
    if (hasCopiedAncestor(snap, reader, copied)) continue; // 已复制子树的后代：裁剪
    emitted.add(id);
    roots.push(payloadFromSnapshot(reader, snap));
    texts.push(renderOutline(reader, snap));
  }
  return { internal: { v: 1, roots }, text: texts.join('\n') };
}

/** 内部（fix round 1）：沿 parentId 上溯，任一祖先在本次复制集合中 → 该 id 是某个
 * 已复制子树的后代。visited 集合防御 crafted parentId 环（同 core subtreeIds 纪律），
 * 保证任意形状下终止。 */
function hasCopiedAncestor(snap: NodeSnapshotLike, reader: DocReader, copied: Set<string>): boolean {
  const visited = new Set<string>([snap.id]);
  let parentId = snap.parentId;
  while (parentId !== '' && !visited.has(parentId)) {
    if (copied.has(parentId)) return true;
    visited.add(parentId);
    const parent = reader.getNode(parentId);
    if (!parent) return false;
    parentId = parent.parentId;
  }
  return false;
}

/** 内部：快照 → payload 子树递归（缺失/墓碑子节点防御性跳过）。 */
function payloadFromSnapshot(reader: DocReader, snap: NodeSnapshotLike): PayloadNode {
  const children: PayloadNode[] = [];
  for (const childId of snap.childIds) {
    const child = reader.getNode(childId);
    if (!child || child.deleted) continue;
    children.push(payloadFromSnapshot(reader, child));
  }
  return {
    id: snap.id,
    text: snap.text,
    note: snap.note ?? '',
    href: snap.href ?? '',
    image: snap.image ? { key: snap.image.key, w: snap.image.w, h: snap.image.h } : null,
    icons: copyIcons(snap.icons),
    style: snap.style ? { ...snap.style } : {},
    children,
  };
}

/** 内部：icons 收敛为 Record<string,string[]>（DocReader 里放宽为 unknown；M7b-W1
 *  多值——Y.Array/数组值取字符串元素，旧单值字符串包装为单元素数组）。 */
function copyIcons(icons: Record<string, unknown> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!icons) return out;
  for (const [group, value] of Object.entries(icons)) {
    if (Array.isArray(value)) {
      const arr = value.filter((v): v is string => typeof v === 'string');
      if (arr.length > 0) out[group] = arr;
    } else if (typeof value === 'string' && value !== '') {
      out[group] = [value];
    }
  }
  return out;
}

/** 内部：快照子树 → Tab 缩进大纲（与 core subtreeToOutlineText 语义保持同步）。 */
function renderOutline(reader: DocReader, root: NodeSnapshotLike): string {
  const lines: string[] = [];
  const walk = (snap: NodeSnapshotLike, depth: number): void => {
    lines.push('\t'.repeat(depth) + collapseNewlines(snap.text));
    for (const childId of snap.childIds) {
      const child = reader.getNode(childId);
      if (!child || child.deleted) continue;
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

/** 内部：换行折叠——镜像 core clipboard.ts collapseNewlines（保持同步）。 */
function collapseNewlines(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ');
}

// ─────────────────────────── paste（内部 payload 路径） ───────────────────────────

/**
 * 粘贴内部 payload（富内容重建，id 全部新建）：先校验（parent 存活 + fix round 1
 * 的全量 payload 预校验——任一节点违规在零写入期抛出，拒绝即零变更），随后首根插
 * 在 parent 的 index 处，其余根与其下后代一律追加（addChild 缺省 index）；每个新
 * 节点按 payload 依次写回 note/href/image/icons（逐组）/style（整 patch）。image
 * 存在且提供 imageKeyRemap 时先 await remap(oldKey) 取新 key 再 setImage（对象存储
 * 复制由页面在 remap 内完成；remap 抛错原样向上传播并携带 pastedIds——已建节点不
 * 回滚，页面可据此恢复/清理）。
 * 返回全部新建 id（先序：根按 payload 顺序，父先于子）。
 * parent 缺失/墓碑 → Error('PARENT_INVALID')（先于任何写入校验）。
 */
export async function pasteNodes(
  doc: IDocHandle,
  parentId: string,
  index: number,
  payload: ClipboardPayload,
  origin?: string,
  imageKeyRemap?: (key: string) => Promise<string>,
): Promise<string[]> {
  requireValidParent(doc, parentId);
  for (const root of payload.roots) assertPayloadNodeValid(root); // fix round 1：全量预校验先于任何写入
  const ids: string[] = [];
  for (const [i, root] of payload.roots.entries()) {
    await pastePayloadNode(doc, parentId, i === 0 ? index : undefined, root, ids, origin, imageKeyRemap);
  }
  return ids;
}

/** 内部（fix round 1）：递归预校验 payload 节点——镜像 pasteText 的 assertSpecValid
 * 形状（保持同步）：text 非字符串 → TypeError；text 超 MAX_TEXT_LENGTH →
 * Error('TEXT_TOO_LONG')（等价 core GmindCoreError('TEXT_TOO_LONG','节点文本长度
 * 已达上限')，页面按 message 映射提示）；children 非数组 → TypeError。
 * 在任何 addChild 之前对整棵 payload 森林执行完毕，违规即整次粘贴零变更。 */
function assertPayloadNodeValid(node: PayloadNode): void {
  if (typeof node.text !== 'string') {
    throw new TypeError('pasteNodes: payload.text 必须为字符串');
  }
  if (node.text.length > MAX_TEXT_LENGTH) {
    throw new Error('TEXT_TOO_LONG');
  }
  if (!Array.isArray(node.children)) {
    throw new TypeError('pasteNodes: payload.children 必须为数组');
  }
  for (const child of node.children) assertPayloadNodeValid(child);
}

/**
 * 内部（M7b-W1）：icon 写通道目录校验 + 组上限——值目录单源自 @gmind/core 的
 * iconValuesOf（M7a-R1 2.5：与 core setIcon 同一目录来源，不再本地镜像分发）。
 * payload 里目录外值（跨版本部署的系统剪贴板遗留）不写、静默降级；multi 组
 * （MARKER_GROUP_MODE）超 MARKER_MULTI_MAX 的尾部的值静默丢弃——避免 paste 半途
 * 抛错造成部分粘贴（pasteNodes 无法回滚已建节点）。合法值正常写入。
 */
function writableIconValues(group: string, values: string[] | undefined): string[] {
  if (!values || !(ICON_GROUPS as readonly string[]).includes(group)) return [];
  const catalog = iconValuesOf(group as IconGroup);
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !catalog.includes(value)) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= MARKER_MULTI_MAX) break;
  }
  return out;
}

/** 内部：递归重建一个 payload 子树，ids 按先序收集。 */
async function pastePayloadNode(
  doc: IDocHandle,
  parentId: string,
  index: number | undefined,
  node: PayloadNode,
  ids: string[],
  origin: string | undefined,
  remap: ((key: string) => Promise<string>) | undefined,
): Promise<void> {
  const id = doc.addChild(parentId, index === undefined ? { text: node.text } : { index, text: node.text }, origin);
  ids.push(id);
  if (node.note !== '') doc.setNote(id, node.note, origin);
  if (node.href !== '') doc.setHref(id, node.href, origin);
  if (node.image) {
    let key: string;
    if (remap) {
      try {
        key = await remap(node.image.key);
      } catch (err) {
        // fix round 1：remap 失败不回滚已建节点；把此刻已建的先序 id 挂到错误上，
        // 页面可据此做部分粘贴的恢复/清理与提示。
        (err as { pastedIds?: string[] }).pastedIds = [...ids];
        throw err;
      }
    } else {
      key = node.image.key;
    }
    doc.setImage(id, { key, w: node.image.w, h: node.image.h }, origin);
  }
  for (const [group, values] of Object.entries(node.icons)) {
    // M7b-W1 多值写回：先按目录+上限收敛（writableIconValues），single 组写首枚
    // （组内替换）、multi 组先清组再逐枚 toggle 追加（等价整组覆写，幂等于目标现状）。
    const writable = writableIconValues(group, values);
    if (writable.length === 0) continue;
    if (MARKER_GROUP_MODE[group as IconGroup] === 'single') {
      doc.setIcon(id, group, writable[0] as string, origin);
    } else {
      doc.setIcon(id, group, null, origin);
      for (const value of writable) doc.setIcon(id, group, value, origin);
    }
  }
  if (Object.keys(node.style).length > 0) doc.setStyle(id, node.style, origin);
  for (const child of node.children) {
    await pastePayloadNode(doc, id, undefined, child, ids, origin, remap);
  }
}

// ─────────────────────────── paste（纯文本路径） ───────────────────────────

/**
 * 粘贴纯文本大纲：outlineToSpec 解析为森林后，经 IDocHandle 镜像 core insertSpec
 * 的语义插入（engine 侧不持有 Y.Doc，故不直接调 insertSpec）：
 * - parent 校验同 pasteNodes（缺失/墓碑 → Error('PARENT_INVALID')）；
 * - 全量预校验镜像 core assertSpecValid（任一 text 超 MAX_TEXT_LENGTH →
 *   Error('TEXT_TOO_LONG')；children 非数组 → TypeError）——先于任何写入，拒绝即零变更；
 * - cursor 语义镜像 core insertSpecNode：根依次插 index、index+1…，新节点子级从 0 顺排。
 * 返回先序新 id。
 */
export function pasteText(
  doc: IDocHandle,
  parentId: string,
  index: number,
  text: string,
  origin?: string,
): string[] {
  requireValidParent(doc, parentId);
  const spec = outlineToSpec(text);
  for (const root of spec) assertSpecValid(root); // 预校验镜像 core insertSpec.assertSpecValid（保持同步）
  const ids: string[] = [];
  let cursor = index;
  for (const root of spec) {
    cursor = insertSpecNode(doc, parentId, cursor, root, ids, origin);
  }
  return ids;
}

/** 内部：镜像 core clipboard.ts assertSpecValid（保持同步）；违规在零写入期抛出。 */
function assertSpecValid(spec: SpecNode): void {
  if (spec.text.length > MAX_TEXT_LENGTH) {
    throw new Error('TEXT_TOO_LONG');
  }
  if (spec.children !== undefined && !Array.isArray(spec.children)) {
    throw new TypeError('pasteText: spec.children 必须为数组');
  }
  for (const child of spec.children ?? []) assertSpecValid(child);
}

/** 内部：镜像 core clipboard.ts insertSpecNode（保持同步）：插父 index 处，子级从 0 顺排。 */
function insertSpecNode(
  doc: IDocHandle,
  parentId: string,
  index: number,
  spec: SpecNode,
  ids: string[],
  origin: string | undefined,
): number {
  const id = doc.addChild(parentId, { index, text: spec.text }, origin);
  ids.push(id);
  let childCursor = 0;
  for (const child of spec.children ?? []) {
    childCursor = insertSpecNode(doc, id, childCursor, child, ids, origin);
  }
  return index + 1;
}

/** 内部：parent 存活校验（缺失/墓碑 → PARENT_INVALID，页面映射 core 的 NODE_* 提示）。 */
function requireValidParent(doc: IDocHandle, parentId: string): void {
  const parent = doc.getNode(parentId);
  if (!parent || parent.deleted) throw new Error('PARENT_INVALID');
}

// ─────────────────────────── cut ───────────────────────────

/**
 * 剪切 = copy + delete：先读当前状态构建 payload（与 copyNodes 完全一致），再调
 * deleteFn(ids)（页面绑定 core deleteNodes）。两步为连续 user 写事务，Yjs
 * captureTimeout 500ms 内自动合并为一个撤销单元。返回删除前状态的复制结果。
 */
export function cutNodes(
  doc: IDocHandle,
  ids: string[],
  deleteFn: (ids: string[]) => void,
): CopyResult {
  const copied = copyNodes(doc, ids); // copy 先行：读删除前状态
  deleteFn(ids);
  return copied;
}

// ─────────────────────────── 系统剪贴板 ───────────────────────────

/** Gmind 内部格式的自定义 MIME（Web custom format，需 'web ' 前缀）。 */
export const INTERNAL_MIME = 'web application/vnd.gmind+json';

/** 内存兜底：系统剪贴板不可用（jsdom / 权限 / 无 API）时的应用内粘贴数据源。 */
let lastInternal: ClipboardPayload | null = null;

/** 读内存兜底（页面在系统剪贴板读取失败时的最后回退）。 */
export function readInternalFallback(): ClipboardPayload | null {
  return lastInternal;
}

/**
 * 写系统剪贴板：单次 ClipboardItem 携带 'text/plain'（文本大纲）与
 * 'web application/vnd.gmind+json'（内部 payload JSON）两 MIME。任一失败
 * （API 缺失 / jsdom / 权限拒绝）→ false；成功与失败都会更新内存兜底 lastInternal
 * （应用内粘贴不依赖系统剪贴板能力）。
 */
export async function writeToSystemClipboard(payload: CopyResult): Promise<boolean> {
  try {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.write !== 'function' ||
      typeof ClipboardItem === 'undefined'
    ) {
      throw new Error('clipboard API unavailable');
    }
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': payload.text,
        [INTERNAL_MIME]: JSON.stringify(payload.internal),
      }),
    ]);
    lastInternal = payload.internal;
    return true;
  } catch {
    lastInternal = payload.internal;
    return false;
  }
}

/**
 * 读系统剪贴板：优先取 gmind 自定义 MIME 的内部 payload（损坏 JSON 视为无），
 * 'text/plain' 作纯文本。语义：
 * - API 缺失（jsdom）/ read() 抛出（权限拒绝）→ { internal: lastInternal, text: null }
 *   （内存兜底）；
 * - 读成功但无 gmind MIME（外部应用复制）→ internal 为 null，不回退 stale
 *   lastInternal（避免把更早复制的 Gmind 内容当成刚复制的）。
 */
export async function readFromSystemClipboard(): Promise<{
  internal: ClipboardPayload | null;
  text: string | null;
}> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return { internal: lastInternal, text: null };
  }
  try {
    const items = await navigator.clipboard.read();
    const item = items[0];
    if (!item) return { internal: lastInternal, text: null };
    let internal: ClipboardPayload | null = null;
    let text: string | null = null;
    if (item.types.includes(INTERNAL_MIME)) {
      try {
        internal = asPayload(JSON.parse(await (await item.getType(INTERNAL_MIME)).text()));
      } catch {
        internal = null;
      }
    }
    if (item.types.includes('text/plain')) {
      try {
        text = await (await item.getType('text/plain')).text();
      } catch {
        text = null;
      }
    }
    return { internal, text };
  } catch {
    return { internal: lastInternal, text: null };
  }
}

/** 内部：解析结果的最小形状守卫（v:1 且 roots 为数组）。 */
function asPayload(value: unknown): ClipboardPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as { v?: unknown; roots?: unknown };
  if (o.v !== 1 || !Array.isArray(o.roots)) return null;
  return o as unknown as ClipboardPayload;
}
