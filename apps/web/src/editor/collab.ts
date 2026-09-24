import { HocuspocusProvider } from '@hocuspocus/provider';
import { docFromState, docToState, ROOT_NODE_ID } from '@gmind/core';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { getToken } from '../api/client';

/**
 * 协同接入封装（M2 Task 3，FR-EDT-034/035）。
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
 * - saved：服务端 persisted ack（{type:'persisted', at}）——「已保存 HH:MM」的驱动；
 * - quota：服务端 quota-exceeded 广播（复用 M1 非重试文案）。
 *
 * 持久化真值表（binding）落在 saveLoop.shouldPut：WS 已连接 → 服务端持久化接管
 * （PUT 停用）；未连接/断开 → PUT 兜底。本模块不触碰 REST。
 */

export type CollabStatus = 'connecting' | 'synced' | 'offline' | 'saved' | 'quota';

export interface CollabOptions {
  onStatus(status: CollabStatus, detail?: string): void;
}

export interface CollabHandle {
  destroy(): void;
  provider: HocuspocusProvider;
}

export function startCollab(fileId: string, doc: Y.Doc, opts: CollabOptions): CollabHandle {
  const { onStatus } = opts;
  // 本地副本先挂（先于 WS）：离线刷新恢复（loadDocFromIndexedDB）与在线编辑共用
  // 同一命名空间（dbName = fileId）
  const idb = new IndexeddbPersistence(fileId, doc);

  const wsScheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new HocuspocusProvider({
    url: `${wsScheme}://${location.host}/collab`,
    name: fileId,
    document: doc,
    token: getToken() ?? '',
  });

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
      const msg = JSON.parse(payload) as { type?: string; at?: string };
      if (msg.type === 'persisted') onStatus('saved', msg.at);
      else if (msg.type === 'quota-exceeded') onStatus('quota');
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
    destroy(): void {
      provider.off('status', onStatusEvent);
      provider.off('synced', onSynced);
      provider.off('stateless', onStateless);
      if (import.meta.env.DEV) {
        delete (window as unknown as { __gmindCollab?: unknown }).__gmindCollab;
      }
      // 自管 socket：destroy 一并关停底层 WebSocket 与重连循环（v4 单 provider 形态）
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
