import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDueTodayOrOverdue, type TodoActivityItem, type TodoItem, type TodoStats } from '@gmind/shared';
import { PROGRESS_STAGE_PCT, progressStageOf } from '@gmind/core';
import { MARKER_CATALOG, type MarkerGlyphDef } from '@gmind/engine';
import { fetchTodoActivity, fetchTodos, patchTodo } from '../api/todos';
import { api } from '../api/client';
import { WorkspaceShell } from './WorkspaceShell';
import { TaskCompletionDialog } from '../editor/TaskCompletionDialog';
import { TodoScopeDialog } from './TodoScopeDialog';
import { MarkerChip } from '../editor/MarkerChip';
import '../editor/marker-picker.css';

/**
 * 我的待办（/todos，第二期批次 B；2026-10-24 按 Figma 原型 Todo.tsx 重做布局；
 * 2026-11-21 第二轮改版，spec 2026-11-21-task-round2-design §5.3）：
 * - 四页签：今日待办 / 所有待办 / 已完成 / 动态（跨文件任务动态流，行点击打开文件）；
 * - 任务按「文件 → 画布」两级分组（旧行 canvas 为空显示「未知画布」）；
 * - 行上角色徽章（总负责人/执行人，双身份只显总负责人）+「我的子进度 N%」可点击，
 *   点开 9 档选盘写自己的子进度（服务端把我的全部执行来源一起改，2026-11-21 裁定）；
 * - 「我的子进度未完成」chip（只在未完成页签出现）。
 * 滑条/勾选维持任务总进度/完成语义（裁定 5，对所有人一致）。
 */

const STATUS_LABEL: Record<string, string> = { todo: '未开始', doing: '进行中', blocked: '阻塞', done: '已完成' };

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

/** 任务动态事件 → 行动作文案（服务端只回 type 原值，中文化归 web；裁定 6）。 */
function activityText(item: TodoActivityItem): { action: string; detail: string } {
  const p = item.payload;
  const task = p?.taskText ?? '';
  switch (item.type) {
    case 'task_assign':
      return { action: '指派了负责人', detail: task };
    case 'task_assignee_add':
      return { action: '添加了执行人', detail: task };
    case 'task_assignee_remove':
      return { action: '移除了执行人', detail: task };
    case 'task_complete':
      return { action: '完成了任务', detail: task };
    case 'task_reopen':
      return { action: '重新打开了任务', detail: task };
    case 'task_status':
      return { action: '更新了状态', detail: task };
    case 'task_progress':
      if (p?.sub) return { action: `把${p.sub.user === p.actor ? '自己' : '成员'}的子进度改到 ${p.sub.after}%`, detail: task };
      return { action: `更新进度到 ${p?.after?.progress ?? '?'}%`, detail: task };
    default:
      return { action: item.type, detail: task };
  }
}

/** 相对时间（动态行；与 ActivityPanel 同规则，独立实现避免编辑器模块耦合）。 */
function relativeTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';
  const diffMs = Date.now() - at.getTime();
  if (diffMs < 60_000) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const mo = String(at.getMonth() + 1).padStart(2, '0');
  const dd = String(at.getDate()).padStart(2, '0');
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

interface MemberRow {
  id: string;
  nickname: string | null;
  departmentId: string | null;
  /** 所属分组（2026-10-25 原型：筛选 chips 改分组并按分组色染色）。 */
  groupIds: string[];
}

export function TodosPage() {
  const [me, setMe] = useState<{ id: string; nickname: string } | null>(null);
  const [stats, setStats] = useState<TodoStats | null>(null);
  const [items, setItems] = useState<TodoItem[] | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [groupDefs, setGroupDefs] = useState<Array<{ id: string; name: string; color: string | null }>>([]);
  // 2026-10-27 原型改版：页签三态——今日待办（含已逾期）/ 所有待办 / 已完成；
  // 2026-11-21 第二轮：新增「动态」页签（跨文件任务动态流）。
  // 人员视角切换（who 下拉）与「提醒 TA」随原型退役（我的待办恒=我）；
  // 统计卡改纯展示（原「点卡=筛选 view」联动撤销，view state 退役）。
  const [tab, setTab] = useState<'today' | 'all' | 'done' | 'activity'>('today');
  const [group, setGroup] = useState<string>(''); // 分组筛选（负责人或参与人所属分组）
  const [mineOnly, setMineOnly] = useState(false); // 「我的子进度未完成」chip（第二轮）
  const [activity, setActivity] = useState<TodoActivityItem[] | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [reopen, setReopen] = useState<TodoItem | null>(null);
  // 我的子进度 9 档选盘（第二轮）：锚点坐标 + 目标行
  const [subPicker, setSubPicker] = useState<{ item: TodoItem; x: number; y: number } | null>(null);
  // 参与范围配置弹窗（2026-11-21 需求方追加）：待办/统计共用同一份排除配置
  const [scopeOpen, setScopeOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(message: string): void {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
    setToast(message);
  }

  const reload = useCallback(async () => {
    if (!me?.id) return;
    // 服务端两态（open/done）不变；「今日含逾期」为前端过滤（dueDate<=今天）
    const page = await fetchTodos('all', tab === 'done' ? 'done' : 'open', me.id);
    setStats(page.stats);
    setItems(page.items);
  }, [tab, me?.id]);

  // 动态流（独立拉取，旁路视图失败呈现空态）
  useEffect(() => {
    if (tab !== 'activity') return;
    let alive = true;
    setActivity(null);
    void fetchTodoActivity(50)
      .then((r) => {
        if (alive) setActivity(r.items);
      })
      .catch(() => {
        if (alive) setActivity([]);
      });
    return () => {
      alive = false;
    };
  }, [tab]);

  // 身份 + 可见人员目录（组织 directory：分组筛选/显示名用）
  useEffect(() => {
    void api<{ id: string; nickname: string }>('/users/me').then(setMe).catch(() => undefined);
    void api<{
      departments: Array<{ id: string; name: string }>;
      groups: Array<{ id: string; name: string; color: string | null }>;
      memberships: Array<{
        userId: string;
        departmentId: string | null;
        groupIds: string[];
        nickname: string | null;
      }>;
    }>('/org/directory')
      .then((dir) => {
        setGroupDefs(dir.groups ?? []);
        setMembers(
          (dir.memberships ?? []).map((m) => ({
            id: m.userId,
            nickname: m.nickname,
            departmentId: m.departmentId,
            groupIds: m.groupIds ?? [],
          })),
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (tab === 'activity') return; // 动态流由独立 effect 拉取
    void reload().catch((e) => setError(msgOf(e)));
  }, [reload, tab]);

  const memberInGroup = (id: string, groupId: string): boolean =>
    (members.find((m) => m.id === id)?.groupIds ?? []).includes(groupId);

  // 基础列表（页签 + 我的子进度 chip 过滤之后、分组过滤之前）：分组 chips 的派生源
  const baseItems = useMemo(
    () =>
      (items ?? []).filter((t) => {
        if (tab === 'today') {
          if (t.status === 'done') return false;
          if (!isDueTodayOrOverdue(t.dueDate)) return false; // 统一口径（shared 单源）
        }
        // 「我的子进度未完成」chip（第二轮裁定 3）：我是执行人且子进度没拉满、任务未完成。
        // 只在未完成页签参与过滤——切到已完成页签时 chip 已隐藏，过滤不得残留（评审 P1-1）
        if (mineOnly && tab !== 'done' && !(t.mySubProgress !== null && t.mySubProgress < 100 && t.status !== 'done')) return false;
        return true;
      }),
    [items, tab, mineOnly],
  );

  // 分组 chips（2026-10-25 原型；2026-11-21 需求方裁定：**不能筛出内容的分组不展示**）
  // ——按基础列表派生：分组内有任一任务（负责人或参与人落在该分组）才显示；
  // 当前选中的分组恒显示（否则无法取消）。
  const groupOptions = useMemo(() => {
    const matched = new Set<string>();
    for (const t of baseItems) {
      for (const p of [...t.owners, ...t.participants]) {
        const m = members.find((mm) => mm.id === p);
        if (m) for (const g of m.groupIds) matched.add(g);
      }
    }
    if (group !== '') matched.add(group);
    return groupDefs.filter((g) => matched.has(g.id));
  }, [baseItems, members, groupDefs, group]);

  // 分组筛选：任务负责人或参与人任一人在该分组
  const visibleItems = useMemo(
    () =>
      baseItems.filter((t) => {
        if (!group) return true;
        const people = [...t.owners, ...t.participants];
        return people.some((o) => memberInGroup(o, group));
      }),
    [baseItems, group, members],
  );

  // 按「文件 → 画布」两级分组（第二轮 §5.3；旧行 canvas 为空显示「未知画布」）
  const byFile = useMemo(() => {
    const map = new Map<string, { fileId: string; fileTitle: string; canvases: Array<{ canvasId: string | null; canvasName: string; items: TodoItem[] }> }>();
    for (const t of visibleItems) {
      const entry = map.get(t.fileId) ?? { fileId: t.fileId, fileTitle: t.fileTitle, canvases: [] };
      let canvas = entry.canvases.find((cv) => cv.canvasId === t.canvasId);
      if (!canvas) {
        canvas = { canvasId: t.canvasId, canvasName: t.canvasName ?? '未知画布', items: [] };
        entry.canvases.push(canvas);
      }
      canvas.items.push(t);
      map.set(t.fileId, entry);
    }
    return [...map.values()];
  }, [visibleItems]);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
      await reload();
    } catch (e) {
      showToast(msgOf(e));
    }
  }

  /** 生成日报：待办口径 Markdown 摘要复制剪贴板（产物形态=需求方裁定）。 */
  async function copyDailyReport(): Promise<void> {
    const list = visibleItems;
    if (list.length === 0) return showToast('当前筛选下没有任务，没有可汇总的内容');
    const done = list.filter((t) => t.status === 'done');
    const open = list.filter((t) => t.status !== 'done');
    const lines = [
      `【日报】${me?.nickname ?? '我'}`,
      `已完成 ${done.length} 项`,
      ...done.map((t) => `· ${t.text}（${t.fileTitle}）`),
      `待办 ${open.length} 项`,
      ...open.map((t) => `· ${t.text}（${t.fileTitle}）进度 ${t.progress}%${t.dueDate ? ` 截止 ${t.dueDate}` : ''}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('日报已复制为 Markdown，去粘贴吧');
    } catch {
      showToast('复制失败，请检查浏览器剪贴板权限');
    }
  }

  /** 统计卡（2026-10-27 原型改纯展示）：数值取服务端 stats 五口径。 */
  const CARDS: Array<{ key: 'all' | 'today' | 'overdue' | 'week'; label: string; num: string; color: string }> = [
    { key: 'all', label: '全部待办', num: '📋', color: '#3370ff' },
    { key: 'today', label: '今日到期', num: '⏰', color: '#ff7d00' },
    { key: 'overdue', label: '已逾期', num: '⚠️', color: '#f54a45' },
    { key: 'week', label: '7 天内到期', num: '📅', color: '#00b42a' },
  ];

  // 今日待办（含已逾期）：shared isDueTodayOrOverdue 统一口径
  const todayOrLateCount = (items ?? []).filter((t) => t.status !== 'done' && isDueTodayOrOverdue(t.dueDate)).length;
  // 「我的子进度未完成」计数（chip 文案；只在未完成页签展示）
  const mineUnfinishedCount = (items ?? []).filter(
    (t) => t.status !== 'done' && t.mySubProgress !== null && t.mySubProgress < 100,
  ).length;

  return (
    <WorkspaceShell activeNav="todo">
      <main className="ws-content todos-page" data-testid="todos-page">
        <div className="ws-page-head">
          <div>
            <h2 className="ws-page-title">我的待办</h2>
            <p className="ws-page-sub">
              汇总所有文件中分配给你和你参与的任务，在这里直接更新进度（今日待办含已逾期）
            </p>
          </div>
          <div className="admin-head-actions">
            <button className="ws-create ghost" data-testid="todo-scope-toggle" onClick={() => setScopeOpen(true)}>
              ⚙ 配置
            </button>
            <button className="ws-create ghost" data-testid="todo-daily-report" onClick={() => void copyDailyReport()}>
              📋 生成日报
            </button>
          </div>
        </div>
        {error && <p className="error" data-testid="todos-error">{error}</p>}

        <div className="todo-cards">
          {CARDS.map((c) => (
            <div key={c.key} className="todo-card" data-testid={`todo-card-${c.key}`}>
              <span className="todo-card-icon" style={{ background: `${c.color}18`, color: c.color }} aria-hidden>
                {c.num}
              </span>
              <span className="todo-card-texts">
                <span className="todo-card-label">{c.label}</span>
                <span className="todo-card-num" data-testid={`todo-count-${c.key}`}>
                  {stats?.[c.key] ?? 0}
                </span>
              </span>
            </div>
          ))}
        </div>

        <div className="todo-tabs-row">
          <div className="todo-tabs" data-testid="todo-tabs">
            <button className={tab === 'today' ? 'active' : ''} data-testid="todo-tab-today" onClick={() => setTab('today')}>
              今日待办 {todayOrLateCount}
            </button>
            <button className={tab === 'all' ? 'active' : ''} data-testid="todo-tab-all" onClick={() => setTab('all')}>
              所有待办 {stats?.all ?? 0}
            </button>
            <button className={tab === 'done' ? 'active' : ''} data-testid="todo-tab-done" onClick={() => setTab('done')}>
              已完成 {stats?.done ?? 0}
            </button>
            <button className={tab === 'activity' ? 'active' : ''} data-testid="todo-tab-activity" onClick={() => setTab('activity')}>
              动态
            </button>
          </div>
          {(tab === 'today' || tab === 'all') && (
            <div className="todo-tabs-chips" data-testid="todo-group-chips">
              <button
                className={mineOnly ? 'chip active' : 'chip'}
                data-testid="todo-chip-mine-unfinished"
                onClick={() => setMineOnly((v) => !v)}
              >
                我的子进度未完成 {mineUnfinishedCount}
              </button>
              {groupOptions.length > 0 && (
                <>
                  <button className={group === '' ? 'chip active' : 'chip'} onClick={() => setGroup('')}>
                    全部分组
                  </button>
                  {groupOptions.map((g) => (
                    <button
                      key={g.id}
                      className={group === g.id ? 'chip active' : 'chip'}
                      onClick={() => setGroup(group === g.id ? '' : g.id)}
                      style={group === g.id && g.color ? { background: g.color, borderColor: g.color, color: '#fff' } : undefined}
                    >
                      {g.color && group !== g.id && <span className="chip-dot" style={{ background: g.color }} aria-hidden />}
                      {g.name}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {tab === 'activity' ? (
          <div className="todo-activity-list" data-testid="todo-activity-list">
            {activity === null && <p className="admin-users-hint">加载中…</p>}
            {activity !== null && activity.length === 0 && (
              <p className="admin-users-hint" data-testid="todo-activity-empty">
                还没有任务动态，去文件里更新任务吧
              </p>
            )}
            {activity?.map((item) => {
              const text = activityText(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="todo-activity-row"
                  data-testid="todo-activity-item"
                  onClick={() => {
                    if (item.payload?.fileId) window.location.href = `/edit/${item.payload.fileId}`;
                  }}
                >
                  <span className="todo-activity-main">
                    <b className="todo-activity-user">{item.userName ?? '系统'}</b>
                    <span className="todo-activity-action">{text.action}</span>
                    <span className="todo-activity-task">{text.detail}</span>
                    {item.fileTitle && <span className="todo-activity-file">在「{item.fileTitle}」</span>}
                  </span>
                  <time className="todo-activity-time">{relativeTime(item.createdAt)}</time>
                </button>
              );
            })}
          </div>
        ) : (
          <>
            {items !== null && byFile.length === 0 && (
              <p className="admin-users-hint" data-testid="todos-empty">
                {tab === 'done'
                  ? '还没有完成的任务'
                  : tab === 'today'
                    ? '今天没有到期的待办，休息一下吧'
                    : mineOnly
                      ? '没有未完成的子进度，休息一下吧'
                      : '没有待办，休息一下吧'}
              </p>
            )}

            <div className="todo-groups">
              {byFile.map((fileGroup) => (
                <section key={fileGroup.fileId} className="todo-file-group" data-testid="todo-file-group">
                  <button
                    className="todo-file-head"
                    onClick={() => (window.location.href = `/edit/${fileGroup.fileId}`)}
                  >
                    {fileGroup.fileTitle}
                    <span className="todo-file-head-sub">
                      {fileGroup.canvases.reduce((n, cv) => n + cv.items.length, 0)} 项 · 打开文件
                    </span>
                  </button>
                  {fileGroup.canvases.map((canvasGroup) => (
                    <div key={canvasGroup.canvasId ?? 'unknown'} className="todo-canvas-group" data-testid="todo-canvas-group">
                      <span className="todo-canvas-name" data-testid="todo-canvas-name">
                        {canvasGroup.canvasName}
                      </span>
                      {canvasGroup.items.map((t) => {
                        const late = tab !== 'done' && t.dueDate !== null && t.dueDate < new Date().toISOString().slice(0, 10);
                        const isDone = t.status === 'done';
                        // 角色徽章（裁定 4）：双身份只显「总负责人」；执行人另显我的子进度
                        const badge = t.myRole === 'participant' ? '执行人' : t.myRole === 'owner' || t.myRole === 'both' ? '总负责人' : null;
                        return (
                          <div key={t.nodeId} className="todo-row" data-testid="todo-row">
                            <input
                              type="checkbox"
                              className="todo-check"
                              data-testid="todo-check"
                              checked={isDone}
                              title={isDone ? '取消完成' : '标记完成'}
                              onChange={(e) => {
                                if (!e.target.checked) {
                                  setReopen(t);
                                  return;
                                }
                                void act(() => patchTodo(t.fileId, t.nodeId, { done: true }));
                              }}
                            />
                            <span className="todo-main">
                              <span className={'todo-title' + (isDone ? ' done' : '')}>{t.text}</span>
                              {badge && (
                                <span
                                  className={'todo-role-badge' + (badge === '执行人' ? ' part' : '')}
                                  data-testid="todo-role-badge"
                                >
                                  {badge}
                                </span>
                              )}
                            </span>
                            <span className={'todo-status' + (late ? ' late' : '')}>{STATUS_LABEL[t.status] ?? t.status}</span>
                            {t.mySubProgress !== null && !isDone && (
                              <button
                                type="button"
                                className="todo-my-progress"
                                data-testid="todo-my-progress"
                                title="点击更新我的子进度"
                                onClick={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setSubPicker({ item: t, x: rect.left + rect.width / 2, y: rect.bottom + 4 });
                                }}
                              >
                                我的子进度 {t.mySubProgress}%
                              </button>
                            )}
                            <span className="todo-progress">
                              <input
                                type="range"
                                min={0}
                                max={100}
                                step={5}
                                value={t.progress}
                                disabled={isDone}
                                aria-label="更新进度"
                                data-testid="todo-progress-range"
                                onChange={(e) => void act(() => patchTodo(t.fileId, t.nodeId, { progress: Number(e.target.value) }))}
                              />
                              <span className="todo-progress-num">{t.progress}%</span>
                            </span>
                            <span className="todo-due" data-testid="todo-due">
                              {late ? '已逾期 ' : ''}
                              {t.dueDate ?? '无截止'}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </>
        )}

        {/* 我的子进度 9 档选盘（第二轮裁定 5）：fixed 锚点浮层，视口内钳制；写入走
            PATCH mySubProgress——服务端把我在该任务的全部执行来源一起改 */}
        {subPicker !== null && (
          <div
            className="marker-picker assignee-picker todos-progress-picker"
            data-testid="todo-my-progress-picker"
            style={{
              left: Math.min(Math.max(subPicker.x - 120, 8), window.innerWidth - 262),
              top: Math.min(subPicker.y + 6, window.innerHeight - 220),
            }}
            role="menu"
            aria-label="我的子进度选择"
          >
            <div className="marker-picker-head">
              <span className="assignee-picker-who">
                <em className="marker-picker-label">我的子进度</em>
                <span className="assignee-picker-name">{subPicker.item.text}</span>
              </span>
              <button
                type="button"
                data-testid="todo-my-progress-picker-close"
                className="marker-picker-close"
                title="关闭"
                aria-label="关闭"
                onClick={() => setSubPicker(null)}
              >
                ×
              </button>
            </div>
            <div className="marker-grid">
              {(MARKER_CATALOG.progress as readonly MarkerGlyphDef[]).map((def) => {
                const active = def.value === progressStageOf(subPicker.item.mySubProgress ?? 0);
                return (
                  <button
                    key={def.value}
                    type="button"
                    data-testid={`todo-my-progress-value-${def.value}`}
                    title={def.label}
                    aria-label={def.label}
                    aria-pressed={active}
                    className={active ? 'marker-btn active' : 'marker-btn'}
                    onClick={() => {
                      const target = subPicker.item;
                      const pct = PROGRESS_STAGE_PCT[def.value as keyof typeof PROGRESS_STAGE_PCT];
                      setSubPicker(null);
                      void act(() => patchTodo(target.fileId, target.nodeId, { mySubProgress: pct }));
                    }}
                  >
                    <MarkerChip def={def} />
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {reopen !== null && (
          <TaskCompletionDialog
            kind="reopen"
            targetStatus="todo"
            onConfirm={() => undefined}
            onConfirmProgress={(_kind, progress) => {
              const target = reopen;
              setReopen(null);
              void act(() => patchTodo(target.fileId, target.nodeId, { done: false, progress }));
            }}
            onCancel={() => setReopen(null)}
          />
        )}
        <TodoScopeDialog
          open={scopeOpen}
          onClose={() => setScopeOpen(false)}
          onChanged={() => void reload().catch(() => undefined)}
        />
        {toast && (
          <div className="workspace-toast" data-testid="toast" role="alert">
            {toast}
          </div>
        )}
      </main>
    </WorkspaceShell>
  );
}
