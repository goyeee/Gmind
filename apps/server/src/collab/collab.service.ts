import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { IncomingMessage as NodeIncomingMessage, Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Hocuspocus } from '@hocuspocus/server';
import type {
  onChangePayload,
  onAuthenticatePayload,
  onLoadDocumentPayload,
  onStatelessPayload,
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import { ulid } from 'ulid';
import {
  assigneeEntriesOf,
  canvasIdOfNode,
  countAliveReachable,
  countAliveReachableAll,
  createTemplateDoc,
  docFromState,
  docToState,
  getNode,
  isLegacyTaskModelState,
  getLastEditor,
} from '@gmind/core';
import type { TaskEventPayload } from '@gmind/shared';
import { env } from '../config/env';
import { MAX_DOC_NODES } from '@gmind/shared';
import { EventsService } from '../events/events.service';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { SessionService } from '../session/session.service';
import { VersionEntity } from '../versions/version.entity';
import { TaskIndexService } from '../todos/task-index.service';
import { taskEventDeclSchema } from './task-event.schema';

/** 协同 WebSocket 升级路由（挂在与 REST API 相同的 HTTP server 上）。 */
export const COLLAB_WS_PATH = '/collab';

/** fileId（ULID 26 位）形状校验：畸形 documentName 不进 DB。 */
const FILE_ID_RE = /^[0-9A-Z]{26}$/;

/** 版本快照类型（versions.type 枚举；manual/pre_restore 由 versions 域与恢复路径写入）。 */
export type VersionSnapshotType = 'auto' | 'manual' | 'pre_restore';

/**
 * 服务端 Hocuspocus 网关（M2 Task 1）。
 *
 * 线协议：@hocuspocus/server 4.7（标准 y-sync + auth 帧；documentName 即 fileId，
 * 来自客户端消息地址前缀）。写路径纪律不变：加载走 docFromState（内含全量
 * normalize）、序列化走 docToState，唯一新增的 yjs 直调是 Y.applyUpdate——把
 * 已 normalize 的干净状态合入 Hocuspocus 的传输文档，属装载通道而非领域写。
 *
 * 钩子语义（准入清单绑定）：
 * - onAuthenticate：?token=/auth 帧 → SessionService.validate → owner/collaborator
 *   口径（findAliveOr404 同查询，返回布尔）；失败抛错 → 服务端回 permission-denied
 *   且不建立文档连接；缺失/已删/无权限同口径 reason，不泄露存在性。
 * - onLoadDocument：doc_state 恢复；无状态 → createTemplateDoc({title, children:[]})
 *   仅含 root 的空文档（裁定）。
 * - onChange：任一画布 countAliveReachable > MAX_DOC_NODES → 边缘触发广播 quota-exceeded
 *   （持久化时序 advisory，不拒绝连接/编辑；PUT 路径 403 语义不变；多画布裁定 1
 *   逐画布口径，Task 6）。
 * - onStoreDocument：Hocuspocus 内置防抖（debounce/maxDebounce 可配）→ 回写
 *   doc_state + node_count（全文档合计=逐画布可达活跃计数之和，裁定 1 展示口径）
 *   → 广播 persisted ack。
 * - 卸载：最后一条连接断开后 Hocuspocus 内置 unloadImmediately 立即落库并卸载
 *   （默认配置即所需），卸载时清越线告警标记。
 */
@Injectable()
export class CollabService implements OnApplicationShutdown {
  private readonly hocuspocus: Hocuspocus;
  private wss?: WebSocketServer;
  private httpServer?: HttpServer;
  private upgradeHandler?: (request: NodeIncomingMessage, socket: unknown, head: Buffer) => void;
  /** 越线告警的边缘触发标记（documentName → 已告警）。 */
  private readonly overQuotaDocs = new Set<string>();
  /** 版本快照节流窗口（FR-VER-001）：同一文档两次 auto 快照的最小间隔。 */
  private static readonly SNAPSHOT_INTERVAL_MS = 3 * 60 * 1000;
  /** 每文档快照元数据（documentName → 上次 auto 快照时刻 + 脏标记）。
   *  onChange 置脏；快照落行清脏；卸载收尾整项删除——生命周期与活跃文档一致，
   *  Map 有界（≤ 在内存文档数），无泄漏。 */
  private readonly snapMeta = new Map<string, { lastAutoAt: number; dirty: boolean }>();

  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @InjectRepository(FileEntity) private readonly files: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collaborators: Repository<FileCollaboratorEntity>,
    @InjectRepository(VersionEntity) private readonly versions: Repository<VersionEntity>,
    @Inject(TaskIndexService) private readonly taskIndex: TaskIndexService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {
    this.hocuspocus = new Hocuspocus({
      quiet: true,
      debounce: env.COLLAB_DEBOUNCE_MS,
      maxDebounce: env.COLLAB_MAX_DEBOUNCE_MS,
      onAuthenticate: async (data) => this.authenticate(data),
      onLoadDocument: async (data) => this.loadDocument(data),
      onChange: async (data) => this.handleChange(data),
      onStoreDocument: async (data) => this.storeDocument(data),
      // 客户端 stateless 中转（轮 2 筛选双层化）：客户端发的 stateless 消息经此转发
      // 给文档内所有在线连接（hocuspocus 默认不自动转发）。filter-updated 类型即
      // 公共筛选变更通知——viewer 的 doc 更新被 beforeHandleMessage 拦截，但 stateless
      // 是独立通道不受影响，因此 viewer 也能收到筛选变更通知。
      // 第二轮（spec §5.5）：type='task-event' 的任务动态声明不转发——拦截后以连接
      // 身份盖章落 events 表（不信任客户端声明的操作者；任务动态无实时弹幕需求，
      // 仅在动态列表可见）。
      onStateless: async (data) => {
        if (this.handleTaskEventDeclaration(data)) return;
        this.hocuspocus.documents
          .get(data.documentName)
          ?.broadcastStateless(data.payload);
      },
      // 只读使用 Hocuspocus 内置 connection.readOnly：同步/在线状态/评论消息继续，
      // 仅 Yjs 写入被拒绝并返回失败状态；不能抛错断掉整个连接。
      beforeHandleMessage: async (data) => {
        data.connection.readOnly = data.context.readOnly === true;
      },
      beforeUnloadDocument: async (data) => {
        // 卸载兜底（FR-VER-001）：会话结束仍有未快照的变更 → 立即落行（补「编辑 1 分钟
        // 即关页」窗口；v4 在最终 store 之后、文档仍在内存时调用本钩子）。快照失败不
        // 阻断卸载——v4 对 beforeUnloadDocument 抛错的处置是放弃卸载（文档滞留内存
        // 泄漏），且丢失的快照可由下次会话的编辑重新置脏兜底。收尾清除 per-file 元数据。
        try {
          await this.snapshotIfDirty(data.documentName, Date.now());
        } catch (err) {
          console.error(`[collab] 卸载快照失败（${data.documentName}）`, err);
        }
        this.snapMeta.delete(data.documentName);
        this.overQuotaDocs.delete(data.documentName);
      },
    });
  }

  /** 把网关接到 Nest 的 HTTP server（main.ts 与 createTestApp 共用，e2e 平价）。 */
  attach(httpServer: HttpServer): void {
    if (this.wss) return;
    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', (socket, request) => {
      // Hocuspocus 仅消费 { url, headers }；Node IncomingMessage 满足（getParameters 兼容 path-only URL）
      const clientConnection = this.hocuspocus.handleConnection(
        socket,
        request as unknown as Parameters<Hocuspocus['handleConnection']>[1],
      );
      // @hocuspocus v4 的约定：事件接线由集成方完成（内置 Server 也这么做，见其 Server.ts）。
      socket.on('message', (data: unknown) => {
        // ws 消息：Buffer | Buffer[]（分片）；ClientConnection.handleMessage 吃 Uint8Array
        const bytes = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
        clientConnection.handleMessage(new Uint8Array(bytes));
      });
      socket.on('close', (code: number, reason: Buffer) => {
        clientConnection.handleClose({ code, reason: reason.toString() });
      });
      socket.on('error', () => {
        // error 后 ws 必然 close，交给 handleClose 收尾；此处仅防未处理 error 事件炸进程
      });
    });
    const upgradeHandler = (request: NodeIncomingMessage, socket: unknown, head: Buffer): void => {
      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname === COLLAB_WS_PATH) {
        wss.handleUpgrade(
          request,
          socket as Parameters<WebSocketServer['handleUpgrade']>[1],
          head,
          (ws) => wss.emit('connection', ws, request),
        );
      } else {
        // 非 /collab 的 upgrade 无人接管：立即销毁，防止 socket 悬挂
        (socket as { destroy: () => void }).destroy();
      }
    };
    httpServer.on('upgrade', upgradeHandler);
    this.httpServer = httpServer;
    this.upgradeHandler = upgradeHandler;
    this.wss = wss;
  }

  getDocumentsCount(): number {
    return this.hocuspocus.getDocumentsCount();
  }

  /** 是否持有该文件的活跃内存 doc（M3a 准入 7.1：PUT 陈旧快照写序守卫的判定面）。
   *  v4 的 documents 是公开 Map<documentName, Document>（documentName 即 fileId），
   *  最后一条连接断开后 unloadImmediately 立即落库并卸载——0 连接的残影只存在于
   *  卸载收尾的瞬态窗口，故「活跃」按该 doc 的连接数判定（getConnectionsCount），
   *  无需自行维护 Set/引用计数。 */
  hasLiveDoc(fileId: string): boolean {
    return (this.hocuspocus.documents.get(fileId)?.getConnectionsCount() ?? 0) > 0;
  }

  /** 活跃文档直读（M4 Task 7 恢复路径复用）：文档在内存时以其执行 fn 并返回结果；
   *  不在内存（无人在线，无活跃 doc）返回 null——调用方回落 DB 侧 doc_state 路径。 */
  withLiveDocument<T>(fileId: string, fn: (doc: Y.Doc) => T): T | null {
    const doc = this.hocuspocus.documents.get(fileId);
    return doc ? fn(doc) : null;
  }

  /** 断开某文档的全部协同连接（M3a Task 4：owner 删除文件后踢除在途协作者；
   *  v4 closeConnections 支持按 documentName 定向，文档未在内存时为 no-op）。
   *  重连被 onAuthenticate 的 deletedAt 检查天然阻止；软删后的在途防抖持久化
   *  受 storeDocument 存活条件保护，不回写已删行。 */
  closeDocumentConnections(fileId: string): void {
    this.hocuspocus.closeConnections(fileId);
  }

  /** Stateless 广播（M3b Task 6，FR-CMT-003）：向该文件的在线协同客户端转发一条
   *  stateless 消息（评论域创建/回复 → {type:'comment-updated'}，payload 由调用方序列化）。
   *  文档不在内存（无人在线）时为 no-op——广播的受众本就只有在线连接；各业务域共用
   *  本单一入口（quota-exceeded/persisted 为网关内部路径，不经此处）。 */
  broadcastStateless(fileId: string, payload: string): void {
    this.hocuspocus.documents.get(fileId)?.broadcastStateless(payload);
  }

  /** 任务动态声明处理（第二轮 spec §5.5）：拦截 type='task-event' 的声明，命中即
   *  盖章落库并返回 true（不再转发）。全部无效路径静默丢弃（旁路遥测，不打断编辑）：
   *  - readOnly 连接（viewer/commenter 无任务写权限）→ 丢弃；
   *  - payload 超 8KB / JSON 损坏 / 形状不符 → 丢弃；
   *  - nodeId 不在本内存文档存活（伪造/过期声明）→ 丢弃。
   *  盖章纪律：actor=connection.context.userId（payload 声明值一律覆盖）；
   *  taskText/canvasId 取内存文档现值；related=声明值收敛 ∪ actor（操作者总能看到
   *  自己操作的事件，user_id=me 条件已覆盖，此处冗余并入以防 payload 缺失）。 */
  private handleTaskEventDeclaration(data: onStatelessPayload): boolean {
    // 解析出 task-event 即视为「命中」：此后一切无效路径（超长/坏 JSON/形状不符/
    // 伪 nodeId/readOnly）一律拦截不转发（评审 P2-5：命中即拦截语义统一）
    if (data.payload.length > 8192) return data.payload.includes('task-event');
    let parsed: unknown;
    let isTaskEvent = false;
    try {
      const outer = JSON.parse(data.payload) as unknown;
      if (outer !== null && typeof outer === 'object' && !Array.isArray(outer)) {
        isTaskEvent = (outer as { type?: unknown }).type === 'task-event';
        parsed = (outer as { decl?: unknown }).decl;
      }
    } catch {
      return data.payload.includes('task-event');
    }
    if (!isTaskEvent) return false; // 其他类型：沿用既有广播
    const context = data.connection?.context as { userId?: string; readOnly?: boolean } | undefined;
    const actor = context?.userId;
    if (!actor || context?.readOnly === true) return true; // 无效身份/readOnly：拦截不落库
    const decl = taskEventDeclSchema.safeParse(parsed);
    if (!decl.success) return true;
    const d = decl.data;
    const doc = data.document;
    const canvasId = canvasIdOfNode(doc, d.nodeId);
    const snap = canvasId !== null ? getNode(doc, d.nodeId, canvasId) : null;
    if (!snap || snap.deleted) return true; // 无中生有的 nodeId：丢弃
    // 伪造完成丢弃（评审 P2-1）：声明完成而文档现值未到 100——任务级事件以文档为准
    if (d.kind === 'task_complete' && snap.task.progress < 100) return true;
    const related = [
      ...new Set([
        ...(d.related ?? []),
        ...(snap.task.ownerId !== null ? [snap.task.ownerId] : []),
        ...assigneeEntriesOf(doc, d.nodeId, canvasId ?? undefined).map((e) => e.user),
        actor,
      ]),
    ];
    // after 以盖章瞬间的文档现值覆盖（评审 P2-1：数值面不信任客户端声明；快速连改
    // 场景下「现值≈操作结果」，与重建补记的近似口径一致）。before 声明值无从校验，
    // 保留（已知限制：before 可被有写权限者伪造为任意旧值，仅影响文案展示）。
    const after = d.after ?? null;
    const payload: TaskEventPayload = {
      fileId: data.documentName,
      canvasId,
      nodeId: d.nodeId,
      taskText: snap.text.slice(0, 255),
      actor,
      related,
      before: d.before ?? null,
      after: after !== null ? { status: snap.task.status, progress: snap.task.progress } : null,
      ...(d.sub !== undefined ? { sub: d.sub } : {}),
      ...(d.owner !== undefined ? { owner: d.owner } : {}),
      ...(d.member !== undefined ? { member: d.member } : {}),
    };
    void this.events.record(d.kind, data.documentName, actor, payload).catch((err: unknown) => {
      console.error(`[collab] 任务动态落库失败（file=${data.documentName}）`, err);
    });
    return true;
  }

  /** 角色变更即时更新目标连接的写闸；移除（role=null）立即断开并通知前端刷新身份。 */
  updateMemberPermission(fileId: string, userId: string, role: 'editor' | 'commenter' | 'viewer' | null): void {
    const doc = this.hocuspocus.documents.get(fileId);
    if (!doc) return;
    for (const [connection] of doc.connections) {
      const context = connection.context as { userId?: string; readOnly?: boolean };
      if (context.userId !== userId) continue;
      if (role === null) connection.close();
      else {
        context.readOnly = role !== 'editor';
        connection.readOnly = role !== 'editor';
      }
    }
    doc.broadcastStateless(JSON.stringify({ type: 'permission-updated', fileId, userId, role }));
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.httpServer && this.upgradeHandler) {
      this.httpServer.off('upgrade', this.upgradeHandler);
    }
    this.hocuspocus.flushPendingStores();
    this.hocuspocus.closeConnections();
    const wss = this.wss;
    this.wss = undefined;
    this.httpServer = undefined;
    this.upgradeHandler = undefined;
    if (wss) {
      // 有界等待：3s 内既有连接仍未关闭则强制 terminate，防僵尸 socket 拖住进程关停
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          for (const client of wss.clients) client.terminate();
          finish();
        }, 3_000);
        wss.close(finish);
      });
    }
  }

  /** 鉴权 + 准入（唯一强制点）：token 优先取 auth 帧（@hocuspocus v4 的 token 通道），
   *  回落升级请求 query 的 ?token=。2026-10-28 P0：token 语义从长效 session 改为
   *  **一次性 ticket**（GETDEL 单次消费，60s 有效）——浏览器 WS 不允许自定义
   *  Authorization 头，URL/日志里不再出现长效凭证；Hocuspocus 客户端 token 支持
   *  ()=>Promise<string>，每次连接/重连换一张新票。无效 / 文件缺失已删 / 无权限
   *  一律抛 permission-denied（v4 统一回写该 reason），不泄露文件存在性。 */
  private async authenticate(data: onAuthenticatePayload): Promise<void> {
    const token = data.token || data.requestParameters.get('token') || '';
    const ticket = await this.sessions.consumeWsTicket(token);
    if (!ticket) throw new Error('permission-denied');
    const allowed = await this.canOpen(data.documentName, ticket.userId);
    if (!allowed) throw new Error('permission-denied');
    data.context.userId = ticket.userId;
    // 只读连接标记（2026-10-28 P0）：viewer（只读链接/只读协作者）读放行、写由
    // beforeHandleMessage 拒绝——同 canWrite 口径，此处本地查询避免引入 FilesService 环
    const file = await this.files.findOne({ where: { id: data.documentName, deletedAt: IsNull() } });
    if (file) {
      if (file.ownerUserId === ticket.userId) {
        data.context.readOnly = false;
      } else {
        const row = await this.collaborators.findOneBy({ fileId: data.documentName, userId: ticket.userId });
        data.context.readOnly = row?.role !== 'editor';
      }
    }
    // 快照基线：会话建立即计时（lastAutoAt=当前时刻，dirty=false）——首窗口内编辑
    // 只走防抖落库，不立即产生版本行
    this.ensureSnapMeta(data.documentName);
  }

  /** 每文档快照元数据 get-or-init（lastAutoAt=初始化时刻，dirty=false）。 */
  private ensureSnapMeta(name: string): { lastAutoAt: number; dirty: boolean } {
    let meta = this.snapMeta.get(name);
    if (!meta) {
      meta = { lastAutoAt: Date.now(), dirty: false };
      this.snapMeta.set(name, meta);
    }
    return meta;
  }

  /** FilesService.findAliveOr404 + assertCanRead 的布尔口径（owner 或 collaborator 行，
   *  存活文件），避免引入 FilesService 造成模块环。 */
  private async canOpen(fileId: string, userId: string): Promise<boolean> {
    if (!FILE_ID_RE.test(fileId)) return false;
    const file = await this.files.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file) return false;
    if (file.ownerUserId === userId) return true;
    const rows = await this.collaborators.countBy({ fileId, userId });
    return rows > 0;
  }

  /** 加载：恢复 doc_state（docFromState 入口全量 normalize）或空模板（仅含 root，
   *  中心节点文本固定「中心主题」——2026-10-09 裁定，仅新建空白文档；meta.title
   *  仍为文件标题，文件标题与中心节点文本自此解耦）。
   *  任务模型迁移钩子（Task 2，2026-11-20 裁定）：docState 为旧任务模型（task.owners
   *  多负责人/人员列旧形状）时，先以原字节建 'pre_task_model' 版本存档，装载产物
   *  （迁移已自动完成）随即回写 doc_state——重复装载/第二个客户端装载时 docState
   *  已是新模型，判定不命中，预迁移版本不重复建。写回走原生 SQL 不翻 updated_at
   *  （files.thumb_svg 同款纪律，saveLoop 写序守卫不受扰）。 */
  private async loadDocument(data: onLoadDocumentPayload): Promise<void> {
    const file = await this.files.findOne({ where: { id: data.documentName, deletedAt: IsNull() } });
    if (!file) throw new Error('permission-denied'); // 鉴权后文件被删的竞态：拒绝加载
    if (file.docState && file.docState.length > 0) {
      const raw = new Uint8Array(file.docState);
      if (isLegacyTaskModelState(raw)) {
        const source = docFromState(raw); // 装载通道内自动完成任务模型迁移
        await this.insertPreTaskModel(file.id, raw, countAliveReachable(source));
        // 乐观并发：仅当数据库仍是装载前读到的旧字节时才覆盖。若期间离线待办直改
        // 已保存新模型状态，跳过回写（其自身已带迁移+备份），以先落库者为准。
        const result = await this.files.query(
          'UPDATE files SET doc_state = ? WHERE id = ? AND doc_state = ?',
          [Buffer.from(docToState(source)), file.id, Buffer.from(raw)],
        );
        if (result.affectedRows > 0) {
          // 原生 SQL 不经过保存钩子；迁移后立即重建，避免旧负责人/状态留在待办索引。
          this.taskIndex.rebuildInBackground(file.id, source);
        }
        Y.applyUpdate(data.document, docToState(source));
        return;
      }
      const source = docFromState(raw); // 装载通道内自动完成任务模型迁移（幂等）
      Y.applyUpdate(data.document, docToState(source));
      // 第二轮（spec §5.1）：存量旧口径索引行（canvas_id IS NULL）后台重建一次，
      // 补齐画布/参与人/派生口径——文件打开即修复，未打开过的文件显示「未知画布」。
      void this.taskIndex.rebuildIfStaleInBackground(data.documentName, source);
      return;
    }
    const source = createTemplateDoc({ title: file.title, children: [], rootText: '中心主题' });
    Y.applyUpdate(data.document, docToState(source));
  }

  /** 任务模型迁移前原状存档：state=旧 docState 原字节（非装载产物）。
   * 按原始字节判重；不同旧状态各自保留，同状态并发经数据库命名锁串行化。 */
  async insertPreTaskModel(fileId: string, raw: Uint8Array, nodeCount: number): Promise<void> {
    const lockName = `gmind:pre-task-model:${fileId}`;
    await this.versions.manager.transaction(async (em) => {
      // GET_LOCK=1 才继续；锁与数据写入同事务连接，提交后才释放——并发连接要么
      // 读到已提交的重复备份，要么在拿到锁后重新查重，保证不重复插入。
      const rows = (await em.query('SELECT GET_LOCK(?, 5) AS acquired', [lockName])) as Array<{ acquired: number | string | Buffer }>;
      const acquired = Number(rows[0]?.acquired ?? 0);
      if (acquired !== 1) {
        throw new Error(`pre_task_model 锁获取失败（file=${fileId}），请重试`);
      }
      try {
        // 同一文件可先后导入不同的旧状态：只有原始字节完全相同的备份才判重。
        const rows = await em.find(VersionEntity, {
          where: { fileId, type: 'pre_task_model' },
          select: ['id', 'state'],
        });
        const bytes = Buffer.from(raw);
        if (rows.some((row) => Buffer.from(row.state).equals(bytes))) return;
        const row = this.versions.create();
        row.id = ulid();
        row.fileId = fileId;
        row.nodeCount = nodeCount;
        row.createdBy = null; // 迁移是系统行为，无操作者
        row.type = 'pre_task_model';
        row.state = bytes;
        row.createdAt = new Date();
        row.restoredFrom = null;
        await em.save(row);
      } finally {
        await em.query('SELECT RELEASE_LOCK(?)', [lockName]);
      }
    });
  }

  /** 配额告警（advisory）：越线边缘触发一次广播；回落限内后再次越线可再告警。
   *  同时承担快照脏标记（FR-VER-001）：onUpdate 仅在装载完成后注册，装载期
   *  applyUpdate 不触发——到达此处的都是真实编辑。 */
  private async handleChange(data: onChangePayload): Promise<void> {
    this.ensureSnapMeta(data.documentName).dirty = true;
    // 配额按画布（多画布裁定 1，Task 6）：逐张画布计数，任一画布越线即告警——旧
    // 缺省单口径只盯 activeCanvasId 指向的一张，非活动画布越线无人知晓。广播载荷
    // nodeCount=越线画布的计数（单画布文档与旧口径一致）。
    let overCount = 0;
    for (const n of countAliveReachableAll(data.document).values()) {
      if (n > MAX_DOC_NODES) overCount = Math.max(overCount, n);
    }
    const over = overCount > 0;
    if (over && !this.overQuotaDocs.has(data.documentName)) {
      this.overQuotaDocs.add(data.documentName);
      data.document.broadcastStateless(
        JSON.stringify({ type: 'quota-exceeded', nodeCount: overCount, max: MAX_DOC_NODES }),
      );
    } else if (!over) {
      this.overQuotaDocs.delete(data.documentName);
    }
  }

  /** 持久化（防抖后）：回写 doc_state + node_count（可达活跃口径，仅存活文件），
   *  并回写 last_modifier_user_id（M3a Task 4，FR-FIL-001：doc meta.lastEditorUserId
   *  由各编辑端 markLastEditor 维护；未标记时保留 DB 既有值），
   *  成功后广播 persisted ack。ack 载荷带 updatedAt（本次落库的行值，M3a 准入 7.1：
   *  客户端以此为 baseUpdatedAt 依据——写序守卫比较的是 DB 行值而非客户端时钟）。
   *  失败必须上抛（v4 契约：hook 抛错 → 文档保留在内存、下次防抖重试；静默吞掉会让
   *  unloadImmediately 在落库失败后照常卸载，最后一次断开前的编辑永久丢失）。 */
  private async storeDocument(data: onStoreDocumentPayload): Promise<void> {
    let persistedUpdatedAt: string | null = null;
    try {
      // node_count 回写全文档合计（多画布裁定 1：Σ 逐画布可达活跃计数，展示口径）；
      // 持久化不因配额拒绝（M2 裁定防丢失），逐画布超限由 onChange advisory 广播。
      let nodeCount = 0;
      for (const n of countAliveReachableAll(data.document).values()) nodeCount += n;
      const docState = Buffer.from(docToState(data.document));
      const lastEditorUserId = getLastEditor(data.document);
      // updated_at 显式取应用侧时钟（datetime(3) 毫秒精度）：MySQL 无 RETURNING，
      // 显式写入免去落库后的二次回读查询（回读会在关停等场景与连接销毁竞态），
      // 且 ack 的 updatedAt 与行值恒一致。写序守卫（准入 7.1）比较的 base 全部
      // 源自本列（GET/ack/PUT 守卫读的都是行值），时钟口径自洽。
      const updatedAt = new Date();
      await this.files.update(
        { id: data.documentName, deletedAt: IsNull() },
        {
          docState,
          nodeCount,
          updatedAt,
          ...(lastEditorUserId ? { lastModifierUserId: lastEditorUserId } : {}),
        },
      );
      persistedUpdatedAt = updatedAt.toISOString();
    } catch (err) {
      console.error(`[collab] onStoreDocument 失败（${data.documentName}）`, err);
      throw err;
    }
    // auto 快照（FR-VER-001）：落库成功后、ack 广播前按节流窗口尝试（await 只约束时序，
    // 不耦合失败）——快照写失败不上抛：persist 已成功，抛错会令 v4 重试整个 store（文档
    // 滞留内存 + doc_state 重复回写），而快照另有卸载兜底与下个 3 分钟窗口，丢一次不丢数据。
    try {
      await this.snapshotIfDue(data.documentName, Date.now());
    } catch (err) {
      console.error(`[collab] auto 快照失败（${data.documentName}）`, err);
    }
    // 任务索引重建（第二期批次 B）：落库成功后异步全量重建（fire-and-forget 同快照
    // 模式——失败不阻断 ack，下个保存窗口自愈）。
    this.taskIndex.rebuildInBackground(data.documentName, data.document);
    // ack 只在成功写入后广播（放在 try 之外，失败路径不可达此处）
    data.document.broadcastStateless(
      JSON.stringify({
        type: 'persisted',
        at: new Date().toISOString(),
        ...(persistedUpdatedAt ? { updatedAt: persistedUpdatedAt } : {}),
      }),
    );
  }

  /** auto 快照节流入口（M4 Task 6，FR-VER-001；public 供 e2e 注入时钟 / T7 复用）：
   *  脏文档且距上次 auto 快照 ≥3 分钟 → 写 auto 行。「有变更才写」由 dirty 保证。
   *  文档不在内存或无元数据（未建立会话/已卸载）一律 false。
   *  TOCTOU 修复（M4 挂账清偿）：先清脏再 await 插入——清脏后至插入完成前到达的
   *  onChange 由 handleChange 无条件重标记为脏（不被覆盖丢失）；插入失败在 catch
   *  恢复 dirty=true（下个窗口/卸载兜底可重试），lastAutoAt 不回拨（失败也按「本窗
   *  已试过」计，与 storeDocument 注释的「下个 3 分钟窗口」口径一致）。 */
  async snapshotIfDue(fileId: string, now: number): Promise<boolean> {
    const meta = this.snapMeta.get(fileId);
    const doc = this.hocuspocus.documents.get(fileId);
    if (!meta?.dirty || !doc || now - meta.lastAutoAt < CollabService.SNAPSHOT_INTERVAL_MS) return false;
    meta.lastAutoAt = now;
    meta.dirty = false;
    try {
      await this.insertVersionSnapshot(fileId, doc, 'auto', now);
    } catch (err) {
      meta.dirty = true;
      throw err;
    }
    return true;
  }

  /** 卸载兜底（FR-VER-001；public 供 e2e / T7 复用）：会话结束时有未落快照的变更 →
   *  立即落行，不看节流间隔（补「编辑 1 分钟即关页」窗口——3 分钟节流只约束 auto
   *  常规快照，不应吞掉会话末尾的最后一次变更）。脏标记时序同 snapshotIfDue（先清
   *  后插、失败恢复）；lastAutoAt 一并推进（卸载路径随收尾删除元数据，dev 快照路由
   *  复用时按「快照已发生」计窗）。 */
  async snapshotIfDirty(fileId: string, now: number): Promise<boolean> {
    const meta = this.snapMeta.get(fileId);
    const doc = this.hocuspocus.documents.get(fileId);
    if (!meta?.dirty || !doc) return false;
    meta.lastAutoAt = now;
    meta.dirty = false;
    try {
      await this.insertVersionSnapshot(fileId, doc, 'auto', now);
    } catch (err) {
      meta.dirty = true;
      throw err;
    }
    return true;
  }

  /** 写一行版本快照（auto/manual/pre_restore 通用；restoredFrom 由恢复路径传入，
   *  常规快照为 null）。id 服务端 ulid() 生成（users/files 同款来源）；nodeCount/
   *  createdBy/state 取自内存 doc 的同一口径（可达活跃计数 / meta 最后编辑人 /
   *  docToState 序列化）；createdAt 显式取调用方时钟（datetime(3)，与 ack 同款纪律）。 */
  private async insertVersionSnapshot(
    fileId: string,
    doc: Y.Doc,
    type: VersionSnapshotType,
    now: number,
    restoredFrom: string | null = null,
  ): Promise<string> {
    const row = this.versions.create();
    row.id = ulid();
    row.fileId = fileId;
    row.nodeCount = countAliveReachable(doc);
    row.createdBy = getLastEditor(doc); // null 合法（从未标记的文档），显示层兜底
    row.type = type;
    row.state = Buffer.from(docToState(doc));
    row.createdAt = new Date(now);
    row.restoredFrom = restoredFrom;
    const saved = await this.versions.save(row);
    return saved.id;
  }
}
