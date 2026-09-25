import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ulid } from 'ulid';
import * as Y from 'yjs';
import { countAliveReachable, docFromState, docToState, restoreFromSnapshot } from '@gmind/core';
import { CollabService } from '../collab/collab.service';
import { EventsService } from '../events/events.service';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { FilesService } from '../files/files.service';
import { UserEntity } from '../users/user.entity';
import { VersionEntity } from './version.entity';

/** 版本列表条目（FR-VER-004）：state 不离开服务端，取态走 getState 的唯一出口。 */
export interface VersionListItem {
  id: string;
  nodeCount: number;
  type: 'auto' | 'manual' | 'pre_restore';
  createdAt: string;
  createdByName: string | null;
  restoredFrom: string | null;
}

/** 版本取态条目：state 以 base64 离开服务端（docState 同款唯一内容出口）。 */
export interface VersionStateView extends VersionListItem {
  state: string;
}

/**
 * 版本域（M4 Task 7，FR-VER-004）：列表 / 取态 / 恢复。
 *
 * 权限（binding，两级判定）：
 * - 列表/取态：canAccess 口径（owner 或协作者）——经 FilesService.findAliveOr404 单点
 *   完成「存活文件 + 权限」，缺失/已删/无权限统一 404「文件不存在」不泄露存在性；
 * - 恢复：owner 或 collaborator.role==='editor'（一期角色集，见 restoreVersion）——
 *   不满足与不存在同口径 404（先经 findAliveOr404 的存在性闸，编辑权不足者同样 404，
 *   观察面无差别）。
 *
 * 恢复流程（binding 时序）：findAliveOr404 → 编辑权闸 → 版本行（须属本文件，否则 404）
 * → snapDoc = docFromState(version.state)（损坏 400「版本数据损坏」）→ **先写 pre_restore
 * 行**（state=恢复前状态：live 路径取内存 doc 序列化，离线路径取 file.docState 原值；
 * createdBy=恢复人；restoredFrom=来源版本 id）→ 恢复执行：
 * - live 路径（有活跃内存 doc）：restoreFromSnapshot 写入 Hocuspocus Document——y-sync
 *   自动向全部在线端广播；onChange/onStoreDocument 钩子照常触发（置脏/配额告警/防抖落库）；
 * - 离线路径（withLiveDocument 为 null）：docFromState(file.docState) 上恢复，恢复产物
 *   回写 files.docState + nodeCount（可达活跃口径，与 PUT/协同持久化一致）。
 * 最后落 version_restore 埋点事件（尽力而为：恢复已提交，事件失败不回滚、不炸响应）。
 */
@Injectable()
export class VersionsService {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
  constructor(
    @InjectRepository(VersionEntity) private readonly repo: Repository<VersionEntity>,
    @InjectRepository(FileEntity) private readonly filesRepo: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collabRepo: Repository<FileCollaboratorEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CollabService) private readonly collab: CollabService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** GET /api/files/:id/versions → {items}：created_at DESC（同毫秒按 ulid 单调性兜底）。 */
  async list(userId: string, fileId: string): Promise<{ items: VersionListItem[] }> {
    const file = await this.files.findAliveOr404(userId, fileId);
    const rows = await this.repo.find({
      where: { fileId: file.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    const names = await this.nicknamesOf(rows.map((r) => r.createdBy).filter((v): v is string => v !== null));
    return { items: rows.map((r) => this.toListItem(r, names)) };
  }

  /** GET /api/files/:id/versions/:versionId → 版本条目 + state(base64)。 */
  async getState(userId: string, fileId: string, versionId: string): Promise<VersionStateView> {
    const file = await this.files.findAliveOr404(userId, fileId);
    const row = await this.findVersionOr404(file.id, versionId);
    const names = await this.nicknamesOf(row.createdBy ? [row.createdBy] : []);
    return { ...this.toListItem(row, names), state: Buffer.from(row.state).toString('base64') };
  }

  /** dev/e2e 快照触发（M4 Task 8；路由仅 NODE_ENV!=='production' 放行，见 controller）：
   *  canAccess 口径过闸（findAliveOr404）后直调 collab.snapshotIfDirty——脏的活跃内存
   *  doc 立即落 auto 行（不看 3 分钟节流）；无变更/不在内存返回 false 不落行。 */
  async snapshotDev(userId: string, fileId: string): Promise<{ created: boolean }> {
    const file = await this.files.findAliveOr404(userId, fileId);
    const created = await this.collab.snapshotIfDirty(file.id, Date.now());
    return { created };
  }

  /** POST /api/files/:id/versions/:versionId/restore → {preRestoreVersionId}。 */
  async restore(userId: string, fileId: string, versionId: string): Promise<{ preRestoreVersionId: string }> {
    const file = await this.files.findAliveOr404(userId, fileId);
    await this.assertCanRestore(userId, file);
    const version = await this.findVersionOr404(file.id, versionId);

    let snapDoc: Y.Doc;
    try {
      snapDoc = docFromState(new Uint8Array(version.state));
    } catch {
      throw new BadRequestException('版本数据损坏');
    }

    // ——先写 pre_restore 行（恢复前状态存档），再执行恢复（binding 时序）——
    // live 路径：恢复前状态取内存 doc 序列化（口径同 collab 快照：docToState + 可达活跃计数）；
    // 离线路径：file.docState 原值 + 解析计数（file.docState 只由服务端写入，损坏 400 收口）。
    const captured = this.collab.withLiveDocument(file.id, (doc) => ({
      state: Buffer.from(docToState(doc)),
      nodeCount: countAliveReachable(doc),
    }));
    let offlineParsed: { bytes: Uint8Array; doc: Y.Doc } | null = null;
    let preState: Buffer;
    let preCount: number;
    if (captured !== null) {
      preState = captured.state;
      preCount = captured.nodeCount;
    } else {
      const bytes = new Uint8Array(file.docState ?? Buffer.alloc(0));
      offlineParsed = { bytes, doc: this.parseDocStateOr400(bytes) };
      preState = Buffer.from(bytes);
      preCount = countAliveReachable(offlineParsed.doc);
    }
    const preRow = await this.insertPreRestore(file.id, preState, preCount, userId, version.id);

    // 恢复执行：优先 live（y-sync 自动广播，onChange/storeDocument 钩子照常走配额与持久化）；
    // 执行时无活跃内存 doc（无人在线，或存档与恢复之间会话卸载）→ 回落离线落库路径。
    let result = this.collab.withLiveDocument(file.id, (doc) => restoreFromSnapshot(doc, snapDoc));
    if (result === null) {
      const bytes = offlineParsed?.bytes ?? new Uint8Array(file.docState ?? Buffer.alloc(0));
      const doc = offlineParsed !== null ? offlineParsed.doc : this.parseDocStateOr400(bytes);
      result = restoreFromSnapshot(doc, snapDoc);
      await this.filesRepo.update(
        { id: file.id, deletedAt: IsNull() },
        {
          docState: Buffer.from(docToState(doc)),
          nodeCount: countAliveReachable(doc),
        },
      );
    }

    // version_restore 埋点（尽力而为：恢复已提交，事件失败不回滚、不炸响应）
    try {
      await this.events.record('version_restore', file.id, userId, {
        versionId: version.id,
        preRestoreVersionId: preRow.id,
        ...result,
      });
    } catch {
      // 遥测旁路：静默
    }
    return { preRestoreVersionId: preRow.id };
  }

  // ---- 内部 ---------------------------------------------------------------

  /** docState 字节 → Y.Doc（docFromState 入口全量 normalize）；解析失败 → 400
   *  「文档解析失败」（与 saveDocState/comments 同口径；file.docState 只由服务端写入，
   *  理论不可达，防御收口）。 */
  private parseDocStateOr400(bytes: Uint8Array): Y.Doc {
    try {
      return docFromState(bytes);
    } catch {
      throw new BadRequestException('文档解析失败');
    }
  }

  /** 恢复编辑权（binding）：owner 或 collaborator.role==='editor'；否则 404「文件不存在」
   *  ——与文件不存在同口径，viewer/commenter 与路人的观察面无差别（不泄露存在性）。 */
  private async assertCanRestore(userId: string, file: FileEntity): Promise<void> {
    if (file.ownerUserId === userId) return;
    const row = await this.collabRepo.findOne({
      where: { fileId: file.id, userId },
      select: ['role'],
    });
    if (!row || row.role !== 'editor') throw new NotFoundException('文件不存在');
  }

  /** 版本行须属本文件（binding：fileId 匹配，否则 404——跨文件版本 id 不可探）。 */
  private async findVersionOr404(fileId: string, versionId: string): Promise<VersionEntity> {
    const row = await this.repo.findOne({ where: { id: versionId, fileId } });
    if (!row) throw new NotFoundException('版本不存在');
    return row;
  }

  /** 写一行 pre_restore 存档（id 服务端 ulid() 生成，users/files/collab 快照同款来源；
   *  createdAt 显式取应用侧时钟，datetime(3)，与 collab.insertVersionSnapshot 同纪律）。 */
  private async insertPreRestore(
    fileId: string,
    state: Buffer,
    nodeCount: number,
    createdBy: string,
    restoredFrom: string,
  ): Promise<VersionEntity> {
    const row = this.repo.create();
    row.id = ulid();
    row.fileId = fileId;
    row.nodeCount = nodeCount;
    row.createdBy = createdBy;
    row.type = 'pre_restore';
    row.state = state;
    row.createdAt = new Date();
    row.restoredFrom = restoredFrom;
    return this.repo.save(row);
  }

  /** 行 → 列表条目（唯一出口：state 绝不在此离开服务端）。 */
  private toListItem(row: VersionEntity, names: Map<string, string>): VersionListItem {
    return {
      id: row.id,
      nodeCount: row.nodeCount,
      type: row.type,
      createdAt: row.createdAt.toISOString(),
      createdByName: row.createdBy === null ? null : (names.get(row.createdBy) ?? null),
      restoredFrom: row.restoredFrom,
    };
  }

  private async nicknamesOf(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await this.userRepo.find({ where: { id: In(ids) }, select: ['id', 'nickname'] });
    return new Map(users.map((u) => [u.id, u.nickname]));
  }
}
