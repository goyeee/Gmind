import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import {
  MAX_DESCRIPTION_LENGTH,
  getMeta,
  setDescription,
  setCustomField,
  setNodeTask,
  type NodeSnapshot,
} from '@gmind/core';
import { MARKER_CATALOG, MARKER_ROW_ORDER, type MarkerGlyphDef } from '@gmind/engine';
import {
  childrenOf,
  effectiveProgress,
  isOverdue,
  todayStr,
  type TaskPatch,
  type TaskStatus,
} from '@gmind/shared';
import type { PresenceMember } from './collab';
import { MarkerChip } from './MarkerPanel';
import {
  CustomFieldInput,
  deriveNodesOfDoc,
  MemberMultiSelect,
  ProgressField,
  SmartDateInput,
  STATUS_KEYS,
  STATUS_META,
  useTaskMembers,
} from './TaskFields';
import './task-panel.css';

/**
 * 右侧任务属性面板（M7c-C3/C4，spec 2026-09-29 §R3；对标 mindgrid NodeEditor）：
 * 工具栏「任务」按钮（task-toggle）点开的右列面板，与「格式」互斥（开任务收格式，
 * 开格式收任务——页面侧接线）；评论面板可共存（同列纵排）。
 *
 * 内容（纵向分节，与 RichPanel 同族样式）：标题（只读展示）/ 描述（textarea，
 * 200 上限计数，失焦提交）/ 负责人（成员多选，同快速卡）/ 状态四选 / 优先级·标记
 * （当前标记回显 +「在标记面板中编辑」跳转）/ 三日期（SmartDateInput）/ 进度
 * （叶子可编、父级 Σ 只读）/ 自定义属性（表格自定义列逐列渲染 CustomFieldInput，
 * 即改即存）/ 删除节点（危险红，confirm 二次确认复用现有机制）。
 *
 * 写纪律：全部走 core op（setDescription / setNodeTask / setIcon）+ afterUserWrite，
 * 即改即存；异常两段式 toast；全部控件 data-testid `task-panel-*`。
 */

export interface TaskPanelProps {
  doc: Y.Doc;
  fileId: string;
  /** 选中节点 id；空串/已删 = 空态（提示选中节点）。 */
  nodeId: string;
  /** 选中节点快照（EditorPage 每 tick 计算，与画布同帧同源——RichPanel 同款）。 */
  selected: NodeSnapshot | null;
  /** 文档版本（EditorPage tick）：派生值（进度 Σ/逾期/子级判定）随写随刷。 */
  docVersion: number;
  presence: PresenceMember[];
  afterUserWrite: () => void;
  showToast: (message: string) => void;
  /** 「在标记面板中编辑」：关闭本面板入口动作由页面侧 openMarkerPanel('icon')。 */
  onOpenMarkers: () => void;
  /** 删除当前选中节点（页面侧 handleDelete；确认弹窗在本组件内）。 */
  onDelete: () => void;
  onClose: () => void;
}

export function TaskPanel(props: TaskPanelProps): ReactElement {
  const { doc, fileId, nodeId, selected, docVersion, presence, afterUserWrite, showToast, onOpenMarkers, onDelete, onClose } =
    props;
  const snap = selected && !selected.deleted ? selected : null;
  // 描述草稿（受控本地态）：仅切换选中节点时从文档回灌（tick 驱动的快照刷新不得
  // 覆盖正在编辑的输入——RichPanel 同款裁决）；失焦提交（未变更零写入）。
  const [desc, setDesc] = useState('');
  useEffect(() => {
    setDesc(snap?.description ?? '');
    // 仅 nodeId 变化回灌（RichPanel 同款裁决）：tick 刷新不得覆盖编辑中的输入
  }, [nodeId]);

  const deriveNodes = useMemo(() => deriveNodesOfDoc(doc), [doc, docVersion]);
  /** 自定义列 schema（meta.customColumns；无列不渲染小节——零噪音）。 */
  const customColumns = getMeta(doc).customColumns;
  const docOwnerIds = useMemo(() => {
    const ids: string[] = [];
    for (const n of deriveNodes) for (const o of n.task?.owners ?? []) if (!ids.includes(o)) ids.push(o);
    return ids;
  }, [deriveNodes]);
  const memberIndex = useTaskMembers(fileId, presence, docOwnerIds);

  const write = (fn: () => void, fallback: string): void => {
    try {
      fn();
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : fallback);
    }
  };

  const commitDescription = (): void => {
    if (!snap) return;
    const next = desc.trim();
    if ((snap.description ?? '') === next) return; // 未变更零写入
    write(() => setDescription(doc, snap.id, next), '描述保存失败，请精简后重试');
  };

  if (!snap) {
    return (
      <aside className="task-panel" data-testid="task-panel">
        <div className="task-panel-head">
          <h3>任务</h3>
          <button
            type="button"
            className="task-panel-close"
            data-testid="task-panel-close"
            title="关闭"
            aria-label="关闭任务面板"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="task-panel-empty">选中节点后查看与编辑任务</p>
      </aside>
    );
  }

  const task = snap.task;
  const owners = [...task.owners];
  const selfNode = deriveNodes.find((n) => n.id === snap.id);
  const hasChildren = childrenOf(deriveNodes, snap.id).length > 0;
  const eff = selfNode ? effectiveProgress(deriveNodes, snap.id) : task.progress;
  const overdue = selfNode ? isOverdue(selfNode, deriveNodes) : false;
  const today = todayStr();

  const commitTask = (patch: TaskPatch): void =>
    write(() => setNodeTask(doc, snap.id, patch), '任务字段保存失败，请调整后重试');
  const toggleOwner = (userId: string): void =>
    commitTask({ owners: owners.includes(userId) ? owners.filter((o) => o !== userId) : [...owners, userId] });

  const markerChips: ReactElement[] = [];
  for (const group of MARKER_ROW_ORDER) {
    for (const value of snap.icons[group] ?? []) {
      const def = (MARKER_CATALOG[group] as readonly MarkerGlyphDef[]).find((d) => d.value === value);
      if (!def) continue; // 目录外值（未收敛窗口期）确定性忽略
      markerChips.push(<MarkerChip key={`${group}-${value}`} def={def} />);
    }
  }

  return (
    <aside className="task-panel" data-testid="task-panel">
      <div className="task-panel-head">
        <h3>任务</h3>
        <button
          type="button"
          className="task-panel-close"
          data-testid="task-panel-close"
          title="关闭"
          aria-label="关闭任务面板"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <section className="task-panel-section">
        <span className="task-field-label">标题</span>
        <span className="task-panel-title" data-testid="task-panel-title">
          {snap.text || '（未命名）'}
        </span>
      </section>

      <section className="task-panel-section">
        <span className="task-field-label">描述</span>
        <textarea
          className="task-panel-desc"
          data-testid="task-panel-desc"
          value={desc}
          maxLength={MAX_DESCRIPTION_LENGTH}
          placeholder="一句话说明任务内容"
          aria-label="任务描述"
          onChange={(e) => setDesc(e.target.value)}
          onBlur={commitDescription}
        />
        <span className="task-panel-desc-count" data-testid="task-panel-desc-count">
          {desc.length}/{MAX_DESCRIPTION_LENGTH}
        </span>
      </section>

      <section className="task-panel-section">
        <span className="task-field-label">负责人</span>
        <MemberMultiSelect
          memberIndex={memberIndex}
          selected={owners}
          onToggle={toggleOwner}
          testIdPrefix="task-panel-owner"
        />
      </section>

      <section className="task-panel-section">
        <span className="task-field-label">状态</span>
        <div className="task-status-row">
          {STATUS_KEYS.map((s: TaskStatus) => (
            <button
              key={s}
              type="button"
              className={task.status === s ? 'task-status-btn active' : 'task-status-btn'}
              data-testid={`task-panel-status-${s}`}
              aria-pressed={task.status === s}
              onClick={() => commitTask({ status: s })}
            >
              <span className="task-dot" style={{ background: STATUS_META[s].color }} />
              {STATUS_META[s].label}
            </button>
          ))}
        </div>
      </section>

      <section className="task-panel-section">
        <span className="task-field-label">优先级 / 标记</span>
        <div className="task-panel-markers" data-testid="task-panel-markers">
          {markerChips.length > 0 ? (
            markerChips
          ) : (
            <span className="task-panel-markers-empty">未设置标记</span>
          )}
        </div>
        <button
          type="button"
          className="task-panel-jump"
          data-testid="task-panel-markers-edit"
          onClick={onOpenMarkers}
        >
          在标记面板中编辑
        </button>
      </section>

      <section className="task-panel-section">
        <span className="task-field-label">日期</span>
        <div className="task-date-row">
          <span className="task-field-label">开始</span>
          <SmartDateInput
            testId="task-panel-date-startDate"
            value={task.startDate}
            onCommit={(v) => {
              if (v !== task.startDate) commitTask({ startDate: v });
            }}
          />
        </div>
        <div className="task-date-row">
          <span className="task-field-label">预期</span>
          <SmartDateInput
            testId="task-panel-date-dueDate"
            value={task.dueDate}
            overdue={overdue}
            today={task.dueDate === today}
            onCommit={(v) => {
              if (v !== task.dueDate) commitTask({ dueDate: v });
            }}
          />
        </div>
        <div className="task-date-row">
          <span className="task-field-label">完成</span>
          <SmartDateInput
            testId="task-panel-date-doneDate"
            value={task.doneDate}
            done={task.doneDate != null}
            onCommit={(v) => {
              if (v !== task.doneDate) commitTask({ doneDate: v });
            }}
          />
        </div>
      </section>

      <section className="task-panel-section">
        <span className="task-field-label">进度</span>
        <ProgressField
          hasChildren={hasChildren}
          effective={eff}
          progress={task.progress}
          testId="task-panel-progress"
          onCommit={(v) => commitTask({ progress: v })}
        />
      </section>

      {/* 自定义属性（表格自定义列消费侧）：任务字段之后按 meta.customColumns 逐列
          渲染 CustomFieldInput（同款编辑器/空值占位），即改即存 setCustomField。 */}
      {customColumns.length > 0 && (
        <section className="task-panel-section" data-testid="task-panel-custom-section">
          <span className="task-field-label">自定义属性</span>
          {customColumns.map((col) => (
            <div className="task-date-row" key={col.id} data-testid="task-panel-custom-row">
              <span className="task-field-label">{col.name}</span>
              <CustomFieldInput
                def={col}
                value={snap.custom?.[col.id]}
                memberIndex={memberIndex}
                onCommit={(v) =>
                  write(() => setCustomField(doc, snap.id, col.id, v), '自定义属性保存失败，请调整后重试')
                }
                testIdPrefix="task-panel-custom"
              />
            </div>
          ))}
        </section>
      )}

      <section className="task-panel-section">
        <button
          type="button"
          className="task-panel-delete"
          data-testid="task-panel-delete"
          onClick={() => {
            const title = snap.text || '（未命名）';
            if (!window.confirm(`确定删除节点「${title}」？其子级将一并删除（可用 Ctrl+Z 撤销）`)) return;
            onDelete();
          }}
        >
          删除节点（含子级）
        </button>
      </section>
    </aside>
  );
}
