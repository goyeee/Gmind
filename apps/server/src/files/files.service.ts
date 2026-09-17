import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { countNodes, createTemplateDoc, docFromState, docToState, SEED_TEMPLATES } from '@gmind/core';
import type { FileListItem } from '@gmind/shared';
import { FileEntity } from './file.entity';

export const MAX_FILES_PER_USER = 100;

@Injectable()
export class FilesService {
  constructor(@InjectRepository(FileEntity) private readonly repo: Repository<FileEntity>) {}

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
}

export class QuotaError extends Error {}
