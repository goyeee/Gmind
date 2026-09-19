import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { countNodes, createTemplateDoc, docFromState, docToState, SEED_TEMPLATES } from '@gmind/core';
import type { FileListItem } from '@gmind/shared';
import { FileCollaboratorEntity } from './file-collaborator.entity';
import { FileEntity } from './file.entity';

export const MAX_FILES_PER_USER = 100;
/** 单文档节点数上限（spec §7.2）：PUT doc-state 超限拒绝（FR-ACC-003）。 */
export const MAX_DOC_NODES = 500;
/** 打开时间戳写摊销节流：1 分钟内重复打开不回写 last_opened_at。 */
const OPEN_THROTTLE_MS = 60_000;

@Injectable()
export class FilesService {
  constructor(
    @InjectRepository(FileEntity) private readonly repo: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collabRepo: Repository<FileCollaboratorEntity>,
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
      file.nodeCount = input.nodeCount ?? countNodes(doc);
      // 从恢复 doc 的 meta 回填 structure/themeId，保证 files 列与 Y.Doc 元数据一致（如种子模板 org 结构）
      const meta = doc.getMap('meta');
      const structure = meta.get('structureType');
      const themeId = meta.get('themeId');
      if (typeof structure === 'string' && structure) file.structure = structure;
      if (typeof themeId === 'string' && themeId) file.themeId = themeId;
    } else {
      const doc = createTemplateDoc({ title: input.title, children: [] });
      file.docState = Buffer.from(docToState(doc));
      file.nodeCount = countNodes(doc);
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

  /** 读取/写入权限（spec §7.2）：owner 或 file_collaborators 存在行（一期协作者即可编辑）。
   *  无权限与「不存在」同口径 404，不泄露文件存在性。 */
  private async assertCanRead(userId: string, file: FileEntity): Promise<void> {
    if (file.ownerUserId === userId) return;
    const collaborators = await this.collabRepo.countBy({ fileId: file.id, userId });
    if (collaborators === 0) throw new NotFoundException('文件不存在');
  }

  /** 加载存活文件并校验权限；缺失/已删/无权限一律 404「文件不存在」。 */
  private async findAliveOr404(userId: string, id: string): Promise<FileEntity> {
    const file = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!file) throw new NotFoundException('文件不存在');
    await this.assertCanRead(userId, file);
    return file;
  }

  /** 编辑器打开文件的完整状态；docState 以 base64 离开服务端（唯一内容出口）。 */
  async getOwnedFileWithState(
    userId: string,
    id: string,
  ): Promise<{ id: string; title: string; structure: string; themeId: string; nodeCount: number; docState: string }> {
    const file = await this.findAliveOr404(userId, id);
    return {
      id: file.id,
      title: file.title,
      structure: file.structure,
      themeId: file.themeId,
      nodeCount: file.nodeCount,
      docState: (file.docState ?? Buffer.alloc(0)).toString('base64'),
    };
  }

  /** 回写文档状态：先解析校验（失败 400），再校验节点配额 ≤500（超限 403），最后落库。 */
  async saveDocState(userId: string, id: string, state: Uint8Array): Promise<{ nodeCount: number }> {
    const file = await this.findAliveOr404(userId, id);
    let doc;
    try {
      doc = docFromState(state);
    } catch {
      throw new BadRequestException('文档解析失败');
    }
    const nodeCount = countNodes(doc);
    if (nodeCount > MAX_DOC_NODES) {
      throw new QuotaError(`文档节点数已达上限（${MAX_DOC_NODES}）`);
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

  /** 回写最近打开时间；1 分钟内重复打开直接返回旧值（写摊销）。 */
  async markOpened(userId: string, id: string): Promise<{ lastOpenedAt: string }> {
    const file = await this.findAliveOr404(userId, id);
    if (file.lastOpenedAt && Date.now() - file.lastOpenedAt.getTime() < OPEN_THROTTLE_MS) {
      return { lastOpenedAt: file.lastOpenedAt.toISOString() };
    }
    const openedAt = new Date();
    file.lastOpenedAt = openedAt;
    await this.repo.save(file);
    return { lastOpenedAt: openedAt.toISOString() };
  }
}

export class QuotaError extends Error {}
