import { useEffect, useMemo, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import {
  MARKER_GROUP_MODE,
  MAX_DESCRIPTION_LENGTH,
  ORIGIN_USER,
  PROGRESS_STAGE_PCT,
  addAssignee,
  completeNodeTask,
  getMeta,
  setDescription,
  removeAssignee,
  setAssigneeProgress,
  setCustomField,
  setIcon,
  setNodeTask,
  setOwnerProgress,
  setTaskOwner,
  setText,
  progressStageOf,
  unfinishedTaskProgressOf,
  type IconGroup,
  type NodeSnapshot,
} from '@gmind/core';
import { MARKER_CATALOG, MARKER_GROUP_LABELS, MARKER_ROW_ORDER, type MarkerGlyphDef } from '@gmind/engine';
import {
  childrenOf,
  isOverdue,
  taskDoneDateOf,
  taskProgressOf,
  taskStatusOf,
  todayStr,
  type TaskPatch,
  type TaskStatus,
} from '@gmind/shared';
import type { PresenceMember } from './collab';
import { MarkerChip } from './MarkerChip';
import {
  avatarSrcOf,
  CustomFieldInput,
  deriveNodesOfDoc,
  MemberMultiSelect,
  ProgressField,
  SmartDateInput,
  STATUS_KEYS,
  STATUS_META,
  useTaskMembers,
} from './TaskFields';
import { TaskCompletionDialog, type UnfinishedEntry } from './TaskCompletionDialog';
import { trackTaskWrite, type TaskWriteDetail, type TaskWriteIntent } from './taskEvents';
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
 * 2026-11-21 需求方裁定（面板进度交互重构）：负责人子进度填写行与人员列行内
 * 进度填写框退役——点头像调起 9 档进度选盘（负责人头像：有其他执行人写子进度、
 * 无执行人直接写任务总进度；人员列头像写逐人子进度）；进度值类入口（进度输入/
 * 档位/选盘）在完成态直接用所选值重开，不再二次弹确认框（纯状态切换仍弹进度
 * 选择——动作未携带进度值）。
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
  /** 当前画布 id（多画布口径：deriveNodesOfDoc 只拉平当前画布子树；缺省=core 缺省解析）。 */
  canvasId?: string;
  presence: PresenceMember[];
  afterUserWrite: () => void;
  showToast: (message: string) => void;
  /** 删除当前选中节点（页面侧 handleDelete；确认弹窗在本组件内）。 */
  onDelete: () => void;
  onClose: () => void;
}

export function TaskPanel(props: TaskPanelProps): ReactElement {
  const { doc, fileId, nodeId, selected, docVersion, canvasId, presence, afterUserWrite, showToast, onDelete, onClose } =
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
  // 完成确认 / 重开进度选择弹窗（2026-11-20 任务模型）：done 有未完成子进度 → 三选；
  // 重开与 0%→进行中（纯状态切换，未携带进度值）→ 进度选择（不自动写 0/1/99）。
  // Esc/取消零写入。2026-11-21 起进度值类入口（进度输入/档位/头像选盘）直接用所选
  // 值重开，不再二次确认。
  const [dialog, setDialog] = useState<
    | { kind: 'complete'; unfinished: UnfinishedEntry[] }
    | { kind: 'reopen'; targetStatus: TaskStatus }
    | null
  >(null);
  // 面板进度选盘（2026-11-21 需求方裁定「点头像调起进度图标选择进度」）：负责人
  // 头像 / 人员列成员头像点开的 9 档选盘浮层——owner.kind 写负责人子进度
  // （setOwnerProgress），无其他执行人时改写任务总进度（total，含 100=完成）；
  // assignee.kind 写人员列逐人进度（setAssigneeProgress 逐人 diff）。
  const [panelPicker, setPanelPicker] = useState<
    | {
        kind: 'owner';
        userId: string;
        /** 无其他执行人=true：写任务总进度（完成/重开语义），否则写负责人子进度。 */
        total: boolean;
        colName: string;
        name: string;
        avatar: string;
        progress: number;
        x: number;
        y: number;
      }
    | {
        kind: 'assignee';
        userId: string;
        colId: string;
        colName: string;
        name: string;
        avatar: string;
        progress: number;
        x: number;
        y: number;
      }
    | null
  >(null);
  const [progressReset, setProgressReset] = useState(0);
  useEffect(() => {
    setTitle(snap?.text ?? '');
    setDesc(snap?.description ?? '');
    // 仅 nodeId 变化回灌（RichPanel 同款裁决）：tick 刷新不得覆盖编辑中的输入
  }, [nodeId]);
  // 面板进度选盘 Esc/外点关闭（画布选盘同机制）。boundary 含 .tt-avatar-btn：
  // 选盘开着再点头像时 pointerdown 不抢先收盘，开合交给头像 click 的 toggle 分支
  // （同画布徽章豁免口径，防「闪关重弹」）。
  useEffect(() => {
    if (!panelPicker) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.panel-progress-picker, .tt-avatar-btn')) setPanelPicker(null);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPanelPicker(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [panelPicker]);

  const deriveNodes = useMemo(() => deriveNodesOfDoc(doc, canvasId, true), [doc, docVersion, canvasId]);
  /** 自定义列 schema（meta.customColumns；按类型拆分后分别塞进负责人/日期/其余区）。 */
  const customColumns = getMeta(doc).customColumns;
  const ownerCustomColumns = customColumns.filter((c) => c.type === 'assignee');
  const dateCustomColumns = customColumns.filter((c) => c.type === 'date');
  const restCustomColumns = customColumns.filter((c) => c.type !== 'assignee' && c.type !== 'date');
  const docOwnerIds = useMemo(() => {
    const ids: string[] = [];
    for (const n of deriveNodes) {
      const ownerId = n.task?.ownerId ?? n.task?.owners[0] ?? null;
      if (ownerId !== null && !ids.includes(ownerId)) ids.push(ownerId);
    }
    return ids;
  }, [deriveNodes]);
  const { memberIndex } = useTaskMembers(fileId, presence, docOwnerIds);

  const write = (fn: () => void, fallback: string): void => {
    try {
      fn();
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : fallback);
    }
  };

  /** 人员列条目当前子进度（动态声明的 before 值；旧 number 简形同 read 侧兼容）。 */
  const assigneeProgressOf = (colId: string, userId: string): number => {
    const v = snap?.custom?.[colId];
    if (typeof v !== 'object' || v === null) return 0;
    const entry = (v as Record<string, { progress?: unknown } | number>)[userId];
    if (typeof entry === 'number') return entry;
    return typeof entry?.progress === 'number' ? entry.progress : 0;
  };

  /** 任务写 + 动态声明（第二轮 spec §5.5）：trackTaskWrite 写前快照/写后发声明，
   *  write 抛错即无声明；面板全部任务写入口统一走本助手。 */
  const writeTask = (intent: TaskWriteIntent, fn: () => void, detail: TaskWriteDetail, fallback: string): void => {
    if (!snap) return; // 面板未锚定节点（暂态）无写无事件
    try {
      trackTaskWrite(doc, canvasId, snap.id, intent, fn, detail);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : fallback);
    }
  };

  const commitDescription = (next: string): void => {
    if (!snap) return;
    if ((snap.description ?? '') === next) return; // 未变更零写入
    write(() => setDescription(doc, snap.id, next, ORIGIN_USER, canvasId), '描述保存失败，请精简后重试');
  };

  /** 标题键入即写（2026-10-10 裁定）：空串不提交（脑图节点无空标题语义，清空等
   *  下次有值再写；本地输入态不受限）。 */
  const commitTitle = (next: string): void => {
    if (!snap) return;
    if (next === snap.text) return; // 未变更零写入
    if (next.trim() === '') return; // 空标题不写入（待用户输入非空值时自然提交）
    write(() => setText(doc, snap.id, next, ORIGIN_USER, canvasId), '标题保存失败，请重试');
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
  const selfNode = deriveNodes.find((n) => n.id === snap.id);
  const hasChildren = childrenOf(deriveNodes, snap.id).length > 0;
  // 父级自动汇总开关：显式设置按显式；未设置 → 默认手动（需求方 2026-10-20 裁定）。
  const autoProgress = task.autoProgress ?? false;
  // 2026-11-20 任务模型：总进度唯一口径 taskProgressOf（人员子进度不参与）。
  const eff = selfNode ? taskProgressOf(deriveNodes, snap.id) : task.progress;
  const displayStatus = selfNode ? taskStatusOf(deriveNodes, snap.id) : task.status;
  const displayDoneDate = selfNode ? taskDoneDateOf(deriveNodes, snap.id) : task.doneDate;
  const overdue = selfNode ? isOverdue(selfNode, deriveNodes) : false;
  const today = todayStr();

  const commitTask = (patch: TaskPatch): void =>
    writeTask('total', () => setNodeTask(doc, snap.id, patch, ORIGIN_USER, canvasId), {}, '任务字段保存失败，请调整后重试');

  // —— 状态点击（2026-11-20 任务模型裁定）——
  // done：有未完成子进度 → 三选弹窗（确认时宿主重新执行 core 预检再调原子命令）；
  // 无子进度未完成 → 直接完成（子进度保留语义）。已完成重开 / 0%→进行中 → 进度选择。
  const hasOtherExecutors = ownerCustomColumns.some((col) => {
    const v = snap.custom?.[col.id];
    return typeof v === 'object' && v !== null && Object.keys(v).length > 0;
  });
  const requestCompletion = (): void => {
    if (task.status === 'done' || task.progress === 100) return;
    const unfinished = unfinishedTaskProgressOf(doc, snap.id, canvasId);
    if (unfinished.owner === null && unfinished.assignees.length === 0) {
      writeTask('complete', () => completeNodeTask(doc, snap.id, 'preserve-subprogress', ORIGIN_USER, canvasId), {}, '任务完成保存失败，请重试');
      return;
    }
    const entries: UnfinishedEntry[] = [];
    if (unfinished.owner !== null) {
      entries.push({
        user: unfinished.owner.userId,
        name: memberIndex.get(unfinished.owner.userId)?.nickname ?? unfinished.owner.userId.slice(0, 8),
        progress: unfinished.owner.progress,
        avatar: memberIndex.get(unfinished.owner.userId)?.avatar ?? null,
      });
    }
    for (const a of unfinished.assignees) {
      const col = ownerCustomColumns.find((c) => c.id === a.colId);
      entries.push({
        user: a.user,
        name: memberIndex.get(a.user)?.nickname ?? a.user.slice(0, 8),
        progress: a.progress,
        avatar: memberIndex.get(a.user)?.avatar ?? null,
        colName: col?.name,
      });
    }
    setDialog({ kind: 'complete', unfinished: entries });
  };
  const requestProgress = (progress: number): void => {
    if (autoProgress || progress === task.progress) return;
    if (progress === 100) {
      requestCompletion();
      return;
    }
    // 完成态直接用所选进度重开（2026-11-21 需求方裁定「不要让用户确定百分比」）：
    // 进度值类入口不再二次弹确认框——裸进度写入在 core 走 applyStatusRules 静默
    // 联动（清完成日期、状态派生 todo/doing），重开弹窗只留给纯状态切换入口。
    commitTask({ progress });
  };
  const clickStatus = (s: TaskStatus): void => {
    if (autoProgress) return;
    if (s === 'done') {
      requestCompletion();
      return;
    }
    if ((task.status === 'done' || task.progress === 100)) {
      setDialog({ kind: 'reopen', targetStatus: s }); // 重开必须显式选 0～99 新进度
      return;
    }
    if (s === 'doing' && task.progress === 0) {
      // 0%→进行中（含 blocked 0%）选 1～99——与 core 门禁条件一致（operations.ts 只看 progress）
      setDialog({ kind: 'reopen', targetStatus: 'doing' });
      return;
    }
    commitTask({ status: s });
  };

  // —— 面板进度选盘（2026-11-21 需求方裁定「头像/名字分开，点头像调起进度图标
  //    选择进度」）：负责人头像 + 人员列成员头像共用 9 档选盘；写路径见
  //    applyPanelPickerValue（owner 子进度 / 无执行人时总进度 / 人员列逐人）。 ——
  const openOwnerPicker = (userId: string, at: { x: number; y: number }): void => {
    if (!snap || userId !== task.ownerId) return;
    if (!hasOtherExecutors && autoProgress) {
      showToast('父节点进度按子级自动汇总，请完成或调整子任务');
      return;
    }
    // 再点同一头像 = toggle 收盘（外点监听已豁免头像按钮，同画布徽章口径）。
    if (panelPicker && panelPicker.kind === 'owner' && panelPicker.userId === userId) {
      setPanelPicker(null);
      return;
    }
    const m = memberIndex.get(userId);
    setPanelPicker({
      kind: 'owner',
      userId,
      total: !hasOtherExecutors,
      colName: hasOtherExecutors ? '负责人' : '任务总进度',
      name: m?.nickname ?? userId.slice(0, 8),
      avatar: avatarSrcOf(m?.avatar ?? null, userId),
      progress: hasOtherExecutors ? (task.ownerProgress ?? 0) : task.progress,
      x: at.x,
      y: at.y,
    });
  };
  const openAssigneePicker = (
    colId: string,
    colName: string,
    userId: string,
    progress: number,
    at: { x: number; y: number },
  ): void => {
    // 再点同一头像 = toggle 收盘；换列/换成员重锚。
    if (panelPicker && panelPicker.kind === 'assignee' && panelPicker.colId === colId && panelPicker.userId === userId) {
      setPanelPicker(null);
      return;
    }
    const m = memberIndex.get(userId);
    setPanelPicker({
      kind: 'assignee',
      userId,
      colId,
      colName,
      name: m?.nickname ?? userId.slice(0, 8),
      avatar: avatarSrcOf(m?.avatar ?? null, userId),
      progress,
      x: at.x,
      y: at.y,
    });
  };
  const applyPanelPickerValue = (pct: number): void => {
    const p = panelPicker;
    setPanelPicker(null);
    if (!p || !snap) return;
    if (p.kind === 'owner') {
      if (p.total) {
        // 无其他执行人：头像选盘即任务总进度入口——100=完成（未完子进度走既有
        // 三选流），非 100 直接落值（完成态静默重开，与 requestProgress 同口径）。
        if (pct === 100) {
          requestCompletion();
        } else if (pct !== task.progress) {
          commitTask({ progress: pct });
        }
        return;
      }
      writeTask('sub', () => setOwnerProgress(doc, snap.id, pct, ORIGIN_USER, canvasId), { sub: { user: p.userId, before: task.ownerProgress ?? 0, after: pct, colName: '负责人子进度' } }, '负责人子进度保存失败，请重试');
      return;
    }
    writeTask('sub', () => setAssigneeProgress(doc, snap.id, p.colId, p.userId, pct, ORIGIN_USER, canvasId), { sub: { user: p.userId, before: p.progress, after: pct, colName: p.colName } }, '人员子进度保存失败，请重试');
  };

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
    const progress = PROGRESS_STAGE_PCT[def.value as keyof typeof PROGRESS_STAGE_PCT];
    if (progress === undefined) return;
    // 同值但徽章缺失（新节点点“未开始”）仍需落徽章；已有同档由 core 同值守卫零写。
    if (progress === eff) {
      write(() => setIcon(doc, snap.id, 'progress', def.value, ORIGIN_USER, canvasId), '任务进度保存失败，请调整后重试');
      return;
    }
    requestProgress(progress);
  };
  // 其余组点击：single 组再点当前值取消（setIcon null）、multi 组 core toggle 直写。
  const clickMarkerValue = (group: IconGroup, value: string): void => {
    if (MARKER_GROUP_MODE[group] === 'multi') {
      write(() => setIcon(doc, snap.id, group, value, ORIGIN_USER, canvasId), '标记设置失败');
      return;
    }
    const has = (snap.icons[group] ?? []).includes(value);
    write(() => setIcon(doc, snap.id, group, has ? null : value, ORIGIN_USER, canvasId), '标记设置失败');
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
        <span className="task-field-label">负责人（单选）</span>
        {/* 总负责人单选（2026-11-20 任务模型）：点成员=设为负责人，再点=取消指派；
            多人执行走下方人员列。2026-11-21：负责人子进度填写行退役——点负责人
            头像调起进度选盘（有其他执行人写其子进度；无执行人直接写任务总进度）。 */}
        <MemberMultiSelect
          memberIndex={memberIndex}
          selected={task.ownerId === null ? [] : [task.ownerId]}
          onToggle={(userId) =>
            writeTask(
              'owner',
              () => setTaskOwner(doc, snap.id, task.ownerId === userId ? null : userId, ORIGIN_USER, canvasId),
              { owner: { before: task.ownerId, after: task.ownerId === userId ? null : userId } },
              '负责人保存失败，请重试',
            )
          }
          onAvatarClick={openOwnerPicker}
          avatarTestIdPrefix="task-panel-owner-avatar"
          testIdPrefix="task-panel-owner"
        />
        {/* 人员相关自定义属性（assignee 类型）直接跟在负责人下面，不再挂「自定义属性」标题；
            面板变体：行内进度填写框退役，点成员头像调起进度选盘逐人写入。 */}
        {ownerCustomColumns.map((col) => (
          <div className="task-date-row" key={col.id} data-testid="task-panel-custom-row">
            <span className="task-field-label">{col.name}</span>
            <CustomFieldInput
              def={col}
              value={snap.custom?.[col.id]}
              memberIndex={memberIndex}
              onCommit={(v) =>
                write(() => setCustomField(doc, snap.id, col.id, v, ORIGIN_USER, canvasId), '自定义属性保存失败，请调整后重试')
              }
              onAssigneeProgress={(userId, progress) =>
                writeTask(
                  'sub',
                  () => setAssigneeProgress(doc, snap.id, col.id, userId, progress, ORIGIN_USER, canvasId),
                  { sub: { user: userId, before: assigneeProgressOf(col.id, userId), after: progress, colName: col.name } },
                  '人员子进度保存失败，请重试',
                )
              }
              onAssigneeToggle={(userId, assigned) =>
                writeTask(
                  assigned ? 'member-add' : 'member-remove',
                  () => {
                    if (assigned) addAssignee(doc, snap.id, col.id, userId, ORIGIN_USER, canvasId);
                    else removeAssignee(doc, snap.id, col.id, userId, ORIGIN_USER, canvasId);
                  },
                  { member: { user: userId, colName: col.name } },
                  '人员保存失败，请重试',
                )
              }
              onAssigneeAvatarPick={(userId, progress, at) => openAssigneePicker(col.id, col.name, userId, progress, at)}
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
              className={displayStatus === s ? 'task-status-btn active' : 'task-status-btn'}
              data-testid={`task-panel-status-${s}`}
              aria-pressed={displayStatus === s}
              disabled={autoProgress}
              title={autoProgress ? '自动父任务状态由子任务进度决定' : undefined}
              onClick={() => clickStatus(s)}
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
          {autoProgress ? (
            <span className="tt-date-text" data-testid="task-panel-date-doneDate">{displayDoneDate ?? '—'}</span>
          ) : (
            <SmartDateInput
              testId="task-panel-date-doneDate"
              value={displayDoneDate}
              done={displayDoneDate != null}
              onCommit={(v) => {
                if (v !== displayDoneDate) commitTask({ doneDate: v });
              }}
            />
          )}
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
                write(() => setCustomField(doc, snap.id, col.id, v, ORIGIN_USER, canvasId), '自定义属性保存失败，请调整后重试')
              }
              onAssigneeProgress={(userId, progress) =>
                writeTask(
                  'sub',
                  () => setAssigneeProgress(doc, snap.id, col.id, userId, progress, ORIGIN_USER, canvasId),
                  { sub: { user: userId, before: assigneeProgressOf(col.id, userId), after: progress, colName: col.name } },
                  '人员子进度保存失败，请重试',
                )
              }
              onAssigneeToggle={(userId, assigned) =>
                writeTask(
                  assigned ? 'member-add' : 'member-remove',
                  () => {
                    if (assigned) addAssignee(doc, snap.id, col.id, userId, ORIGIN_USER, canvasId);
                    else removeAssignee(doc, snap.id, col.id, userId, ORIGIN_USER, canvasId);
                  },
                  { member: { user: userId, colName: col.name } },
                  '人员保存失败，请重试',
                )
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
          key={`${snap.id}:${task.progress}:${progressReset}`}
          auto={autoProgress}
          effective={eff}
          progress={task.progress}
          testId="task-panel-progress"
          onCommit={requestProgress}
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
                  write(() => setCustomField(doc, snap.id, col.id, v, ORIGIN_USER, canvasId), '自定义属性保存失败，请调整后重试')
                }
                onAssigneeProgress={() => undefined}
                onAssigneeToggle={() => undefined}
                testIdPrefix="task-panel-custom"
              />
            </div>
          ))}
        </section>
      )}

      {dialog !== null && (
        <TaskCompletionDialog
          kind={dialog.kind}
          unfinished={dialog.kind === 'complete' ? dialog.unfinished : undefined}
          targetStatus={dialog.kind === 'reopen' ? dialog.targetStatus : undefined}
          onConfirm={(_kind, mode) => {
            setDialog(null);
            writeTask('complete', () => completeNodeTask(doc, snap.id, mode, ORIGIN_USER, canvasId), {}, '任务完成保存失败，请重试');
          }}
          onConfirmProgress={(_kind, p) => {
            setDialog(null);
            commitTask({ status: dialog.kind === 'reopen' ? dialog.targetStatus : 'doing', progress: p });
          }}
          onCancel={() => {
            setDialog(null);
            setProgressReset((v) => v + 1);
          }}
        />
      )}

      {/* 面板进度选盘（2026-11-21 需求方裁定）：负责人/人员列成员头像点开的 9 档
          浮层——结构与画布人员选盘同款（marker-picker assignee-picker 复用样式，
          fixed 定位锚点头像、视口内钳制）。 */}
      {panelPicker !== null && (
        <div
          className="marker-picker assignee-picker panel-progress-picker"
          data-testid="panel-progress-picker"
          style={{
            left: Math.min(panelPicker.x + 6, window.innerWidth - 262),
            top: Math.min(panelPicker.y + 6, window.innerHeight - 200),
          }}
          role="menu"
          aria-label="进度选择"
        >
          <div className="marker-picker-head">
            <span className="assignee-picker-who" data-testid="panel-progress-picker-who">
              <em className="marker-picker-label">{panelPicker.colName}</em>
              <img className="assignee-picker-avatar" src={panelPicker.avatar} alt="" width={22} height={22} />
              <span className="assignee-picker-name">{panelPicker.name}</span>
            </span>
            <button
              type="button"
              data-testid="panel-progress-picker-close"
              className="marker-picker-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => setPanelPicker(null)}
            >
              ×
            </button>
          </div>
          <div className="marker-grid">
            {(MARKER_CATALOG.progress as readonly MarkerGlyphDef[]).map((def) => {
              // 高亮：当前进度落档（progressStageOf 1/8 步进）——与画布选盘同口径。
              const active = def.value === progressStageOf(panelPicker.progress);
              return (
                <button
                  key={def.value}
                  type="button"
                  data-testid={`panel-progress-picker-value-${def.value}`}
                  title={def.label}
                  aria-label={def.label}
                  aria-pressed={active}
                  className={active ? 'marker-btn active' : 'marker-btn'}
                  onClick={() => applyPanelPickerValue(PROGRESS_STAGE_PCT[def.value as keyof typeof PROGRESS_STAGE_PCT])}
                >
                  <MarkerChip def={def} />
                </button>
              );
            })}
          </div>
        </div>
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
