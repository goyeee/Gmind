import { HocuspocusProvider } from '@hocuspocus/provider';
import { attachRemoteNormalization, docFromState, docToState, ROOT_NODE_ID } from '@gmind/core';
import { colorForUser, type RemoteCursor } from '@gmind/engine';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { api, getToken } from '../api/client';

/**
 * 协同接入封装（M2 Task 3，FR-EDT-034/035；Task 5 起 Awareness 身份/选区广播）。
 *
 * startCollab 在既有 doc（useEditorDoc 经 GET 装配的同一实例）上挂两条通道：
 * - IndexeddbPersistence(fileId, doc)：本地副本——所有 origin 的 update（本地写、
 *   远端同步）都会并入（y-indexeddb 仅跳过自身 origin），断网编辑可写（FR-EDT-035
 *   刷新兜底的数据源）；
 * - HocuspocusProvider：/collab 网关（vite ws 代理 → API_ORIGIN），documentName =
 *   fileId，token 走 auth 帧（与 server Task 1 对齐）。
 *
 * 状态回调（EditorPage 映射为四值指示）：
 * - synced：WS 同步完成（真值表「已连接」成立的依据）；
 * - offline：连接断开（「离线编辑中，恢复联网后自动同步」）；
 * - saved：服务端 persisted ack（{type:'persisted', at, updatedAt}）——「已保存 HH:MM」
 *   的驱动；updatedAt（M3a 准入 7.1）经 onPersisted 回调刷新写序 base；
 * - quota：服务端 quota-exceeded 广播（复用 M1 非重试文案）。
 *
 * Awareness（M2 Task 5，FR-COL-002/005）：v4 provider 自动创建 provider.awareness
 * （y-protocols Awareness）。本地身份经 GET /api/users/me 一次性装配（模块级缓存），
 * 广播字段：user { userId, nickname, color }（color = colorForUser(userId)，会话内
 * 恒定）、joinedAt（ISO）、editing（本地用户写置 true，连续 60s 无写自动回落——
 * 「正在编辑」按最近写活动动态判定的裁定口径；短窗（3s）会在输入间隙把协作方
 * 面板行反复抖出「正在编辑」组，60s 折中）、selection（SelectionModel.onChange
 * 桥接的节点 id 列表）。
 *
 * 裁定：RemoteCursor.userId = awareness clientID 字符串（非账号 userId）——同一
 * 账号开多个标签页时各占独立光标/选区元素，光标层的元素键互不覆盖；昵称/颜色
 * 仍来自账号身份。
 *
 * 消失路径（FR-COL-005「5 秒内消失」）：页面关闭 → provider.destroy() /
 * pagehide 广播 removeAwarenessStates（WS 断开时服务端亦按连接清理并转发）——
 * 即时移除，不依赖 awareness 30s 陈旧回收。
 *
 * 持久化真值表（binding）落在 saveLoop.shouldPut：WS 已连接 → 服务端持久化接管
 * （PUT 停用）；未连接/断开 → PUT 兜底。本模块不触碰内容类 REST。
 */

export type CollabStatus = 'connecting' | 'synced' | 'offline' | 'saved' | 'quota';

/** awareness 广播的本地身份（user 字段）。 */
export interface PresenceUser {
  userId: string;
  nickname: string;
  color: string;
}

/** 在线成员（awareness states → 成员面板数据面；含自己）。 */
export interface PresenceMember extends PresenceUser {
  /** awareness clientID：同账号多标签页各自独立（面板行键的稳定性依据）。 */
  clientID: number;
  joinedAt: string;
  editing: boolean;
  isSelf: boolean;
}

export interface CollabOptions {
  onStatus(status: CollabStatus, detail?: string): void;
  /** 远端（非自己）光标/选区变化（EditorPage → CursorLayer.setCursors）。 */
  onRemoteCursors?(cursors: RemoteCursor[]): void;
  /** 在线成员变化（含自己；EditorPage → 成员面板 + 在线数角标）。 */
  onPresence?(members: PresenceMember[]): void;
  /** persisted ack 携带的行 updated_at（M3a 准入 7.1）：EditorPage → baseUpdatedAtRef
   *  更新（saveLoop PUT 的 baseUpdatedAt 依据）。缺 updatedAt 字段的旧载荷不回调
   *  （向后兼容，M1 的 {type:'persisted', at} 不变）。 */
  onPersisted?(updatedAt: string): void;
}

export interface CollabHandle {
  destroy(): void;
  provider: HocuspocusProvider;
  /** 本地用户写后调用：editing=true；连续 60s 无写自动回落 false（裁定见文件头）。 */
  markEditing(): void;
  /** 本地选区广播（SelectionModel.onChange 桥接）。 */
  setSelection(nodeIds: string[]): void;
}

/** GET /api/users/me 响应（collab 只消费 id/nickname）。 */
interface MeResponse {
  id: string;
  nickname: string;
}

let mePromise: Promise<MeResponse> | null = null;

/** 当前用户身份（模块级缓存：成功后页面生命周期内复用，多文件切换不重发；
 *  失败不缓存——清空占位让下次 startCollab 重试，避免一次网络抖动永久匿名）。
 *  身份未装配时 id 为空串（调用方据此跳过 last_editor 标记等身份动作）。 */
function fetchMe(): Promise<MeResponse> {
  mePromise ??= api<MeResponse>('/users/me').catch(() => {
    mePromise = null;
    return { id: '', nickname: '用户' };
  });
  return mePromise;
}

/** 当前用户身份的公开读取口（M3a Task 4）：EditorPage afterUserWrite 的
 *  markLastEditor 依据——与 awareness 广播共用同一模块级缓存，不重发请求。
 *  身份未装配（GET 失败）时 id 为空串，调用方跳过标记。 */
export function getCurrentUser(): Promise<MeResponse> {
  return fetchMe();
}

/** awareness 单客户端状态（宽松形状：字段可选，坏数据跳过不入面板）。 */
export type AwarenessState = Record<string, unknown>;

/** 宽松读取身份字段：无 userId 视为「身份未装配」，跳过。 */
function userOf(state: AwarenessState): PresenceUser | null {
  const user = state.user as Partial<PresenceUser> | undefined;
  if (!user || typeof user.userId !== 'string' || user.userId === '') return null;
  return {
    userId: user.userId,
    nickname: typeof user.nickname === 'string' && user.nickname !== '' ? user.nickname : '用户',
    color: typeof user.color === 'string' ? user.color : colorForUser(user.userId),
  };
}

/** awareness states → 在线成员列表（joinedAt 升序，稳定面板顺序；自身标 isSelf）。 */
export function buildPresence(
  states: Map<number, AwarenessState>,
  selfClientID: number,
): PresenceMember[] {
  const members: PresenceMember[] = [];
  for (const [clientID, state] of states) {
    const user = userOf(state);
    if (!user) continue;
    members.push({
      ...user,
      clientID,
      joinedAt: typeof state.joinedAt === 'string' ? state.joinedAt : '',
      editing: state.editing === true,
      isSelf: clientID === selfClientID,
    });
  }
  members.sort((a, b) => {
    if (a.joinedAt !== b.joinedAt) return a.joinedAt < b.joinedAt ? -1 : 1;
    return a.userId < b.userId ? -1 : 1;
  });
  return members;
}

/** awareness states → 远端光标（过滤自己与未装配身份者；空选区不出光标）。 */
export function buildRemoteCursors(
  states: Map<number, AwarenessState>,
  selfClientID: number,
): RemoteCursor[] {
  const cursors: RemoteCursor[] = [];
  for (const [clientID, state] of states) {
    if (clientID === selfClientID) continue;
    const user = userOf(state);
    if (!user || !Array.isArray(state.selection)) continue;
    const nodeIds = state.selection.filter((id): id is string => typeof id === 'string');
    if (nodeIds.length === 0) continue;
    cursors.push({ userId: String(clientID), name: user.nickname, color: user.color, nodeIds });
  }
  return cursors;
}

/** 「最近写活动」回落窗（裁定：60s，见文件头）。 */
const EDITING_IDLE_MS = 60_000;

export function startCollab(fileId: string, doc: Y.Doc, opts: CollabOptions): CollabHandle {
  const { onStatus } = opts;
  // 本地副本先挂（先于 WS）：离线刷新恢复（loadDocFromIndexedDB）与在线编辑共用
  // 同一命名空间（dbName = fileId）
  const idb = new IndexeddbPersistence(fileId, doc);

  // —— 远端事务收敛（M2 准入清单 §1，Task 7）——
  // HocuspocusProvider 把服务端同步的 update 以裸 applyUpdate 写进同一 Y.Doc 实例
  //（不走 withTransaction），并发残留（move vs delete 等）会未治愈落库。挂载
  // attachRemoteNormalization（每 doc 一次，随 destroy 注销）后，每个提交的事务——
  // 含远端事务——统一按脏区收敛。裁定记录：
  // ① 本地写因此「双过闸」（withTransaction 已 normalize，监听再跑一遍）——normalize
  //    幂等，第二趟零修复零写入，代价仅为一次只读推导；换来单一远端治愈入口
  //   （origin 甄别不可靠：远端事务可伪装本地 origin）。
  // ② 服务端 Hocuspocus 的内存文档**有意不挂**本接线（本文档随连接生灭、瞬态）：
  //    onLoadDocument 经 docFromState 入口全量 normalize，两次装载间的残留无害；
  //    接线属 web 客户端职责，收敛语义在 core 级被 remote-sync.test.ts 钉死。
  const detachRemoteNormalization = attachRemoteNormalization(doc);

  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new HocuspocusProvider({
    url: `${wsScheme}://${location.host}/collab`,
    name: fileId,
    document: doc,
    token: getToken() ?? '',
  });

  // —— Awareness 身份/选区广播（M2 Task 5）——
  const awareness = provider.awareness;
  const selfClientID = doc.clientID; // Awareness 构造沿用 doc.clientID：本地身份键
  let destroyed = false;
  // 本地镜像：身份装配（users/me）与写活动/选区是异步到达的两条线，谁先到都不许
  // 互相覆盖——身份落定时回放当前镜像，而不是重置（selection 同理，见 setSelection）。
  let localSelection: string[] = [];
  let localEditing = false;

  // 身份异步装配（users/me 模块级缓存）；装配后一次性写入本地字段，
  // 此前（含远端）的 awareness 状态不含本端身份，面板/光标自然不显示。
  void fetchMe().then((me) => {
    if (destroyed || !awareness) return;
    awareness.setLocalStateField('user', {
      userId: me.id,
      nickname: me.nickname,
      color: colorForUser(me.id),
    });
    awareness.setLocalStateField('joinedAt', new Date().toISOString());
    awareness.setLocalStateField('editing', localEditing);
    awareness.setLocalStateField('selection', localSelection);
  });

  const onAwarenessChange = (): void => {
    const states = (awareness?.getStates() ?? new Map()) as Map<number, AwarenessState>;
    if (opts.onPresence) opts.onPresence(buildPresence(states, selfClientID));
    if (opts.onRemoteCursors) opts.onRemoteCursors(buildRemoteCursors(states, selfClientID));
  };
  awareness?.on('change', onAwarenessChange);

  let editingTimer: ReturnType<typeof setTimeout> | null = null;
  const markEditing = (): void => {
    localEditing = true;
    awareness?.setLocalStateField('editing', true);
    if (editingTimer !== null) clearTimeout(editingTimer);
    editingTimer = setTimeout(() => {
      editingTimer = null;
      localEditing = false;
      awareness?.setLocalStateField('editing', false);
    }, EDITING_IDLE_MS);
  };

  const setSelection = (nodeIds: string[]): void => {
    localSelection = nodeIds;
    awareness?.setLocalStateField('selection', nodeIds);
  };

  const onStatusEvent = ({ status }: { status: string }): void => {
    // 'connected' ≠ 可展示态：等服务端 sync 完成再报 synced；连接失败/断开报 offline
    if (status === 'disconnected') onStatus('offline');
    else onStatus('connecting');
  };
  const onSynced = (): void => {
    onStatus('synced');
  };
  const onStateless = ({ payload }: { payload: string }): void => {
    try {
      const msg = JSON.parse(payload) as { type?: string; at?: string; updatedAt?: string };
      if (msg.type === 'persisted') {
        onStatus('saved', msg.at);
        // 写序 base 刷新（准入 7.1）：以落库后的行值为准；旧载荷无 updatedAt 不更新
        if (typeof msg.updatedAt === 'string' && msg.updatedAt !== '') opts.onPersisted?.(msg.updatedAt);
      } else if (msg.type === 'quota-exceeded') {
        onStatus('quota');
      }
    } catch {
      // 非 JSON stateless 广播：与本页无关，忽略
    }
  };

  provider.on('status', onStatusEvent);
  provider.on('synced', onSynced);
  provider.on('stateless', onStateless);

  // dev-only e2e 钩子（纪律同 EditorPage 的 window.__gmind.getDoc，生产构建剔除）：
  // 断网编排需要确定性地断开/恢复 WS——CDP setOffline 对「已建立 WS」的拆除是
  // 竞态的（实测会出现代理上游已死而页面侧 socket 存活的僵尸态）。disconnect =
  // 主动关闭且不重连（shouldConnect=false）；connect = 显式重建。
  if (import.meta.env.DEV) {
    const hooks = {
      setReachable(reachable: boolean): void {
        if (reachable) {
          void provider.connect();
        } else {
          provider.disconnect();
          // socket close 事件异步落地；同步推进离线状态，消除「断网编排返回后
          // 状态尚未翻转」的竞态（E2E 断网编排的确定性依赖此同步语义）。
          onStatus('offline');
        }
      },
    };
    (window as unknown as { __gmindCollab?: typeof hooks }).__gmindCollab = hooks;
  }

  return {
    provider,
    markEditing,
    setSelection,
    destroy(): void {
      destroyed = true;
      if (editingTimer !== null) clearTimeout(editingTimer);
      detachRemoteNormalization(); // 远端收敛接线注销（Task 7）
      awareness?.off('change', onAwarenessChange);
      provider.off('status', onStatusEvent);
      provider.off('synced', onSynced);
      provider.off('stateless', onStateless);
      if (import.meta.env.DEV) {
        delete (window as unknown as { __gmindCollab?: unknown }).__gmindCollab;
      }
      // 自管 socket：destroy 一并关停底层 WebSocket 与重连循环（v4 单 provider 形态）。
      // destroy 内部先 removeAwarenessStates 广播本端移除再断链——对端即时消失。
      provider.destroy();
      void idb.destroy().catch(() => undefined);
    },
  };
}

/**
 * 离线刷新兜底（FR-EDT-035）：GET /api/files/:id 不可达时从 IndexedDB 本地副本恢复。
 * 空副本（本机从未打开过该文件）返回 null，调用方落入既有错误态。
 * 加载纪律与其他通道一致：docFromState 入口全量 normalize。
 */
export async function loadDocFromIndexedDB(fileId: string): Promise<Y.Doc | null> {
  const raw = new Y.Doc();
  const idb = new IndexeddbPersistence(fileId, raw);
  try {
    await idb.whenSynced;
    if (!raw.getMap('nodes').has(ROOT_NODE_ID)) {
      // 副本为空：无 root 即从未在本机装载过，无法恢复
      await idb.destroy();
      raw.destroy();
      return null;
    }
    const doc = docFromState(docToState(raw));
    await idb.destroy();
    raw.destroy();
    return doc;
  } catch (e) {
    // IDB 打开失败（隐私模式/存储不可用）：按不可恢复处理
    console.error('[collab] IndexedDB 恢复失败', e);
    void idb.destroy().catch(() => undefined);
    raw.destroy();
    return null;
  }
}
