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
  onStoreDocumentPayload,
} from '@hocuspocus/server';
import * as Y from 'yjs';
import {
  countAliveReachable,
  createTemplateDoc,
  docFromState,
  docToState,
  getLastEditor,
} from '@gmind/core';
import { env } from '../config/env';
import { MAX_DOC_NODES } from '@gmind/shared';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { SessionService } from '../session/session.service';

/** 协同 WebSocket 升级路由（挂在与 REST API 相同的 HTTP server 上）。 */
export const COLLAB_WS_PATH = '/collab';

/** fileId（ULID 26 位）形状校验：畸形 documentName 不进 DB。 */
const FILE_ID_RE = /^[0-9A-Z]{26}$/;

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
 * - onChange：countAliveReachable > MAX_DOC_NODES → 边缘触发广播 quota-exceeded（持久化时序
 *   advisory，不拒绝连接/编辑；PUT 路径 403 语义不变）。
 * - onStoreDocument：Hocuspocus 内置防抖（debounce/maxDebounce 可配）→ 回写
 *   doc_state + node_count（可达活跃口径，与 PUT 一致）→ 广播 persisted ack。
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

  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @InjectRepository(FileEntity) private readonly files: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collaborators: Repository<FileCollaboratorEntity>,
  ) {
    this.hocuspocus = new Hocuspocus({
      quiet: true,
      debounce: env.COLLAB_DEBOUNCE_MS,
      maxDebounce: env.COLLAB_MAX_DEBOUNCE_MS,
      onAuthenticate: async (data) => this.authenticate(data),
      onLoadDocument: async (data) => this.loadDocument(data),
      onChange: async (data) => this.handleChange(data),
      onStoreDocument: async (data) => this.storeDocument(data),
      beforeUnloadDocument: async (data) => {
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
   *  回落升级请求 query 的 ?token=；会话无效 / 文件缺失已删 / 无权限一律抛
   *  permission-denied（v4 统一回写该 reason），不泄露文件存在性。 */
  private async authenticate(data: onAuthenticatePayload): Promise<void> {
    const token = data.token || data.requestParameters.get('token') || '';
    const session = await this.sessions.validate(token);
    if (!session) throw new Error('permission-denied');
    const allowed = await this.canOpen(data.documentName, session.userId);
    if (!allowed) throw new Error('permission-denied');
    data.context.userId = session.userId;
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

  /** 加载：恢复 doc_state（docFromState 入口全量 normalize）或空模板（仅含 root）。 */
  private async loadDocument(data: onLoadDocumentPayload): Promise<void> {
    const file = await this.files.findOne({ where: { id: data.documentName, deletedAt: IsNull() } });
    if (!file) throw new Error('permission-denied'); // 鉴权后文件被删的竞态：拒绝加载
    const source =
      file.docState && file.docState.length > 0
        ? docFromState(new Uint8Array(file.docState))
        : createTemplateDoc({ title: file.title, children: [] });
    Y.applyUpdate(data.document, docToState(source));
  }

  /** 配额告警（advisory）：越线边缘触发一次广播；回落限内后再次越线可再告警。 */
  private async handleChange(data: onChangePayload): Promise<void> {
    const nodeCount = countAliveReachable(data.document);
    const over = nodeCount > MAX_DOC_NODES;
    if (over && !this.overQuotaDocs.has(data.documentName)) {
      this.overQuotaDocs.add(data.documentName);
      data.document.broadcastStateless(
        JSON.stringify({ type: 'quota-exceeded', nodeCount, max: MAX_DOC_NODES }),
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
      const nodeCount = countAliveReachable(data.document);
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
    // ack 只在成功写入后广播（放在 try 之外，失败路径不可达此处）
    data.document.broadcastStateless(
      JSON.stringify({
        type: 'persisted',
        at: new Date().toISOString(),
        ...(persistedUpdatedAt ? { updatedAt: persistedUpdatedAt } : {}),
      }),
    );
  }
}
