import * as Y from 'yjs';
import { ulid } from 'ulid';
import { applyStatusRules, type DeriveNode, type TaskPatch } from '@gmind/shared';
import {
  ICON_GROUPS,
  MARKER_GROUP_MODE,
  MARKER_MULTI_MAX,
  MAX_DESCRIPTION_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TASK_OWNERS,
  MAX_TEXT_LENGTH,
  TASK_OWNER_MAX_LENGTH,
  TASK_OWNER_MIN_LENGTH,
  TASK_STATUSES,
  iconValuesOf,
  isValidDateStr,
  type IconGroup,
} from './constants';
import { GmindCoreError } from './errors';
import { ROOT_NODE_ID } from './doc';
import { getNode, requireAliveNode, subtreeIds, type NodeImage } from './read';
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
 */
export function addChild(
  doc: Y.Doc,
  parentId: string,
  opts: AddChildOptions = {},
  origin: WriteOrigin = ORIGIN_USER,
): string {
  if (opts.text !== undefined && opts.text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const parent = requireAliveNode(doc, parentId);
  const id = ulid();
  withTransaction(doc, origin, () => {
    const node = new Y.Map<unknown>();
    node.set('text', opts.text ?? '');
    node.set('parentId', parentId);
    node.set('children', new Y.Array<string>());
    doc.getMap('nodes').set(id, node);

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
): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('text', text);
  });
}

/** 与 read.ts 同款类型化访问（Y.Map 泛型丢失问题）。 */
function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes');
}

/** 内部：将 nodeId 及其全部后代标记为墓碑（deleted=true），children 数组保留不动（快照可还原）。 */
function tombstoneSubtree(doc: Y.Doc, nodeId: string): void {
  const nodes = nodesMap(doc);
  for (const id of subtreeIds(doc, nodeId, true)) {
    nodes.get(id)?.set('deleted', true);
  }
}

/** 内部：从父节点的 children 数组中移除 childId（含容错：父缺失/无 children/重复项）。
 * 父节点已墓碑时不动其 children——那是保留结构（快照还原依据），如批量 [祖先, 后代] 连删。 */
function removeFromParentChildren(doc: Y.Doc, childId: string): void {
  const nodes = nodesMap(doc);
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
): void {
  withTransaction(doc, origin, () => {
    const nodes = nodesMap(doc);
    for (const id of ids) {
      if (id === ROOT_NODE_ID) {
        const root = nodes.get(ROOT_NODE_ID);
        const rootChildren = root?.get('children') as Y.Array<string> | undefined;
        if (!rootChildren) continue;
        for (const childId of rootChildren.toArray()) tombstoneSubtree(doc, childId);
        rootChildren.delete(0, rootChildren.length);
        continue;
      }
      if (!nodes.get(id)) continue; // 不存在的 id 静默忽略
      tombstoneSubtree(doc, id);
      removeFromParentChildren(doc, id);
    }
  });
}

/**
 * 移动节点（换父或同父重排，FR-EDT-003）。
 * 校验（先于 transact，拒绝即零变更）：id 非 root（ROOT_FORBIDDEN）、id 存活
 * （NODE_NOT_FOUND/NODE_DELETED）、newParent 存活；newParent 不得为 id 自身或其后代
 * （CYCLE_FORBIDDEN，subtreeIds 含自身）。同事务：从旧 parent children 移除、写 parentId、
 * 按指定 index 插入新 parent children（缺省/越界 clamp 到末尾）。
 */
export function moveNode(
  doc: Y.Doc,
  id: string,
  newParentId: string,
  index?: number,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (id === ROOT_NODE_ID) {
    throw new GmindCoreError('ROOT_FORBIDDEN', '中心主题不可移动');
  }
  const node = requireAliveNode(doc, id);
  const newParent = requireAliveNode(doc, newParentId);
  if (subtreeIds(doc, id).includes(newParentId)) {
    throw new GmindCoreError('CYCLE_FORBIDDEN', '不能移动到自身或其后代');
  }
  withTransaction(doc, origin, () => {
    removeFromParentChildren(doc, id);

    node.set('parentId', newParentId);

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
 * 设置节点备注（FR-EDT-018）。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_NOTE_LENGTH，否则 NOTE_TOO_LONG。
 */
export function setNote(
  doc: Y.Doc,
  id: string,
  note: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (note.length > MAX_NOTE_LENGTH) {
    throw new GmindCoreError('NOTE_TOO_LONG', '备注长度已达上限');
  }
  const node = requireAliveNode(doc, id);
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
): void {
  if (text.length > MAX_DESCRIPTION_LENGTH) {
    throw new GmindCoreError(
      'DESCRIPTION_TOO_LONG',
      `描述长度已达上限（最多 ${MAX_DESCRIPTION_LENGTH} 字），请精简后再保存`,
    );
  }
  const node = requireAliveNode(doc, id);
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
): void {
  if (href !== '' && !/^https?:\/\//i.test(href)) {
    throw new GmindCoreError('INVALID_HREF', '链接仅支持 http/https');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('href', href);
  });
}

/**
 * 设置节点图片（FR-EDT-020）：{key,w,h} 写入；null 清除（读回 null，spec §4.1 缺省语义）。
 * 校验（先于 transact）：存活。
 */
export function setImage(
  doc: Y.Doc,
  id: string,
  image: NodeImage | null,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    if (image === null) node.delete('image');
    else node.set('image', image);
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
): void {
  if (!ICON_GROUPS.includes(group)) {
    throw new GmindCoreError('INVALID_ICON_GROUP', '未知的图标分组');
  }
  const node = requireAliveNode(doc, id);
  if (MARKER_GROUP_MODE[group] === 'single') {
    if (value !== null && !iconValuesOf(group).includes(value)) {
      throw new GmindCoreError('INVALID_ICON_VALUE', '未知的图标取值');
    }
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
 * progress(整数 0-100) / owners(用户ID 字符串数组) / startDate|dueDate|doneDate
 * ('YYYY-MM-DD'|null)。task 为节点上的可选 Y.Map；未提供的键不动，日期 null 删键
 * （读取侧缺省语义见 read.ts readTask）。默认 ORIGIN_USER（可撤销，经既有
 * capUndoStack 纪律由页面侧 afterUserWrite 裁剪，与相邻 op 同路径）。
 *
 * 校验（先于 transact，拒绝即零变更，错误码 TASK_INVALID_*、文案两段式）：
 * - status ∈ TASK_STATUSES，否则 TASK_INVALID_STATUS；
 * - progress 为整数 0-100（拒绝小数/NaN/越界），否则 TASK_INVALID_PROGRESS；
 * - owners 为字符串数组：每项长度 1-64（存用户ID）；**先去重（保序）再校验
 *   去重后 ≤ MAX_TASK_OWNERS 项**，否则 TASK_INVALID_OWNERS；
 * - 三个日期为 null 或日历合法的 'YYYY-MM-DD'（2026-02-30 这类拒绝），否则 TASK_INVALID_DATE。
 *
 * 状态联动（规则唯一实现在 @gmind/shared applyStatusRules，core 与 web 共用、禁止双写）：
 * status→done 联动（patch.status='done' 且此前非 done、此前无完成日期、patch 未显式给
 * doneDate）时自动 doneDate=今天（本地日期字符串）+ progress=100——mindgrid 语义：
 * 联动分支 progress 恒置 100，patch 显式给的 progress 也被覆盖；patch 显式给 doneDate
 * 时联动分支不触发（progress 保留 patch 值）。status 离开 done 且 patch 未显式给
 * doneDate 时清空既有 doneDate **且 progress 回退 0**（M7b-W1 需求方裁定「改回待开始
 * 进度改为 0%」，uniform 适用于 done→任意目标）；手改 doneDate 不反写 status。
 */
export function setNodeTask(
  doc: Y.Doc,
  id: string,
  patch: TaskPatch,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  // —— 校验（先于事务；任一违规即抛，零变更）——
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
    owners = [...new Set(patch.owners)]; // 去重保序（存储口径：唯一用户ID 集）
    if (owners.length > MAX_TASK_OWNERS) {
      throw new GmindCoreError(
        'TASK_INVALID_OWNERS',
        `负责人最多 ${MAX_TASK_OWNERS} 人（去重后），请精简后重试`,
      );
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

  const node = requireAliveNode(doc, id);

  // —— 状态联动（@gmind/shared 唯一实现）：before 取当前归一化任务快照。 ——
  const current = getNode(doc, id)!.task;
  const before: DeriveNode = { id, parentId: null, title: '', task: current };
  const linked = applyStatusRules(before, owners === undefined ? { ...patch } : { ...patch, owners });
  if (linked.owners === undefined && owners !== undefined) linked.owners = owners; // 去重结果随写

  // 空 patch（且联动无注入）＝零变更：不开事务直接返回。
  const definedKeys = (Object.keys(linked) as (keyof TaskPatch)[]).filter((k) => linked[k] !== undefined);
  if (definedKeys.length === 0) return;

  withTransaction(doc, origin, () => {
    writeTaskPatch(node, linked);
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
  if (patch.owners !== undefined) task.set('owners', patch.owners);
  for (const key of ['startDate', 'dueDate', 'doneDate'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null) task.delete(key);
    else task.set(key, v);
  }
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
): void {
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('collapsed', collapsed);
  });
}

/** 翻转折叠状态（默认 ORIGIN_SYSTEM，同 setCollapsed 不可撤销）。 */
export function toggleCollapse(doc: Y.Doc, id: string, origin: WriteOrigin = ORIGIN_SYSTEM): void {
  const node = requireAliveNode(doc, id);
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
): void {
  const node = requireAliveNode(doc, id);
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
): void {
  const targets = new Set<string>();
  for (const rootId of rootIds) {
    requireAliveNode(doc, rootId);
    if (scope === 'subtree') {
      for (const targetId of subtreeIds(doc, rootId)) targets.add(targetId);
    } else {
      targets.add(rootId);
    }
  }
  withTransaction(doc, origin, () => {
    const nodes = nodesMap(doc);
    for (const targetId of targets) {
      const node = nodes.get(targetId);
      if (!node) continue; // 防御：事务前已校验存活，正常不可达
      writeStylePatch(node, patch);
    }
  });
}
