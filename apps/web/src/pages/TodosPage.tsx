import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDueTodayOrOverdue, type TodoItem, type TodoStats } from '@gmind/shared';
import { fetchTodos, patchTodo } from '../api/todos';
import { api } from '../api/client';
import { WorkspaceShell } from './WorkspaceShell';

/**
 * 我的待办（/todos，第二期批次 B；2026-10-24 按 Figma 原型 Todo.tsx 重做布局）：
 * - 页头右侧：人员下拉（可见范围内任意负责人视角）+ 生成日报 + 提醒 TA；
 * - 四统计卡（图标色块，点卡=筛选）；tabs 待办/已完成 + 右侧部门 chips；
 * - 任务按文件分组折叠（文件头打开文件；行：勾选/标题/部门标签/进度滑条/截止）。
 * 人员视角经 GET /todos?who=（服务端按「文件对 me 可见」收敛，可看协作者的待办）。
 */

const STATUS_LABEL: Record<string, string> = { todo: '未开始', doing: '进行中', done: '已完成' };

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
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
  // 人员视角切换（who 下拉）与「提醒 TA」随原型退役（我的待办恒=我）；
  // 统计卡改纯展示（原「点卡=筛选 view」联动撤销，view state 退役）。
  const [tab, setTab] = useState<'today' | 'all' | 'done'>('today');
  const [group, setGroup] = useState<string>(''); // 分组筛选（负责人所属分组）
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
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
    void reload().catch((e) => setError(msgOf(e)));
  }, [reload]);

  // 分组 chips（2026-10-25 原型：按分组筛选并染色）：可见成员的分组去重（按目录序）
  const groupOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const m of members) for (const g of m.groupIds) ids.add(g);
    return groupDefs.filter((g) => ids.has(g.id));
  }, [members, groupDefs]);

  const memberInGroup = (id: string, groupId: string): boolean =>
    (members.find((m) => m.id === id)?.groupIds ?? []).includes(groupId);

  // 分组筛选：任务负责人任一人在该分组
  const visibleItems = (items ?? []).filter((t) => {
    // 页签三态过滤（2026-10-27 原型）：今日待办=未完成且 dueDate<=今天（含已逾期）；
    // 所有待办=服务端 open 全量；已完成=服务端 done
    if (tab === 'today') {
      if (t.status === 'done') return false;
      if (!isDueTodayOrOverdue(t.dueDate)) return false; // 统一口径（shared 单源）
    }
    if (!group) return true;
    const owners = (t as unknown as { ownerIds?: string[] }).ownerIds ?? [];
    return owners.some((o) => memberInGroup(o, group));
  });

  // 按文件分组（原型 byFile）
  const byFile = useMemo(() => {
    const map = new Map<string, { fileId: string; fileTitle: string; items: TodoItem[] }>();
    for (const t of visibleItems) {
      const entry = map.get(t.fileId) ?? { fileId: t.fileId, fileTitle: t.fileTitle, items: [] };
      entry.items.push(t);
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

  return (
    <WorkspaceShell activeNav="todo">
      <main className="ws-content todos-page" data-testid="todos-page">
        <div className="ws-page-head">
          <div>
            <h2 className="ws-page-title">我的待办</h2>
            <p className="ws-page-sub">汇总所有文件中分配给你的任务，在这里直接更新进度（今日待办含已逾期）</p>
          </div>
          <div className="admin-head-actions">
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
          </div>
          {groupOptions.length > 0 && (
            <div className="todo-tabs-chips" data-testid="todo-group-chips">
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
            </div>
          )}
        </div>

        {items !== null && byFile.length === 0 && (
          <p className="admin-users-hint" data-testid="todos-empty">
            {tab === 'done'
              ? '还没有完成的任务'
              : tab === 'today'
                ? '今天没有到期的待办，休息一下吧'
                : '没有待办，休息一下吧'}
          </p>
        )}

        <div className="todo-groups">
          {byFile.map((groupItem) => (
            <section key={groupItem.fileId} className="todo-file-group" data-testid="todo-file-group">
              <button
                className="todo-file-head"
                onClick={() => (window.location.href = `/edit/${groupItem.fileId}`)}
              >
                {groupItem.fileTitle}
                <span className="todo-file-head-sub">{groupItem.items.length} 项 · 打开文件</span>
              </button>
              {groupItem.items.map((t) => {
                const late = tab !== 'done' && t.dueDate !== null && t.dueDate < new Date().toISOString().slice(0, 10);
                const isDone = t.status === 'done';
                return (
                  <div key={t.nodeId} className="todo-row" data-testid="todo-row">
                    <input
                      type="checkbox"
                      className="todo-check"
                      data-testid="todo-check"
                      checked={isDone}
                      title={isDone ? '取消完成' : '标记完成'}
                      onChange={(e) => void act(() => patchTodo(t.fileId, t.nodeId, { done: e.target.checked }))}
                    />
                    <span className="todo-main">
                      <span className={'todo-title' + (isDone ? ' done' : '')}>{t.text}</span>
                    </span>
                    <span className={'todo-status' + (late ? ' late' : '')}>{STATUS_LABEL[t.status] ?? t.status}</span>
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
            </section>
          ))}
        </div>

        {toast && (
          <div className="workspace-toast" data-testid="toast" role="alert">
            {toast}
          </div>
        )}
      </main>
    </WorkspaceShell>
  );
}
