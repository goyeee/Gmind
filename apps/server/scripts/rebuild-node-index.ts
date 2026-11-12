/**
 * node_index 存量回填（2026-10-28 P1 全文搜索上线一次性脚本）：
 * 迁移只建表——存量文件的节点文本索引需从 files.doc_state 重建一次。
 * 遍历全部存活文件（deleted_at IS NULL），逐个走 TaskIndexService.rebuildForFile
 * （task_index 与 node_index 同事务重写——任务索引数据同源无副作用）。
 *
 * 用法（apps/server 目录）：npx tsx scripts/rebuild-node-index.ts
 * 幂等可重跑；失败单文件跳过不阻塞。
 */
import { NestFactory } from '@nestjs/core';
import { docFromState } from '@gmind/core';
import { DataSource, IsNull } from 'typeorm';
import { AppModule } from '../src/app.module';
import { TaskIndexService } from '../src/todos/task-index.service';
import { FileEntity } from '../src/files/file.entity';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const ds = app.get<DataSource>(DataSource);
  const files = await ds.getRepository(FileEntity).find({ where: { deletedAt: IsNull() }, select: ['id', 'title', 'docState'] });
  console.log(`[rebuild] 存活文件 ${files.length} 个，开始回填 node_index…`);
  const svc = app.get(TaskIndexService);
  let ok = 0;
  let failed = 0;
  for (const f of files) {
    try {
      const doc = docFromState(new Uint8Array(f.docState));
      await svc.rebuildForFile(f.id, doc);
      doc.destroy();
      ok++;
    } catch (e) {
      failed++;
      console.error(`[rebuild] 跳过 ${f.id}（${f.title}）：`, e instanceof Error ? e.message : String(e));
    }
  }
  console.log(`[rebuild] 完成：成功 ${ok}，失败 ${failed}`);
  await app.close();
}

void main().catch((e) => {
  console.error('[rebuild] 失败：', e);
  process.exit(1);
});
