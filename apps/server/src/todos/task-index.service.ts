import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ulid } from 'ulid';
import { getNode } from '@gmind/core';
import type * as Y from 'yjs';
import { NodeIndexEntity } from './node-index.entity';
import { TaskIndexEntity } from './task-index.entity';

/**
 * 任务索引服务（第二期批次 B）：持久化落库后从 docState 全量重建 task_index。
 *
 * - 抽取口径：节点 task 与缺省不同（owners 非空 ∥ startDate ∥ dueDate ∥ status≠todo ∥
 *   progress>0）才算任务；文本截断 255；
 * - 重建策略：事务内 DELETE 该文件全部 + 批量插入（数百节点级，异步 fire-and-forget
 *   不阻塞保存；失败仅 console.error——与 auto 快照同模式，下个保存窗口自愈）；
 * - 遍历：root 起经 childIds 深搜（NodeSnapshot.childIds，core 读 API）。
 */

/** 判定节点是否「用户显式设过任务」（与缺省值比较的单点口径）。
 *  2026-11-20 任务模型：新写入只有 ownerId（owners 键删除）——负责人判定改
 *  ownerId 优先、owners 兼容回退（不提前破坏待办索引，参与人收录留第二轮）。 */
function isExplicitTask(t: {
  status: string;
  progress: number;
  ownerId: string | null;
  owners: string[];
  startDate: string | null;
  dueDate: string | null;
}): boolean {
  return (
    t.ownerId !== null ||
    t.owners.length > 0 ||
    t.startDate !== null ||
    t.dueDate !== null ||
    t.status !== 'todo' ||
    t.progress > 0
  );
}

@Injectable()
export class TaskIndexService {
  private readonly logger = new Logger(TaskIndexService.name);

  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @InjectRepository(TaskIndexEntity) private readonly repo: Repository<TaskIndexEntity>,
    @Inject(DataSource) private readonly dataSource: DataSource,
  ) {}

  /** 全量重建某文件的任务索引（落库成功后调用；doc 为刚持久化的 Y.Doc）。
   *  同事务重建 node_index（2026-10-28 P1 全文搜索）：全存活节点文本（含无任务
   *  节点），与 task_index 同遍历口径——两张表要么一起新要么一起旧。 */
  async rebuildForFile(fileId: string, doc: Y.Doc): Promise<void> {
    const rows: TaskIndexEntity[] = [];
    const nodeRows: NodeIndexEntity[] = [];
    const walk = (id: string): void => {
      const snap = getNode(doc, id);
      if (!snap || snap.deleted) return;
      if (snap.text.trim() !== '') {
        const nr = new NodeIndexEntity();
        nr.fileId = fileId;
        nr.nodeId = snap.id;
        nr.text = snap.text;
        nodeRows.push(nr);
      }
      const t = snap.task;
      if (isExplicitTask(t)) {
        const row = new TaskIndexEntity();
        row.id = ulid();
        row.fileId = fileId;
        row.nodeId = snap.id;
        row.text = snap.text.slice(0, 255);
        row.ownersCsv = t.ownerId !== null ? t.ownerId : t.owners.join(',');
        row.status = t.status;
        row.progress = t.progress;
        row.startDate = t.startDate;
        row.dueDate = t.dueDate;
        row.doneDate = t.doneDate;
        rows.push(row);
      }
      for (const child of snap.childIds) walk(child);
    };
    walk('root');

    await this.dataSource.transaction(async (em) => {
      await em.delete(TaskIndexEntity, { fileId });
      await em.delete(NodeIndexEntity, { fileId });
      if (rows.length > 0) {
        await em.insert(TaskIndexEntity, rows as TaskIndexEntity[]);
      }
      if (nodeRows.length > 0) {
        await em.insert(NodeIndexEntity, nodeRows as NodeIndexEntity[]);
      }
    });
  }

  /** fire-and-forget 包装（落库钩子用）：失败仅留痕，绝不阻塞保存主流程。 */
  rebuildInBackground(fileId: string, doc: Y.Doc): void {
    void this.rebuildForFile(fileId, doc).catch((err: unknown) => {
      this.logger.error(`任务索引重建失败（file=${fileId}）`, err instanceof Error ? err.message : String(err));
    });
  }
}
