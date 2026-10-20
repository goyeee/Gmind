import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import {
  MARKER_GROUP_MODE,
  MAX_DESCRIPTION_LENGTH,
  getMeta,
  setDescription,
  setCustomField,
  setIcon,
  setNodeTask,
  setText,
  progressStageOf,
  type IconGroup,
  type NodeSnapshot,
} from '@gmind/core';
import { MARKER_CATALOG, MARKER_GROUP_LABELS, MARKER_ROW_ORDER, type MarkerGlyphDef } from '@gmind/engine';
import {
  childrenOf,
  effectiveProgress,
  isOverdue,
  todayStr,
  type TaskPatch,
  type TaskStatus,
} from '@gmind/shared';
import type { PresenceMember } from './collab';
import { MarkerChip } from './MarkerChip';
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
import './marker-picker.css';

/**
 * 右侧任务属性面板（M7c-C3/C4，spec 2026-09-29 §R3；对标 mindgrid NodeEditor）：
 * 工具栏「任务」按钮（task-toggle）点开的右列面板，与「格式」互斥（开任务收格式，
 * 开格式收任务——页面侧接线）；评论面板可共存（同列纵排）。
 * 2026-10-10 需求方裁定新增第二入口：**再点已选中节点**也开本面板（mindgrid
 * 「单击选中 · 再击开属性」同款；右键「任务设置」快速卡随之删除）。
 *
 * 内容（纵向分节，与 RichPanel 同族样式）：标题（2026-10-10 预览反馈起可编辑
 * input，键入即写 setText 实时同步画布节点）/ 描述（textarea，200 上限计数，
 * 同日起键入即写实时同步画布描述行；原失焦提交退役）/ 负责人（成员多选）/
 * 状态四选 / 优先级·标记（2026-10-10 需求方裁定内嵌化：优先级+进度两组图标平铺
 * 常显，其余六组折叠行——「在标记面板中编辑」按钮与 MarkerPanel 弹层退役）/
 * 三日期（SmartDateInput）/ 进度（叶子可编、父级 Σ 只读）/ 自定义属性（表格
 * 自定义列逐列渲染 CustomFieldInput，即改即存）/ 删除节点（危险红，confirm
 * 二次确认复用现有机制）。
 *
 * 写纪律：全部走 core op（setDescription / setNodeTask / setIcon）+ afterUserWrite，
 * 即改即存；异常两段式 toast；全部控件 data-testid `task-panel-*`。
 */

/** 内嵌目录常显行（平铺可直接点）：优先级 + 进度（2026-10-10 需求方裁定）。 */
const INLINE_MARKER_GROUPS: readonly IconGroup[] = ['priority', 'progress'];
/** 其余六组折叠行（点组名展开；组序沿用 engine 目录行序去掉常显两组）。 */
const COLLAPSED_MARKER_GROUPS: readonly IconGroup[] = MARKER_ROW_ORDER.filter(
  (g) => !INLINE_MARKER_GROUPS.includes(g),
);

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
  /** 删除当前选中节点（页面侧 handleDelete；确认弹窗在本组件内）。 */
  onDelete: () => void;
  onClose: () => void;
}

export function TaskPanel(props: TaskPanelProps): ReactElement {
  const { doc, fileId, nodeId, selected, docVersion, presence, afterUserWrite, showToast, onDelete, onClose } =
    props;
  const snap = selected && !selected.deleted ? selected : null;
  // 标题/描述草稿（受控本地态）：仅切换选中节点时从文档回灌（tick 驱动的快照刷新
  // 不得覆盖正在编辑的输入——RichPanel 同款裁决）。
  // 2026-10-10 需求方裁定（预览反馈）：标题改可编辑输入框、描述改**键入即写**——
  // 两者实时经 core setText/setDescription 落文档，画布节点文字同帧跟随（撤销栈
  // 按 500ms 合并打字突发）；未变更零写入（同值守卫）。
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  // 折叠标记组的展开态（2026-10-10 内嵌化）：组名→开合，切换节点不重置（跨节点
  // 连续编辑同一组的常见流）。
  const [openMarkerGroups, setOpenMarkerGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setTitle(snap?.text ?? '');
    setDesc(snap?.description ?? '');
    // 仅 nodeId 变化回灌（RichPanel 同款裁决）：tick 刷新不得覆盖编辑中的输入
  }, [nodeId]);

  const deriveNodes = useMemo(() => deriveNodesOfDoc(doc), [doc, docVersion]);
  /** 自定义列 schema（meta.customColumns；按类型拆分后分别塞进负责人/日期/其余区）。 */
  const customColumns = getMeta(doc).customColumns;
  const ownerCustomColumns = customColumns.filter((c) => c.type === 'assignee');
  const dateCustomColumns = customColumns.filter((c) => c.type === 'date');
  const restCustomColumns = customColumns.filter((c) => c.type !== 'assignee' && c.type !== 'date');
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

  const commitDescription = (next: string): void => {
    if (!snap) return;
    if ((snap.description ?? '') === next) return; // 未变更零写入
    write(() => setDescription(doc, snap.id, next), '描述保存失败，请精简后重试');
  };

  /** 标题键入即写（2026-10-10 裁定）：空串不提交（脑图节点无空标题语义，清空等
   *  下次有值再写；本地输入态不受限）。 */
  const commitTitle = (next: string): void => {
    if (!snap) return;
    if (next === snap.text) return; // 未变更零写入
    if (next.trim() === '') return; // 空标题不写入（待用户输入非空值时自然提交）
    write(() => setText(doc, snap.id, next), '标题保存失败，请重试');
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
  // 父级自动汇总开关：显式设置按显式；未设置 → 默认手动（需求方 2026-10-20 裁定）。
  const autoProgress = task.autoProgress ?? false;
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

  // —— 内嵌标记编辑（2026-10-10 需求方裁定：优先级/进度平铺常显 + 其余六组折叠）——
  // 进度行 radio（全量联动）：高亮 = 当前任务百分比对应档位（progressStageOf）；
  // 点档位经 setIcon 反向同步——core 同事务写 task.progress=档位百分比并落徽章
  // （当前档再点幂等：徽章已在=零事务；徽章缺失（新节点点「未开始」显式落徽章，
  // 进度 0 走 setNodeTask 会被同值守卫吞掉）则补齐）。父级只读（与 ProgressField
  // 父级 Σ 只读一致——父节点进度按子级自动汇总）。
  const activeStage = progressStageOf(task.progress);
  const clickProgressStage = (def: MarkerGlyphDef): void => {
    // 自动汇总父级：进度由子级决定，档位按钮只读。
    if (autoProgress) return;
    write(() => setIcon(doc, snap.id, 'progress', def.value), '任务进度保存失败，请调整后重试');
  };
  // 其余组点击：single 组再点当前值取消（setIcon null）、multi 组 core toggle 直写。
  const clickMarkerValue = (group: IconGroup, value: string): void => {
    if (MARKER_GROUP_MODE[group] === 'multi') {
      write(() => setIcon(doc, snap.id, group, value), '标记设置失败');
      return;
    }
    const has = (snap.icons[group] ?? []).includes(value);
    write(() => setIcon(doc, snap.id, group, has ? null : value), '标记设置失败');
  };
  const markerValueButton = (
    group: IconGroup,
    def: MarkerGlyphDef,
    active: boolean,
    disabled: boolean,
    onClick: () => void,
  ): ReactElement => (
    <button
      key={def.value}
      type="button"
      data-testid={`marker-${group}-${def.value}`}
      title={def.label}
      aria-label={def.label}
      aria-pressed={active}
      disabled={disabled}
      className={active ? 'task-marker-btn active' : 'task-marker-btn'}
      onClick={onClick}
    >
      <MarkerChip def={def} />
    </button>
  );

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
        <input
          className="task-panel-title"
          data-testid="task-panel-title"
          value={title}
          placeholder="（未命名）"
          aria-label="节点标题"
          onChange={(e) => {
            setTitle(e.target.value);
            commitTitle(e.target.value);
          }}
        />
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
          onChange={(e) => {
            setDesc(e.target.value);
            commitDescription(e.target.value); // 键入即写（2026-10-10 裁定）
          }}
          onBlur={(e) => commitDescription(e.target.value)}
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
        {/* 人员相关自定义属性（assignee 类型）直接跟在负责人下面，不再挂「自定义属性」标题 */}
        {ownerCustomColumns.map((col) => (
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
        {/* 常显行：优先级（single 单选替换，再点当前值取消）——2026-10-10 需求方
            裁定：目录全量平铺常显（弹层与跳转按钮退役）。 */}
        <div className="task-marker-row" data-testid="task-panel-marker-row-priority">
          <em className="task-marker-row-label">{MARKER_GROUP_LABELS.priority}</em>
          <div className="task-marker-grid">
            {(MARKER_CATALOG.priority as readonly MarkerGlyphDef[]).map((def) =>
              markerValueButton('priority', def, (snap.icons.priority ?? []).includes(def.value), false, () =>
                clickMarkerValue('priority', def.value),
              ),
            )}
          </div>
        </div>
        {/* 常显行：进度 radio（全量联动）——高亮=当前百分比档位；点档位=写百分比
            （core 同步徽章）；自动汇总父级只读。 */}
        <div className="task-marker-row" data-testid="task-panel-marker-row-progress">
          <em className="task-marker-row-label">{MARKER_GROUP_LABELS.progress}</em>
          <div className="task-marker-grid">
            {(MARKER_CATALOG.progress as readonly MarkerGlyphDef[]).map((def) =>
              markerValueButton('progress', def, activeStage === def.value, autoProgress, () =>
                clickProgressStage(def),
              ),
            )}
          </div>
          {autoProgress && <span className="task-marker-hint">父节点进度按子级自动汇总</span>}
        </div>
        {/* 折叠组：心情/数字/箭头/旗帜/其他/表情（点组名开合；已选计数回显）。 */}
        {COLLAPSED_MARKER_GROUPS.map((group) => {
          const open = openMarkerGroups[group] ?? false;
          const current = snap.icons[group] ?? [];
          return (
            <div className="task-marker-collapse" key={group} data-testid={`task-panel-marker-group-${group}`}>
              <button
                type="button"
                className="task-marker-collapse-head"
                data-testid={`task-panel-marker-toggle-${group}`}
                aria-expanded={open}
                onClick={() => setOpenMarkerGroups((s) => ({ ...s, [group]: !open }))}
              >
                <em className="task-marker-row-label">{MARKER_GROUP_LABELS[group]}</em>
                {current.length > 0 && <span className="task-marker-count">{current.length}</span>}
                <span className="task-marker-caret" aria-hidden>
                  {open ? '▾' : '▸'}
                </span>
              </button>
              {open && (
                <div className="task-marker-grid">
                  {(MARKER_CATALOG[group] as readonly MarkerGlyphDef[]).map((def) =>
                    markerValueButton(group, def, current.includes(def.value), false, () =>
                      clickMarkerValue(group, def.value),
                    ),
                  )}
                </div>
              )}
            </div>
          );
        })}
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
        {/* 日期相关自定义属性（date 类型）并入日期组，同样去掉「自定义属性」标题 */}
        {dateCustomColumns.map((col) => (
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

      <section className="task-panel-section">
        <div className="task-progress-head">
          <span className="task-field-label">进度</span>
          {hasChildren && (
            <label className="task-auto-toggle" data-testid="task-panel-auto-progress-toggle">
              <input
                type="checkbox"
                checked={autoProgress}
                onChange={(e) => {
                  const next = e.target.checked;
                  // 开启自动：按子级覆盖当前进度；关闭自动：保留当前手动值。
                  commitTask(next ? { autoProgress: true, progress: eff } : { autoProgress: false });
                }}
              />
              自动计算
            </label>
          )}
        </div>
        <ProgressField
          auto={autoProgress}
          effective={eff}
          progress={task.progress}
          testId="task-panel-progress"
          onCommit={(v) => commitTask({ progress: v })}
        />
      </section>

      {/* 其余自定义属性（text/progress 等）：不挂「自定义属性」标题，按行渲染在进度之后。 */}
      {restCustomColumns.length > 0 && (
        <section className="task-panel-section" data-testid="task-panel-custom-section">
          {restCustomColumns.map((col) => (
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
