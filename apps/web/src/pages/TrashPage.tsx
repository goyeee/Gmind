import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TrashItem } from '@gmind/shared';
import { api, apiDel, apiPost } from '../api/client';

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

/** 回收站（M3a Task 9 接线，FR-FIL-005~007）：还原 / 彻底删除（二次确认）/ 30 天保留提示。 */
export function TrashPage() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [error, setError] = useState('');
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);

  const reload = useCallback(async () => {
    setItems(await api<TrashItem[]>('/trash'));
  }, []);

  useEffect(() => {
    void reload().catch((e) => setError(msgOf(e)));
  }, [reload]);

  async function restore(t: TrashItem): Promise<void> {
    try {
      await apiPost(`/trash/${t.id}/restore`);
      await reload();
    } catch (e) {
      setError(msgOf(e));
    }
  }

  async function purge(): Promise<void> {
    if (!purgeTarget) return;
    try {
      await apiDel(`/trash/${purgeTarget.id}`);
      setPurgeTarget(null);
      await reload();
    } catch (e) {
      setError(msgOf(e));
    }
  }

  return (
    <div className="trash-page" data-testid="trash-page">
      <header className="workspace-header">
        <h2>回收站</h2>
        <div className="header-actions">
          <Link to="/workspace">返回工作台</Link>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <p className="trash-hint">回收站内容保留 30 天，到期自动彻底删除</p>
      <ul className="trash-list">
        {items.map((t) => (
          <li key={t.id}>
            <span className="title">{t.title}</span>
            <span className="meta">删除时间 {new Date(t.deletedAt).toLocaleString()}</span>
            <span className="meta">删除人 {t.deletedByName ?? '—'}</span>
            <span className="meta">{t.folderName ? `原位置 ${t.folderName}` : '原位置 根目录'}</span>
            <span className="ops">
              <button data-testid="restore-btn" onClick={() => void restore(t)}>
                还原
              </button>
              <button className="danger" data-testid="purge-btn" onClick={() => setPurgeTarget(t)}>
                彻底删除
              </button>
            </span>
          </li>
        ))}
        {items.length === 0 && <li className="empty">回收站为空</li>}
      </ul>

      {purgeTarget && (
        <div className="modal-mask" data-testid="purge-confirm">
          <div className="modal">
            <h3>彻底删除「{purgeTarget.title}」？</h3>
            <p>彻底删除后不可恢复，评论 / 版本 / 协作记录将一并清除。</p>
            <div className="modal-actions">
              <button onClick={() => setPurgeTarget(null)}>取消</button>
              <button className="danger" data-testid="purge-confirm-btn" onClick={() => void purge()}>
                确认彻底删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
