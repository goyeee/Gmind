import type * as Y from 'yjs';
import { childrenIds, getNode, listCanvases } from '@gmind/core';

/**
 * 文档级文本导出（2026-10-25 原型分享弹窗导出页签）：Markdown 大纲 + CSV 任务表，
 * 真实下载（区别于 PNG/PDF 占位——主项目图像导出走既有 image-export 通道）。
 * 只读导出：全部经 core 读 API，覆盖全部存活画布（多画布裁定 3 同款「文件=全部画布」
 * 口径）；owners 为 userId，昵称由调用方经 nameOf 映射（无目录时回退 id 尾 4 位）。
 */

/** 触发浏览器下载（data URL，避免临时 blob URL 生命周期）。 */
function download(name: string, text: string, mime: string): void {
  const a = document.createElement('a');
  a.href = `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
  a.download = name;
  a.click();
}

interface FlatRow {
  title: string;
  depth: number;
  owners: string[];
  dueDate: string | null;
  progress: number;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  priority: string | null;
}

/** 画布树 → 平铺行（root 不进表，depth 0=直属子级；collapsed 展开导出全量）。 */
function flattenCanvas(doc: Y.Doc, canvasId: string, rootId: string): FlatRow[] {
  const rows: FlatRow[] = [];
  const walk = (id: string, depth: number): void => {
    for (const cid of childrenIds(doc, id, canvasId)) {
      const snap = getNode(doc, cid, canvasId);
      if (!snap || snap.deleted) continue;
      const progress = snap.task?.progress ?? 0;
      rows.push({
        title: snap.text,
        depth,
        owners: snap.task?.owners ?? [],
        dueDate: snap.task?.dueDate ?? null,
        progress,
        status: snap.task?.status ?? (progress >= 100 ? 'done' : progress > 0 ? 'doing' : 'todo'),
        priority: snap.icons?.priority?.[0] ?? null,
      });
      walk(cid, depth + 1);
    }
  };
  walk(rootId, 0);
  return rows;
}

/** Markdown 大纲导出：`文件名.md`（每画布一节，无序列表按深度缩进）。 */
export function exportMarkdown(doc: Y.Doc, title: string): void {
  const parts: string[] = [`# ${title}`, ''];
  for (const c of listCanvases(doc)) {
    // 单画布文件保持「标题即节」（文件名==画布名时不再重复一节标题）
    if (listCanvases(doc).length > 1) parts.push(`## ${c.name}`, '');
    for (const r of flattenCanvas(doc, c.id, c.rootId)) {
      parts.push(`${'  '.repeat(r.depth)}- ${r.title || '（未命名）'}`);
    }
    parts.push('');
  }
  download(`${title}.md`, parts.join('\n'), 'text/markdown');
}

/** CSV 任务表导出：`文件名.csv`（表头对齐原型：序号/主题/负责人/截止时间/进度/
 *  状态/优先级；\ufeff BOM 保证 Excel 直开 UTF-8；字段内逗号/引号 RFC 4180 转义）。 */
export function exportCsv(doc: Y.Doc, title: string, nameOf: (userId: string) => string): void {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ['序号,主题,负责人,截止时间,进度,状态,优先级'];
  let i = 0;
  for (const c of listCanvases(doc)) {
    for (const r of flattenCanvas(doc, c.id, c.rootId)) {
      i += 1;
      lines.push(
        [
          String(i),
          esc(`${'　'.repeat(r.depth)}${r.title || '（未命名）'}`),
          esc(r.owners.map(nameOf).join('/')),
          r.dueDate ?? '',
          `${r.progress}%`,
          r.status === 'done' ? '已完成' : r.status === 'doing' ? '进行中' : r.status === 'blocked' ? '阻塞' : '未开始',
          r.priority ?? '',
        ].join(','),
      );
    }
  }
  download(`${title}.csv`, `\ufeff${lines.join('\n')}`, 'text/csv');
}
