import { useMemo, type ReactElement } from 'react';
import type * as Y from 'yjs';
import { getMeta, getNode, setCustomField, setIcon, setNodeTask, type IconGroup } from '@gmind/core';
import { MARKER_CATALOG, type MarkerGlyphDef } from '@gmind/engine';
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
 * 节点任务快速设置弹层（M7c-C3，对标 mindgrid NodeQuickCard）：
 * 选中节点右键菜单「任务设置」或按 `,` 弹出的紧凑卡（fixed 锚定点击点/节点右缘，
 * 视口内钳制——同 marker-picker 模式，钳制在页面侧坐标计算）。
 *
 * 内容：状态四选（色点）/ 负责人（成员多选）/ 优先级九徽（MARKER_CATALOG.priority
 * 复用）/ 常用图标一行（other 组 ✓✕★⚠?💡 六枚）+「更多」跳标记面板 / 三日期
 * （SmartDateInput）/ 进度（叶子数字输入、父级 Σ 只读）/ 自定义属性（表格自
 * 定义列逐列渲染 CustomFieldInput，即改即存）。
 *
 * 写纪律：全部走 core op（setNodeTask / setIcon）+ afterUserWrite——即点即存、
 * 无「保存」按钮；异常两段式 toast。Esc/外点关闭由页面侧统一监听（同
 * markerPicker 机制）；readOnly 由页面侧闸（不弹）。优先级= single 组（点当前值
 * 移除该组）、常用图标= other 多选组 toggle——同值移除判定在读侧完成后写 null/值。
 */

/** 快速卡常用图标（other 组前 6 枚：✓✕★⚠?💡，值目录见 @gmind/core OTHER_VALUES）。 */
const QUICK_ICON_VALUES = ['done', 'cancel', 'important', 'alert', 'question', 'idea'] as const;

/** 卡宽（钳制用，与 task-panel.css .task-quickcard width 一致）。 */
const CARD_W = 300;

export interface TaskQuickCardProps {
  doc: Y.Doc;
  fileId: string;
  nodeId: string;
  /** 文档版本（EditorPage tick）：本地/远端任何 doc 更新驱动快照重算。 */
  docVersion: number;
  /** 弹出锚点（viewport 客户端坐标，fixed 定位）。 */
  anchor: { x: number; y: number };
  presence: PresenceMember[];
  afterUserWrite: () => void;
  showToast: (message: string) => void;
  /** 「更多」：关闭本卡并打开标记面板（页面侧 openMarkerPanel('icon')）。 */
  onMoreMarkers: () => void;
  onClose: () => void;
}

export function TaskQuickCard(props: TaskQuickCardProps): ReactElement | null {
  const { doc, fileId, nodeId, docVersion, anchor, presence, afterUserWrite, showToast, onMoreMarkers, onClose } =
    props;
  const snap = getNode(doc, nodeId);
  const alive = !!snap && !snap.deleted;
  /** 自定义列 schema（meta.customColumns；无列不渲染小节——零噪音）。 */
  const customColumns = getMeta(doc).customColumns;

  const deriveNodes = useMemo(() => deriveNodesOfDoc(doc), [doc, docVersion]);
  const docOwnerIds = useMemo(() => {
    const ids: string[] = [];
    for (const n of deriveNodes) for (const o of n.task?.owners ?? []) if (!ids.includes(o)) ids.push(o);
    return ids;
  }, [deriveNodes]);
  const memberIndex = useTaskMembers(fileId, presence, docOwnerIds);

  if (!alive || !snap) return null;

  const task = snap.task;
  const owners = [...task.owners];
  const node = deriveNodes.find((n) => n.id === nodeId);
  const hasChildren = childrenOf(deriveNodes, nodeId).length > 0;
  const eff = node ? effectiveProgress(deriveNodes, nodeId) : task.progress;
  const overdue = node ? isOverdue(node, deriveNodes) : false;
  const today = todayStr();

  const write = (fn: () => void, fallback: string): void => {
    try {
      fn();
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : fallback);
    }
  };
  const commitTask = (patch: TaskPatch): void =>
    write(() => setNodeTask(doc, nodeId, patch), '任务字段保存失败，请调整后重试');
  const toggleOwner = (userId: string): void =>
    commitTask({ owners: owners.includes(userId) ? owners.filter((o) => o !== userId) : [...owners, userId] });
  const toggleIcon = (group: IconGroup, value: string): void =>
    write(() => {
      const has = snap.icons?.[group]?.includes(value) ?? false;
      setIcon(doc, nodeId, group, has ? null : value);
    }, '标记设置失败');

  // 视口内钳制（同 marker-picker：锚点右下偏移 6px，右/下缘收回）
  const left = Math.max(8, Math.min(anchor.x + 6, window.innerWidth - CARD_W - 8));
  const top = Math.max(8, Math.min(anchor.y + 6, window.innerHeight - 460));

  const otherDefs = MARKER_CATALOG.other as readonly MarkerGlyphDef[];

  return (
    <div
      className="task-quickcard"
      data-testid="task-quickcard"
      style={{ left, top }}
      role="dialog"
      aria-label="任务设置"
    >
      <div className="task-quickcard-head">
        <span className="task-quickcard-title">
          任务设置
          <span className="task-quickcard-sub">{snap.text || '（未命名）'}</span>
        </span>
        <button
          type="button"
          className="task-quickcard-close"
          data-testid="task-quickcard-close"
          title="关闭（Esc）"
          aria-label="关闭任务设置"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="task-quickcard-body">
        <div>
          <span className="task-field-label">状态</span>
          <div className="task-status-row">
            {STATUS_KEYS.map((s: TaskStatus) => (
              <button
                key={s}
                type="button"
                className={task.status === s ? 'task-status-btn active' : 'task-status-btn'}
                data-testid={`quickcard-status-${s}`}
                aria-pressed={task.status === s}
                onClick={() => commitTask({ status: s })}
              >
                <span className="task-dot" style={{ background: STATUS_META[s].color }} />
                {STATUS_META[s].label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="task-field-label">负责人</span>
          <MemberMultiSelect
            memberIndex={memberIndex}
            selected={owners}
            onToggle={toggleOwner}
            testIdPrefix="quickcard-owner"
          />
        </div>
        <div>
          <span className="task-field-label">优先级</span>
          <div className="task-chip-row">
            {(MARKER_CATALOG.priority as readonly MarkerGlyphDef[]).map((def) => {
              const active = snap.icons?.priority?.includes(def.value) ?? false;
              return (
                <button
                  key={def.value}
                  type="button"
                  className={active ? 'task-chip-btn active' : 'task-chip-btn'}
                  data-testid={`quickcard-priority-${def.value}`}
                  title={active ? `${def.label}（再点取消）` : def.label}
                  aria-label={def.label}
                  aria-pressed={active}
                  onClick={() => toggleIcon('priority', def.value)}
                >
                  <MarkerChip def={def} />
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <span className="task-field-label">常用图标</span>
          <div className="task-chip-row">
            {QUICK_ICON_VALUES.map((value) => {
              const def = otherDefs.find((d) => d.value === value);
              if (!def) return null;
              const active = snap.icons?.other?.includes(value) ?? false;
              return (
                <button
                  key={value}
                  type="button"
                  className={active ? 'task-chip-btn active' : 'task-chip-btn'}
                  data-testid={`quickcard-icon-${value}`}
                  title={active ? `${def.label}（再点取消）` : def.label}
                  aria-label={def.label}
                  aria-pressed={active}
                  onClick={() => toggleIcon('other', value)}
                >
                  <MarkerChip def={def} />
                </button>
              );
            })}
            <button
              type="button"
              className="task-more-btn"
              data-testid="quickcard-icon-more"
              title="打开标记面板"
              onClick={onMoreMarkers}
            >
              更多…
            </button>
          </div>
        </div>
        <div>
          <span className="task-field-label">日期</span>
          <div className="task-date-row">
            <span className="task-field-label">开始</span>
            <SmartDateInput
              testId="quickcard-date-startDate"
              value={task.startDate}
              onCommit={(v) => {
                if (v !== task.startDate) commitTask({ startDate: v });
              }}
            />
          </div>
          <div className="task-date-row">
            <span className="task-field-label">预期</span>
            <SmartDateInput
              testId="quickcard-date-dueDate"
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
              testId="quickcard-date-doneDate"
              value={task.doneDate}
              done={task.doneDate != null}
              onCommit={(v) => {
                if (v !== task.doneDate) commitTask({ doneDate: v });
              }}
            />
          </div>
        </div>
        <div>
          <span className="task-field-label">进度</span>
          <ProgressField
            hasChildren={hasChildren}
            effective={eff}
            progress={task.progress}
            testId="quickcard-progress"
            onCommit={(v) => commitTask({ progress: v })}
          />
        </div>
        {/* 自定义属性（表格自定义列消费侧）：任务字段之后按 meta.customColumns 逐列
            渲染 CustomFieldInput（同款编辑器/空值占位），即改即存 setCustomField。 */}
        {customColumns.length > 0 && (
          <div data-testid="quickcard-custom-section">
            <span className="task-field-label">自定义属性</span>
            {customColumns.map((col) => (
              <div className="task-date-row" key={col.id} data-testid="quickcard-custom-row">
                <span className="task-field-label">{col.name}</span>
                <CustomFieldInput
                  def={col}
                  value={snap.custom?.[col.id]}
                  memberIndex={memberIndex}
                  onCommit={(v) =>
                    write(() => setCustomField(doc, nodeId, col.id, v), '自定义属性保存失败，请调整后重试')
                  }
                  testIdPrefix="quickcard-custom"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
