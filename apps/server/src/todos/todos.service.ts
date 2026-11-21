import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type * as Y from 'yjs';
import { ulid } from 'ulid';
import type {
  TaskEventPayload,
  TodoActivityItem,
  TodoItem,
  TodoMyRole,
  TodoOwnerRow,
  TodoPage,
  TodoReport,
  TodoStats,
  TodoScope,
  TodoScopeCanvas,
  TodoTaskStatus,
} from '@gmind/shared';
import {
  assigneeEntriesOf,
  canvasIdOfNode,
  completeNodeTask,
  countAliveReachable,
  docFromState,
  docToState,
  getNode,
  isLegacyTaskModelState,
  ORIGIN_USER,
  setAssigneeProgress,
  setNodeTask,
  setOwnerProgress,
  type NodeSnapshot,
} from '@gmind/core';
import { CollabService } from '../collab/collab.service';
import { FilesService } from '../files/files.service';
import { NotifyService } from '../notify/notify.service';
import { OrgService } from '../org/org.service';
import { EventsService } from '../events/events.service';
import { TaskIndexService } from './task-index.service';
import { TaskIndexEntity } from './task-index.entity';
import { TodoScopeConfigEntity } from './todo-scope-config.entity';

/**
 * 跨文件待办（第二期批次 B/C；2026-11-21 第二轮扩口径，spec §5.2）：
 * - 范围口径：负责人 **或人员列参与人** 含我，且文件存活且可见（owner/协作者）；
 *   同一任务同一人按节点唯一一行，无重复；
 * - 行内新增 canvas（文件→画布两级分组）、myRole（负责人/参与人/双身份）、
 *   mySubProgress（我的人员列条目最高值 ∪ 我是负责人时的 ownerProgress）、
 *   participants（统计/下钻）；status 透传 blocked（修「阻塞显示未开始」怪相）；
 * - PATCH 直改：优先写 collab 活跃内存文档（走既有防抖持久化+广播，零漂移）；
 *   无活跃会话时服务端加载 docState 合规写（core setNodeTask）并落库；新增
 *   mySubProgress——写我在该任务的全部执行来源（人员列条目 + ownerProgress，
 *   2026-11-21 需求方裁定「全部来源一起改」，与展示取最高值口径一致）；
 * - 动态：PATCH 直记 task_* 事件（操作者=登录身份）；`activity()` 提供跨文件
 *   动态流（task_* ∩ 可见文件 ∩ 操作者是我 OR payload 含我 id）；
 * - remind：站内通知（notify 既有能力）；生成日报/报告的 MD 剪贴板产物在前端。
 * 日期口径在应用侧算（避免 DB 时区与业务「今天」错位）。
 */

/** 合法状态档（blocked 独立透传——自动父派生不产出 blocked，手动节点保留）。 */
const TASK_STATUSES: readonly string[] = ['todo', 'doing', 'blocked', 'done'];

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
  canvasId?: string | null;
  canvasName?: string | null;
  ownerProgress?: number | null;
  imOwner?: number | string;
  myPartProgress?: number | null;
}

@Injectable()
export class TodosService {
  private readonly logger = new Logger(TodosService.name);

  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @InjectRepository(TaskIndexEntity) private readonly repo: Repository<TaskIndexEntity>,
    @InjectRepository(TodoScopeConfigEntity) private readonly scopeRepo: Repository<TodoScopeConfigEntity>,
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(CollabService) private readonly collab: CollabService,
    @Inject(TaskIndexService) private readonly taskIndex: TaskIndexService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(OrgService) private readonly org: OrgService,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private dayBounds(): { today: string; weekEnd: string } {
    const fmt = (d: Date): string => d.toISOString().slice(0, 10);
    const now = new Date();
    return { today: fmt(now), weekEnd: fmt(new Date(now.getTime() + 7 * 86400_000)) };
  }

  /** 参与人聚合（评审 P1-3）：按 file 集拉回 (file,node,user) 后应用层分组——
   *  不用 GROUP_CONCAT（默认 group_concat_max_len=1024 字节，ULID+逗号约 37 人即
   *  静默截断，「不静默错数据」纪律）。key=`${fileId}:${nodeId}`。 */
  private async participantsByTask(fileIds: string[]): Promise<Map<string, string[]>> {
    const uniq = [...new Set(fileIds.filter(Boolean))];
    if (uniq.length === 0) return new Map();
    const rows = (await this.dataSource.query(
      'SELECT file_id AS fileId, node_id AS nodeId, user_id AS userId FROM task_participant WHERE file_id IN (?)',
      [uniq],
    )) as Array<{ fileId: string; nodeId: string; userId: string }>;
    const map = new Map<string, string[]>();
    for (const r of rows) {
      const key = `${r.fileId}:${r.nodeId}`;
      const list = map.get(key) ?? [];
      if (!list.includes(r.userId)) list.push(r.userId);
      map.set(key, list);
    }
    return map;
  }

  /** 范围 SQL（权限+存活+个人排除）：
   *  - ownerOnly=false（待办空间 report）：可见文件的全部任务（按人员/部门聚合）；
   *  - ownerOnly=true（我的待办 page）：负责人 **或参与人** 含 who（缺省 me），
   *    文件对 me 可见（第二轮裁定：待办收录任意人员列参与人）；
   *  - excludeFor（2026-11-21 追加）：按请求者的 todo_scope_config 排除——文件级
   *    （canvas_id=''）排除整个文件，画布级排除对应画布；canvas_id 为 NULL 的旧
   *    口径行不受画布级排除影响（文件级仍生效）。默认全关联，无行即参与。
   *  占位符顺序：ownerOnly=true 为 [who, who, me, me(, excludeFor)]，false 为 [me, me(, excludeFor)]。 */
  private scopeSql(ownerOnly: boolean, excludeFor?: string): string {
    const mine = ownerOnly
      ? '(FIND_IN_SET(?, t.owners_csv) OR EXISTS (SELECT 1 FROM task_participant tp WHERE tp.file_id = t.file_id AND tp.node_id = t.node_id AND tp.user_id = ?)) AND '
      : '';
    const excluded =
      excludeFor !== undefined
        ? ' AND NOT EXISTS (SELECT 1 FROM todo_scope_config sc WHERE sc.user_id = ? AND sc.file_id = t.file_id AND (sc.canvas_id = \'\' OR sc.canvas_id = t.canvas_id))'
        : '';
    return (
      'FROM task_index t ' +
      'JOIN files f ON f.id = t.file_id AND f.deleted_at IS NULL ' +
      'WHERE ' + mine +
      '(f.owner_user_id = ? OR EXISTS (SELECT 1 FROM file_collaborators fc WHERE fc.file_id = t.file_id AND fc.user_id = ?))' +
      excluded
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
        this.scopeSql(true, me),
      [today, today, today, weekEnd, viewer, viewer, me, me, me],
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
    // 行内我的子进度子查询：MAX(我的人员列条目)（单值无截断面）；participants 不在
    // SQL 里 GROUP_CONCAT（默认 group_concat_max_len=1024，约 37 人即静默截断——
    // 评审 P1-3），改二次查询应用层聚合（行数 LIMIT 200，按 file IN 拉回后分组）
    const itemRows = (await this.dataSource.query(
      'SELECT t.file_id AS fileId, f.title AS fileTitle, t.node_id AS nodeId, t.text, t.status, t.progress, ' +
        't.start_date AS startDate, t.due_date AS dueDate, t.owners_csv AS ownersCsv, ' +
        't.canvas_id AS canvasId, t.canvas_name AS canvasName, t.owner_progress AS ownerProgress, ' +
        'FIND_IN_SET(?, t.owners_csv) AS imOwner, ' +
        '(SELECT MAX(tp.progress) FROM task_participant tp WHERE tp.file_id = t.file_id AND tp.node_id = t.node_id AND tp.user_id = ?) AS myPartProgress ' +
        this.scopeSql(true, me) +
        ` AND ${conds.join(' AND ')}` +
        ' ORDER BY t.due_date IS NULL, t.due_date ASC, t.text ASC LIMIT 200',
      [viewer, viewer, viewer, viewer, me, me, me, ...extra],
    )) as IndexRow[];
    const participantsByTask = await this.participantsByTask(itemRows.map((r) => r.fileId));
    const items: TodoItem[] = itemRows.map((row) => {
      const imOwner = Number(row.imOwner ?? 0) === 1;
      const myPart =
        row.myPartProgress === null || row.myPartProgress === undefined ? null : Number(row.myPartProgress);
      // 负责人来源：我同时是负责人且设过执行子进度（ownerProgress）才算候选
      const ownerSub =
        imOwner && row.ownerProgress !== null && row.ownerProgress !== undefined ? Number(row.ownerProgress) : null;
      const candidates = [myPart, ownerSub].filter((v): v is number => v !== null);
      const myRole: TodoMyRole = imOwner && myPart !== null ? 'both' : imOwner ? 'owner' : 'participant';
      return {
        fileId: row.fileId,
        fileTitle: row.fileTitle,
        canvasId: row.canvasId ?? null,
        canvasName: row.canvasName ?? null,
        nodeId: row.nodeId,
        text: row.text,
        status: TASK_STATUSES.includes(row.status) ? (row.status as TodoTaskStatus) : 'todo',
        progress: Number(row.progress) || 0,
        startDate: row.startDate,
        dueDate: row.dueDate,
        owners: (row.ownersCsv ?? '').split(',').filter(Boolean),
        participants: participantsByTask.get(`${row.fileId}:${row.nodeId}`) ?? [],
        myRole,
        mySubProgress: candidates.length === 0 ? null : Math.max(...candidates),
      };
    });
    return { stats, items };
  }

  /**
   * 直接更新任务进度/完成/我的子进度：优先写活跃内存文档（零漂移，广播在线协作者）；
   * 无活跃会话走 DB 合规写（core setNodeTask，校验先于事务）。写后立即重建索引，
   * 并直记 task_* 动态事件（操作者=登录身份，spec §5.5 服务端直写路径）。
   */
  async patchTask(
    me: string,
    fileId: string,
    nodeId: string,
    input: { progress?: number; done?: boolean; mySubProgress?: number },
  ): Promise<void> {
    // viewer 只读（2026-10-28 P0）：任务进度/完成直改要求 editor 角色
    if (!(await this.files.canWrite(me, fileId))) throw new NotFoundException('文件不存在');
    const file = await this.files.findAliveOr404(me, fileId);
    // 事件素材（写前快照在 applyPatch 内捕获；校验先于事务——抛错即无写入）
    let pre: NodeSnapshot | null = null;
    let beforeSubMax: number | null = null;
    const applyPatch = (doc: Y.Doc): void => {
      const cid = canvasIdOfNode(doc, nodeId) ?? undefined;
      const snap = getNode(doc, nodeId, cid);
      if (!snap || snap.deleted) throw new NotFoundException('任务不存在，请刷新后重试');
      if (input.mySubProgress === undefined && snap.task.autoProgress === true) {
        throw new BadRequestException('自动汇总父任务由子任务进度决定，请进入文件更新子任务');
      }
      pre = snap;
      if (input.mySubProgress !== undefined) {
        // 我的子进度：我是负责人 → ownerProgress 也算执行来源；我的人员列条目逐列写
        const isOwner = snap.task.ownerId === me;
        const myEntries = assigneeEntriesOf(doc, nodeId, cid).filter((e) => e.user === me);
        if (!isOwner && myEntries.length === 0) {
          throw new BadRequestException('你不是这个任务的负责人或执行人，无法更新子进度；请先确认任务指派后重试');
        }
        const cands = [
          ...myEntries.map((e) => e.progress),
          ...(isOwner && snap.task.ownerProgress !== null ? [snap.task.ownerProgress] : []),
        ];
        beforeSubMax = cands.length === 0 ? null : Math.max(...cands);
        // 全部来源一起改（2026-11-21 需求方裁定）：与「展示取最高值」口径一致
        if (isOwner) setOwnerProgress(doc, nodeId, input.mySubProgress, ORIGIN_USER, cid);
        for (const e of myEntries) setAssigneeProgress(doc, nodeId, e.colId, me, input.mySubProgress, ORIGIN_USER, cid);
        return;
      }
      // 完成统一走 core 原子命令，默认保留人员子进度；重开必须同时给出明确的新进度。
      // 写入一律显式带画布（canvasIdOfNode 解析）——多画布文档缺省画布≠节点所在画布。
      if (input.done === true) {
        completeNodeTask(doc, nodeId, 'preserve-subprogress', ORIGIN_USER, cid);
      } else if (input.done === false) {
        if (input.progress === undefined || !Number.isInteger(input.progress) || input.progress < 0 || input.progress > 99) {
          throw new BadRequestException('重新打开任务需要同时选择 0～99% 的新进度，请设置进度后重试');
        }
        setNodeTask(doc, nodeId, { status: input.progress === 0 ? 'todo' : 'doing', progress: input.progress }, ORIGIN_USER, cid);
      } else {
        setNodeTask(doc, nodeId, { progress: input.progress ?? 0 }, ORIGIN_USER, cid);
      }
    };
    let liveDoc: Y.Doc | null = null;
    const liveApplied = this.collab.withLiveDocument(fileId, (doc) => {
      liveDoc = doc;
      applyPatch(doc);
      return true;
    });
    if (liveApplied) {
      // 活跃会话：写内存 doc（防抖持久化+在线广播自然跟进），索引立即重建免陈旧闪现
      if (liveDoc) {
        this.taskIndex.rebuildInBackground(fileId, liveDoc);
        await this.recordPatchEvents(me, fileId, liveDoc, nodeId, input, pre, beforeSubMax);
      }
      return;
    }
    if (!file.docState || file.docState.length === 0) throw new NotFoundException('任务不存在，请刷新后重试');
    const raw = new Uint8Array(file.docState);
    const doc = docFromState(raw);
    // 节点存在性与画布解析统一在 applyPatch 内（canvasIdOfNode 跨画布解析——
    // 此处不再用缺省画布预检，多画布文档非活动画布的任务也会命中）
    applyPatch(doc);
    // 离线直改同样可能触发旧任务模型迁移；回写前使用同一版本存档入口。
    if (isLegacyTaskModelState(raw)) {
      await this.collab.insertPreTaskModel(fileId, raw, countAliveReachable(doc));
    }
    // 服务端直写：无活跃会话，不存在内存/DB 漂移；updated_at 由 ORM update 语义推进（写序自洽）
    await this.files.persistServerDocState(fileId, docToState(doc));
    // 重建走同文件串行链（评审 P2-3）：与后台重建互斥，错误照常上抛
    await this.taskIndex.enqueueRebuild(fileId, () => this.taskIndex.rebuildForFile(fileId, doc));
    await this.recordPatchEvents(me, fileId, doc, nodeId, input, pre, beforeSubMax);
  }

  /** PATCH 直记动态事件（spec §5.5 服务端直写路径）：操作者=me；taskText/canvasId/
   *  related 全部服务端现值；事件是旁路遥测，失败留痕不阻断 PATCH。 */
  private async recordPatchEvents(
    me: string,
    fileId: string,
    doc: Y.Doc,
    nodeId: string,
    input: { progress?: number; done?: boolean; mySubProgress?: number },
    pre: NodeSnapshot | null,
    beforeSubMax: number | null,
  ): Promise<void> {
    if (pre === null) return;
    const cid = canvasIdOfNode(doc, nodeId);
    const post = getNode(doc, nodeId, cid ?? undefined);
    if (!post) return;
    const related = [
      ...new Set(
        [pre.task.ownerId, ...assigneeEntriesOf(doc, nodeId, cid ?? undefined).map((e) => e.user)].filter(
          (v): v is string => typeof v === 'string' && v !== '',
        ),
      ),
    ];
    const base = {
      fileId,
      canvasId: cid,
      nodeId,
      taskText: post.text.slice(0, 255),
      actor: me,
      related,
    };
    let type: string;
    let payload: TaskEventPayload;
    if (input.mySubProgress !== undefined) {
      type = 'task_progress';
      payload = {
        ...base,
        before: null,
        after: null,
        sub: { user: me, before: beforeSubMax ?? 0, after: input.mySubProgress },
      };
    } else if (input.done === true) {
      type = 'task_complete';
      payload = {
        ...base,
        before: { status: pre.task.status, progress: pre.task.progress },
        after: { status: 'done', progress: 100 },
      };
    } else if (input.done === false) {
      type = 'task_reopen';
      payload = {
        ...base,
        before: { status: pre.task.status, progress: pre.task.progress },
        after: { status: post.task.status, progress: post.task.progress },
      };
    } else {
      // 同值守卫（评审 P3-1）：进度没变不记事件（与客户端 trackTaskWrite 同口径）
      if (pre.task.progress === post.task.progress && pre.task.status === post.task.status) return;
      type = 'task_progress';
      payload = {
        ...base,
        before: { status: pre.task.status, progress: pre.task.progress },
        after: { status: post.task.status, progress: post.task.progress },
      };
    }
    try {
      await this.events.record(type, fileId, me, payload);
    } catch (err: unknown) {
      this.logger.warn(`任务动态直记失败（file=${fileId} node=${nodeId}）: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  /** 跨文件任务动态流（第二轮，spec §5.5）：task_* 事件 ∩ 我可见文件 ∩（操作者是我
   *  OR payload 引号精确串含我的 id——related=操作瞬间负责人+全体参与人，ULID 无误
   *  命中问题）。倒序分页；损坏 payload 防御 null（不炸动态流）。 */
  async activity(me: string, limit: number): Promise<{ items: TodoActivityItem[] }> {
    const rows = (await this.dataSource.query(
      'SELECT e.id, e.type, e.payload, e.user_id AS userId, e.created_at AS createdAt, f.title AS fileTitle ' +
        'FROM events e ' +
        'JOIN files f ON f.id = e.file_id AND f.deleted_at IS NULL ' +
        "WHERE e.type LIKE 'task\\_%' " +
        'AND (f.owner_user_id = ? OR EXISTS (SELECT 1 FROM file_collaborators fc WHERE fc.file_id = e.file_id AND fc.user_id = ?)) ' +
        'AND (e.user_id = ? OR e.payload LIKE CONCAT(\'%"\', ?, \'"%\')) ' +
        // 个人排除（2026-11-21 追加）：文件级排除整文件；画布级按 payload 内 canvasId 引号精确串
        'AND NOT EXISTS (SELECT 1 FROM todo_scope_config sc WHERE sc.user_id = ? AND sc.file_id = e.file_id ' +
        'AND (sc.canvas_id = \'\' OR e.payload LIKE CONCAT(\'%"canvasId":"\', sc.canvas_id, \'%"\'))) ' +
        `ORDER BY e.created_at DESC, e.id DESC LIMIT ${limit}`,
      [me, me, me, me, me],
    )) as Array<{ id: string; type: string; payload: string | null; userId: string | null; createdAt: Date | string; fileTitle: string }>;
    const profiles = await this.profilesFor(rows.map((r) => r.userId).filter((v): v is string => v !== null && v !== ''));
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        createdAt: new Date(r.createdAt).toISOString(),
        userName: r.userId === null ? null : (profiles.get(r.userId)?.name ?? null),
        fileTitle: r.fileTitle,
        payload: parseTaskEventPayload(r.payload),
      })),
    };
  }

  /** 参与范围配置读侧（2026-11-21 追加）：我可见的存活文件全集 + 各文件有任务的
   *  画布（task_index 去重）+ 我的排除行。默认全关联——无排除行即参与。 */
  async scope(me: string): Promise<TodoScope> {
    const fileRows = (await this.dataSource.query(
      'SELECT f.id AS fileId, f.title FROM files f ' +
        'WHERE f.deleted_at IS NULL AND (f.owner_user_id = ? OR EXISTS (SELECT 1 FROM file_collaborators fc WHERE fc.file_id = f.id AND fc.user_id = ?)) ' +
        'ORDER BY f.updated_at DESC',
      [me, me],
    )) as Array<{ fileId: string; title: string }>;
    const fileIds = fileRows.map((r) => r.fileId);
    // 画布清单只列**有任务**的画布（无任务画布排除无意义；「未知画布」旧行 canvas_id
    // 为 NULL 不入清单——画布级排除对旧行无效，文件级开关可覆盖，登记于功能文档）
    const canvasRows = fileIds.length
      ? ((await this.dataSource.query(
          'SELECT file_id AS fileId, canvas_id AS canvasId, canvas_name AS canvasName FROM task_index WHERE file_id IN (?) AND canvas_id IS NOT NULL',
          [fileIds],
        )) as Array<{ fileId: string; canvasId: string; canvasName: string | null }>)
      : [];
    const exclRows = (await this.scopeRepo.find({ where: { userId: me }, select: ['fileId', 'canvasId'] })) as Array<{
      fileId: string;
      canvasId: string;
    }>;
    const fileExcluded = new Set(exclRows.filter((r) => r.canvasId === '').map((r) => r.fileId));
    const canvasExcluded = new Set(exclRows.filter((r) => r.canvasId !== '').map((r) => `${r.fileId}:${r.canvasId}`));
    const canvasByName = new Map<string, TodoScopeCanvas[]>();
    for (const r of canvasRows) {
      const list = canvasByName.get(r.fileId) ?? [];
      if (!list.some((c) => c.canvasId === r.canvasId)) {
        list.push({
          canvasId: r.canvasId,
          canvasName: r.canvasName ?? '未知画布',
          excluded: canvasExcluded.has(`${r.fileId}:${r.canvasId}`),
        });
      }
      canvasByName.set(r.fileId, list);
    }
    return {
      files: fileRows.map((r) => ({
        fileId: r.fileId,
        title: r.title,
        excluded: fileExcluded.has(r.fileId),
        canvases: canvasByName.get(r.fileId) ?? [],
      })),
    };
  }

  /** 参与范围配置写侧：excluded=true 落排除行（INSERT IGNORE 幂等）、false 删行。
   *  文件必须对我可见（否则 404 不泄露存在性）。 */
  async setScope(me: string, input: { fileId: string; canvasId: string; excluded: boolean }): Promise<void> {
    if (!(await this.files.canAccess(me, input.fileId))) throw new NotFoundException('文件不存在');
    if (input.excluded) {
      await this.dataSource.query(
        'INSERT IGNORE INTO todo_scope_config (id, user_id, file_id, canvas_id) VALUES (?, ?, ?, ?)',
        [ulid(), me, input.fileId, input.canvasId],
      );
    } else {
      await this.dataSource.query(
        'DELETE FROM todo_scope_config WHERE user_id = ? AND file_id = ? AND canvas_id = ?',
        [me, input.fileId, input.canvasId],
      );
    }
  }

  /** 待办空间聚合（批次 C；2026-11-21 第二轮拆负责/参与两计数）：range 收缩
   *  updated_at + 按人员/部门/分组 + 近 7 天完成趋势。
   *  - 按人：某人名下任务数 = 我是总负责人的 + 我是执行人的（同人同任务只进一处，
   *    responsible 优先）；部门/分组口径下任务按负责人部门、参与人部门各计一次，
   *    合计可大于任务总数（裁定 6，知情）；
   *  - 完成率、趋势仍按任务级；range='today' 口径同我的待办（due_date<=今天）。 */
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
      'SELECT t.file_id AS fileId, t.node_id AS nodeId, t.owners_csv AS ownersCsv, t.status, t.due_date AS dueDate, t.done_date AS doneDate ' +
        this.scopeSql(false, me) +
        rangeCond,
      rangeStart ? [me, me, me, rangeStart] : [me, me, me],
    )) as Array<{ fileId: string; nodeId: string; ownersCsv: string; status: string; dueDate: string | null; doneDate: string | null }>;
    // 参与人二次查询应用层聚合（评审 P1-3：GROUP_CONCAT 1024 字节截断会让统计少计人）
    const participantsByTask = await this.participantsByTask(rows.map((r) => r.fileId));

    const ownerAgg = new Map<string, TodoOwnerRow>();
    const deptAgg = new Map<string, TodoOwnerRow>();
    const groupAgg = new Map<string, TodoOwnerRow>();
    const byDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) byDay.set(fmt(new Date(Date.now() - i * 86400_000)), 0);
    const stats = { total: 0, done: 0, doing: 0, todo: 0, overdue: 0 };

    // responsible=true 计入「任总负责人」，否则计入「任执行人」（同人同任务只进一处）
    const bump = (
      agg: Map<string, TodoOwnerRow>,
      key: string,
      name: string,
      status: string,
      isOverdue: boolean,
      responsible: boolean,
    ): void => {
      const row = agg.get(key) ?? { key, name, total: 0, responsible: 0, participating: 0, done: 0, doing: 0, todo: 0, overdue: 0 };
      row.total += 1;
      if (responsible) row.responsible += 1;
      else row.participating += 1;
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
      const participants = participantsByTask.get(`${row.fileId}:${row.nodeId}`) ?? [];
      const people = new Set([...owners, ...participants]);
      const isDone = row.status === 'done';
      const isOverdue = !isDone && row.dueDate !== null && row.dueDate < today;
      stats.total += 1;
      if (isDone) {
        stats.done += 1;
        if (row.doneDate && byDay.has(row.doneDate)) byDay.set(row.doneDate, (byDay.get(row.doneDate) ?? 0) + 1);
      } else if (row.status === 'doing') stats.doing += 1;
      else stats.todo += 1;
      if (isOverdue) stats.overdue += 1;
      for (const person of people) {
        const responsible = owners.includes(person);
        bump(ownerAgg, person, person, row.status, isOverdue, responsible);
        const dept = userDept.get(person) ?? 'none';
        bump(deptAgg, dept, dept === 'none' ? '未设置部门' : (deptName.get(dept) ?? '未设置部门'), row.status, isOverdue, responsible);
        const gids = userGroups.get(person) ?? [];
        if (gids.length === 0) bump(groupAgg, 'none', '未设置分组', row.status, isOverdue, responsible);
        for (const gid of gids) bump(groupAgg, gid, groupName.get(gid) ?? '未设置分组', row.status, isOverdue, responsible);
      }
    }

    // 人员行回填昵称（org memberships 只有 id；昵称从 users 表补齐）
    // 名单（2026-11-21 修正）：聚合键 ∪ 明细池全部相关人——明细池不分时间范围，
    // 名单必须与范围解耦（此前页面从 byOwner 建映射，「今日」范围下范围外人员查不到
    // 又掉「成员+id尾段」兜底——需求方实测明细负责人列显示成员 J18V）
    const items = await this.spaceItems(me);
    const peopleIds = [
      ...new Set([
        ...ownerAgg.keys(),
        ...items.flatMap((i) => [...i.owners, ...i.participants]),
      ]),
    ];
    const profiles = await this.profilesFor(peopleIds);
    const byOwner = [...ownerAgg.values()].map((row) => ({
      ...row,
      name: profiles.get(row.key)?.name ?? row.name,
      avatarUrl: profiles.get(row.key)?.avatarUrl ?? null,
    }));

    return {
      stats: { ...stats, rate: stats.total === 0 ? 0 : Math.round((stats.done / stats.total) * 100) },
      byOwner,
      byDepartment: [...deptAgg.values()],
      byGroup: [...groupAgg.values()],
      byDay: [...byDay.entries()].map(([date, dn]) => ({ date, done: dn })),
      items,
      people: peopleIds.map((id) => ({
        id,
        name: profiles.get(id)?.name ?? id,
        avatarUrl: profiles.get(id)?.avatarUrl ?? null,
      })),
    };
  }

  /** 待办空间任务明细（2026-11-21 修正）：**与统计同池**——可见文件全部任务、
   *  全状态（状态 chips 客户端过滤，「已完成」chip 由此生效）。此前取 page(me,…)
   *  只含「我是负责人/参与人」的任务，池子比统计小：选他人行下钻明细必空、他人
   *  任务永远不在明细里（需求方实测：冯武鑫行下钻无内容）。行映射与 page 一致。 */
  private async spaceItems(me: string): Promise<TodoItem[]> {
    const itemRows = (await this.dataSource.query(
      'SELECT t.file_id AS fileId, f.title AS fileTitle, t.node_id AS nodeId, t.text, t.status, t.progress, ' +
        't.start_date AS startDate, t.due_date AS dueDate, t.owners_csv AS ownersCsv, ' +
        't.canvas_id AS canvasId, t.canvas_name AS canvasName, t.owner_progress AS ownerProgress, ' +
        'FIND_IN_SET(?, t.owners_csv) AS imOwner, ' +
        '(SELECT MAX(tp.progress) FROM task_participant tp WHERE tp.file_id = t.file_id AND tp.node_id = t.node_id AND tp.user_id = ?) AS myPartProgress ' +
        this.scopeSql(false, me) +
        ' ORDER BY t.due_date IS NULL, t.due_date ASC, t.text ASC LIMIT 200',
      [me, me, me, me, me],
    )) as IndexRow[];
    const participantsByTask = await this.participantsByTask(itemRows.map((r) => r.fileId));
    return itemRows.map((row) => {
      const imOwner = Number(row.imOwner ?? 0) === 1;
      const myPart =
        row.myPartProgress === null || row.myPartProgress === undefined ? null : Number(row.myPartProgress);
      const ownerSub =
        imOwner && row.ownerProgress !== null && row.ownerProgress !== undefined ? Number(row.ownerProgress) : null;
      const candidates = [myPart, ownerSub].filter((v): v is number => v !== null);
      const myRole: TodoMyRole = imOwner && myPart !== null ? 'both' : imOwner ? 'owner' : 'participant';
      return {
        fileId: row.fileId,
        fileTitle: row.fileTitle,
        canvasId: row.canvasId ?? null,
        canvasName: row.canvasName ?? null,
        nodeId: row.nodeId,
        text: row.text,
        status: TASK_STATUSES.includes(row.status) ? (row.status as TodoTaskStatus) : 'todo',
        progress: Number(row.progress) || 0,
        startDate: row.startDate,
        dueDate: row.dueDate,
        owners: (row.ownersCsv ?? '').split(',').filter(Boolean),
        participants: participantsByTask.get(`${row.fileId}:${row.nodeId}`) ?? [],
        myRole,
        mySubProgress: candidates.length === 0 ? null : Math.max(...candidates),
      };
    });
  }

  /** 用户 id → 昵称+头像键（2026-11-21 追加头像：统计页行渲染真实头像图片）。
   *  avatarUrl 为存储键（users/<id>/…），web 侧经 avatarSrcOf 转 /api/images 直出。 */
  private async profilesFor(userIds: string[]): Promise<Map<string, { name: string; avatarUrl: string | null }>> {
    if (userIds.length === 0) return new Map();
    const rows = (await this.dataSource.query('SELECT id, nickname, avatar_url AS avatarUrl FROM users WHERE id IN (?)', [
      userIds,
    ])) as Array<{ id: string; nickname: string; avatarUrl: string | null }>;
    return new Map(rows.map((u) => [u.id, { name: u.nickname, avatarUrl: u.avatarUrl }]));
  }
}

/** events.payload JSON 文本 → TaskEventPayload（损坏/非对象行防御 null，不炸动态流）。 */
function parseTaskEventPayload(raw: string | null): TaskEventPayload | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as TaskEventPayload;
  } catch {
    return null;
  }
}
