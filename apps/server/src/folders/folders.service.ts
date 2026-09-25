import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { MAX_FOLDER_DEPTH } from '@gmind/shared';
import type { FolderItem } from '@gmind/shared';
import { FilesService } from '../files/files.service';
import { FolderEntity } from './folder.entity';

/** FolderEntity → FolderItem 序列化契约（唯一出口）。 */
function toFolderItem(f: FolderEntity): FolderItem {
  return { id: f.id, name: f.name, parentId: f.parentId, depth: f.depth };
}

@Injectable()
export class FoldersService {
  constructor(
    @InjectRepository(FolderEntity) private readonly repo: Repository<FolderEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  /** 新建文件夹（FR-FIL-002）：根 depth=1；有 parent 时校验归属+存活（400「父文件夹不存在」），
   *  并做 5 级深度校验（parent.depth + 1 > 5 → 400）。space_id 一期恒 NULL（个人空间）。 */
  async createForUser(userId: string, input: { name: string; parentId?: string }): Promise<FolderItem> {
    let parentDepth = 0;
    if (input.parentId) {
      const parent = await this.repo.findOne({
        where: { id: input.parentId, ownerUserId: userId, deletedAt: IsNull() },
      });
      if (!parent) throw new BadRequestException('父文件夹不存在');
      parentDepth = parent.depth;
    }
    if (parentDepth + 1 > MAX_FOLDER_DEPTH) {
      throw new BadRequestException(`文件夹层级已达上限（${MAX_FOLDER_DEPTH} 级）`);
    }
    const folder = this.repo.create();
    folder.ownerUserId = userId;
    folder.name = input.name;
    folder.parentId = input.parentId ?? null;
    folder.depth = parentDepth + 1;
    const saved = await this.repo.save(folder);
    return toFolderItem(saved);
  }

  /** 我的存活文件夹扁平列表（GET /api/folders 裁定口径）：服务端按 depth ASC → name ASC
   *  排序返回，树结构由客户端组装。 */
  async listTree(userId: string): Promise<FolderItem[]> {
    const rows = await this.repo.find({
      where: { ownerUserId: userId, deletedAt: IsNull() },
      order: { depth: 'ASC', name: 'ASC' },
    });
    return rows.map(toFolderItem);
  }

  /** 改名与/或移动（FR-FIL-002）。移动语义：
   *  - parentId null → 移到根；非空 → 目标须为本人存活文件夹（400「目标文件夹不存在」）；
   *  - 环检测：目标在自身子树内（含自指）→ 400「不能移动到自身或其子文件夹」；
   *  - 深度重算：先在内存中按整棵子树推演新 depth，任一节点超 5 级即 400 且**不落库**
   *    （先校验后写入，无中间态）；通过后整棵子树统一更新。
   *  缺失/已删/非本人一律 404「文件夹不存在」，不泄露存在性。 */
  async update(
    userId: string,
    id: string,
    input: { name?: string; parentId?: string | null },
  ): Promise<FolderItem> {
    const folder = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!folder || folder.ownerUserId !== userId) throw new NotFoundException('文件夹不存在');

    if (input.name !== undefined) folder.name = input.name;

    if (input.parentId !== undefined) {
      const all = await this.repo.find({ where: { ownerUserId: userId, deletedAt: IsNull() } });
      const byId = new Map(all.map((f) => [f.id, f]));
      const childrenOf = new Map<string, FolderEntity[]>();
      for (const f of all) {
        if (f.parentId) {
          const list = childrenOf.get(f.parentId) ?? [];
          list.push(f);
          childrenOf.set(f.parentId, list);
        }
      }

      const newParentId = input.parentId;
      if (newParentId !== null) {
        if (newParentId === id) throw new BadRequestException('不能移动到自身或其子文件夹');
        const parent = byId.get(newParentId);
        if (!parent) throw new BadRequestException('目标文件夹不存在');
        // 环检测：沿新父向上走，撞到自身即环（存活链深 ≤5，步数有界）
        let cur: FolderEntity | undefined = parent;
        while (cur) {
          if (cur.id === id) throw new BadRequestException('不能移动到自身或其子文件夹');
          cur = cur.parentId ? byId.get(cur.parentId) : undefined;
        }
      }

      // 整棵子树推演新 depth（移动中的子树内部相对层级不变）
      const baseDepth = newParentId === null ? 0 : (byId.get(newParentId)?.depth ?? 0);
      if (baseDepth + 1 > MAX_FOLDER_DEPTH) {
        throw new BadRequestException(`文件夹层级已达上限（${MAX_FOLDER_DEPTH} 级）`);
      }
      const subtree: Array<{ entityId: FolderEntity; newDepth: number }> = [];
      const walk = (node: FolderEntity, depth: number): void => {
        subtree.push({ entityId: node, newDepth: depth });
        for (const child of childrenOf.get(node.id) ?? []) walk(child, depth + 1);
      };
      walk(folder, baseDepth + 1);

      const over = subtree.filter((s) => s.newDepth > MAX_FOLDER_DEPTH);
      if (over.length > 0) {
        throw new BadRequestException(`文件夹层级已达上限（${MAX_FOLDER_DEPTH} 级）`);
      }
      // 校验全部通过才写库：先根（parentId/depth 一起变），再逐个后代定点更新
      folder.parentId = newParentId;
      folder.depth = baseDepth + 1;
      await this.repo.save(folder);
      for (const s of subtree) {
        if (s.entityId.id !== id) await this.repo.update(s.entityId.id, { depth: s.newDepth });
      }
    } else {
      await this.repo.save(folder);
    }
    return toFolderItem(folder);
  }

  /** 删除（FR-FIL-002 整体入回收站）：文件夹软删 + 递归子文件夹软删 + 其下全部存活文件
   *  软删入回收站（deleted_by = 调用者，复用 FilesService.softDeleteFile 核心）。
   *  仅文件夹 owner 可删；缺失/已删/非本人一律 404「文件夹不存在」，不泄露存在性。 */
  async deleteRecursively(userId: string, id: string): Promise<void> {
    const folder = await this.repo.findOne({ where: { id, deletedAt: IsNull() } });
    if (!folder || folder.ownerUserId !== userId) throw new NotFoundException('文件夹不存在');

    const all = await this.repo.find({ where: { ownerUserId: userId, deletedAt: IsNull() } });
    const subtreeIds: string[] = [folder.id];
    const frontier = [folder.id];
    while (frontier.length > 0) {
      const cur = frontier.pop() as string;
      for (const f of all) {
        if (f.parentId === cur && !subtreeIds.includes(f.id)) {
          subtreeIds.push(f.id);
          frontier.push(f.id);
        }
      }
    }
    const now = new Date();
    await this.repo.update({ id: In(subtreeIds) }, { deletedAt: now });
    await this.files.softDeleteFilesInFolders(subtreeIds, userId);
  }
}
