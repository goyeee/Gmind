import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  countAliveReachable,
  createTemplateDoc,
  docFromState,
  docToState,
  SEED_TEMPLATES,
} from '@gmind/core';
import { MAX_DOC_NODES } from '@gmind/shared';
import type { FileListItem } from '@gmind/shared';
import { CollabService } from '../collab/collab.service';
import { FileCollaboratorEntity } from './file-collaborator.entity';
import { FileEntity } from './file.entity';

export const MAX_FILES_PER_USER = 100;
/** 打开时间戳写摊销节流：1 分钟内重复打开不回写 last_opened_at。 */
const OPEN_THROTTLE_MS = 60_000;
/** 陈旧快照 PUT 的拒绝文案（M3a 准入 7.1）；web 侧 saveLoop 以同一文案呈现终态。 */
export const STALE_SNAPSHOT_MESSAGE = '文档已在别处更新，请刷新后重试';

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(FileEntity) private readonly repo: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collabRepo: Repository<FileCollaboratorEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
    @Inject(CollabService) private readonly collab: CollabService,
  ) {}

  /** 新建文件；无 doc 状态时用空白模板。配额 100 文件（FR-ACC-003）。 */
  async createForUser(
    userId: string,
    input: { title: string; state?: Uint8Array; nodeCount?: number },
  ): Promise<FileEntity> {
    const count = await this.repo.countBy({ ownerUserId: userId, deletedAt: IsNull() });
    if (count >= MAX_FILES_PER_USER) {
      throw new QuotaError('文件数量已达上限（100 个）');
    }
    const file = this.repo.create();
    file.ownerUserId = userId;
    file.title = input.title;
    if (input.state) {
      const doc = docFromState(input.state);
      file.docState = Buffer.from(input.state);
      // 口径统一（M2 终审修复轮，FR-ACC-003）：createForUser 与 saveDocState/协同
      // 持久化同为 countAliveReachable（可达活跃、不含 root）——旧 countNodes 会计入
      // 墓碑/孤儿，与保存路径 ±N 语义差（M2 准入清单 §1 遗留项收口）。
      file.nodeCount = input.nodeCount ?? countAliveReachable(doc);
      // 从恢复 doc 的 meta 回填 structure/themeId，保证 files 列与 Y.Doc 元数据一致（如种子模板 org 结构）
      const meta = doc.getMap('meta');
      const structure = meta.get('structureType');
      const themeId = meta.get('themeId');
      if (typeof structure === 'string' && structure) file.structure = structure;
      if (typeof themeId === 'string' && themeId) file.themeId = themeId;
    } else {
      const doc = createTemplateDoc({ title: input.title, children: [] });
      file.docState = Buffer.from(docToState(doc));
      file.nodeCount = countAliveReachable(doc);
    }
    return this.repo.save(file);
  }

  /** 注册赠送 3 个示例脑图（FR-ACC-001）。 */
  async createSeedFiles(userId: string): Promise<void> {
    for (const tpl of SEED_TEMPLATES) {
      const state = docToState(createTemplateDoc(tpl));
      await this.createForUser(userId, { title: tpl.title, state, nodeCount: undefined });
    }
  }

  /** FileListItem 序列化契约（唯一出口）：docState 等内部字段绝不离开服务端。 */
  toListItem(file: FileEntity): FileListItem {
    return {
      id: file.id,
      title: file.title,
      structure: file.structure as FileListItem['structure'],
      nodeCount: file.nodeCount,
      lastOpenedAt: file.lastOpenedAt?.toISOString() ?? null,
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  async listOwned(userId: string): Promise<FileListItem[]> {
    const rows = await this.repo.find({
      where: { ownerUserId: userId, deletedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
    return rows.map((f) => this.toListItem(f));
  }

  /** 存取授权布尔口径（spec §7.2）：owner 或 file_collaborators 存在行（一期协作者即可编辑），
   *  文件须存活（deletedAt null）。findAliveOr404 与存储写端点（M3a 准入 7.2）共用此单一判定源；
   *  返回布尔由调用方自决 404「文件不存在」——无权限与不存在同口径，不泄露文件存在性。 */
  async canAccess(userId: string, fileId: string): Promise<boolean> {
    const file = await this.repo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file) return false;
    if (file.ownerUserId === userId) return true;
    return (await this.collabRepo.countBy({ fileId: file.id, userId })) > 0;
  }

  /** 读取/写入权限（spec §7.2）：owner 或 file_collaborators 存在行（一期协作者即可编辑）。
   *  无权限与「不存在」同口径 404，不泄露文件存在性。 */
  private async assertCanRead(userId: string, file: FileEntity): Promise<void> {
    if (!(await this.canAccess(userId, file.id))) throw new NotFoundException('文件不存在');
  }

  /** 加载存活文件并校验权限；缺失/已删/无权限一律 404「文件不存在」。 */
  private async findAliveOr404(userId: string, id: string): Promise<FileEntity> {
    const file = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!file) throw new NotFoundException('文件不存在');
    await this.assertCanRead(userId, file);
    return file;
  }

  /** 编辑器打开文件的完整状态；docState 以 base64 离开服务端（唯一内容出口）。
   *  ownerUserId（M2 Task 6，FR-COL-005）：前端创建者标识依据。
   *  updatedAt（M3a 准入 7.1）：客户端陈旧写序守卫的初始 base（PUT 携带回服务端）。 */
  async getOwnedFileWithState(
    userId: string,
    id: string,
  ): Promise<{ id: string; title: string; structure: string; themeId: string; nodeCount: number; ownerUserId: string; updatedAt: string; docState: string }> {
    const file = await this.findAliveOr404(userId, id);
    return {
      id: file.id,
      title: file.title,
      structure: file.structure,
      themeId: file.themeId,
      nodeCount: file.nodeCount,
      ownerUserId: file.ownerUserId,
      updatedAt: file.updatedAt.toISOString(),
      docState: (file.docState ?? Buffer.alloc(0)).toString('base64'),
    };
  }

  /** 回写文档状态：先解析校验（失败 400），再校验节点配额 ≤ MAX_DOC_NODES（超限 403），
   *  然后陈旧写序守卫（准入 7.1，快照落后且存在活跃 WS 内存 doc → 409），最后落库。
   *  配额口径（FR-ACC-003＝活跃文档规模）：countAliveReachable——docFromState 入口已
   *  全量 normalize，取自 root 可达的存活节点数；墓碑随编辑永久累积、孤儿不可达，
   *  均不计入（countNodes 口径会使远低于上限的正常文档被墓碑余额永久卡死保存）。
   *  守卫口径（M2 终审复审 Important #2 的丢失场景）：baseUpdatedAt 严格早于行
   *  updated_at **且** collab 持有活跃内存 doc（有 WS 通道在写，PUT 是陈旧整快照，
   *  落库会覆盖 WS 侧新编辑）→ 拒绝；二者缺一放行——纯 PUT 用户间无 WS 竞争面
   *  （无内存 doc 时最新落库者即 PUT 自己）；base 缺省/非法（旧客户端/首次保存）
   *  视为无 base，永远放行。 */
  async saveDocState(
    userId: string,
    id: string,
    state: Uint8Array,
    baseUpdatedAt?: string,
  ): Promise<{ nodeCount: number }> {
    const file = await this.findAliveOr404(userId, id);
    let doc;
    try {
      doc = docFromState(state);
    } catch {
      throw new BadRequestException('文档解析失败');
    }
    const nodeCount = countAliveReachable(doc);
    if (nodeCount > MAX_DOC_NODES) {
      throw new QuotaError(`文档节点数已达上限（${MAX_DOC_NODES}）`);
    }
    if (baseUpdatedAt) {
      const base = Date.parse(baseUpdatedAt);
      if (!Number.isNaN(base) && file.updatedAt.getTime() > base && this.collab.hasLiveDoc(id)) {
        throw new ConflictException(STALE_SNAPSHOT_MESSAGE);
      }
    }
    file.docState = Buffer.from(state);
    file.nodeCount = nodeCount;
    await this.repo.save(file); // @UpdateDateColumn 自动回写 updated_at
    return { nodeCount };
  }

  /** 重命名（title 已在 controller 经 createFileSchema.title 校验）。 */
  async rename(userId: string, id: string, title: string): Promise<FileListItem> {
    const file = await this.findAliveOr404(userId, id);
    file.title = title;
    await this.repo.save(file);
    return this.toListItem(file);
  }

  /** 回写最近打开时间；1 分钟内重复打开直接返回旧值（写摊销）。
   *  落库走 repo.update 定点更新：UpdateQueryBuilder 对 @UpdateDateColumn 会自动回填
   *  CURRENT_TIMESTAMP，必须显式把 updated_at 钉回自身（updatedAt: () => 'updated_at'）
   *  才能不推进——save() 全量回写会污染列表 updatedAt 排序（M1 遗留）。 */
  async markOpened(userId: string, id: string): Promise<{ lastOpenedAt: string }> {
    const file = await this.findAliveOr404(userId, id);
    if (file.lastOpenedAt && Date.now() - file.lastOpenedAt.getTime() < OPEN_THROTTLE_MS) {
      return { lastOpenedAt: file.lastOpenedAt.toISOString() };
    }
    const openedAt = new Date();
    await this.repo.update(id, {
      lastOpenedAt: openedAt,
      updatedAt: () => 'updated_at', // 定点写：updated_at 设回自身，绕开自动 CURRENT_TIMESTAMP
    });
    return { lastOpenedAt: openedAt.toISOString() };
  }
}

export class QuotaError extends Error {}
