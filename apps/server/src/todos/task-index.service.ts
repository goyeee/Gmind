import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ulid } from 'ulid';
import {
  assigneeEntriesOf,
  getLastEditor,
  getNode,
  listCanvases,
  rootIdOf,
  subtreeIds,
  canvasNodesMap,
} from '@gmind/core';
import { taskDoneDateOf, taskProgressOf, taskStatusOf, type DeriveNode } from '@gmind/shared';
import type * as Y from 'yjs';
import { EventsService } from '../events/events.service';
import { NodeIndexEntity } from './node-index.entity';
import { TaskIndexEntity } from './task-index.entity';
import { TaskParticipantEntity } from './task-participant.entity';

/**
 * 任务索引服务（第二期批次 B；2026-11-21 第二轮扩口径，spec §5.1）：
 *
 * - 抽取口径：显式任务 = 节点 task 与缺省不同（ownerId/owners/日期/status/progress）
 *   **或人员列有任一条目**（第二轮放宽：纯参与节点入索引，待办收录参与人的必然
 *   结论，统计任务总数随之变大=需求方知情）；文本截断 255；
 * - 派生口径：progress/status/done_date 存 shared derive 同算法的有效值——自动父
 *   =Σ直属真正任务均值/最晚子完成日期，手动节点=自身值；三处消费（索引/待办/统计）
 *   同源，不出现第二套算法（spec 评审重点 4）；
 * - 重建范围：每画布 root 子树（先例 allAliveNodeIds）；同节点多列同人参与人逐条目
 *   落 task_participant；node_index 维持首画布口径（全文搜索跨画布不在本设计范围）；
 * - 重建策略：diff 与行构建全在事务外，事务内 DELETE 该文件三表 + 批量插入（数百
 *   节点级，异步 fire-and-forget 不阻塞保存；失败仅留痕——与 auto 快照同模式，下个
 *   保存窗口自愈）；
 * - 动态补记（spec §5.5）：自动父无用户级写入口（子任务编辑抬起派生值），重建时
 *   对比新旧派生值，变化即补记 task_progress/task_complete 事件——操作者归属触发
 *   重建的最后修改者（近似口径：多人同瞬并发归最后保存者，如实登记）。
 */

/** 判定节点是否「用户显式设过任务」（与缺省值比较的单点口径）。
 *  2026-11-20 任务模型：新写入只有 ownerId（owners 键删除）——负责人判定改
 *  ownerId 优先、owners 兼容回退。2026-11-21 第二轮放宽：人员列有任一条目也算
 *  显式任务（否则纯参与节点拼不出待办行）；「排除 taskActive === false」由本式
 *  自然成立（人列条目/任一旧条件成立 ⇒ taskActive 必为 true）。 */
function isExplicitTask(
  t: {
    status: string;
    progress: number;
    ownerId: string | null;
    owners: string[];
    startDate: string | null;
    dueDate: string | null;
  },
  hasAssigneeEntries: boolean,
): boolean {
  return (
    hasAssigneeEntries ||
    t.ownerId !== null ||
    t.owners.length > 0 ||
    t.startDate !== null ||
    t.dueDate !== null ||
    t.status !== 'todo' ||
    t.progress > 0
  );
}

/** 自动父派生变化补记事件的行内载体（重建事务后落 events）。 */
interface AutoParentDiff {
  nodeId: string;
  canvasId: string;
  canvasName: string;
  text: string;
  progress: number;
  status: string;
  related: string[];
}

@Injectable()
export class TaskIndexService {
  private readonly logger = new Logger(TaskIndexService.name);

  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @InjectRepository(TaskIndexEntity) private readonly repo: Repository<TaskIndexEntity>,
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** 同文件重建串行链（评审 P2-3）：fire-and-forget 并发时旧版本事务可能后提交
   *  覆盖新版本（索引短暂回退）——按 fileId 链式等待前一轮完成。Map 值恒为「最后
   *  一轮的尾 Promise」（catch 过不抛），文件数有界（≤ 活跃文件数），无泄漏面。 */
  private readonly rebuildChains = new Map<string, Promise<void>>();

  /** 供 TodosModule 离线直改路径 await（同链串行）；后台路径忽略返回值。 */
  enqueueRebuild(fileId: string, run: () => Promise<void>): Promise<void> {
    const prev = this.rebuildChains.get(fileId) ?? Promise.resolve();
    const run2: Promise<void> = prev.then(run, run); // 前一轮失败不阻断本轮
    const tail: Promise<void> = run2.catch((err: unknown) => {
      this.logger.error(
        `任务索引重建失败（file=${fileId}）`,
        err instanceof Error ? (err.stack ?? err.message) : String(err),
      );
    });
    this.rebuildChains.set(fileId, tail);
    return run2; // 调用方可 await 并自捕错（离线 PATCH 路径错误需上抛）
  }

  /** 全量重建某文件的任务索引（落库成功后调用；doc 为刚持久化的 Y.Doc）。
   *  同事务重建 node_index（2026-10-28 P1 全文搜索）：首画布全存活节点文本（含无
   *  任务节点），与既有口径一致；task_index/task_participant 扩全部画布。 */
  async rebuildForFile(fileId: string, doc: Y.Doc): Promise<void> {
    // 旧行先读（事务外）：自动父派生 diff 的对比基线；重建失败不影响旧数据在库
    const oldRows = (await this.repo.find({
      where: { fileId },
      select: ['nodeId', 'status', 'progress'],
    })) as Array<{ nodeId: string; status: string; progress: number }>;
    const oldByNode = new Map(oldRows.map((r) => [r.nodeId, r]));

    const rows: TaskIndexEntity[] = [];
    const participantRows: TaskParticipantEntity[] = [];
    const nodeRows: NodeIndexEntity[] = [];
    const autoDiffs: AutoParentDiff[] = [];
    const canvases = listCanvases(doc);
    const firstCanvasId = canvases[0]?.id;

    for (const canvas of canvases) {
      const canvasId = canvas.id;
      // 派生输入：本画布全存活节点 → DeriveNode[]（taskProgressOf 自 id 向下递归
      // 汇总，需完整子树；parentId 建树与 core 快照同构，order 不参与均值可缺省）
      const deriveNodes: DeriveNode[] = [];
      const snaps = new Map<string, ReturnType<typeof getNode>>();
      for (const [id] of canvasNodesMap(doc, canvasId).entries()) {
        const snap = getNode(doc, id, canvasId);
        if (!snap || snap.deleted) continue;
        snaps.set(id, snap);
        deriveNodes.push({
          id,
          parentId: snap.parentId === '' ? null : snap.parentId,
          title: snap.text,
          task: { ...snap.task },
          taskActive: snap.taskActive,
        });
      }
      // 入索引集合=画布 root 子树（可达口径，与旧 walk('root') 一致；环防御内建）
      for (const id of subtreeIds(doc, rootIdOf(doc, canvasId), canvasId)) {
        const snap = snaps.get(id);
        if (!snap) continue;
        // node_index 维持首画布口径（行为不变，范围变更不在本设计）
        if (canvasId === firstCanvasId && snap.text.trim() !== '') {
          const nr = new NodeIndexEntity();
          nr.fileId = fileId;
          nr.nodeId = snap.id;
          nr.text = snap.text;
          nodeRows.push(nr);
        }
        const assignees = assigneeEntriesOf(doc, id, canvasId);
        if (!isExplicitTask(snap.task, assignees.length > 0)) continue;
        const row = new TaskIndexEntity();
        row.id = ulid();
        row.fileId = fileId;
        row.canvasId = canvasId;
        row.canvasName = canvas.name.slice(0, 100);
        row.nodeId = snap.id;
        row.text = snap.text.slice(0, 255);
        row.ownersCsv = snap.task.ownerId !== null ? snap.task.ownerId : snap.task.owners.join(',');
        row.status = taskStatusOf(deriveNodes, id);
        row.progress = taskProgressOf(deriveNodes, id);
        row.ownerProgress = snap.task.ownerProgress;
        row.startDate = snap.task.startDate;
        row.dueDate = snap.task.dueDate;
        // 完成日期同源派生口径：自动父=全完后的最晚子完成日期（不伪造今天）
        row.doneDate = taskDoneDateOf(deriveNodes, id);
        rows.push(row);
        for (const e of assignees) {
          const pr = new TaskParticipantEntity();
          pr.fileId = fileId;
          pr.nodeId = snap.id;
          pr.userId = e.user;
          pr.progress = e.progress;
          pr.colId = e.colId;
          participantRows.push(pr);
        }
        // 自动父派生 diff 候选（普通节点变化由客户端声明/todos PATCH 直记，不在此补记）
        if (snap.task.autoProgress === true) {
          autoDiffs.push({
            nodeId: snap.id,
            canvasId,
            canvasName: canvas.name,
            text: snap.text.slice(0, 255),
            progress: row.progress,
            status: row.status,
            related: [
              ...(snap.task.ownerId !== null ? [snap.task.ownerId] : []),
              ...assignees.map((e) => e.user),
            ],
          });
        }
      }
    }

    await this.dataSource.transaction(async (em) => {
      await em.delete(TaskIndexEntity, { fileId });
      await em.delete(NodeIndexEntity, { fileId });
      await em.delete(TaskParticipantEntity, { fileId });
      if (rows.length > 0) {
        await em.insert(TaskIndexEntity, rows as TaskIndexEntity[]);
      }
      if (nodeRows.length > 0) {
        await em.insert(NodeIndexEntity, nodeRows as NodeIndexEntity[]);
      }
      if (participantRows.length > 0) {
        await em.insert(TaskParticipantEntity, participantRows as TaskParticipantEntity[]);
      }
    });

    // 派生事件在索引落库成功后补记（失败仅留痕，与重建同模式——下个保存窗口重算）
    await this.recordAutoParentEvents(fileId, doc, autoDiffs, oldByNode);
  }

  /** 自动父派生变化 → 动态事件（spec §5.5）：progress 变化即记，新值 100 记
   *  task_complete；操作者=文档 lastEditor（无标记为 null，展示层兜底「—」）。 */
  private async recordAutoParentEvents(
    fileId: string,
    doc: Y.Doc,
    autoDiffs: AutoParentDiff[],
    oldByNode: Map<string, { nodeId: string; status: string; progress: number }>,
  ): Promise<void> {
    if (autoDiffs.length === 0) return;
    const actor = getLastEditor(doc);
    for (const d of autoDiffs) {
      const old = oldByNode.get(d.nodeId);
      if (!old) continue; // 首次入索引无「变化」可言
      const oldProgress = Number(old.progress) || 0;
      if (d.progress === oldProgress && d.status === old.status) continue;
      const type = d.progress === 100 && oldProgress < 100 ? 'task_complete' : 'task_progress';
      try {
        await this.events.record(type, fileId, actor, {
          fileId,
          canvasId: d.canvasId,
          canvasName: d.canvasName,
          nodeId: d.nodeId,
          taskText: d.text,
          actor,
          related: [...new Set(d.related)],
          before: { status: old.status, progress: oldProgress },
          after: { status: d.status, progress: d.progress },
          derived: true, // 重建补记标记（区别于用户级声明；文案可标注「自动汇总」）
        });
      } catch (err: unknown) {
        this.logger.warn(
          `自动父派生动态补记失败（file=${fileId} node=${d.nodeId}）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** fire-and-forget 包装（落库钩子用）：失败仅留痕，绝不阻塞保存主流程；
   *  同文件按 enqueueRebuild 串行（评审 P2-3）。 */
  rebuildInBackground(fileId: string, doc: Y.Doc): void {
    void this.enqueueRebuild(fileId, () => this.rebuildForFile(fileId, doc)).catch(() => undefined); // 链尾已留痕
  }

  /** 装载兜底（第二轮，spec §5.1）：存量索引行 canvas_id IS NULL = 旧口径（未见过
   *  新重建器）→ 后台全量重建一次补齐画布/参与人/派生口径。文件打开一次即修复；
   *  未打开过的文件画布显示「未知画布」（不跑全量离线重建，避免部署期长事务）。 */
  async rebuildIfStaleInBackground(fileId: string, doc: Y.Doc): Promise<void> {
    try {
      const rows = (await this.dataSource.query(
        'SELECT COUNT(*) AS n FROM task_index WHERE file_id = ? AND canvas_id IS NULL',
        [fileId],
      )) as Array<{ n: number | string }>;
      if (Number(rows[0]?.n ?? 0) > 0) this.rebuildInBackground(fileId, doc);
    } catch {
      // 探测失败按「无需重建」处理：该文件下个保存窗口的重建自然自愈
    }
  }
}
