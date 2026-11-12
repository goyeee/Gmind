import { useMemo, useState } from 'react';
import type { TaskStatus } from '@gmind/shared';
import './todo-bench.css';

/**
 * 编辑器内「待办汇总」抽屉（二期对齐轮 2026-10-24，原型 Workbench 对齐）：
 * 本文件维度的按人/按组待办——左列成员（负责人并集 + 待办数徽标）与分组 chips
 * （自定义人员列），右列选中人待办（标题/截止/进度条）；页脚「在表格中查看」
 * （设置表格负责人筛选并切表格视图）与「通知待办」（站内提醒，宿主接线）；
 * 「日报」页签 = 按人生成 Markdown 复制剪贴板（与我的待办页同产物口径）。
 * 数据面 = 宿主自当前画布 nodeData 派生的 rows（只读快照，零文档写入）。
 */

export interface BenchRow {
  id: string;
  text: string;
  owners: string[];
  status: TaskStatus;
  dueDate: string | null;
  /** 行有效进度（叶=自身、父=Σ 子级；宿主自任务视觉透传，与画布/表格同口径）。 */
  progress: number;
  /** 人员进度列条目（分组 = 自定义人员列）。 */
  assignees: Array<{ user: string; name: string; progress: number; colId: string }>;
}

export interface TodoBenchProps {
  open: boolean;
  onClose: () => void;
  rows: BenchRow[];
  /** 负责人显示名候选（文档负责人 ∪ 在线成员；label = 昵称回退）。 */
  candidates: Array<{ id: string; label: string }>;
  meId: string;
  /** 分组（自定义人员列）：id=列 id、name=列名；计数宿主预聚合。 */
  groups: Array<{ id: string; name: string; count: number }>;
  /** 「在表格中查看」：宿主设置表格负责人筛选并切到表格视图。 */
  onShowInTable: (ownerId: string) => void;
  /** 「通知待办」：宿主逐条发站内提醒（入参 = 目标人与其待办条目集）。 */
  onNotify: (ownerId: string, pending: Array<{ row: BenchRow; progress: number }>) => void;
  showToast: (message: string) => void;
}

const STATUS_LABEL: Record<TaskStatus, string> = { todo: '未开始', doing: '进行中', done: '已完成', blocked: '阻塞' };

interface PendingEntry {
  row: BenchRow;
  progress: number;
}

export function TodoBench(props: TodoBenchProps): React.ReactElement | null {
  const { open, onClose, rows, candidates, meId, groups, onShowInTable, onNotify, showToast } = props;
  const [tab, setTab] = useState<'todo' | 'daily'>('todo');
  const labelOf = (id: string): string => (id === meId ? '我' : (candidates.find((c) => c.id === id)?.label ?? `成员 ${id.slice(-4)}`));

  // 负责人并集（owner ∪ 人员列条目）+ 各自待办（status ≠ done 的条目，进度取
  // 条目级：owner 逐人无独立进度——以任务有效进度呈现（与我的待办页口径一致）。
  const people = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of rows) {
      const ids = new Set([...r.owners, ...r.assignees.map((a) => a.user)]);
      const open0 = r.status !== 'done';
      for (const id of ids) {
        if (open0) map.set(id, (map.get(id) ?? 0) + 1);
        else map.set(id, map.get(id) ?? 0);
      }
    }
    return [...map.entries()].map(([id, count]) => ({ id, count }));
  }, [rows]);

  const [who, setWho] = useState<string>('');
  const whoId = who || people[0]?.id || meId;
  const whoName = labelOf(whoId);

  const pendingOf = (id: string): PendingEntry[] => {
    const out: PendingEntry[] = [];
    for (const r of rows) {
      if (r.status === 'done') continue;
      const progress = r.owners.includes(id) ? r.progress : r.assignees.find((a) => a.user === id)?.progress;
      if (progress !== undefined) {
        out.push({ row: r, progress });
      }
    }
    return out;
  };
  const doneOf = (id: string): BenchRow[] => rows.filter((r) => r.status === 'done' && (r.owners.includes(id) || r.assignees.some((a) => a.user === id)));

  const pend = pendingOf(whoId);
  const done = doneOf(whoId);

  const groupCounts = useMemo(() => {
    const byCol = new Map<string, number>();
    for (const r of rows) {
      if (r.status === 'done') continue;
      for (const a of r.assignees) if (a.progress < 100) byCol.set(a.colId, (byCol.get(a.colId) ?? 0) + 1);
    }
    return byCol;
  }, [rows]);

  const today = new Date();
  const dateText = `${today.getMonth() + 1}月${today.getDate()}日`;
  const report = useMemo(() => {
    const doing = pend.filter((p) => p.progress > 0);
    const todo = pend.filter((p) => p.progress === 0);
    return [
      `【${dateText} 日报】${whoName}`,
      '',
      `今日完成（${done.length}）`,
      ...(done.length ? done.map((d) => `· ${d.text}`) : ['· 暂无']),
      '',
      `进行中（${doing.length}）`,
      ...doing.map((p) => `· ${p.row.text}${p.row.dueDate ? `（截止 ${p.row.dueDate}）` : ''} ${p.progress}%`),
      '',
      `待开始（${todo.length}）`,
      ...todo.map((p) => `· ${p.row.text}${p.row.dueDate ? `（截止 ${p.row.dueDate}）` : ''}`),
    ].join('\n');
  }, [dateText, whoName, done, pend]);

  if (!open) return null;

  const copyReport = (): void => {
    navigator.clipboard
      ?.writeText(report)
      .then(() => showToast('日报已复制为 Markdown，去粘贴吧'))
      .catch(() => showToast('复制失败，请检查浏览器剪贴板权限'));
  };

  return (
    <div className="tb-mask" data-testid="todo-bench-mask" onClick={onClose}>
      <div className="tb-modal" data-testid="todo-bench" role="dialog" aria-label="待办汇总" onClick={(e) => e.stopPropagation()}>
        <div className="tb-head">
          <b>待办汇总</b>
          <button type="button" data-testid="todo-bench-close" aria-label="关闭待办汇总" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tb-tabs" role="tablist">
          <button type="button" className={tab === 'todo' ? 'active' : ''} onClick={() => setTab('todo')}>
            按人 / 按组待办
          </button>
          <button type="button" className={tab === 'daily' ? 'active' : ''} onClick={() => setTab('daily')}>
            日报
          </button>
        </div>
        <div className="tb-body">
          <div className="tb-side">
            <div className="tb-side-title">成员</div>
            <ul className="tb-people">
              {people.map((p) => (
                <li key={p.id}>
                  <button type="button" className={whoId === p.id ? 'active' : ''} onClick={() => setWho(p.id)}>
                    <span className="tb-avatar" aria-hidden>
                      {labelOf(p.id).charAt(0)}
                    </span>
                    <span className="tb-name">{labelOf(p.id)}</span>
                    <span className={p.count ? 'tb-num' : 'tb-num zero'}>{p.count}</span>
                  </button>
                </li>
              ))}
              {people.length === 0 && <li className="tb-hint">本文件还没有分配过负责人</li>}
            </ul>
            {groups.length > 0 && (
              <>
                <div className="tb-side-title tb-groups-title">按分组</div>
                <div className="tb-group-chips">
                  {groups.map((g) => (
                    <button key={g.id} type="button" className="tb-group-chip" onClick={() => setTab('todo')}>
                      {g.name} · {groupCounts.get(g.id) ?? 0}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {tab === 'todo' ? (
            <div className="tb-main">
              <div className="tb-main-title">
                {whoName} 的待办 · {pend.length} 项
              </div>
              <ul className="tb-list">
                {pend.map((p) => (
                  <li key={p.row.id} className="tb-item">
                    <div className="tb-item-main">
                      <div className="tb-item-title">
                        <span className="tb-item-text">{p.row.text}</span>
                        <span className="tb-item-status">{STATUS_LABEL[p.row.status]}</span>
                      </div>
                      <div className="tb-item-sub">{p.row.dueDate ? `截止 ${p.row.dueDate}` : '未设置截止时间'}</div>
                    </div>
                    <span className="tb-item-bar">
                      <i style={{ width: `${p.progress}%` }} />
                    </span>
                    <span className="tb-item-pct">{p.progress}%</span>
                  </li>
                ))}
                {pend.length === 0 && <li className="tb-hint">{whoName} 暂无待办，全部完成</li>}
              </ul>
            </div>
          ) : (
            <pre className="tb-report" data-testid="todo-bench-report">
              {report}
            </pre>
          )}
        </div>
        <div className="tb-foot">
          {tab === 'todo' ? (
            <>
              <button
                type="button"
                className="tb-btn ghost"
                data-testid="todo-bench-table"
                onClick={() => {
                  onShowInTable(whoId);
                  onClose();
                }}
              >
                在表格中查看
              </button>
              <button
                type="button"
                className="tb-btn primary"
                data-testid="todo-bench-notify"
                onClick={() => onNotify(whoId, pend)}
              >
                通知待办
              </button>
            </>
          ) : (
            <button type="button" className="tb-btn primary" data-testid="todo-bench-copy" onClick={copyReport}>
              复制日报
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
