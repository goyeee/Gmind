import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TodoReport, TodoOwnerRow } from '@gmind/shared';
import { fetchTodoReport, remindTodo } from '../api/todos';
import { avatarSrcOf } from '../editor/TaskFields';
import { api } from '../api/client';
import { WorkspaceShell } from './WorkspaceShell';
import { TodoScopeDialog } from './TodoScopeDialog';

/**
 * 待办空间（/todo-space，第二期批次 C；2026-10-24 按 Figma 原型 Space.tsx 重做布局）：
 * - 页头：标题+副标（含日期范围）+ 今日/本周/本月/全部 + 生成完成报告（主钮）；
 * - 五统计卡（总数/已完成/进行中/逾期/完成率）；按人员/分组/部门 tabs + 聚合表
 *   （主体带头像/部门小字，完成率进度条）；右侧近 7 天完成/到期双柱趋势（纯 CSS）；
 * - 下方任务明细表（任务+描述/所属文件/负责人·部门/截止/进度/状态/跳转），行内提醒。
 */

type Dim = 'owner' | 'group' | 'department';
type Range = 'today' | 'week' | 'month' | 'all';

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

const RANGES: Array<{ key: Range; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'all', label: '全部' },
];

const RANGE_TEXT: Record<Range, string> = { today: '今日', week: '本周', month: '本月', all: '全部时间' };

interface MemberRow {
  id: string;
  nickname: string | null;
  departmentId: string | null;
  groupIds: string[];
}

export function TodoSpacePage() {
  const [report, setReport] = useState<TodoReport | null>(null);
  const [range, setRange] = useState<Range>('week');
  const [dim, setDim] = useState<Dim>('owner');
  // 聚合行下钻（2026-10-25 原型）：选中的维度行 key（再点取消）；联动明细表过滤。
  // 趋势图为服务端全量聚合（report.byDay 无按对象拆分），选中时不重算、副行如实
  // 标注「全量」——不虚做按对象过滤的数据。
  const [selectedKey, setSelectedKey] = useState<string>('');
  // 明细状态 chips（2026-10-25 原型）：全部/未开始/进行中/逾期/已完成
  const [itemStatus, setItemStatus] = useState<'all' | 'todo' | 'doing' | 'overdue' | 'done'>('all');
  const [meId, setMeId] = useState<string>('');
  const [meName, setMeName] = useState<string>('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [deptNames, setDeptNames] = useState<Array<{ id: string; name: string }>>([]);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(message: string): void {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
    setToast(message);
  }

  const reload = useCallback(async () => {
    setReport(await fetchTodoReport(range));
  }, [range]);

  useEffect(() => {
    void api<{ id: string; nickname: string }>('/users/me').then((me) => {
      setMeId(me.id);
      setMeName(me.nickname);
    }).catch(() => undefined);
    void api<{
      departments: Array<{ id: string; name: string }>;
      memberships: Array<{
        userId: string;
        departmentId: string | null;
        groupIds: string[];
        nickname: string | null;
      }>;
    }>('/org/directory')
      .then((dir) => {
        setDeptNames(dir.departments);
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

  async function act(fn: () => Promise<unknown>, message?: string): Promise<void> {
    try {
      await fn();
      if (message) showToast(message);
    } catch (e) {
      showToast(msgOf(e));
    }
  }

  // 名字解析（2026-11-21 修正）：目录（org directory）只收录有部门/分组挂靠的账号，
  // 纯任务协作用户（无挂靠）查不到会掉进「成员+id尾段」兜底——服务端 byOwner.name
  // 本来就是 users 表昵称（namesFor 回填），用它建全量 id→昵称映射作第二兜底。
  // 顺序：本人 → 目录 → 服务端昵称 → 成员+id尾段。
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    // 名单与时间范围解耦（2026-11-21 修正）：「今日」等范围下范围外人员的明细行
    // 也要能解析真名，不能用按范围过滤的 byOwner 建映射
    if (report) for (const p of report.people) map.set(p.id, p.name);
    return map;
  }, [report]);
  const nicknameOf = (id: string): string =>
    id === meId
      ? meName
      : (members.find((m) => m.id === id)?.nickname ?? nameById.get(id) ?? `成员 ${id.slice(-4)}`);
  const deptOf = (id: string): string => {
    const deptId = members.find((m) => m.id === id)?.departmentId;
    return deptId ? (deptNames.find((d) => d.id === deptId)?.name ?? '未分配') : '未分配';
  };

  /** 提醒负责人：取其任一未完成任务发站内通知。 */
  function remindRow(row: TodoOwnerRow): void {
    const detail = (report?.items ?? []).find((t) => t.status !== 'done');
    if (!detail) return showToast('该成员没有未完成任务可提醒');
    void act(() => remindTodo(detail.fileId, detail.nodeId, row.key), `已向 ${row.name} 推送待办提醒`);
  }

  /** 生成完成报告：Markdown 复制剪贴板（产物形态=需求方裁定）。 */
  async function copyReport(): Promise<void> {
    if (!report) return;
    const dimRows = dim === 'owner' ? report.byOwner : dim === 'department' ? report.byDepartment : report.byGroup;
    const dimLabel = dim === 'owner' ? '人员' : dim === 'department' ? '部门' : '分组';
    const lines = [
      `【完成报告】${RANGE_TEXT[range]} · 按${dimLabel}`,
      `任务总数 ${report.stats.total}，已完成 ${report.stats.done}，完成率 ${report.stats.rate}%`,
      '',
      ...dimRows.map((r) => `· ${r.name}：总 ${r.total} / 完成 ${r.done} / 进行中 ${r.doing} / 逾期 ${r.overdue}`),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      showToast('完成报告已复制为 Markdown，去粘贴吧');
    } catch {
      showToast('复制失败，请检查浏览器剪贴板权限');
    }
  }

  const dimRows: TodoOwnerRow[] = !report
    ? []
    : dim === 'owner'
      ? report.byOwner.map((r) => ({ ...r, name: nicknameOf(r.key) }))
      : dim === 'department'
        ? report.byDepartment
        : report.byGroup;

  // 下钻判定：负责人/部门/分组三维度下，任务是否归属选中行（按 owners ∪ participants
  // 反查挂靠；第二轮统计收录参与人，下钻同口径）
  const deptOfId = (id: string): string | null => members.find((m) => m.id === id)?.departmentId ?? null;
  const groupsOfId = (id: string): string[] => members.find((m) => m.id === id)?.groupIds ?? [];
  const itemInSelection = (t: { owners: string[]; participants?: string[] }): boolean => {
    if (!selectedKey) return true;
    const people = [...t.owners, ...(t.participants ?? [])];
    if (dim === 'owner') return people.includes(selectedKey);
    if (dim === 'department') return people.some((o) => deptOfId(o) === selectedKey);
    return people.some((o) => groupsOfId(o).includes(selectedKey));
  };

  // 明细过滤：维度选中（若有效）× 状态 chips（逾期=未完成且截止早于今天，前端派生）
  const todayStr = new Date().toISOString().slice(0, 10);
  const statusOf = (t: { status: string; dueDate: string | null }): string =>
    t.status !== 'done' && t.dueDate !== null && t.dueDate < todayStr ? 'overdue' : t.status;
  const shownItems = (report?.items ?? []).filter((t) => {
    if (!itemInSelection(t)) return false;
    if (itemStatus === 'all') return true;
    return statusOf(t) === itemStatus;
  });
  const selectedName = selectedKey
    ? (dim === 'owner' ? nicknameOf(selectedKey) : dimRows.find((r) => r.key === selectedKey)?.name ?? selectedKey)
    : '';
  const maxDay = report ? Math.max(1, ...report.byDay.map((d) => d.done)) : 1;
  const maxDue = report ? Math.max(1, ...report.byDay.map((d) => d.date === new Date().toISOString().slice(0, 10) ? 0 : 0)) : 1;
  void maxDue;

  return (
    <WorkspaceShell activeNav="space">
      <main className="ws-content todo-space-page" data-testid="todo-space-page">
        <div className="ws-page-head">
          <div>
            <h2 className="ws-page-title">统计面板</h2>
            <p className="ws-page-sub">
              汇总可见文件中的任务，按人员/部门/分组查看完成情况 · {RANGE_TEXT[range]}
              <em className="space-visibility-note">仅统计你可见范围</em>
            </p>
          </div>
          <div className="admin-head-actions">
            {RANGES.map((r) => (
              <button
                key={r.key}
                className={range === r.key ? 'range-btn active' : 'range-btn'}
                data-testid={`todo-range-${r.key}`}
                onClick={() => setRange(r.key)}
              >
                {r.label}
              </button>
            ))}
            <button className="ws-create ghost" data-testid="todo-scope-toggle" onClick={() => setScopeOpen(true)}>
              ⚙ 配置
            </button>
            <button className="ws-create" data-testid="todo-report-btn" onClick={() => void copyReport()}>
              生成完成报告
            </button>
          </div>
        </div>
        {error && <p className="error" data-testid="todo-space-error">{error}</p>}

        <div className="todo-cards space-cards">
          <button className="todo-card active" data-testid="space-card-total">
            <span className="todo-card-label">任务总数</span>
            <span className="todo-card-num" data-testid="space-total">{report?.stats.total ?? 0}</span>
            <span className="todo-card-hint">涉及可见文件</span>
          </button>
          <button className="todo-card" data-testid="space-card-done">
            <span className="todo-card-label">已完成</span>
            <span className="todo-card-num ok" data-testid="space-done">{report?.stats.done ?? 0}</span>
            <span className="todo-card-hint">收工的活儿</span>
          </button>
          <button className="todo-card" data-testid="space-card-doing">
            <span className="todo-card-label">进行中</span>
            <span className="todo-card-num" data-testid="space-doing">{report?.stats.doing ?? 0}</span>
            <span className="todo-card-hint">未开始 {report?.stats.todo ?? 0}</span>
          </button>
          <button className="todo-card" data-testid="space-card-overdue">
            <span className="todo-card-label">逾期未完成</span>
            <span className="todo-card-num bad" data-testid="space-overdue">{report?.stats.overdue ?? 0}</span>
            <span className="todo-card-hint">要抓紧了</span>
          </button>
          <button className="todo-card" data-testid="space-card-rate">
            <span className="todo-card-label">完成率</span>
            <span className="todo-card-num" data-testid="space-rate">{report?.stats.rate ?? 0}%</span>
            <span className="todo-card-hint">{report?.stats.done ?? 0} / {report?.stats.total ?? 0}</span>
          </button>
        </div>

        <div className="space-grid">
          <div className="space-table-wrap">
            <div className="todo-tabs" data-testid="space-dims">
              <button className={dim === 'owner' ? 'active' : ''} data-testid="space-dim-owner" onClick={() => setDim('owner')}>
                按人员
              </button>
              <button className={dim === 'group' ? 'active' : ''} data-testid="space-dim-group" onClick={() => setDim('group')}>
                按分组
              </button>
              <button className={dim === 'department' ? 'active' : ''} data-testid="space-dim-department" onClick={() => setDim('department')}>
                按部门
              </button>
            </div>
            <div className="admin-user-table" data-testid="space-table">
              <div className="admin-table-head space-head">
                <span>{dim === 'owner' ? '人员' : dim === 'group' ? '分组' : '部门'}</span>
                <span>总任务</span>
                <span>负责</span>
                <span>参与</span>
                <span>已完成</span>
                <span>进行中</span>
                <span>未开始</span>
                <span>逾期</span>
                <span>完成率</span>
                <span />
              </div>
              {dimRows.length === 0 && <p className="admin-users-hint" data-testid="space-empty">范围内还没有任务数据</p>}
              {dimRows.map((r) => (
                <div
                  key={r.key}
                  className={'admin-table-row' + (selectedKey === r.key ? ' space-row-selected' : '')}
                  data-testid="space-row"
                  // 行点击下钻（2026-10-25 原型）：再点取消；提醒按钮 stopPropagation 不触发
                  onClick={() => setSelectedKey(selectedKey === r.key ? '' : r.key)}
                >
                  <span className="cell nickname">
                    {dim === 'owner' && (
                      <>
                        {r.avatarUrl ? (
                          <img
                            className="space-avatar space-avatar-img"
                            src={avatarSrcOf(r.avatarUrl, r.key)}
                            alt=""
                          />
                        ) : (
                          <span className="space-avatar" aria-hidden>
                            {r.name.charAt(0)}
                          </span>
                        )}
                        <span className="space-name-wrap">
                          <b>{r.name}</b>
                          <i>{deptOf(r.key)}</i>
                        </span>
                      </>
                    )}
                    {dim !== 'owner' && r.name}
                  </span>
                  <span className="cell">{r.total}</span>
                  {/* 负责/参与拆计数（第二轮裁定 4/6）：同人同任务只进一处，负责+参与=总任务 */}
                  <span className="cell" data-testid="space-responsible">{r.responsible}</span>
                  <span className="cell" data-testid="space-participating">{r.participating}</span>
                  <span className="cell">{r.done}</span>
                  <span className="cell">{r.doing}</span>
                  <span className="cell">{r.todo}</span>
                  <span className="cell">{r.overdue}</span>
                  <span className="cell rate">
                    <span className="rate-bar">
                      <i style={{ width: `${r.total === 0 ? 0 : Math.round((r.done / r.total) * 100)}%` }} />
                    </span>
                    {r.total === 0 ? '—' : `${Math.round((r.done / r.total) * 100)}%`}
                  </span>
                  <span className="cell ops">
                    {dim === 'owner' && r.key !== meId && (
                      <button
                        data-testid={`space-remind-${r.key}`}
                        onClick={(e) => {
                          e.stopPropagation(); // 行点击=下钻选中，提醒不冒泡
                          remindRow(r);
                        }}
                      >
                        提醒
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-trend" data-testid="space-trend">
            <h3>近 7 天完成趋势</h3>
            {/* 副行如实标注（2026-10-25）：服务端按日聚合无按对象拆分，下钻选中不
                重算趋势——标注「全量」不虚做 */}
            <p className="space-trend-sub">{selectedKey ? `当前下钻：${selectedName}（趋势为全量）` : '全部对象'}</p>
            <div className="space-trend-chart">
              {(report?.byDay ?? []).map((d) => (
                <div key={d.date} className="space-trend-col" title={`${d.date}：完成 ${d.done}`}>
                  <i className="space-trend-bar" style={{ height: `${Math.round((d.done / maxDay) * 72) + 4}px` }} />
                  <span className="space-trend-date">{d.date.slice(5)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="ws-section-head">
          <h2>任务明细</h2>
          <span className="ws-section-sub">
            {selectedKey ? `${selectedName} · ` : ''}
            {shownItems.length} 项
          </span>
          {selectedKey && (
            <button className="todo-file link" data-testid="space-clear-selection" onClick={() => setSelectedKey('')}>
              清除选择
            </button>
          )}
        </div>
        <div className="todo-tabs-chips" data-testid="space-status-chips">
          {(
            [
              ['all', '全部'],
              ['todo', '未开始'],
              ['doing', '进行中'],
              ['overdue', '逾期'],
              ['done', '已完成'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={itemStatus === k ? 'chip active' : 'chip'}
              data-testid={`space-status-${k}`}
              onClick={() => setItemStatus(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="admin-user-table" data-testid="space-items">
          <div className="admin-table-head space-head">
            <span>任务</span>
            <span>所属文件</span>
            <span>负责人</span>
            <span>参与人</span>
            <span>截止</span>
            <span>进度</span>
            <span>状态</span>
            <span />
          </div>
          {shownItems.map((t) => (
            <div key={`${t.fileId}:${t.nodeId}`} className="admin-table-row" data-testid="space-item">
              <span className="cell nickname">{t.text}</span>
              <span className="cell">
                <button className="todo-file link" onClick={() => (window.location.href = `/edit/${t.fileId}`)}>
                  {t.fileTitle}
                </button>
              </span>
              <span className="cell">{t.owners.map(nicknameOf).join('、') || '未分配'}</span>
              <span className="cell">{t.participants.map(nicknameOf).join('、') || '—'}</span>
              <span className="cell">{t.dueDate ?? '—'}</span>
              <span className="cell rate">
                <span className="rate-bar">
                  <i style={{ width: `${t.progress}%` }} />
                </span>
                {t.progress}%
              </span>
              <span className="cell">
                {statusOf(t) === 'overdue'
                  ? '逾期'
                  : t.status === 'done'
                    ? '已完成'
                    : t.status === 'doing'
                      ? '进行中'
                      : '未开始'}
              </span>
              <span className="cell ops">
                <button className="todo-file link" onClick={() => (window.location.href = `/edit/${t.fileId}`)}>
                  打开
                </button>
              </span>
            </div>
          ))}
          {shownItems.length === 0 && <p className="admin-users-hint">没有符合条件的任务</p>}
        </div>

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
