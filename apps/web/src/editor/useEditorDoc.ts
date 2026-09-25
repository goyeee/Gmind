import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import * as Y from 'yjs';
import { createUndoManager, docFromState, ORIGIN_USER, setDocMeta } from '@gmind/core';
import { api } from '../api/client';
import { loadDocFromIndexedDB } from './collab';

/**
 * 编辑器文档装载 hook — M1b Task 11；M2 Task 3 增加离线刷新兜底；M3a Task 2 起
 * 记录写序 base（baseUpdatedAtRef）。
 *
 * GET /api/files/:id → docState(base64) → docFromState（导入即 normalize）
 * → createUndoManager；响应的 updatedAt（行值 ISO）写入 baseUpdatedAtRef——saveLoop
 * PUT 携带为 baseUpdatedAt（陈旧写序守卫，准入 7.1），后续由 persisted ack 携带的
 * updatedAt 经 startCollab 的 onPersisted 回调刷新；随后 POST /:id/open
 * （fire-and-forget，FR-ACC-004 打开标记）。
 * GET 不可达（断网/后端失联）→ 从 IndexedDB 本地副本恢复（FR-EDT-035，collab.ts
 * 装配的本地副本在离线编辑期间持续可写）；副本为空才落入错误态——恢复路径拿不到
 * base，baseUpdatedAtRef 保持 null（PUT 不携带该字段 = 服务端兼容放行）。
 * 标题编辑 = setDocMeta({title}, ORIGIN_USER)（可撤销）+ 防抖 PATCH /:id。
 */

export interface EditorDocState {
  doc: Y.Doc;
  um: Y.UndoManager;
  /** 文件所有者（M2 Task 6，FR-COL-005 创建者标识）；离线恢复路径拿不到 → null。 */
  ownerUserId: string | null;
}

interface FileContentResponse {
  id: string;
  title: string;
  structure: string;
  themeId: string;
  nodeCount: number;
  ownerUserId: string | null;
  updatedAt: string;
  docState: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 标题 PATCH 防抖间隔。 */
const TITLE_PATCH_DEBOUNCE_MS = 800;

export function useEditorDoc(fileId: string): {
  state: EditorDocState | null;
  error: string;
  setTitle: (title: string) => void;
  /** 写序 base（准入 7.1）：GET 装载的行 updated_at，persisted ack 刷新；null = 无 base
   *  （离线恢复路径/未装载）。ref 形态：saveLoop 决策与 collab 回调都要读/写最新值，
   *  不需要触发渲染。 */
  baseUpdatedAtRef: MutableRefObject<string | null>;
} {
  const [state, setState] = useState<EditorDocState | null>(null);
  const [error, setError] = useState('');
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTitle = useRef<string | null>(null);
  const baseUpdatedAtRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    baseUpdatedAtRef.current = null; // 文件切换不继承上一文件的 base
    setState(null);
    setError('');
    (async () => {
      try {
        const meta = await api<FileContentResponse>(`/files/${fileId}`);
        const doc = docFromState(base64ToBytes(meta.docState));
        const um = createUndoManager(doc);
        if (cancelled) return;
        baseUpdatedAtRef.current = meta.updatedAt; // 写序 base 初始值（准入 7.1）
        setState({ doc, um, ownerUserId: meta.ownerUserId ?? null });
        void api(`/files/${fileId}/open`, { method: 'POST' }).catch(() => undefined);
      } catch (e) {
        if (cancelled) return;
        // 离线刷新兜底（FR-EDT-035）：本地副本恢复；副本能给出完整文档（含 meta/root）
        // 即视为装载成功，编辑能力与在线态一致
        const restored = await loadDocFromIndexedDB(fileId);
        if (cancelled) {
          restored?.destroy();
          return;
        }
        if (restored) {
          const um = createUndoManager(restored);
          setState({ doc: restored, um, ownerUserId: null });
          void api(`/files/${fileId}/open`, { method: 'POST' }).catch(() => undefined);
        } else {
          setError(e instanceof Error ? e.message : '加载失败');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // 卸载：清理防抖计时并把未落库的标题直接 PATCH（冲刷，避免丢改名）
  useEffect(
    () => () => {
      if (patchTimer.current !== null) clearTimeout(patchTimer.current);
      const title = pendingTitle.current;
      if (title !== null) {
        void api(`/files/${fileId}`, { method: 'PATCH', body: { title } }).catch(
          () => undefined,
        );
        pendingTitle.current = null;
      }
    },
    [fileId],
  );

  const setTitle = (title: string): void => {
    if (!state) return;
    if (title.trim() === '') return; // 空标题（fix round 1）：不写文档更不 PATCH，受控值回灌恢复
    setDocMeta(state.doc, { title }, ORIGIN_USER);
    pendingTitle.current = title;
    if (patchTimer.current !== null) clearTimeout(patchTimer.current);
    patchTimer.current = setTimeout(() => {
      patchTimer.current = null;
      void api(`/files/${fileId}`, { method: 'PATCH', body: { title } })
        .then(() => {
          if (pendingTitle.current === title) pendingTitle.current = null;
        })
        .catch(() => undefined);
    }, TITLE_PATCH_DEBOUNCE_MS);
  };

  return { state, error, setTitle, baseUpdatedAtRef };
}
