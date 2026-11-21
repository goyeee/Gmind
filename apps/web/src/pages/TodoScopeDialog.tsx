import { useEffect, useState } from 'react';
import type { TodoScope, TodoScopeFile } from '@gmind/shared';
import { fetchTodoScope, updateTodoScope } from '../api/todos';
// 样式在 workspace.css（todo-scope-* 段）——弹窗挂在 WorkspaceShell 内随宿主页加载

/**
 * 待办/统计参与范围配置弹窗（2026-11-21 需求方追加）：每个人可配置「我的待办 +
 * 统计面板」参与哪些文件/画布，默认新文件全关联，可随时取消或恢复。
 *
 * - 我的待办与统计面板共用同一份配置（服务端 todo_scope_config 表，跨设备一致），
 *   两页面页头各有一个「⚙ 配置」入口打开本弹窗；
 * - 文件行 = 总开关（关 = 整个文件排除）；展开看画布级开关（只列**有任务**的画布
 *   ——无任务画布排除无意义；「未知画布」旧索引行不入清单，文件级开关可覆盖）；
 * - 开关即改（PUT 幂等），改完回调 onChanged 让宿主页刷新列表/统计；
 * - 文件清单 = 我可见的存活文件全集（含暂无任务的——以后加了任务自动生效）。
 */

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

export function TodoScopeDialog({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose(): void;
  /** 任一开关变更后回调（宿主刷新列表/统计；弹窗保持打开）。 */
  onChanged?(): void;
}) {
  const [scope, setScope] = useState<TodoScope | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setScope(null);
    void fetchTodoScope()
      .then((r) => {
        if (alive) setScope(r);
      })
      .catch((e: unknown) => {
        if (alive) {
          setScope({ files: [] });
          setToast(msgOf(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  async function toggleFile(file: TodoScopeFile): Promise<void> {
    try {
      await updateTodoScope({ fileId: file.fileId, excluded: !file.excluded });
      setScope((prev) =>
        prev
          ? { files: prev.files.map((f) => (f.fileId === file.fileId ? { ...f, excluded: !f.excluded } : f)) }
          : prev,
      );
      onChanged?.();
    } catch (e) {
      setToast(msgOf(e));
    }
  }

  async function toggleCanvas(file: TodoScopeFile, canvasId: string, excluded: boolean): Promise<void> {
    try {
      await updateTodoScope({ fileId: file.fileId, canvasId, excluded });
      setScope((prev) =>
        prev
          ? {
              files: prev.files.map((f) =>
                f.fileId === file.fileId
                  ? { ...f, canvases: f.canvases.map((c) => (c.canvasId === canvasId ? { ...c, excluded } : c)) }
                  : f,
              ),
            }
          : prev,
      );
      onChanged?.();
    } catch (e) {
      setToast(msgOf(e));
    }
  }

  return (
    <div className="todo-scope-mask" data-testid="todo-scope-dialog" onClick={onClose}>
      <div className="todo-scope-pop" role="dialog" aria-label="待办范围配置" onClick={(e) => e.stopPropagation()}>
        <header className="todo-scope-head">
          <div>
            <b>待办与统计范围</b>
            <p className="todo-scope-sub">新文件默认自动参与；关闭某个文件或画布后，「我的待办」和「统计面板」都不再统计它</p>
          </div>
          <button
            type="button"
            className="todo-scope-close"
            data-testid="todo-scope-close"
            aria-label="关闭配置"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {scope === null && <p className="admin-users-hint">加载中…</p>}
        {scope !== null && scope.files.length === 0 && (
          <p className="admin-users-hint" data-testid="todo-scope-empty">
            还没有可见文件
          </p>
        )}
        <ul className="todo-scope-files">
          {scope?.files.map((file) => (
            <li key={file.fileId} className="todo-scope-file" data-testid={`todo-scope-file-${file.fileId}`}>
              <div className="todo-scope-file-row">
                <button
                  type="button"
                  className={'todo-scope-expand' + (expanded.has(file.fileId) ? ' open' : '')}
                  aria-label={file.canvases.length === 0 ? '无画布可配置' : '展开画布配置'}
                  aria-expanded={expanded.has(file.fileId)}
                  disabled={file.canvases.length === 0}
                  onClick={() =>
                    setExpanded((prev) => {
                      const n = new Set(prev);
                      if (n.has(file.fileId)) n.delete(file.fileId);
                      else n.add(file.fileId);
                      return n;
                    })
                  }
                >
                  ▸
                </button>
                <span className="todo-scope-name" title={file.title}>
                  {file.title}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={!file.excluded}
                  aria-label={`参与待办：${file.title}`}
                  className="pref-switch"
                  data-testid={`todo-scope-file-switch-${file.fileId}`}
                  onClick={() => void toggleFile(file)}
                >
                  <i aria-hidden />
                </button>
              </div>
              {expanded.has(file.fileId) && (
                <ul className="todo-scope-canvases">
                  {file.canvases.length === 0 && <li className="todo-scope-canvas-empty">该文件还没有带任务的画布</li>}
                  {file.canvases.map((c) => (
                    <li key={c.canvasId} className={'todo-scope-canvas' + (file.excluded ? ' dim' : '')}>
                      <span className="todo-scope-name">{c.canvasName}</span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={!c.excluded}
                        aria-label={`参与待办：${file.title} · ${c.canvasName}`}
                        className="pref-switch"
                        data-testid={`todo-scope-canvas-switch-${file.fileId}-${c.canvasId}`}
                        disabled={file.excluded}
                        onClick={() => void toggleCanvas(file, c.canvasId, !c.excluded)}
                      >
                        <i aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        {toast && (
          <div className="workspace-toast" data-testid="toast" role="alert">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
