import * as Y from 'yjs';
import { docToState } from '@gmind/core';
import { MAX_DOC_NODES } from '@gmind/shared';
import { api, ApiError } from '../api/client';

/**
 * 自动保存循环 — M1b Task 11。
 *
 * doc.on('afterTransaction')（任意 origin：用户写与 normalize 修复都算变更）→
 * 重置 2s 防抖 → PUT doc-state（base64 全量状态）→ setStatus('已保存 HH:MM')；
 * 请求在途又有新变更 → 状态保持「保存中…」，落地后立即补存；
 * 失败指数退避 1s/2s/4s 重试 3 次，仍未成功 → setStatus('保存失败，正在重试')
 * 并保留待存状态，下一次事务把重试计数清零重新进入防抖。
 * 例外（M1 验收修复轮）：403 配额拒绝（FR-ACC-003，可达活跃节点 > MAX_DOC_NODES）是确定性
 * 拒绝——重试同样超限，走独立非重试分支给出可行动文案并停止自动重试；用户删除
 * 节点后的下一次事务照常触发补存（硬封锁会导致删除本身也无法落库）。
 */

const DEBOUNCE_MS = 2000;
const RETRY_DELAYS_MS = [1000, 2000, 4000] as const;
/** 403 配额终态文案（区别于网络类失败的重试文案，可直接行动）；上限数值与 server 共用 @gmind/shared。 */
const QUOTA_STATUS = `文档节点数超过上限（${MAX_DOC_NODES}），请删除部分节点后保存`;

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

export type SaveStatusSetter = (status: string) => void;

/** 启动自动保存循环，返回停止函数（卸载时调用）。 */
export function startSaveLoop(doc: Y.Doc, fileId: string, setStatus: SaveStatusSetter): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let dirty = false;
  let retries = 0;
  let stopped = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  async function save(): Promise<void> {
    if (stopped || inFlight || !dirty) return;
    dirty = false;
    inFlight = true;
    setStatus('保存中…');
    try {
      await api(`/files/${fileId}/doc-state`, {
        method: 'PUT',
        body: { docState: toBase64(docToState(doc)) },
      });
      retries = 0;
      setStatus(`已保存 ${clockNow()}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        // 配额超限：确定性拒绝，重试无意义——不消耗 1s/2s/4s 退避路径，放弃本次
        // 待存（下一次事务重新进入防抖；删除节点后的下一次补存即可成功落库）
        dirty = false;
        setStatus(QUOTA_STATUS);
        return;
      }
      dirty = true; // 保留待存状态
      if (retries < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[retries];
        retries += 1;
        setStatus('保存失败，正在重试');
        timer = setTimeout(() => {
          timer = null;
          void save();
        }, delay);
      } else {
        // 3 次退避重试均失败：停在错误指示，等下一次事务重置重试
        setStatus('保存失败，正在重试');
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
    if (dirty && !inFlight) {
      dirty = false;
      void api(`/files/${fileId}/doc-state`, {
        method: 'PUT',
        body: { docState: toBase64(docToState(doc)) },
      }).catch(() => undefined);
    }
  };
}
