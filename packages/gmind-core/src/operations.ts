import * as Y from 'yjs';
import { ulid } from 'ulid';
import { applyStatusRules, todayStr, type DeriveNode, type TaskPatch } from '@gmind/shared';
import {
  CUSTOM_COLUMN_LIMIT,
  CUSTOM_COLUMN_NAME_MAX,
  CUSTOM_COLUMN_TYPES,
  CUSTOM_TEXT_MAX_LENGTH,
  ICON_GROUPS,
  MARKER_GROUP_MODE,
  MARKER_MULTI_MAX,
  MAX_DESCRIPTION_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TASK_OWNERS,
  MAX_TEXT_LENGTH,
  PROGRESS_STAGE_PCT,
  TASK_OWNER_MAX_LENGTH,
  TASK_OWNER_MIN_LENGTH,
  TASK_STATUSES,
  canonicalCustomColumns,
  canonicalSharedFilter,
  canonicalTableView,
  iconValuesOf,
  isValidDateStr,
  progressStageOf,
  type CustomColumnDef,
  type CustomColumnType,
  type CustomFieldValue,
  type IconGroup,
  type SharedFilter,
  type TableViewMeta,
} from './constants';
import { GmindCoreError, type GmindCoreErrorCode } from './errors';
import {
  canvasNodesMap,
  canvasesMap,
  ensureCanvasShape,
  rootIdOf,
} from './canvas';
import {
  getNode,
  isImagePlacement,
  requireAliveNode,
  subtreeIds,
  unfinishedTaskProgressOf,
  type NodeImage,
} from './read';
import { normalizeTree, normalizeTreeFor, deriveNormalizeDirty } from './repair';
import { ORIGIN_SYSTEM, ORIGIN_USER, type WriteOrigin } from './undo';

/** 写操作来源常量定义于 undo.ts（撤销栈同源）；此处 re-export 保持既有导入路径可用。 */
export { ORIGIN_USER, ORIGIN_SYSTEM };
export type { WriteOrigin };

export interface AddChildOptions {
  /** 插入位置；缺省追加末尾，越界（负数或超过长度）clamp 到末尾。 */
  index?: number;
  /** 新节点文本；缺省 `''`（spec §4.1 默认值）。 */
  text?: string;
}

/**
 * 节点持久侧别（需求方 2026-09-30 逆时针定侧规则）：仅 root 直接子级在 mindmap
 * 结构下有语义（engine 布局优先采用；logic/org 与更深后代忽略）。写入口：
 * addChild（root 级自动定侧）/ setNodeSide（手动调整，如拖放换侧）；换父离开
 * root 级由 moveNode 清键，非法值由 repair 归一删除。
 */
export type NodeSide = 'left' | 'right';

/** NodeSide 合法值目录（setNodeSide 校验 / repair 归一同一口径）。 */
const NODE_SIDES: readonly NodeSide[] = ['left', 'right'];

/**
 * 右侧常驻配额（需求方原话「默认一开始在右侧新增，当二级主题为三个以上时，第四个
 * 就要放到左侧……以后再多的新增也都在左侧了」）：第 1~3 个二级主题在右、第 4 个起
 * 在左。engine layout.ts 有同值常量（引擎不依赖 core，改动需两处同步）。
 */
const ROOT_SIDE_RIGHT_QUOTA = 3;

/**
 * root 直接子级的「现有右侧计数」（逆时针定侧的计数口径，addChild 定侧用）：
 * - 有 side 字段的节点按持久值计（含手动 setNodeSide 换过侧的）；
 * - 无 side 字段的旧节点按文档序折算：index 0-2 视为 right、≥3 视为 left；
 * - 墓碑不入计（normalize 后 root children 恒为存活节点，此处再防御一次）。
 * 画布口径（Task 4）：按 canvasId 解析该画布子图与该画布根。
 * 2026-11-15 分侧忠实还原 Task 4 起 export（只增，函数体一字未动）：web 导出链
 * docToXmindSheets 用它产导出件根扩展 right-number——导出计数镜像引擎渲染折算口径
 * （本函数与 engine layout.ts assignMindmapSides 同款折算），模板/混合文档往返无损。
 */
export function countRightSideRootChildren(doc: Y.Doc, canvasId?: string): number {
  const nodes = canvasNodesMap(doc, canvasId);
  const root = nodes.get(rootIdOf(doc, canvasId));
  const children = root?.get('children') as Y.Array<string> | undefined;
  if (!children) return 0;
  let right = 0;
  const ids = children.toArray();
  ids.forEach((childId, index) => {
    const node = nodes.get(childId);
    if (!node || node.get('deleted') === true) return;
    const side = node.get('side');
    if (side === 'left' || side === 'right') {
      if (side === 'right') right += 1;
      return;
    }
    if (index < ROOT_SIDE_RIGHT_QUOTA) right += 1; // 旧节点（无 side）按 index 折算
  });
  return right;
}

export interface WithTransactionOptions {
  /** 事务后是否执行 normalizeTree（默认 true；normalize 以 system origin 执行）。 */
  normalize?: boolean;
}

/** 摊销安全网间隔：每 64 次本地写做一次全量 normalize 清扫（见 withTransaction）。 */
const SAFETY_SWEEP_INTERVAL = 64;

/**
 * 每文档写计数（模块级 WeakMap）：仅本地调度用，不进文档状态、不参与副本收敛——
 * normalize 是文档状态的纯函数，计数只决定「何时」做全量清扫，不改变收敛结果。
 */
const writeCounters = new WeakMap<Y.Doc, number>();

/** 统一写入口：doc.transact(fn, origin) + 事务后按脏区增量 normalizeTree（默认开启）。
 * 脏区由事务对象推导（deriveNormalizeDirty，replica 一致）；无法确定性识别的形状
 * （未知根类型/未知嵌套数组/root 缺失）退回全量 normalizeTree 安全阀。
 * 嵌套调用（外层 withTransaction 事务内）时内层跳过 normalize，由最外层统一执行
 * （见下方嵌套规则注释）——组合原子操作请包一层外层 withTransaction。
 * 自愈安全网（Task 9 修复轮 2）：脏区推导只覆盖「本事务制造的违例」，历史残留
 * （未走本入口的裸写等）由每 64 次写一次的全量 normalizeTree 清扫兜底——全量扫描
 * 蕴含增量修复（同一收敛结果），故第 64 写以全量替代增量而非叠加。 */
export function withTransaction<T>(
  doc: Y.Doc,
  origin: WriteOrigin,
  fn: () => T,
  opts: WithTransactionOptions = {},
): T {
  const writes = (writeCounters.get(doc) ?? 0) + 1;
  writeCounters.set(doc, writes);
  // afterTransaction 监听在事务 GC（tryGcDeleteSet）之前触发，可安全读取脏区
  // （含被覆盖键的旧值 item 链）；一次性注册，finally 注销。
  let captured: Y.Transaction | null = null;
  const capture = (tr: Y.Transaction): void => {
    captured = tr;
  };
  doc.on('afterTransaction', capture);
  let committed = false;
  let result: T;
  try {
    result = doc.transact(fn, origin);
    committed = true;
  } finally {
    doc.off('afterTransaction', capture);
  }
  // fn 抛出时（部分写入已提交）与原行为一致：跳过 normalize 向上传播。
  // ── 嵌套规则 ── captured===null ⇒ afterTransaction 尚未触发 ⇒ 本调用嵌套在某个
  // 外层 withTransaction 的事务内（Yjs 嵌套 transact 复用外层事务，afterTransaction
  // 仅在最外层提交时触发一次）。此时内层整体跳过 normalize，交由最外层统一执行：
  // ① 外层事务包含全部子写入，最外层提交时的 deriveNormalizeDirty（或第 64 写全量
  //   清扫）覆盖一切，内层再跑只会在同一事务内重复修复；
  // ② 嵌套内开的事务复用外层 origin——内层修复写会归到外层 origin（user 时混入
  //   撤销栈，违反「normalize 以 system origin 写入」纪律）；
  // ③ 内层修复在外层 fn 仍可能抛出时就已写入（修复提交先于外层成败可知）。
  // 组合原子操作请包一层外层 withTransaction。
  if (committed && opts.normalize !== false && captured !== null) {
    if (writes % SAFETY_SWEEP_INTERVAL === 0) {
      normalizeTree(doc, ORIGIN_SYSTEM); // 摊销全量清扫（蕴含增量）
    } else {
      const dirty = deriveNormalizeDirty(doc, captured);
      if (dirty === null) normalizeTree(doc, ORIGIN_SYSTEM);
      else normalizeTreeFor(doc, ORIGIN_SYSTEM, dirty);
    }
  }
  return result;
}

/**
 * 在 parent 下新增子节点，返回新 ULID。
 * 校验（先于 transact，拒绝即零变更）：parent 存在且存活（root 合法）；
 * text 长度 ≤ MAX_TEXT_LENGTH，否则 TEXT_TOO_LONG（与 setText 同规则，T3 评审补齐）。
 *
 * 逆时针定侧（需求方 2026-09-30）：parentId 为 root 时自动写 side——现有右侧二级
 * 主题数（计数口径见 countRightSideRootChildren，含旧节点按 index 折算）<3 → 'right'，
 * 否则 'left'（第 1~3 个右、第 4 个起左）。定侧计算在事务外（校验先于事务纪律），
 * 随建节点同一事务落盘；非 root 父级不写 side。
 */
export function addChild(
  doc: Y.Doc,
  parentId: string,
  opts: AddChildOptions = {},
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): string {
  if (opts.text !== undefined && opts.text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const parent = requireAliveNode(doc, parentId, canvasId);
  const nodes = canvasNodesMap(doc, canvasId); // 画布子图解析先于事务（校验先于事务）
  const id = ulid();
  // 逆时针定侧（仅该画布 root 直接子级）：现有右侧计数 < 配额 → 右，否则左。
  // 事务外只读计算；rootId 按画布解析（任一画布根的同級定侧口径一致）。
  const canvasRootId = rootIdOf(doc, canvasId);
  const side: NodeSide | undefined =
    parentId === canvasRootId
      ? countRightSideRootChildren(doc, canvasId) < ROOT_SIDE_RIGHT_QUOTA
        ? 'right'
        : 'left'
      : undefined;
  withTransaction(doc, origin, () => {
    const node = new Y.Map<unknown>();
    node.set('text', opts.text ?? '');
    node.set('parentId', parentId);
    node.set('children', new Y.Array<string>());
    if (side !== undefined) node.set('side', side);
    nodes.set(id, node);

    let parentChildren = parent.get('children') as Y.Array<string> | undefined;
    if (!parentChildren) {
      parentChildren = new Y.Array<string>();
      parent.set('children', parentChildren);
    }
    const len = parentChildren.length;
    const idx =
      opts.index !== undefined && opts.index >= 0 && opts.index <= len ? opts.index : len;
    parentChildren.insert(idx, [id]);
  });
  return id;
}

/**
 * 修改节点文本。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_TEXT_LENGTH，否则 TEXT_TOO_LONG。
 */
export function setText(
  doc: Y.Doc,
  id: string,
  text: string,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const node = requireAliveNode(doc, id, canvasId);
  // 同值守卫（M7c-E4，需求方 #4）：文本未变化不开事务——行内编辑 blur 提交是
  // 无条件 setText，无守卫时「点开又点走」也会生成一次空更新（亮「保存中」+服务端
  // 白存一版历史）。缺键归 ''（与读取侧口径一致），首次写 '' 同为零变更。
  if ((node.get('text') ?? '') === text) return;
  withTransaction(doc, origin, () => {
    node.set('text', text);
  });
}

/** 内部：将 nodeId 及其全部后代标记为墓碑（deleted=true），children 数组保留不动（快照可还原）。
 *  读写同一画布子图（canvasNodesMap）——评审定点修复：旧实现从画布子图读 id 集合、
 *  却向顶层空 nodes 写墓碑，读写错位。 */
function tombstoneSubtree(doc: Y.Doc, nodeId: string, canvasId?: string): void {
  const nodes = canvasNodesMap(doc, canvasId);
  for (const id of subtreeIds(doc, nodeId, canvasId, true)) {
    nodes.get(id)?.set('deleted', true);
  }
}

/** 内部：从父节点的 children 数组中移除 childId（含容错：父缺失/无 children/重复项）。
 * 父节点已墓碑时不动其 children——那是保留结构（快照还原依据），如批量 [祖先, 后代] 连删。 */
function removeFromParentChildren(doc: Y.Doc, childId: string, canvasId?: string): void {
  const nodes = canvasNodesMap(doc, canvasId);
  const node = nodes.get(childId);
  if (!node) return;
  const parentId = node.get('parentId');
  if (typeof parentId !== 'string' || parentId === '') return;
  const parent = nodes.get(parentId);
  if (!parent || parent.get('deleted') === true) return;
  const children = parent.get('children') as Y.Array<string> | undefined;
  if (!children) return;
  // Y.Array 无 indexOf，借 toArray() 定位（数组极小，开销可忽略）
  for (let i = children.toArray().indexOf(childId); i !== -1; i = children.toArray().indexOf(childId)) {
    children.delete(i, 1);
  }
}

/**
 * 批量删除（墓碑级联，FR-EDT-002/003）：单事务内对每个 id 处理——
 * - id==='root'：降级为「清空 root 全部子节点」（root 存活，递归墓碑全部子孙）；
 * - 其他 id：不存在则静默忽略；否则墓碑该节点及全部后代，并从父 children 中移除该 id。
 * 后代节点的 children 数组保留不动（撤销/快照可还原）。事务后 normalize。
 */
export function deleteNodes(
  doc: Y.Doc,
  ids: string[],
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  // 画布子图与该画布根解析先于事务（校验先于事务；显式 canvasId 缺失抛 CANVAS_NOT_FOUND）。
  const nodes = canvasNodesMap(doc, canvasId);
  const canvasRootId = rootIdOf(doc, canvasId);
  withTransaction(doc, origin, () => {
    for (const id of ids) {
      if (id === canvasRootId) {
        const root = nodes.get(canvasRootId);
        const rootChildren = root?.get('children') as Y.Array<string> | undefined;
        if (!rootChildren) continue;
        for (const childId of rootChildren.toArray()) tombstoneSubtree(doc, childId, canvasId);
        rootChildren.delete(0, rootChildren.length);
        continue;
      }
      if (!nodes.get(id)) continue; // 不存在的 id 静默忽略
      tombstoneSubtree(doc, id, canvasId);
      removeFromParentChildren(doc, id, canvasId);
    }
  });
}

/**
 * 移动节点（换父或同父重排，FR-EDT-003）。
 * 校验（先于 transact，拒绝即零变更）：id 非 root（ROOT_FORBIDDEN）、id 存活
 * （NODE_NOT_FOUND/NODE_DELETED）、newParent 存活；newParent 不得为 id 自身或其后代
 * （CYCLE_FORBIDDEN，subtreeIds 含自身）。同事务：从旧 parent children 移除、写 parentId、
 * 按指定 index 插入新 parent children（缺省/越界 clamp 到末尾）。
 *
 * 侧别清理（逆时针定侧，持久 side 仅 root 直接子级有语义）：oldParent==='root' 且
 * newParent!=='root'（换父离开 root 级）→ 删 side；同父重排 / 换入 root 级不动 side——
 * 换入 root 级不自动定侧（新归属的落点由调用方决定，页面拖放按落点解析的
 * target.side 显式调 setNodeSide），无 side 时由 engine 按文档序计数规则兜底。
 */
export function moveNode(
  doc: Y.Doc,
  id: string,
  newParentId: string,
  index?: number,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  const canvasRootId = rootIdOf(doc, canvasId); // 先于事务：ROOT 特判按各画布根推广
  if (id === canvasRootId) {
    throw new GmindCoreError('ROOT_FORBIDDEN', '中心主题不可移动');
  }
  const node = requireAliveNode(doc, id, canvasId);
  const newParent = requireAliveNode(doc, newParentId, canvasId);
  if (subtreeIds(doc, id, canvasId).includes(newParentId)) {
    throw new GmindCoreError('CYCLE_FORBIDDEN', '不能移动到自身或其后代');
  }
  const oldParentId = node.get('parentId');
  withTransaction(doc, origin, () => {
    removeFromParentChildren(doc, id, canvasId);

    node.set('parentId', newParentId);
    // 换父离开该画布 root 级 → 清持久侧别（键面删除，非 root 子级不残留无语义字段）
    if (oldParentId === canvasRootId && newParentId !== canvasRootId) {
      node.delete('side');
    }

    let newChildren = newParent.get('children') as Y.Array<string> | undefined;
    if (!newChildren) {
      newChildren = new Y.Array<string>();
      newParent.set('children', newChildren);
    }
    const len = newChildren.length;
    const idx = index !== undefined && index >= 0 && index <= len ? index : len;
    newChildren.insert(idx, [id]);
  });
}

/**
 * 设置节点持久侧别（逆时针定侧的手动调整口，需求方「用户可以手动调整到右侧」）：
 * 写 node.side（'left'|'right'），engine mindmap 布局优先采用。
 * 校验（先于 transact，拒绝即零变更）：side ∈ {left,right} 否则 INVALID_NODE_SIDE；
 * 节点存活（NODE_NOT_FOUND/NODE_DELETED）；parent 必须为 root（中心主题的直接子级），
 * 否则 SIDE_ONLY_ROOT_CHILD（持久侧别仅 root 级有语义，更深节点不收）。
 * 同值守卫（M7c-E4）：side 与现值相同零事务——拖放释放对同侧节点重复调用的
 * 幂等路径不产生空更新。
 */
export function setNodeSide(
  doc: Y.Doc,
  id: string,
  side: NodeSide,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (!(NODE_SIDES as readonly string[]).includes(side)) {
    throw new GmindCoreError(
      'INVALID_NODE_SIDE',
      `侧别非法（${JSON.stringify(String(side))}），仅支持左侧/右侧`,
    );
  }
  const node = requireAliveNode(doc, id, canvasId);
  if (node.get('parentId') !== rootIdOf(doc, canvasId)) {
    throw new GmindCoreError('SIDE_ONLY_ROOT_CHILD', '仅中心主题的直接子级可设置左右侧');
  }
  if (node.get('side') === side) return; // 同值守卫（M7c-E4）：零变更不开事务
  withTransaction(doc, origin, () => {
    node.set('side', side);
  });
}

/**
 * 设置节点备注（FR-EDT-018）。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_NOTE_LENGTH，否则 NOTE_TOO_LONG。
 */
export function setNote(
  doc: Y.Doc,
  id: string,
  note: string,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (note.length > MAX_NOTE_LENGTH) {
    throw new GmindCoreError('NOTE_TOO_LONG', '备注长度已达上限');
  }
  const node = requireAliveNode(doc, id, canvasId);
  if ((node.get('note') ?? '') === note) return; // 同值守卫（M7c-E4）：零变更不开事务
  withTransaction(doc, origin, () => {
    node.set('note', note);
  });
}

/**
 * 设置节点描述（M7c-C1）：description = 任务的一句话描述（对齐 mindgrid
 * TaskNode.description），与 setNote 的企微备注角标语义并存、互不替代。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_DESCRIPTION_LENGTH(200，
 * 与 mindgrid 同口径)，否则 DESCRIPTION_TOO_LONG（文案两段式=原因+下一步）。
 * 默认 ORIGIN_USER（可撤销，经页面侧 afterUserWrite 裁剪撤销栈，与相邻 op 同路径）。
 */
export function setDescription(
  doc: Y.Doc,
  id: string,
  text: string,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    throw new GmindCoreError(
      'DESCRIPTION_TOO_LONG',
      `描述长度已达上限（最多 ${MAX_DESCRIPTION_LENGTH} 字），请精简后再保存`,
    );
  }
  const node = requireAliveNode(doc, id, canvasId);
  if ((node.get('description') ?? '') === text) return; // 同值守卫（M7c-E4）：零变更不开事务
  withTransaction(doc, origin, () => {
    node.set('description', text);
  });
}

/**
 * 设置节点链接（FR-EDT-019）：仅允许 http/https；空串表示清除。
 * 校验（先于 transact，拒绝即零变更）：存活；/^https?:\/\//i 或空串，否则 INVALID_HREF。
 */
export function setHref(
  doc: Y.Doc,
  id: string,
  href: string,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (href !== '' && !/^https?:\/\//i.test(href)) {
    throw new GmindCoreError('INVALID_HREF', '链接仅支持 http/https');
  }
  const node = requireAliveNode(doc, id, canvasId);
  withTransaction(doc, origin, () => {
    node.set('href', href);
  });
}

/** placement 校验（setImage/moveImage 同源，校验先于事务）。 */
function assertImagePlacement(image: NodeImage): void {
  if (image.placement !== undefined && !isImagePlacement(image.placement)) {
    throw new GmindCoreError(
      'INVALID_IMAGE_PLACEMENT',
      `图片位置非法：${String(image.placement)} / 仅支持 top、bottom、left、right`,
    );
  }
}

/**
 * 设置节点图片（FR-EDT-020）：{key,w,h,placement?} 写入；null 清除（读回 null，spec §4.1
 * 缺省语义）。校验（先于 transact）：存活 + placement 合法（缺省键不出现 = bottom）。
 */
export function setImage(
  doc: Y.Doc,
  id: string,
  image: NodeImage | null,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  const node = requireAliveNode(doc, id, canvasId);
  if (image !== null) assertImagePlacement(image);
  withTransaction(doc, origin, () => {
    if (image === null) node.delete('image');
    else node.set('image', image);
  });
}

/**
 * 跨节点移动图片（需求方 2026-10-20 四槽位：允许把图片拖到其他节点）：源节点清空 +
 * 目标节点写入，**单事务** → 一步撤销、一次广播。目标已有图直接覆盖（裁定：直接替换）。
 * 校验（先于 transact）：两端存活、非同节点、placement 合法。
 */
export function moveImage(
  doc: Y.Doc,
  fromId: string,
  toId: string,
  image: NodeImage,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (fromId === toId) {
    throw new GmindCoreError(
      'INVALID_IMAGE_MOVE',
      '移动图片的源与目标为同一节点 / 请改用 setImage 调整位置',
    );
  }
  assertImagePlacement(image);
  const from = requireAliveNode(doc, fromId, canvasId);
  const to = requireAliveNode(doc, toId, canvasId);
  withTransaction(doc, origin, () => {
    from.delete('image');
    to.set('image', image);
  });
}

/**
 * 设置节点图标（FR-EDT-021，M7b-W1 多值模型）：按组语义写入组值数组——
 * - single 组（MARKER_GROUP_MODE，优先级/心情/数字/箭头/旗帜/进程）：value=null 删组，
 *   否则整组替换为 [value]（组内单选替换；再点同值由面板先发 null，op 层不做 toggle）；
 * - multi 组（其他/表情）：toggle 语义——value 已在组数组中则移除该枚（组空则删键），
 *   否则追加；追加前校验单组上限 MARKER_MULTI_MAX(8)，超出抛 INVALID_ICON_OVERFLOW。
 *
 * icons 存储形状（Yjs 裁定）：节点 icons 为 Y.Map<组名, Y.Array<string>>——每组值
 * 恒为 Y.Array（单选组 0/1 枚、多选组 0-8 枚）。选 Y.Array 而非 JSON 字符串的理由：
 * ① 多值组的并发 toggle 是元素级 CRDT 合并（两端各自新增的枚都存活、跨副本确定性
 * 收敛），JSON 串是组级 LWW、并发丢一端；② 与仓库 children Y.Array 纪律一致。
 * 代价登记：multi 组删除单枚会经 deriveNormalizeDirty 的「未知数组删除」防御路径
 * 退回全量 normalizeTree 安全阀（确定性、有界，与第 64 写摊销清扫同机制）。
 * 缺失时同事务内创建（约定与 read.ts 读取侧一致）。
 *
 * 校验（先于 transact，拒绝即零变更）：存活；group ∈ ICON_GROUPS，否则
 * INVALID_ICON_GROUP；single 替换值 / multi 追加值必须属于该组值目录，否则
 * INVALID_ICON_VALUE（multi 移除方向不校验目录——清除目录外旧值恒合法）。
 */
export function setIcon(
  doc: Y.Doc,
  id: string,
  group: IconGroup,
  value: string | null,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (!ICON_GROUPS.includes(group)) {
    throw new GmindCoreError('INVALID_ICON_GROUP', '未知的图标分组');
  }
  const node = requireAliveNode(doc, id, canvasId);
  if (MARKER_GROUP_MODE[group] === 'single') {
    if (value !== null && !iconValuesOf(group).includes(value)) {
      throw new GmindCoreError('INVALID_ICON_VALUE', '未知的图标取值');
    }
    // 进度组反向联动（需求方 2026-10-10 全量联动）：进度徽章是任务进度的可视化
    // 档位，与 task.progress 一体两面——写档位同步 task.progress=档位百分比
    // （PROGRESS_STAGE_PCT）；value=null=清除徽章并把进度重开为 0%。状态与完成日期
    // 走同一 applyStatusRules；同值守卫同时比较徽章和联动后的任务字段。
    if (group === 'progress') {
      const current = readIconArray(node, group);
      const currentTask = getNode(doc, id, canvasId)!.task;
      if (currentTask.autoProgress === true && origin !== 'restore') {
        throw new GmindCoreError('TASK_INVALID_STATUS', '自动汇总父任务由子任务进度决定，不能直接修改父任务进度徽章');
      }
      const targetPct = value === null ? 0 : PROGRESS_STAGE_PCT[value as keyof typeof PROGRESS_STAGE_PCT];
      const linked = applyStatusRules(
        { id, parentId: null, title: '', task: currentTask },
        { progress: targetPct },
      );
      const taskSame = (['status', 'progress', 'doneDate'] as const).every((key) => {
        const next = linked[key] === undefined ? currentTask[key] : linked[key];
        return (next ?? null) === (currentTask[key] ?? null);
      });
      const sameBadge = value === null ? current.length === 0 : current.length === 1 && current[0] === value;
      if (sameBadge && taskSame) return;
      withTransaction(doc, origin, () => {
        if (value === null) {
          if (current.length > 0) iconsMapOf(node).delete(group);
        } else if (!sameBadge) {
          iconsMapOf(node).set(group, Y.Array.from([value]));
        }
        writeTaskPatch(node, linked);
      });
      return;
    }
    // 同值守卫（M7c-E4）：single 组已是目标态（同值 / 移除已空的组）不开事务——
    // 也避免 iconsMapOf 的建 Y.Map 副作用落在零变更路径上。
    const current = readIconArray(node, group);
    if (value === null && current.length === 0) return;
    if (value !== null && current.length === 1 && current[0] === value) return;
    withTransaction(doc, origin, () => {
      if (value === null) iconsMapOf(node).delete(group);
      else iconsMapOf(node).set(group, Y.Array.from([value]));
    });
    return;
  }
  // multi 组 toggle：先读现值（校验先于事务），移除方向不校验目录
  const current = readIconArray(node, group);
  const idx = value !== null ? current.indexOf(value) : -1;
  if (value === null) {
    if (current.length === 0) return; // 同值守卫（M7c-E4）：组本就不存在=已是移除态
    withTransaction(doc, origin, () => {
      iconsMapOf(node).delete(group);
    });
    return;
  }
  if (idx >= 0) {
    withTransaction(doc, origin, () => {
      const arr = readIconArrayY(node, group);
      arr?.delete(idx, 1);
      if (arr !== undefined && arr.length === 0) iconsMapOf(node).delete(group); // 组空删键
    });
    return;
  }
  if (!iconValuesOf(group).includes(value)) {
    throw new GmindCoreError('INVALID_ICON_VALUE', '未知的图标取值');
  }
  if (current.length >= MARKER_MULTI_MAX) {
    throw new GmindCoreError(
      'INVALID_ICON_OVERFLOW',
      `该组图标最多 ${MARKER_MULTI_MAX} 个，请先移除后再添加`,
    );
  }
  withTransaction(doc, origin, () => {
    const arr = readIconArrayY(node, group);
    if (arr) arr.push([value]);
    else iconsMapOf(node).set(group, Y.Array.from([value]));
  });
}

/** 内部：取节点 icons Y.Map（缺失则创建并挂到节点上，需在事务内调用）。 */
function iconsMapOf(node: Y.Map<unknown>): Y.Map<unknown> {
  let icons = node.get('icons');
  if (!(icons instanceof Y.Map)) {
    icons = new Y.Map<unknown>();
    node.set('icons', icons);
  }
  return icons as Y.Map<unknown>;
}

/** 内部：读节点某组的值数组（防御形状；快照外的旧字符串单值包装为单元素）。 */
function readIconArray(node: Y.Map<unknown>, group: IconGroup): string[] {
  const raw = iconsValueOf(node, group);
  if (raw instanceof Y.Array) return raw.toArray().filter((v): v is string => typeof v === 'string');
  if (typeof raw === 'string' && raw !== '') return [raw];
  return [];
}

/** 内部：读节点某组的 Y.Array 本体（形状不符返回 undefined）。 */
function readIconArrayY(node: Y.Map<unknown>, group: IconGroup): Y.Array<string> | undefined {
  const raw = iconsValueOf(node, group);
  return raw instanceof Y.Array ? (raw as Y.Array<string>) : undefined;
}

function iconsValueOf(node: Y.Map<unknown>, group: IconGroup): unknown {
  const icons = node.get('icons');
  if (!(icons instanceof Y.Map)) return undefined;
  return icons.get(group);
}

// ══ 任务字段（M7a-T1，2026-09-28 需求方裁定「任务常驻」）════════════════════

/**
 * 设置节点任务字段（M7a-T1）：status('todo'|'doing'|'done'|'blocked') /
 * progress(整数 0-100) / startDate|dueDate|doneDate('YYYY-MM-DD'|null) /
 * autoProgress。旧 owners 入参仅为兼容：最多一项并转写 ownerId，不再写 owners。
 * task 为节点上的可选 Y.Map；未提供的键不动，日期 null 删键。默认 ORIGIN_USER。
 *
 * 校验先于事务：status 枚举、0-100 整数进度、单负责人、布尔自动开关和合法日期。
 * 完成态重开及 0%→doing 必须显式给新进度；恢复来源的全字段快照保留原值。
 *
 * 状态联动由 @gmind/shared applyStatusRules 唯一实现：0%=todo、1～99%=doing、
 * 100%=done，blocked 保留当前进度；普通完成默认保留所有子进度。
 */
export function setNodeTask(
  doc: Y.Doc,
  id: string,
  patch: TaskPatch,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (patch.status !== undefined && !(TASK_STATUSES as readonly string[]).includes(patch.status)) {
    throw new GmindCoreError(
      'TASK_INVALID_STATUS',
      `任务状态非法（${JSON.stringify(String(patch.status))}），请从待开始/进行中/已完成/阻塞中选择`,
    );
  }
  if (
    patch.progress !== undefined &&
    (!Number.isInteger(patch.progress) || patch.progress < 0 || patch.progress > 100)
  ) {
    throw new GmindCoreError(
      'TASK_INVALID_PROGRESS',
      '任务进度必须是 0-100 的整数，请调整后重试',
    );
  }
  if (patch.autoProgress !== undefined && typeof patch.autoProgress !== 'boolean') {
    throw new GmindCoreError(
      'TASK_INVALID_AUTO_PROGRESS',
      '自动计算进度开关必须是布尔值，请刷新后重试',
    );
  }
  let owners: string[] | undefined;
  if (patch.owners !== undefined) {
    if (!Array.isArray(patch.owners)) {
      throw new GmindCoreError('TASK_INVALID_OWNERS', '负责人必须是字符串数组，请刷新后重试');
    }
    for (const o of patch.owners) {
      if (typeof o !== 'string' || o.length < TASK_OWNER_MIN_LENGTH || o.length > TASK_OWNER_MAX_LENGTH) {
        throw new GmindCoreError(
          'TASK_INVALID_OWNERS',
          `负责人格式非法（每项须为 ${TASK_OWNER_MIN_LENGTH}-${TASK_OWNER_MAX_LENGTH} 字符的用户ID），请重新选择成员`,
        );
      }
    }
    owners = [...new Set(patch.owners)];
    if (owners.length > 1) {
      throw new GmindCoreError('TASK_INVALID_OWNERS', '总负责人只能有一人，请改用 setTaskOwner 重新选择');
    }
  }
  for (const key of ['startDate', 'dueDate', 'doneDate'] as const) {
    const v = patch[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || !isValidDateStr(v)) {
      throw new GmindCoreError(
        'TASK_INVALID_DATE',
        `任务日期非法（${key} 须为 YYYY-MM-DD 或留空），请重新选择日期`,
      );
    }
  }

  const node = requireAliveNode(doc, id, canvasId);
  const current = getNode(doc, id, canvasId)!.task;
  const restoringSnapshot = origin === 'restore' && patch.doneDate !== undefined;
  if (!restoringSnapshot && current.autoProgress === true && patch.autoProgress === undefined &&
    (patch.status === 'done' || patch.progress === 100)) {
    throw new GmindCoreError('TASK_INVALID_STATUS', '自动汇总父任务由子任务进度决定，请完成子任务而不是手动完成父任务');
  }
  if (!restoringSnapshot) {
    const reopening = (current.status === 'done' || current.progress === 100) &&
      patch.status !== undefined && patch.status !== 'done';
    if (reopening && patch.progress === undefined) {
      throw new GmindCoreError('TASK_INVALID_PROGRESS', '重新打开已完成任务必须选择 0-99 的新进度，请先选择进度');
    }
    if (reopening && patch.progress === 100) {
      throw new GmindCoreError('TASK_INVALID_PROGRESS', '重新打开任务的新进度必须是 0-99，请勿再次使用完成值');
    }
    if (reopening && patch.status === 'doing' && patch.progress === 0) {
      throw new GmindCoreError('TASK_INVALID_PROGRESS', '重新打开为进行中必须选择 1-99 的进度，请先选择进度');
    }
    if (patch.status === 'doing' && patch.progress === undefined && current.progress === 0) {
      throw new GmindCoreError('TASK_INVALID_PROGRESS', '从 0% 改为进行中必须选择 1-99 的进度，请先选择进度');
    }
    if (patch.status === 'doing' && patch.progress === 0) {
      throw new GmindCoreError('TASK_INVALID_PROGRESS', '进行中任务的进度必须是 1-99，请先选择有效进度');
    }
  }

  const before: DeriveNode = { id, parentId: null, title: '', task: current };
  const explicitDoneDate = patch.doneDate;
  const ruleInput = { ...patch };
  delete ruleInput.owners;
  delete ruleInput.doneDate;
  const linked = applyStatusRules(
    before,
    restoringSnapshot ? { ...ruleInput, doneDate: explicitDoneDate } : ruleInput,
  );
  // 开关自动汇总时携带的 progress 只是当前汇总值缓存，不是用户主动完成任务；
  // 不写状态或完成日期。自动父的对外状态/日期由 shared 派生函数负责。
  if (patch.autoProgress !== undefined && patch.status === undefined && patch.doneDate === undefined) {
    delete linked.status;
    delete linked.doneDate;
  }
  if (!restoringSnapshot && explicitDoneDate !== undefined &&
    linked.status !== 'todo' && linked.status !== 'doing' && linked.status !== 'blocked') {
    linked.doneDate = explicitDoneDate;
  }
  const nextOwnerId = owners === undefined ? undefined : (owners[0] ?? null);
  const ownerChanged = nextOwnerId !== undefined && nextOwnerId !== current.ownerId;
  const ownerWrite = nextOwnerId !== undefined && (ownerChanged || current.owners.length > 0);
  const definedKeys = (Object.keys(linked) as (keyof TaskPatch)[]).filter((k) => linked[k] !== undefined);
  if (definedKeys.length === 0 && !ownerWrite) return;
  const same = definedKeys.every((k) => (linked[k] ?? null) === (current[k] ?? null));
  if (same && !ownerWrite) return;

  // 普通完成入口默认 preserve-subprogress：不改 ownerProgress 或任何人员子进度。
  withTransaction(doc, origin, () => {
    writeTaskPatch(node, linked);
    if (ownerWrite) {
      const task = taskMapOf(node);
      task.set('ownerId', nextOwnerId);
      task.delete('owners');
      if (ownerChanged) task.delete('ownerProgress');
    }
    if (linked.progress !== undefined) {
      const stage = progressStageOf(linked.progress);
      if (stage !== null) iconsMapOf(node).set('progress', Y.Array.from([stage]));
    }
  });
}

/** 内部：取节点 task Y.Map（缺失则创建并挂到节点上，需在事务内调用）。 */
function taskMapOf(node: Y.Map<unknown>): Y.Map<unknown> {
  let task = node.get('task');
  if (!(task instanceof Y.Map)) {
    task = new Y.Map<unknown>();
    node.set('task', task);
  }
  return task as Y.Map<unknown>;
}

/** 内部：向节点 task Y.Map 应用 patch（仅写已定义键；日期 null 删键，与读取缺省对称）。 */
function writeTaskPatch(node: Y.Map<unknown>, patch: TaskPatch): void {
  const task = taskMapOf(node);
  if (patch.status !== undefined) task.set('status', patch.status);
  if (patch.progress !== undefined) task.set('progress', patch.progress);
  if (patch.autoProgress !== undefined) task.set('autoProgress', patch.autoProgress);
  for (const key of ['startDate', 'dueDate', 'doneDate'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) task.delete(key);
    else task.set(key, v);
  }
}

function assertOwnerId(ownerId: string | null): void {
  if (ownerId !== null && (typeof ownerId !== 'string' || ownerId.length < TASK_OWNER_MIN_LENGTH || ownerId.length > TASK_OWNER_MAX_LENGTH)) {
    throw new GmindCoreError('TASK_INVALID_OWNERS', '总负责人标识非法，请重新选择成员');
  }
}

/** 设置唯一总负责人。负责人实际变化时清除旧 ownerProgress，总 progress 不动；
 *  同事务删除旧 owners，避免读侧回退到已失效的旧负责人。 */
export function setTaskOwner(
  doc: Y.Doc,
  id: string,
  ownerId: string | null,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  assertOwnerId(ownerId);
  const node = requireAliveNode(doc, id, canvasId);
  const current = getNode(doc, id, canvasId)!.task;
  if (current.ownerId === ownerId && current.owners.length === 0) return;
  const changed = current.ownerId !== ownerId;
  withTransaction(doc, origin, () => {
    const task = taskMapOf(node);
    task.set('ownerId', ownerId);
    task.delete('owners');
    if (changed) task.delete('ownerProgress');
  });
}

/** 设置总负责人的可选执行子进度；只写 ownerProgress，不改任务总进度或状态。 */
export function setOwnerProgress(
  doc: Y.Doc,
  id: string,
  progress: number,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new GmindCoreError('TASK_INVALID_PROGRESS', '负责人子进度必须是 0-100 的整数，请调整后重试');
  }
  const node = requireAliveNode(doc, id, canvasId);
  const current = getNode(doc, id, canvasId)!.task;
  if (current.ownerId === null) {
    throw new GmindCoreError('TASK_INVALID_OWNERS', '尚未设置总负责人，请先选择负责人再填写子进度');
  }
  if (current.ownerProgress === progress) return;
  withTransaction(doc, origin, () => {
    taskMapOf(node).set('ownerProgress', progress);
  });
}

// ══ 表格自定义列（doc 级 schema + 节点 custom 值）════════════════════════════

/** 内部：自定义列孤儿清理的节点遍历范围——全部存活画布的 nodes 子图（列 schema 是
 *  doc 级，删列清孤儿须覆盖所有画布）；无画布（装载迁移前旧形状窗口）回退顶层 nodes。
 *  墓碑画布确定性跳过（Task 6 收口登记，对齐 deleteCanvas 冻结口径）：墓碑内容整体
 *  冻结、作快照还原依据保留，孤儿键随内容一并冻结——解冻（restore 整画布重建/复活）
 *  时按快照内容原样恢复，概不追补清理（与概要裁定 6 同精神：冻结态不做收敛性写入）。 */
function allNodesMapsForCleanup(doc: Y.Doc): Y.Map<Y.Map<unknown>>[] {
  const maps: Y.Map<Y.Map<unknown>>[] = [];
  for (const canvas of canvasesMap(doc).values()) {
    // crafted 值防御：非 Y.Map 确定性跳过（对齐 repair 层裁定，与全项目同类遍历同款）
    if (!(canvas instanceof Y.Map) || canvas.get('deleted') === true) continue; // 墓碑画布冻结：孤儿键随内容一并冻结
    maps.push(ensureCanvasShape(canvas as Y.Map<unknown>).nodes);
  }
  if (maps.length === 0) maps.push(doc.getMap('nodes') as Y.Map<Y.Map<unknown>>);
  return maps;
}

/**
 * 整表替换自定义列 schema（增删改名重排一次写入；便捷面裁定——core 只做整表替换 +
 * 单字段写入两个 op，保持 API 面 minimal，页面侧自管编辑态草稿后一次提交）。
 *
 * 数据口径：meta.customColumns = CustomColumnDef[]（普通 JSON 数组存 meta Y.Map）；
 * 列 schema 是 doc 级，不随复制/粘贴/导入子树携带（见 clipboard.ts 透传裁定）。
 *
 * 校验（先于事务，任一违规即抛、零变更，错误码 CUSTOM_COLUMN_*、文案两段式）：
 * - 入参为数组，否则 CUSTOM_COLUMN_INVALID；
 * - 每项：id 非空字符串且不重复（重复抛 CUSTOM_COLUMN_INVALID）、name 非空且
 *   ≤ CUSTOM_COLUMN_NAME_MAX(30) 字、type ∈ CUSTOM_COLUMN_TYPES(文本/人员/进度/日期)；
 * - 总数 ≤ CUSTOM_COLUMN_LIMIT(20)，超出抛 CUSTOM_COLUMN_OVERFLOW。
 *
 * 同值守卫（M7c-E4）：现 schema 按防御口径规范化后与入参 JSON 全同 → 零事务
 * （空清单对无键/空 schema 文档同为零变更）。
 *
 * 删列清孤儿（数据不留孤儿键）：被移除的列 id 在**同一事务**内从全部节点（含墓碑
 * ——撤销同事务整体回滚，与 icons 收敛同覆盖裁定）的 custom Y.Map 中删除该键；
 * 事务外只读推导被删 id 集合（校验先于事务纪律）。
 */
export function setCustomColumns(
  doc: Y.Doc,
  columns: CustomColumnDef[],
  origin: WriteOrigin = ORIGIN_USER,
): void {
  // —— 校验（先于事务；任一违规即抛，零变更）——
  if (!Array.isArray(columns)) {
    throw new GmindCoreError('CUSTOM_COLUMN_INVALID', '自定义列清单必须是数组，请刷新后重试');
  }
  const seen = new Set<string>();
  for (const col of columns) {
    if (col === null || typeof col !== 'object') {
      throw new GmindCoreError('CUSTOM_COLUMN_INVALID', '自定义列定义非法，请刷新后重试');
    }
    if (typeof col.id !== 'string' || col.id === '') {
      throw new GmindCoreError('CUSTOM_COLUMN_INVALID', '自定义列 id 须为非空字符串，请刷新后重试');
    }
    if (seen.has(col.id)) {
      throw new GmindCoreError(
        'CUSTOM_COLUMN_INVALID',
        `自定义列 id 重复（${col.id}），请勿重复添加同名列`,
      );
    }
    if (typeof col.name !== 'string' || col.name === '') {
      throw new GmindCoreError(
        'CUSTOM_COLUMN_INVALID',
        `列名不能为空，请输入 1-${CUSTOM_COLUMN_NAME_MAX} 字的名称`,
      );
    }
    if (col.name.length > CUSTOM_COLUMN_NAME_MAX) {
      throw new GmindCoreError(
        'CUSTOM_COLUMN_INVALID',
        `列名长度已达上限（最多 ${CUSTOM_COLUMN_NAME_MAX} 字），请精简后再保存`,
      );
    }
    if (!(CUSTOM_COLUMN_TYPES as readonly string[]).includes(col.type)) {
      throw new GmindCoreError(
        'CUSTOM_COLUMN_INVALID',
        `列类型非法（${JSON.stringify(String(col.type))}），仅支持文本/人员/进度/日期`,
      );
    }
    seen.add(col.id);
  }
  if (columns.length > CUSTOM_COLUMN_LIMIT) {
    throw new GmindCoreError(
      'CUSTOM_COLUMN_OVERFLOW',
      `自定义列最多 ${CUSTOM_COLUMN_LIMIT} 列，请先删除不需要的列再新增`,
    );
  }

  // 同值守卫：现 schema 规范化后与入参 JSON 相等 → 零事务。
  const current = canonicalCustomColumns(doc.getMap('meta').get('customColumns'));
  if (JSON.stringify(current) === JSON.stringify(columns)) return;

  // 删列孤儿清理计划（事务外只读推导）：被移除的列 id → 同事务从全部节点清除。
  const keptIds = new Set(columns.map((c) => c.id));
  const removedIds = current.filter((c) => !keptIds.has(c.id)).map((c) => c.id);

  withTransaction(doc, origin, () => {
    doc.getMap('meta').set('customColumns', columns.map((c) => ({ ...c })));
    if (removedIds.length === 0) return;
    for (const nodes of allNodesMapsForCleanup(doc)) {
      for (const node of nodes.values()) {
        const custom = node.get('custom');
        if (!(custom instanceof Y.Map)) continue;
        for (const colId of removedIds) {
          if (custom.has(colId)) custom.delete(colId);
        }
      }
    }
  });
}

// ══ 表格视图列体系（meta.tableView：统一列序/隐藏/固定/排序）══════════════════

/**
 * 整体写入表格视图持久态（需求方 2026-10-01 列体系升级；setCustomColumns 同款
 * 「doc 级结构化数据 → 专属 op」裁定——setDocMeta 的 patch 面保持哑写不掺跨键
 * canonical，故 tableView 走本 op 而非并入 setDocMeta）。
 *
 * 数据口径：meta.tableView = TableViewMeta（plain JSON 对象存 meta Y.Map）；统一
 * 列清单 = 内置列（TABLE_BUILTIN_COLUMN_KEYS 固定 key）∪ 当前 meta.customColumns
 * 的 colId，自定义列可排进内置列中间。
 *
 * 归一（canonicalTableView 单源，先于事务）：入参非对象抛 TABLE_VIEW_INVALID；
 * order/hidden/pinned 过滤到合法 key 集合（多余 key 剔除——含已删自定义列残留）、
 * 去重保首，order 再按缺省序补全缺失 key（恒为完整排列）；hidden 恒剔 'title'
 * （任务名不可隐藏裁定）；sort 形状非法归 null。
 *
 * 同值守卫：现值 canonical 后与入参归一结果 JSON 全同 → 零事务。
 *
 * origin 默认 system（与 collapsed 折叠态同裁定）：列序/隐藏/固定/排序是视图级
 * 偏好而非内容编辑，不进撤销栈（Ctrl+Z 不回滚视图态），随 Yjs 正常协同同步。
 * setCustomColumns 删列**不**顺带清 tableView（读取侧 canonical 剔除已删 colId
 * 即可）——保留原始 order 使「删列→Ctrl+Z 恢复」后列位复原，且避免给既有撤销
 * 语义掺入视图写。
 */
export function setTableView(
  doc: Y.Doc,
  tableView: TableViewMeta,
  origin: WriteOrigin = ORIGIN_SYSTEM,
): void {
  if (tableView === null || typeof tableView !== 'object' || Array.isArray(tableView)) {
    throw new GmindCoreError('TABLE_VIEW_INVALID', '表格视图配置必须是对象，请刷新后重试');
  }
  // 归一（先于事务）：合法 key 集 = 内置 ∪ 当前自定义列 schema（canonical 读）。
  const customColumns = canonicalCustomColumns(doc.getMap('meta').get('customColumns'));
  const next = canonicalTableView(tableView, customColumns);
  if (next === undefined) {
    throw new GmindCoreError('TABLE_VIEW_INVALID', '表格视图配置非法，请刷新后重试');
  }
  // 同值守卫：现值（防御读）与归一结果全同 → 零事务。
  const current = canonicalTableView(doc.getMap('meta').get('tableView'), customColumns);
  if (current !== undefined && JSON.stringify(current) === JSON.stringify(next)) return;

  withTransaction(doc, origin, () => {
    doc.getMap('meta').set('tableView', next);
  });
}

/** 整体写入公共筛选（轮 2 筛选双层化，2026-11-15 需求方拍板：改动默认仅自己可见，
 * 「对所有人生效」写入文件成为团队公共筛选、他人打开默认用这套）。公共筛选 = doc 级
 * meta.sharedFilter（不含 keyword——会话级；不含 scope——旧模型已退役）。
 *
 * 数据口径：meta.sharedFilter = SharedFilter（plain JSON 对象存 meta Y.Map）。
 *
 * 归一（canonicalSharedFilter 单源，先于事务）：入参含 keyword 键抛 SHARED_FILTER_INVALID
 * （keyword 不允许入文档）；非对象（且非 null）抛 SHARED_FILTER_INVALID；null → 清除公共筛选。
 * 其余按 canonicalSharedFilter 规则归一（owners/statuses 数组归一、conds 四键提取、布尔/字符串
 * 按类型回退）。
 *
 * 同值守卫：现值 canonical 后与入参归一结果 JSON 全同 → 零事务。
 *
 * origin 默认 system（与 setTableView 同裁定）：公共筛选是协作视图偏好而非内容编辑，
 * 不进撤销栈（Ctrl+Z 不回滚视图态），随 Yjs 正常协同同步。
 * restore 排除（随 meta.title 先例「视图偏好不随版本回滚」）。 */
export function setSharedFilter(
  doc: Y.Doc,
  filter: SharedFilter | null,
  origin: WriteOrigin = ORIGIN_SYSTEM,
): void {
  if (filter !== null && (typeof filter !== 'object' || Array.isArray(filter))) {
    throw new GmindCoreError('SHARED_FILTER_INVALID', '公共筛选配置必须是对象，请刷新后重试');
  }
  if (filter !== null && 'keyword' in filter) {
    throw new GmindCoreError('SHARED_FILTER_INVALID', '公共筛选不能包含搜索关键词（关键词仅本次会话可见），请移除后重试');
  }
  const next = filter === null ? null : canonicalSharedFilter(filter);
  if (filter !== null && next === undefined) {
    throw new GmindCoreError('SHARED_FILTER_INVALID', '公共筛选配置非法，请刷新后重试');
  }
  // 同值守卫：现值（防御读）与归一结果全同 → 零事务。
  const current = canonicalSharedFilter(doc.getMap('meta').get('sharedFilter'));
  const currentJson = current === undefined ? 'null' : JSON.stringify(current);
  const nextJson = next === null ? 'null' : JSON.stringify(next);
  if (currentJson === nextJson) return;

  withTransaction(doc, origin, () => {
    if (next === null) {
      doc.getMap('meta').delete('sharedFilter');
    } else {
      doc.getMap('meta').set('sharedFilter', next);
    }
  });
}

/** 内部：custom 值校验/归一结果——ok 时 value 为写入值（assignee 归 v2 结构）；违规时
 *  携带错误码与两段式文案（setCustomField 抛出用；clipboard 粘贴过滤按 ok 静默丢弃）。 */
interface CustomValueCheck {
  ok: boolean;
  value?: string | number | Record<string, { progress: number; weight?: number }>;
  code?: GmindCoreErrorCode;
  message?: string;
}

/** 内部：按列类型校验 custom 值（单源：setCustomField 抛错口径 + 粘贴过滤口径）。
 *  null/undefined（删键方向）恒 ok；progress 整数 0-100；date 日历合法（isValidDateStr）；
 *  assignee=人员列 v2（每人 {progress, weight?}——旧版 number 简形归一升级，2026-10-12
 *  比重裁定：weight 缺省=按人数平分，自定义比重经列 weighted 开关生效）。 */
function checkCustomValue(type: CustomColumnType, value: unknown): CustomValueCheck {
  if (value === null || value === undefined) return { ok: true }; // 删键方向，无值校验
  switch (type) {
    case 'text':
      if (typeof value !== 'string') {
        return {
          ok: false,
          code: 'CUSTOM_FIELD_INVALID_VALUE',
          message: '文本列的值必须是字符串，请检查后重试',
        };
      }
      if (value.length > CUSTOM_TEXT_MAX_LENGTH) {
        return {
          ok: false,
          code: 'CUSTOM_FIELD_TEXT_TOO_LONG',
          message: `文本列内容长度已达上限（最多 ${CUSTOM_TEXT_MAX_LENGTH} 字），请精简后再保存`,
        };
      }
      return { ok: true, value };
    case 'progress':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
        return {
          ok: false,
          code: 'CUSTOM_FIELD_INVALID_VALUE',
          message: '进度列的值必须是 0-100 的整数，请调整后重试',
        };
      }
      return { ok: true, value };
    case 'assignee': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return {
          ok: false,
          code: 'CUSTOM_FIELD_INVALID_VALUE',
          message: '人员列的值必须是「成员→进度」对象，请重新编辑后重试',
        };
      }
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > MAX_TASK_OWNERS) {
        return {
          ok: false,
          code: 'CUSTOM_FIELD_INVALID_VALUE',
          message: `人员列最多 ${MAX_TASK_OWNERS} 人，请精简后重试`,
        };
      }
      // 归一为 v2 结构 {progress, weight?}：旧版 number 简形按 {progress: n} 升级
      // （读侧全链路兼容旧形，写入口统一新结构）。
      const out: Record<string, { progress: number; weight?: number }> = {};
      for (const [user, raw] of entries) {
        if (user.length < TASK_OWNER_MIN_LENGTH || user.length > TASK_OWNER_MAX_LENGTH) {
          return {
            ok: false,
            code: 'CUSTOM_FIELD_INVALID_VALUE',
            message: `人员列的成员标识非法（须为 ${TASK_OWNER_MIN_LENGTH}-${TASK_OWNER_MAX_LENGTH} 字符的用户ID），请重新选择成员`,
          };
        }
        const norm =
          typeof raw === 'number' ? { progress: raw } : (raw as { progress?: unknown; weight?: unknown } | null);
        const progress = norm?.progress;
        if (typeof progress !== 'number' || !Number.isInteger(progress) || progress < 0 || progress > 100) {
          return {
            ok: false,
            code: 'CUSTOM_FIELD_INVALID_VALUE',
            message: '人员列的进度必须是 0-100 的整数，请调整后重试',
          };
        }
        const weight = norm?.weight;
        if (weight !== undefined && (typeof weight !== 'number' || !(weight > 0) || weight > 1000)) {
          return {
            ok: false,
            code: 'CUSTOM_FIELD_INVALID_VALUE',
            message: '人员列的比重必须是 0.1~1000 的正数，请调整后重试',
          };
        }
        out[user] = weight === undefined ? { progress } : { progress, weight };
      }
      return { ok: true, value: out };
    }
    case 'date':
      if (typeof value !== 'string' || !isValidDateStr(value)) {
        return {
          ok: false,
          code: 'CUSTOM_FIELD_INVALID_VALUE',
          message: '日期列的值须为 YYYY-MM-DD 或留空，请重新选择日期',
        };
      }
      return { ok: true, value };
  }
}

/** 内部：读节点 custom Y.Map（只读口径；缺失/形状不符返回 undefined）。 */
function customMapOf(node: Y.Map<unknown>): Y.Map<unknown> | undefined {
  const custom = node.get('custom');
  return custom instanceof Y.Map ? (custom as Y.Map<unknown>) : undefined;
}

/** 内部：取/建节点 custom Y.Map（缺失或形状不符时新建覆盖，需在事务内调用；与
 *  taskMapOf/iconsMapOf 同款约定）。 */
function ensureCustomMap(node: Y.Map<unknown>): Y.Map<unknown> {
  let custom = node.get('custom');
  if (!(custom instanceof Y.Map)) {
    custom = new Y.Map<unknown>();
    node.set('custom', custom);
  }
  return custom as Y.Map<unknown>;
}

type AssigneeValues = Record<string, { progress: number; weight?: number }>;

function requireAssigneeColumn(doc: Y.Doc, colId: string): void {
  const col = canonicalCustomColumns(doc.getMap('meta').get('customColumns')).find((c) => c.id === colId);
  if (!col) {
    throw new GmindCoreError('CUSTOM_FIELD_UNKNOWN_COL', `列 ${colId} 不存在或已删除，请刷新表格后重试`);
  }
  if (col.type !== 'assignee') {
    throw new GmindCoreError('CUSTOM_FIELD_INVALID_VALUE', '目标列不是人员列，请选择人员列后重试');
  }
}

function assertAssigneeUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length < TASK_OWNER_MIN_LENGTH || userId.length > TASK_OWNER_MAX_LENGTH) {
    throw new GmindCoreError('CUSTOM_FIELD_INVALID_VALUE', '人员列的成员标识非法，请重新选择成员');
  }
}

function assigneeValuesOf(doc: Y.Doc, id: string, colId: string, canvasId?: string): AssigneeValues {
  const raw = getNode(doc, id, canvasId)?.custom?.[colId];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: AssigneeValues = {};
  for (const [user, value] of Object.entries(raw as Record<string, unknown>)) {
    const norm = typeof value === 'number' ? { progress: value } : (value as { progress?: unknown; weight?: unknown } | null);
    if (typeof norm?.progress !== 'number') continue;
    const weight = norm.weight;
    out[user] = {
      progress: norm.progress,
      ...(typeof weight === 'number' && weight > 0 ? { weight } : {}),
    };
  }
  return out;
}

function sameAssigneeValue(a: { progress: number; weight?: number } | undefined, b: { progress: number; weight?: number } | undefined): boolean {
  return a?.progress === b?.progress && a?.weight === b?.weight;
}

function assigneeDiffers(current: AssigneeValues, next: AssigneeValues, removeMissing: boolean): boolean {
  if (Object.entries(next).some(([user, value]) => !sameAssigneeValue(current[user], value))) return true;
  return removeMissing && Object.keys(current).some((user) => !(user in next));
}

/** 在已开启的事务内应用逐用户 diff。旧普通对象先归一为 col→user→字段的嵌套
 *  Y.Map，再只写目标用户的目标字段；本函数不做校验、不抛错。 */
function writeAssigneeValues(
  node: Y.Map<unknown>,
  colId: string,
  current: AssigneeValues,
  next: AssigneeValues,
  removeMissing: boolean,
): void {
  const custom = ensureCustomMap(node);
  let column = custom.get(colId);
  if (!(column instanceof Y.Map)) {
    const normalized = new Y.Map<unknown>();
    for (const [user, value] of Object.entries(current)) {
      const entry = new Y.Map<unknown>();
      entry.set('progress', value.progress);
      if (value.weight !== undefined) entry.set('weight', value.weight);
      normalized.set(user, entry);
    }
    custom.set(colId, normalized);
    column = normalized;
  }
  const columnMap = column as Y.Map<unknown>;
  if (removeMissing) {
    for (const user of Object.keys(current)) {
      if (!(user in next)) columnMap.delete(user);
    }
  }
  for (const [user, value] of Object.entries(next)) {
    if (sameAssigneeValue(current[user], value)) continue;
    let entry = columnMap.get(user);
    if (!(entry instanceof Y.Map)) {
      entry = new Y.Map<unknown>();
      columnMap.set(user, entry);
    }
    const entryMap = entry as Y.Map<unknown>;
    entryMap.set('progress', value.progress);
    if (value.weight === undefined) entryMap.delete('weight');
    else entryMap.set('weight', value.weight);
  }
}

/**
 * 设置节点自定义列值（右键任务设置/表格单元格的写入口）。
 *
 * 数据口径：node.custom Y.Map<colId, 值>——text=string / progress=0-100 整数 /
 * date='YYYY-MM-DD' / assignee=嵌套 Y.Map<用户ID, Y.Map<progress|weight>>。
 * assignee 入参仍兼容普通对象与旧 number 简形，写入前归一并按用户、按字段 diff；
 * 不再整列覆盖，人员子进度不影响任务总进度，也不再参与完成门禁。
 *
 * 校验（先于事务，拒绝即零变更）：colId 在当前 schema 中（防御读取坏 meta 按 []
 * 处理），否则 CUSTOM_FIELD_UNKNOWN_COL；值按列类型校验（checkCustomValue 单源），
 * 错误码 CUSTOM_FIELD_INVALID_VALUE / CUSTOM_FIELD_TEXT_TOO_LONG（文案两段式）。
 *
 * null/undefined（值合法的删键方向）= 删键；同值守卫（deep equal，零事务）：
 * 删键方向且键本就缺失 / 写入值与现存储值 JSON 全同（person 按去重后的写入口径
 * 比）→ 不开事务。
 */
export function setCustomField(
  doc: Y.Doc,
  id: string,
  colId: string,
  value: CustomFieldValue | undefined,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  // schema 校验：colId 必须在当前自定义列 schema 中
  const schema = canonicalCustomColumns(doc.getMap('meta').get('customColumns'));
  const col = schema.find((c) => c.id === colId);
  if (col === undefined) {
    throw new GmindCoreError(
      'CUSTOM_FIELD_UNKNOWN_COL',
      `列 ${colId} 不存在或已删除，请刷新表格后重试`,
    );
  }
  const check = checkCustomValue(col.type, value);
  if (!check.ok) throw new GmindCoreError(check.code as GmindCoreErrorCode, check.message as string);

  const node = requireAliveNode(doc, id, canvasId);

  if (col.type === 'assignee' && value !== null && value !== undefined) {
    const currentValues = assigneeValuesOf(doc, id, colId, canvasId);
    const nextValues = check.value as AssigneeValues;
    if (!assigneeDiffers(currentValues, nextValues, true) &&
      ((customMapOf(node)?.has(colId) ?? false) || Object.keys(nextValues).length > 0)) return;
    withTransaction(doc, origin, () => {
      writeAssigneeValues(node, colId, currentValues, nextValues, true);
    });
    return;
  }

  // 同值守卫（deep equal，零事务）：现值含 Y 类型（crafted 状态）时守卫不命中，
  // 走写入路径以整形（ensureCustomMap/整值覆写）。
  const current = customMapOf(node)?.get(colId);
  if (value === null || value === undefined) {
    if (current === undefined) return; // 键本就缺失：已是删键态
  } else if (
    current !== undefined &&
    !(current instanceof Y.Map) &&
    !(current instanceof Y.Array) &&
    JSON.stringify(current) === JSON.stringify(check.value)
  ) {
    return; // 同值：零变更
  }

  withTransaction(doc, origin, () => {
    if (value === null || value === undefined) {
      ensureCustomMap(node).delete(colId);
      return;
    }
    ensureCustomMap(node).set(colId, check.value);
  });
}

/** 新增人员条目，默认子进度 0；已有成员幂等，不覆盖其当前进度。 */
export function addAssignee(
  doc: Y.Doc,
  id: string,
  colId: string,
  userId: string,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  requireAssigneeColumn(doc, colId);
  assertAssigneeUserId(userId);
  const node = requireAliveNode(doc, id, canvasId);
  const current = assigneeValuesOf(doc, id, colId, canvasId);
  if (current[userId]) return;
  if (Object.keys(current).length >= MAX_TASK_OWNERS) {
    throw new GmindCoreError('CUSTOM_FIELD_INVALID_VALUE', `人员列最多 ${MAX_TASK_OWNERS} 人，请精简后重试`);
  }
  const next = { ...current, [userId]: { progress: 0 } };
  withTransaction(doc, origin, () => {
    writeAssigneeValues(node, colId, current, next, false);
  });
}

/** 只移除目标用户条目，不动同列其他成员。 */
export function removeAssignee(
  doc: Y.Doc,
  id: string,
  colId: string,
  userId: string,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  requireAssigneeColumn(doc, colId);
  assertAssigneeUserId(userId);
  const node = requireAliveNode(doc, id, canvasId);
  const current = assigneeValuesOf(doc, id, colId, canvasId);
  if (!current[userId]) return;
  const next = { ...current };
  delete next[userId];
  withTransaction(doc, origin, () => {
    writeAssigneeValues(node, colId, current, next, true);
  });
}

/** 只写目标用户的 progress 字段，不整列覆盖，也不改任务总进度。 */
export function setAssigneeProgress(
  doc: Y.Doc,
  id: string,
  colId: string,
  userId: string,
  progress: number,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  requireAssigneeColumn(doc, colId);
  assertAssigneeUserId(userId);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) {
    throw new GmindCoreError('CUSTOM_FIELD_INVALID_VALUE', '人员子进度必须是 0-100 的整数，请调整后重试');
  }
  const node = requireAliveNode(doc, id, canvasId);
  const current = assigneeValuesOf(doc, id, colId, canvasId);
  if (!current[userId]) {
    throw new GmindCoreError('CUSTOM_FIELD_INVALID_VALUE', '该成员尚未加入人员列，请先添加成员再更新进度');
  }
  if (current[userId]!.progress === progress) return;
  const next = { ...current, [userId]: { ...current[userId]!, progress } };
  withTransaction(doc, origin, () => {
    writeAssigneeValues(node, colId, current, next, false);
  });
}

export type TaskCompletionMode = 'preserve-subprogress' | 'complete-subprogress';

/** 原子完成总任务；普通入口与显式命令共享 preserve 默认。complete 模式只补全预检
 *  返回的生效子进度，所有校验和逐用户 diff 均在事务前完成。 */
export function completeNodeTask(
  doc: Y.Doc,
  id: string,
  mode: TaskCompletionMode,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  if (mode !== 'preserve-subprogress' && mode !== 'complete-subprogress') {
    throw new GmindCoreError('TASK_INVALID_STATUS', '任务完成模式非法，请重新选择保留或同步子进度');
  }
  const node = requireAliveNode(doc, id, canvasId);
  const current = getNode(doc, id, canvasId)!.task;
  if (current.autoProgress === true) {
    throw new GmindCoreError('TASK_INVALID_STATUS', '自动汇总父任务由子任务进度决定，请完成子任务而不是手动完成父任务');
  }
  const unfinished = unfinishedTaskProgressOf(doc, id, canvasId);
  const byCol = new Map<string, { current: AssigneeValues; next: AssigneeValues }>();
  if (mode === 'complete-subprogress') {
    for (const entry of unfinished.assignees) {
      let diff = byCol.get(entry.colId);
      if (!diff) {
        const values = assigneeValuesOf(doc, id, entry.colId, canvasId);
        diff = { current: values, next: { ...values } };
        byCol.set(entry.colId, diff);
      }
      diff.next[entry.user] = { ...diff.next[entry.user]!, progress: 100 };
    }
  }
  const ownerWillChange = mode === 'complete-subprogress' && unfinished.owner !== null;
  const taskWillChange = current.status !== 'done' || current.progress !== 100 || current.doneDate === null;
  const assigneesWillChange = [...byCol.values()].some((diff) => assigneeDiffers(diff.current, diff.next, false));
  if (!taskWillChange && !ownerWillChange && !assigneesWillChange) return;
  const doneDate = current.doneDate ?? todayStr();
  withTransaction(doc, origin, () => {
    const task = taskMapOf(node);
    task.set('status', 'done');
    task.set('progress', 100);
    task.set('doneDate', doneDate);
    iconsMapOf(node).set('progress', Y.Array.from(['done']));
    if (ownerWillChange) task.set('ownerProgress', 100);
    for (const [colId, diff] of byCol) writeAssigneeValues(node, colId, diff.current, diff.next, false);
  });
}

/**
 * 粘贴透传的 custom 值过滤（clipboard.insertSpec 用）：按目标文档**当前** schema
 * 逐键校验，未知列（列 schema 是 doc 级、粘贴不建列）或值与目标列类型不符的键
 * 静默丢弃（跨文档粘贴的合理降级，与 repair 的孤儿清理口径一致），返回可安全经
 * setCustomField 写入的子集（无可写键返回 null）。
 */
export function sanitizeCustomForDoc(
  doc: Y.Doc,
  custom: Record<string, unknown>,
): Record<string, NonNullable<CustomFieldValue>> | null {
  const schema = canonicalCustomColumns(doc.getMap('meta').get('customColumns'));
  if (schema.length === 0) return null;
  const typeById = new Map(schema.map((c) => [c.id, c.type] as const));
  let out: Record<string, NonNullable<CustomFieldValue>> | null = null;
  for (const [colId, value] of Object.entries(custom)) {
    if (value === null || value === undefined) continue; // 删键方向对粘贴无意义
    const type = typeById.get(colId);
    if (type === undefined) continue; // 目标文档无此列：丢弃
    const check = checkCustomValue(type, value);
    if (!check.ok || check.value === undefined) continue; // 值形状不符目标列类型：丢弃
    if (out === null) out = {};
    out[colId] = check.value;
  }
  return out;
}

/**
 * 折叠/展开节点（FR-EDT-030）。默认 ORIGIN_SYSTEM：同步生效但不可撤销
 * （spec §4.2 第 5 条裁决——折叠状态不进撤销栈）。
 */
export function setCollapsed(
  doc: Y.Doc,
  id: string,
  collapsed: boolean,
  origin: WriteOrigin = ORIGIN_SYSTEM,
  canvasId?: string,
): void {
  const node = requireAliveNode(doc, id, canvasId);
  withTransaction(doc, origin, () => {
    node.set('collapsed', collapsed);
  });
}

/** 翻转折叠状态（默认 ORIGIN_SYSTEM，同 setCollapsed 不可撤销）。 */
export function toggleCollapse(
  doc: Y.Doc,
  id: string,
  origin: WriteOrigin = ORIGIN_SYSTEM,
  canvasId?: string,
): void {
  const node = requireAliveNode(doc, id, canvasId);
  withTransaction(doc, origin, () => {
    node.set('collapsed', node.get('collapsed') !== true);
  });
}

/** 内部：向节点 style Y.Map 应用 patch；value null 删除键；数值归一为字符串（与 NodeSnapshot.style 一致）。 */
function writeStylePatch(node: Y.Map<unknown>, patch: Record<string, string | number | null>): void {
  let style = node.get('style') as Y.Map<string> | undefined;
  if (!style) {
    style = new Y.Map<string>();
    node.set('style', style);
  }
  for (const [attr, value] of Object.entries(patch)) {
    if (value === null) style.delete(attr);
    else style.set(attr, String(value));
  }
}

/**
 * 修改节点样式（FR-EDT-030）：多键 patch；value null 删除该键。
 * 校验（先于 transact，拒绝即零变更）：存活。
 */
export function setStyle(
  doc: Y.Doc,
  id: string,
  patch: Record<string, string | number | null>,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  const node = requireAliveNode(doc, id, canvasId);
  withTransaction(doc, origin, () => {
    writeStylePatch(node, patch);
  });
}

/** applyStyle 作用域：'subtree' 对每个 root 的全部存活后代（含自身）；'single' 仅节点自身。 */
export type StyleScope = 'subtree' | 'single';

/**
 * 批量样式（FR-EDT-015 多选）：目标 id 在事务前收集完毕（rootIds 全部存活校验，
 * subtree 作用域经 subtreeIds 展开含自身），随后单个 withTransaction 写入全部目标——
 * 多选节点同时生效、撤销一次全部回滚。subtreeIds 跳过墓碑（对墓碑样式无意义）。
 */
export function applyStyle(
  doc: Y.Doc,
  rootIds: string[],
  patch: Record<string, string | number | null>,
  scope: StyleScope,
  origin: WriteOrigin = ORIGIN_USER,
  canvasId?: string,
): void {
  const targets = new Set<string>();
  for (const rootId of rootIds) {
    requireAliveNode(doc, rootId, canvasId);
    if (scope === 'subtree') {
      for (const targetId of subtreeIds(doc, rootId, canvasId)) targets.add(targetId);
    } else {
      targets.add(rootId);
    }
  }
  // 画布子图解析先于事务（校验先于事务纪律）
  const nodes = canvasNodesMap(doc, canvasId);
  withTransaction(doc, origin, () => {
    for (const targetId of targets) {
      const node = nodes.get(targetId);
      if (!node) continue; // 防御：事务前已校验存活，正常不可达
      writeStylePatch(node, patch);
    }
  });
}
