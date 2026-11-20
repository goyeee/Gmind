import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type * as Y from 'yjs';
import type { TodoItem, TodoOwnerRow, TodoPage, TodoReport, TodoStats } from '@gmind/shared';
import { completeNodeTask, countAliveReachable, docFromState, docToState, getNode, isLegacyTaskModelState, setNodeTask } from '@gmind/core';
import { CollabService } from '../collab/collab.service';
import { FilesService } from '../files/files.service';
import { NotifyService } from '../notify/notify.service';
import { OrgService } from '../org/org.service';
import { TaskIndexService } from './task-index.service';
import { TaskIndexEntity } from './task-index.entity';

/**
 * 跨文件待办（第二期批次 B/C，spec §三/§四）：
 * - 范围口径：FIND_IN_SET(me, owners_csv) 且文件存活且可见（owner/协作者）；
 * - PATCH 直改：优先写 collab 活跃内存文档（走既有防抖持久化+广播，零漂移）；
 *   无活跃会话时服务端加载 docState 合规写（core setNodeTask）并落库；
 * - remind：站内通知（notify 既有能力）；生成日报/报告的 MD 剪贴板产物在前端。
 * 日期口径在应用侧算（避免 DB 时区与业务「今天」错位）。
 */

const TASK_TYPES = ['todo', 'doing', 'done'] as const;

/** 我的待办/待办空间共用的行形状（raw 查询返回）。 */
interface IndexRow {
  fileId: string;
  fileTitle: string;
  nodeId: string;
  text: string;
  status: string;
  progress: number;
  startDate: string | null;
  dueDate: string | null;
  ownersCsv?: string;
  doneDate?: string | null;
}

@Injectable()
export class TodosService {
  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @InjectRepository(TaskIndexEntity) private readonly repo: Repository<TaskIndexEntity>,
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(CollabService) private readonly collab: CollabService,
    @Inject(TaskIndexService) private readonly taskIndex: TaskIndexService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OrgService) private readonly org: OrgService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  private dayBounds(): { today: string; weekEnd: string } {
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const now = new Date();
    return { today: fmt(now), weekEnd: fmt(new Date(now.getTime() + 7 * 86400_000)) };
  }

  /** 范围 SQL（权限+存活）：
   *  - ownerOnly=false（待办空间 report）：可见文件的全部任务（按人员/部门聚合）；
   *  - ownerOnly=true（我的待办 page）：负责人含 who（缺省 me），文件对 me 可见。
   *  占位符顺序见各调用处。 */
  private scopeSql(ownerOnly: boolean): string {
    const findInSet = ownerOnly ? 'FIND_IN_SET(?, t.owners_csv) AND ' : '';
    return (
      'FROM task_index t ' +
      'JOIN files f ON f.id = t.file_id AND f.deleted_at IS NULL ' +
      'WHERE ' + findInSet +
      '(f.owner_user_id = ? OR EXISTS (SELECT 1 FROM file_collaborators fc WHERE fc.file_id = t.file_id AND fc.user_id = ?))'
    );
  }

  async page(me: string, view: string, tab: string, who?: string): Promise<TodoPage> {
    const viewer = who ?? me; // 视角：任务负责人口径按 who；可见性仍按 me（文件对我可见才看得到）
    const { today, weekEnd } = this.dayBounds();
    const statsRows = (await this.dataSource.query(
      'SELECT SUM(CASE WHEN t.status = \'done\' THEN 1 ELSE 0 END) AS done, ' +
        "SUM(CASE WHEN t.status <> 'done' THEN 1 ELSE 0 END) AS openAll, " +
        "SUM(CASE WHEN t.status <> 'done' AND t.due_date = ? THEN 1 ELSE 0 END) AS today, " +
        "SUM(CASE WHEN t.status <> 'done' AND t.due_date IS NOT NULL AND t.due_date < ? THEN 1 ELSE 0 END) AS overdue, " +
        "SUM(CASE WHEN t.status <> 'done' AND t.due_date BETWEEN ? AND ? THEN 1 ELSE 0 END) AS week " +
        this.scopeSql(true),
      [today, today, today, weekEnd, viewer, me, me],
    )) as Array<{ done: string | number; openAll: string | number; today: string | number; overdue: string | number; week: string | number }>;
    const r = statsRows[0] ?? {};
    const stats: TodoStats = {
      all: Number(r.openAll ?? 0),
      today: Number(r.today ?? 0),
      overdue: Number(r.overdue ?? 0),
      week: Number(r.week ?? 0),
      done: Number(r.done ?? 0),
    };

    const conds: string[] = [tab === 'done' ? "t.status = 'done'" : "t.status <> 'done'"];
    const extra: string[] = [];
    if (view === 'today') {
      conds.push('t.due_date = ?');
      extra.push(today);
    } else if (view === 'overdue') {
      conds.push('t.due_date IS NOT NULL AND t.due_date < ?');
      extra.push(today);
    } else if (view === 'week') {
      conds.push('t.due_date BETWEEN ? AND ?');
      extra.push(today, weekEnd);
    }
    const itemRows = (await this.dataSource.query(
      'SELECT t.file_id AS fileId, f.title AS fileTitle, t.node_id AS nodeId, t.text, t.status, t.progress, t.start_date AS startDate, t.due_date AS dueDate, t.owners_csv AS ownersCsv ' +
        this.scopeSql(true) +
        ` AND ${conds.join(' AND ')}` +
        ' ORDER BY t.due_date IS NULL, t.due_date ASC, t.text ASC LIMIT 200',
      [viewer, me, me, ...extra],
    )) as IndexRow[];
    const items: TodoItem[] = itemRows.map((row) => ({
      fileId: row.fileId,
      fileTitle: row.fileTitle,
      nodeId: row.nodeId,
      text: row.text,
      status: (TASK_TYPES as readonly string[]).includes(row.status) ? (row.status as TodoItem['status']) : 'todo',
      progress: Number(row.progress) || 0,
      startDate: row.startDate,
      dueDate: row.dueDate,
      owners: (row.ownersCsv ?? '').split(',').filter(Boolean),
    }));
    return { stats, items };
  }

  /**
   * 直接更新任务进度/完成：优先写活跃内存文档（零漂移，广播在线协作者）；
   * 无活跃会话走 DB 合规写（core setNodeTask，校验先于事务）。写后立即重建索引。
   */
  async patchTask(me: string, fileId: string, nodeId: string, input: { progress?: number; done?: boolean }): Promise<void> {
    // viewer 只读（2026-10-28 P0）：任务进度/完成直改要求 editor 角色
    if (!(await this.files.canWrite(me, fileId))) throw new NotFoundException('文件不存在');
    // 完成统一走 core 原子命令，默认保留人员子进度；重开必须同时给出明确的新进度。
    const applyPatch = (doc: Y.Doc): void => {
      if (getNode(doc, nodeId)?.task.autoProgress === true) {
        throw new BadRequestException('自动汇总父任务由子任务进度决定，请进入文件更新子任务');
      }
      if (input.done === true) {
        completeNodeTask(doc, nodeId, 'preserve-subprogress');
      } else if (input.done === false) {
        if (input.progress === undefined || !Number.isInteger(input.progress) || input.progress < 0 || input.progress > 99) {
          throw new BadRequestException('重新打开任务需要同时选择 0～99% 的新进度，请设置进度后重试');
        }
        setNodeTask(doc, nodeId, { status: input.progress === 0 ? 'todo' : 'doing', progress: input.progress });
      } else {
        setNodeTask(doc, nodeId, { progress: input.progress ?? 0 });
      }
    };
    const file = await this.files.findAliveOr404(me, fileId);
    let liveDoc: Y.Doc | null = null;
    const liveApplied = this.collab.withLiveDocument(fileId, (doc) => {
      liveDoc = doc;
      applyPatch(doc);
      return true;
    });
    if (liveApplied) {
      // 活跃会话：写内存 doc（防抖持久化+在线广播自然跟进），索引立即重建免陈旧闪现
      if (liveDoc) this.taskIndex.rebuildInBackground(fileId, liveDoc);
      return;
    }
    if (!file.docState || file.docState.length === 0) throw new NotFoundException('任务不存在，请刷新后重试');
    const raw = new Uint8Array(file.docState);
    const doc = docFromState(raw);
    const snap = getNode(doc, nodeId);
    if (!snap || snap.deleted) throw new NotFoundException('任务不存在，请刷新后重试');
    applyPatch(doc);
    // 离线直改同样可能触发旧任务模型迁移；回写前使用同一版本存档入口。
    if (isLegacyTaskModelState(raw)) {
      await this.collab.insertPreTaskModel(fileId, raw, countAliveReachable(doc));
    }
    // 服务端直写：无活跃会话，不存在内存/DB 漂移；updated_at 由 ORM update 语义推进（写序自洽）
    await this.files.persistServerDocState(fileId, docToState(doc));
    await this.taskIndex.rebuildForFile(fileId, doc);
  }

  /** 提醒 TA：站内通知（notify 既有能力）。 */
  async remind(me: string, meName: string, fileId: string, nodeId: string, ownerUserId: string): Promise<void> {
    if (!(await this.files.canAccess(me, fileId))) throw new NotFoundException('文件不存在');
    if (ownerUserId === me) throw new ConflictException('不能提醒自己，请直接处理该任务');
    const rows = (await this.dataSource.query(
      'SELECT t.text, f.title FROM task_index t JOIN files f ON f.id = t.file_id WHERE t.file_id = ? AND t.node_id = ? LIMIT 1',
      [fileId, nodeId],
    )) as Array<{ text: string; title: string }>;
    if (rows.length === 0) throw new NotFoundException('任务不存在，请刷新后重试');
    await this.notify.notify(ownerUserId, 'mention', {
      commenterName: `${meName} 提醒你跟进`,
      title: `${rows[0]!.text}（${rows[0]!.title}）`,
      fileId,
      nodeId,
      // 提醒标识（2026-10-28 P1）：payload.kind 区分「评论提及」与「催办提醒」——
      // 通知面板按此筛选（type 枚举列不动，零迁移）
      kind: 'remind',
    });
  }

  /** 待办空间聚合（批次 C）：range 收缩 updated_at + 按人员/部门/分组 + 近 7 天完成趋势。
   *  2026-10-28 P1 口径统一：range='today' 从「今日有更新」改为「今日到期（含已逾期）」
   *  ——与我的待办页签/shared isDueTodayOrOverdue 同语义（due_date<=今天），三处
   *  「今日」数字对齐。 */
  async report(me: string, range: string): Promise<TodoReport> {
    const { today } = this.dayBounds();
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const rangeStart =
      range === 'today'
        ? today
        : range === 'week'
          ? fmt(new Date(Date.now() - 6 * 86400_000))
          : range === 'month'
            ? fmt(new Date(Date.now() - 29 * 86400_000))
            : null;
    const rangeCond =
      range === 'today'
        ? ' AND t.due_date IS NOT NULL AND t.due_date <= ?'
        : rangeStart
          ? ' AND t.updated_at >= ?'
          : '';
    const rows = (await this.dataSource.query(
      'SELECT t.owners_csv AS ownersCsv, t.status, t.progress, t.due_date AS dueDate, t.done_date AS doneDate ' +
        this.scopeSql(false) +
        rangeCond,
      rangeStart ? [me, me, rangeStart] : [me, me],
    )) as Array<{ ownersCsv: string; status: string; dueDate: string | null; doneDate: string | null }>;

    const ownerAgg = new Map<string, TodoOwnerRow>();
    const deptAgg = new Map<string, TodoOwnerRow>();
    const groupAgg = new Map<string, TodoOwnerRow>();
    const byDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) byDay.set(fmt(new Date(Date.now() - i * 86400_000)), 0);
    const stats = { total: 0, done: 0, doing: 0, todo: 0, overdue: 0 };

    const bump = (agg: Map<string, TodoOwnerRow>, key: string, name: string, status: string, isOverdue: boolean): void => {
      const row = agg.get(key) ?? { key, name, total: 0, done: 0, doing: 0, todo: 0, overdue: 0 };
      row.total += 1;
      if (status === 'done') row.done += 1;
      else if (status === 'doing') row.doing += 1;
      else row.todo += 1;
      if (isOverdue) row.overdue += 1;
      agg.set(key, row);
    };

    const directory = await this.org.directory();
    const userDept = new Map<string, string>();
    const userGroups = new Map<string, string[]>();
    for (const m of directory.memberships) {
      if (m.departmentId) userDept.set(m.userId, m.departmentId);
      userGroups.set(m.userId, m.groupIds);
    }
    const deptName = new Map(directory.departments.map((d) => [d.id, d.name]));
    const groupName = new Map(directory.groups.map((g) => [g.id, g.name]));

    for (const row of rows) {
      const owners = row.ownersCsv.split(',').filter(Boolean);
      const isDone = row.status === 'done';
      const isOverdue = !isDone && row.dueDate !== null && row.dueDate < today;
      stats.total += 1;
      if (isDone) {
        stats.done += 1;
        if (row.doneDate && byDay.has(row.doneDate)) byDay.set(row.doneDate, (byDay.get(row.doneDate) ?? 0) + 1);
      } else if (row.status === 'doing') stats.doing += 1;
      else stats.todo += 1;
      if (isOverdue) stats.overdue += 1;
      for (const ownerId of owners) {
        bump(ownerAgg, ownerId, ownerId, row.status, isOverdue);
        const dept = userDept.get(ownerId) ?? 'none';
        bump(deptAgg, dept, dept === 'none' ? '未设置部门' : (deptName.get(dept) ?? '未设置部门'), row.status, isOverdue);
        const gids = userGroups.get(ownerId) ?? [];
        if (gids.length === 0) bump(groupAgg, 'none', '未设置分组', row.status, isOverdue);
        for (const gid of gids) bump(groupAgg, gid, groupName.get(gid) ?? '未设置分组', row.status, isOverdue);
      }
    }

    // 人员行回填昵称（org memberships 只有 id；昵称从 users 表补齐）
    const named = await this.namesFor([...ownerAgg.keys()]);
    const byOwner = [...ownerAgg.values()].map((row) => ({ ...row, name: named.get(row.key) ?? row.name }));

    return {
      stats: { ...stats, rate: stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100) },
      byOwner,
      byDepartment: [...deptAgg.values()],
      byGroup: [...groupAgg.values()],
      byDay: [...byDay.entries()].map(([date, dn]) => ({ date, done: dn })),
      items: (await this.page(me, 'all', 'open')).items,
    };
  }

  private async namesFor(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const rows = (await this.dataSource.query('SELECT id, nickname FROM users WHERE id IN (?)', [userIds])) as Array<{
      id: string;
      nickname: string;
    }>;
    return new Map(rows.map((u) => [u.id, u.nickname]));
  }
}
