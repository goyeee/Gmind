import * as Y from 'yjs';
import { docToState, getLastEditor } from '@gmind/core';
import { MAX_DOC_NODES } from '@gmind/shared';
import { api, ApiError } from '../api/client';
import { track } from '../api/events';

/**
 * 自动保存循环 — M1b Task 11；M2 Task 3 起持久化通道按真值表分流。
 *
 * doc.on('afterTransaction')（任意 origin：用户写与 normalize 修复都算变更）→
 * 重置 2s 防抖 → 决策 shouldPut：
 * - WS 已连接（且曾成功同步）→ false：服务端持久化接管（onStoreDocument 防抖），
 *   「已保存」由 persisted ack 驱动（EditorPage 桥接 collab 状态）；本地写后立即
 *   置「保存中…」直至 ack；
 * - 未曾连接成功 / 曾连接后断开 → true：PUT doc-state（base64 全量状态）兜底
 *   （REST 或 IndexedDB 路径），落地后 setStatus(`已保存 HH:MM`)。
 * 请求在途又有新变更 → 状态保持「保存中…」，落地后立即补存；
 * 失败指数退避 1s/2s/4s 重试 3 次。PUT 失败时若 WS 也不可达（全断网），状态走
 * 离线文案（「离线编辑中，恢复联网后自动同步」）而非重试失败文案，且保持周期性
 * 兜底尝试（避免 finally 立即补存把耗尽态变成热循环）；恢复联网后由 WS 接管或
 * PUT 成功收尾。
 * 例外（M1 验收修复轮）：403 配额拒绝（FR-ACC-003，可达活跃节点 > MAX_DOC_NODES）
 * 是确定性拒绝——重试同样超限，走独立非重试分支给出可行动文案并停止自动重试；
 * 用户删除节点后的下一次事务照常触发补存（硬封锁会导致删除本身也无法落库）。
 * 例外（M3a 准入 7.1）：409 陈旧快照拒绝（PUT body 携带 baseUpdatedAt，服务端判定
 * 整快照严格落后且存在活跃 WS 内存 doc）同为确定性拒绝——重试同样陈旧，走非重试
 * 终态文案并停止自动重试；base 由 useEditorDoc 记录（GET 装载）并随 persisted ack
 * 刷新（collab onPersisted → EditorPage 桥接 getBaseUpdatedAt）。
 * WS 模式下配额拒绝经 quota-exceeded 广播同文案呈现（EditorPage 桥接）；M2 终审
 * 修复轮起广播另置客户端新增拦截标志（nextQuotaBlock），WS 主路径的 ≤500 节点
 * 控制（FR-ACC-003 P0）由客户端强制，不再只是指示文案。
 */

const DEBOUNCE_MS = 2000;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
/** 403 配额终态文案（区别于网络类失败的重试文案，可直接行动）；上限数值与 server 共用 @gmind/shared。 */
export const QUOTA_STATUS = `文档节点数超过上限（${MAX_DOC_NODES}），请删除部分节点后保存`;
/**
 * WS 路径配额拦截（M2 终审修复轮，FR-ACC-003）的「新增被拒」文案。
 * M1b 终审裁定原文：超限广播 → 客户端置只读新增拦截标志 + toast——PRD 阻止的是
 * **新增**节点，删除/既有节点文本编辑/样式修改不受限。
 */
export const QUOTA_ADD_BLOCKED = '文档节点数已达上限，请删除部分节点后再添加';
/** 409 陈旧快照终态文案（M3a 准入 7.1；与 server 的 STALE_SNAPSHOT_MESSAGE 同文）。 */
export const STALE_DOC_STATUS = '文档已在别处更新，请刷新后重试';

/**
 * 持久化通道真值表（binding，M2 Task 3）：
 * - WS 已连接且曾成功同步 → false：服务端持久化接管，PUT 停用；
 * - 从未连接成功 → true：PUT 兜底（REST 或 IndexedDB 路径，M1 语义）；
 * - 曾连接后断开 → true：PUT 尝试兜底 REST（REST 也不可达时状态走离线文案）。
 */
export function shouldPut(input: {
  wsConnected: boolean;
  wsEverConnected: boolean;
  forceFallback?: boolean;
}): boolean {
  if (input.forceFallback) return true;
  if (input.wsConnected && input.wsEverConnected) return false;
  return true;
}

/**
 * WS 路径配额拦截标志机（M2 终审修复轮，M1b 终审裁定的可单测形态）。
 *
 * 事件（EditorPage 桥接 collab 状态与用户动作推进）：
 * - `{ type: 'quota' }`：服务端 quota-exceeded 广播 → 置拦截（阻止新增节点）；
 * - `{ type: 'deleted' }`：用户删除节点成功 → 解除（删除是用户唯一被裁定的
 *   主动解除通道；若删除后仍超限，服务端边缘触发器在回落限内前不会重复广播，
 *   该残余窗口为 advisory 语义，登记 docs/m2-entry-checklist.md §7.6）；
 * - `{ type: 'saved'; aliveCount }`：拦截期间每次 persisted ack 复查——客户端
 *   无法逐键负担可达计数，借服务端持久化回执按 countAliveReachable ≤ 上限
 *   收敛；仍超限则保持拦截（同时指示文案不得被 ack 覆盖回「已保存」）。
 * 未拦截时 saved/deleted 均维持 false（saved 只复查、不设标志）。
 */
export type QuotaBlockEvent =
  | { type: 'quota' }
  | { type: 'deleted' }
  | { type: 'saved'; aliveCount: number };

export function nextQuotaBlock(prev: boolean, event: QuotaBlockEvent): boolean {
  switch (event.type) {
    case 'quota':
      return true;
    case 'deleted':
      return false;
    case 'saved':
      return prev && event.aliveCount > MAX_DOC_NODES;
  }
}

/** EditorPage 桥接 collab 状态给 saveLoop 的只读视图。 */
export interface CollabBridge {
  /** 真值表决策：当前是否应走 PUT 兜底。 */
  shouldPutNow(): boolean;
  /** WS 不可达时的离线文案；null = WS 在线（PUT 失败维持 M1 重试文案语义）。 */
  offlineHint(): string | null;
}

export interface SaveLoopOptions {
  collab?: CollabBridge;
  /** 当前写序 base（M3a 准入 7.1）：useEditorDoc 记录的行 updated_at（GET 装载，
   *  persisted ack 携带的最新行值刷新）。PUT body 以 baseUpdatedAt 携带，服务端据此
   *  拒绝陈旧整快照（409）；缺省（离线恢复等拿不到 base 的路径）不携带 → 兼容放行。 */
  getBaseUpdatedAt?: () => string | null;
}

function toBase64(state: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < state.length; i += CHUNK) {
    binary += String.fromCharCode(...state.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function clockNow(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/** PUT body 装配：docState 必带；baseUpdatedAt 仅有 base 时携带（缺省字段 = 旧客户端
 *  兼容口径，服务端视为无 base 永远放行）；lastEditorUserId（M3a Task 4，FR-FIL-001）
 *  为 doc meta 的最后修改人离线补报——服务端校验其值 === token 用户才落库，故远端
 *  最新写者是别人（meta 被同步覆盖）时值不匹配，服务端保留既有修改人。 */
function putBody(
  doc: Y.Doc,
  baseUpdatedAt: string | null,
): { docState: string; baseUpdatedAt?: string; lastEditorUserId?: string } {
  const body: { docState: string; baseUpdatedAt?: string; lastEditorUserId?: string } = {
    docState: toBase64(docToState(doc)),
  };
  if (baseUpdatedAt) body.baseUpdatedAt = baseUpdatedAt;
  const lastEditorUserId = getLastEditor(doc);
  if (lastEditorUserId) body.lastEditorUserId = lastEditorUserId;
  return body;
}

export type SaveStatusSetter = (status: string) => void;

/** 启动自动保存循环，返回停止函数（卸载时调用）。 */
export function startSaveLoop(
  doc: Y.Doc,
  fileId: string,
  setStatus: SaveStatusSetter,
  options?: SaveLoopOptions,
): () => void {
  const shouldPutNow = options?.collab?.shouldPutNow ?? (() => true);
  const offlineHint = options?.collab?.offlineHint ?? (() => null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let dirty = false;
  let retries = 0;
  let stopped = false;
  // error_occur 埋点（M5 Task 4，PRD 6.4「保存失败/是否已自动恢复」）：任一次保存尝试
  // 失败置位，随后成功收尾时上报 recovered:true 并复位——「失败 + 自动恢复」成对可观测
  let hadSaveFailure = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const armRetry = (delay: number): void => {
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, delay);
  };

  async function save(): Promise<void> {
    if (stopped || inFlight || !dirty) return;
    dirty = false;
    if (!shouldPutNow()) {
      // 真值表：WS 已连接 → 服务端持久化接管。「保存中」已由事务回调置位，
      // persisted ack 负责收尾；此处不得再写状态——防抖计时与 ack 到达存在竞争
      // （ack 先到会被这里的「保存中」覆盖回去，且无后续 ack 可纠正）。
      return;
    }
    inFlight = true;
    // 离线（WS 不可达）时不得用 PUT 的「保存中…」覆盖「离线编辑中」（FR-EDT-034
    // 状态优先级：离线态压制保存中；PUT 静默兜底，状态由 offlineHint 维持）。
    if (offlineHint() === null) setStatus('保存中…');
    try {
      await api(`/files/${fileId}/doc-state`, {
        method: 'PUT',
        body: putBody(doc, options?.getBaseUpdatedAt?.() ?? null),
      });
      retries = 0;
      if (hadSaveFailure) {
        hadSaveFailure = false;
        track('error_occur', { kind: 'save-fail', recovered: true }, fileId);
      }
      setStatus(`已保存 ${clockNow()}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 陈旧快照守卫（准入 7.1）：服务端判定本端整快照落后于 WS 侧已持久化的
        // 版本——确定性拒绝，重试同样陈旧，还会持续覆盖失败；放弃本次待存并停
        // 在终态文案（镜像 403 配额拒绝的非重试模式），用户刷新/重开文件后以新
        // base 继续
        dirty = false;
        setStatus(STALE_DOC_STATUS);
        hadSaveFailure = false; // 终态失败：recovered 语义留给重试类失败的成功收尾
        track('error_occur', { kind: 'save-fail', recovered: false }, fileId);
        return;
      }
      if (e instanceof ApiError && e.status === 403) {
        // 配额超限：确定性拒绝，重试无意义——不消耗 1s/2s/4s 退避路径，放弃本次
        // 待存（下一次事务重新进入防抖；删除节点后的下一次补存即可成功落库）
        dirty = false;
        setStatus(QUOTA_STATUS);
        return;
      }
      dirty = true; // 保留待存状态
      hadSaveFailure = true; // 重试类失败：成功收尾时配对上报 recovered:true
      const offline = offlineHint();
      if (retries < RETRY_DELAYS_MS.length) {
        setStatus(offline ?? '保存失败，正在重试');
        armRetry(RETRY_DELAYS_MS[retries]);
        retries += 1;
      } else if (offline !== null) {
        // 全断网退避耗尽：保持周期性兜底尝试（恢复联网后由 WS 接管或 PUT 成功收尾）；
        // 若交由 finally 立即补存会把耗尽态变成热循环
        setStatus(offline);
        armRetry(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
      } else {
        // 3 次退避重试均失败：停在错误指示，等下一次事务重置重试
        setStatus('保存失败，正在重试');
        // error_occur（M5 Task 4）：重试耗尽的终态保存失败（离线态除外——那是受支持
        // 的降级而非异常，成功收尾的 recovered:true 已覆盖其恢复观测）
        track('error_occur', { kind: 'save-fail', recovered: false }, fileId);
      }
    } finally {
      inFlight = false;
      // 在途期间有新变更且防抖已耗尽（在途时 fire 过一次空跑）→ 立即补存
      if (!stopped && dirty && timer === null) schedule(0);
    }
  }

  function schedule(delay: number): void {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void save();
    }, delay);
  }

  const onAfterTransaction = (): void => {
    dirty = true;
    retries = 0; // 下一次事务重置重试计数
    if (!shouldPutNow()) {
      // WS 模式：本地写后且未收到 persisted ack 前，立即置「保存中」（binding 状态
      // 语义）；若为远端同步触发的空变更，ack 收尾前同态，语义一致
      setStatus('保存中…');
    }
    schedule(DEBOUNCE_MS);
  };

  doc.on('afterTransaction', onAfterTransaction);
  return () => {
    stopped = true;
    clearTimer();
    doc.off('afterTransaction', onAfterTransaction);
    // 卸载冲刷（fix round 1）：2s 防抖内的待存变更在导航离开时立即发送，
    // 否则静默丢失。SPA 内导航页面进程存活，fetch 会正常完成；在途请求自身
    // 会落地，不重复发。（真实 unload 场景的 keepalive 属页面关闭范畴，M1b 不做。）
    // 真值表：WS 已连接时服务端持久化接管（最后断开方触发 unload 落库），不再 PUT。
    if (dirty && !inFlight && shouldPutNow()) {
      dirty = false;
      void api(`/files/${fileId}/doc-state`, {
        method: 'PUT',
        body: putBody(doc, options?.getBaseUpdatedAt?.() ?? null),
      }).catch(() => undefined);
    }
  };
}
