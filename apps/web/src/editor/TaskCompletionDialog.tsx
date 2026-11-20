import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { TaskStatus } from '@gmind/shared';
import { Avatar } from './TaskFields';
import './task-completion.css';

/**
 * 任务完成确认 / 重开与开始进度选择弹窗（Task 3，2026-11-20 任务模型裁定，spec §三.7/8、§六）：
 * - complete 模式：总进度设为 100% 与状态「已完成」是同一完成动作；存在未完成子进度
 *   时三选——「完成并全部改为 100%」（complete-subprogress，core 原子命令）/「仅完成，
 *   保留子进度」（preserve-subprogress）/ 取消（零写入）。
 * - reopen 模式：已完成任务重新打开必须明确选择 0～99% 的新进度（清除完成日期）；
 *   0%→进行中复用同一流程选 1～99%；不自动写 0/1/99。
 *
 * 三视图（任务面板/表格/脑图入口）共用本组件；Esc/取消零写入。确认时宿主先重执行
 * core 预检（plan Review Focus：确认时重新执行 core 预检，再调 completeNodeTask）。
 */

export interface UnfinishedEntry {
  /** 用户 ID（头像/名字锚点）。 */
  user: string;
  /** 显示名（宿主成员目录映射；查不到回退 ID 前 8 位）。 */
  name: string;
  /** 未完成子进度 0-99。 */
  progress: number;
  /** 头像地址（缺省 = 宿主预置分配）。 */
  avatar?: string | null;
  /** 人员列名（complete 列表分组展示用；owner 项为空）。 */
  colName?: string;
}

export function isUnfinishedNonEmpty(
  unfinished: { owner: { userId: string; progress: number } | null; assignees: Array<{ colId: string; user: string; progress: number }> } | null,
): boolean {
  return unfinished !== null && (unfinished.owner !== null || unfinished.assignees.length > 0);
}

export function TaskCompletionDialog({
  kind,
  unfinished,
  targetStatus,
  onConfirm,
  onConfirmProgress,
  onCancel,
}: {
  kind: 'complete' | 'reopen';
  /** complete 模式：未达 100% 的生效子进度项（ownerProgress + 全部人员条目）。 */
  unfinished?: UnfinishedEntry[];
  /** reopen 模式：目标状态（todo/doing/blocked；进度选择 0～99，doing 1～99）。 */
  targetStatus?: TaskStatus;
  /** complete：三选其一（core completeNodeTask 的两种模式）。 */
  onConfirm: (kind: 'complete', mode: 'preserve-subprogress' | 'complete-subprogress') => void;
  /** reopen：带选定进度确认（宿主组 patch {status, progress}）。 */
  onConfirmProgress: (kind: 'reopen', progress: number) => void;
  onCancel: () => void;
}): ReactElement {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const [progress, setProgress] = useState<string>(kind === 'reopen' ? '' : '');
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])]
        .filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.select();
    } else {
      boxRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
    }
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus();
    };
  }, []);

  const minProgress = kind === 'reopen' && targetStatus === 'doing' ? 1 : 0;
  const parsed = Number(progress);
  const valid = /^\d+$/.test(progress.trim()) && Number.isInteger(parsed) && parsed >= minProgress && parsed <= 99;

  return (
    <div className="task-dialog-overlay" data-testid="task-dialog-overlay" role="presentation">
      <div ref={boxRef} className="task-dialog" role="dialog" aria-modal="true" aria-label={kind === 'complete' ? '任务完成确认' : '选择新进度'}>
        {kind === 'complete' ? (
          <>
            <h3 className="task-dialog-title">任务完成确认</h3>
            <p className="task-dialog-hint">还有子进度未达 100%，选择本任务的完成方式：</p>
            <ul className="task-dialog-list" data-testid="task-dialog-unfinished">
              {unfinished?.map((e) => (
                <li key={`${e.colName ?? 'owner'}-${e.user}`} className="task-dialog-item">
                  <Avatar userId={e.user} nickname={e.name} avatar={e.avatar} size={18} />
                  <span className="task-dialog-item-name">{e.name}</span>
                  {e.colName !== undefined && <span className="task-dialog-item-col">{e.colName}</span>}
                  <span className="task-dialog-item-progress">{e.progress}%</span>
                </li>
              ))}
            </ul>
            <div className="task-dialog-actions">
              <button
                type="button"
                className="task-dialog-btn primary"
                data-testid="task-dialog-complete-all"
                onClick={() => onConfirm('complete', 'complete-subprogress')}
              >
                完成并全部改为 100%
              </button>
              <button
                type="button"
                className="task-dialog-btn"
                data-testid="task-dialog-complete-keep"
                onClick={() => onConfirm('complete', 'preserve-subprogress')}
              >
                仅完成，保留子进度
              </button>
              <button type="button" className="task-dialog-btn ghost" data-testid="task-dialog-cancel" onClick={onCancel}>
                取消
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="task-dialog-title">
              {targetStatus === 'doing' ? '开始任务' : targetStatus === 'blocked' ? '重新打开为「阻塞」' : '重新打开任务'}
            </h3>
            <p className="task-dialog-hint">
              {minProgress === 1 ? '进行中需要 1～99% 的进度，请先选择进度' : '请选择 0～99% 的新进度（完成日期将清除）'}
            </p>
            <div className="task-dialog-progress-row">
              <input
                ref={inputRef}
                type="number"
                min={minProgress}
                max={99}
                className="task-dialog-progress-input"
                data-testid="task-dialog-progress-input"
                value={progress}
                placeholder={`${minProgress}-99`}
                aria-label="新进度"
                onChange={(e) => setProgress(e.target.value)}
                onCompositionStart={() => { composingRef.current = true; }}
                onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && valid && !e.nativeEvent.isComposing && !composingRef.current) onConfirmProgress('reopen', parsed);
                }}
              />
              <span className="task-dialog-progress-unit">%</span>
            </div>
            {!valid && progress.trim() !== '' && (
              <span className="task-dialog-error" data-testid="task-dialog-progress-error">
                请输入 {minProgress}～99 之间的整数
              </span>
            )}
            <div className="task-dialog-actions">
              <button
                type="button"
                className="task-dialog-btn primary"
                data-testid="task-dialog-progress-confirm"
                disabled={!valid}
                onClick={() => onConfirmProgress('reopen', parsed)}
              >
                确认
              </button>
              <button type="button" className="task-dialog-btn ghost" data-testid="task-dialog-cancel" onClick={onCancel}>
                取消
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
