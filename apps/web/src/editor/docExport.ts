import type * as Y from 'yjs';
import { childrenIds, getNode, listCanvases } from '@gmind/core';
import { taskProgressOf, taskStatusOf, type DeriveNode } from '@gmind/shared';

/**
 * 文档级导出（2026-10-25 原型分享弹窗导出页签；2026-11-15 轮 1 五项收敛）：
 * Markdown 大纲 + CSV/Excel 任务表真实下载（图像导出走既有 image-export JPG 通道，PNG 2026-11-15 退役）。
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
  const derive: DeriveNode[] = [];
  const collect = (id: string, parentId: string | null): void => {
    const snap = getNode(doc, id, canvasId);
    if (!snap || snap.deleted) return;
    derive.push({
      id,
      parentId,
      title: snap.text,
      taskActive: snap.taskActive,
      task: snap.task,
    });
    for (const child of childrenIds(doc, id, canvasId)) collect(child, id);
  };
  collect(rootId, null);
  const walk = (id: string, depth: number): void => {
    for (const cid of childrenIds(doc, id, canvasId)) {
      const snap = getNode(doc, cid, canvasId);
      if (!snap || snap.deleted) continue;
      const progress = taskProgressOf(derive, cid);
      const ownerId = snap.task.ownerId ?? snap.task.owners[0] ?? null;
      rows.push({
        title: snap.text,
        depth,
        owners: ownerId === null ? [] : [ownerId],
        dueDate: snap.task?.dueDate ?? null,
        progress,
        status: taskStatusOf(derive, cid),
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
          STATUS_LABEL[r.status],
          r.priority ?? '',
        ].join(','),
      );
    }
  }
  download(`${title}.csv`, `\ufeff${lines.join('\n')}`, 'text/csv');
}

import { zipEntries } from '@gmind/xmind-io';

const STATUS_LABEL: Record<FlatRow['status'], string> = { todo: '未开始', doing: '进行中', blocked: '阻塞', done: '已完成' };

/** 二进制下载（blob URL，click 后下一宏任务回收——image-export downloadBlob 同模式）。 */
function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const XLSX_COLS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const escXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xlsxCell = (row: number, col: number, v: string | number): string =>
  typeof v === 'number'
    ? `<c r="${XLSX_COLS[col]}${row}" t="n"><v>${v}</v></c>`
    : `<c r="${XLSX_COLS[col]}${row}" t="inlineStr"><is><t>${escXml(v)}</t></is></c>`;

/** 单元格显示宽（2026-11-15 验收反馈②）：文本码点展开（[...s]，代理对不重复计）后
 *  CJK/全角（U+2E80–U+9FFF、U+F900–U+FAFF、U+FF00–U+FFEF）记 2 其余记 1；
 *  数字按字符串化长度（100→3）。缩进全角空格 U+3000 落在 CJK 区间计 2。 */
const displayWidth = (v: string | number): number => {
  if (typeof v === 'number') return String(v).length;
  return [...v].reduce((w, ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    const wide = (cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef);
    return w + (wide ? 2 : 1);
  }, 0);
};

/** 行模型 → 最小 xlsx 字节（手写 OOXML：ContentTypes/.rels/workbook/worksheet 五部件，
 *  zip 经 xmind-io zipEntries=fflate，零新依赖；含 7 列列宽自适应（<cols> 置 <sheetData> 前）；
 *  不支持公式/样式，挂账候选）。 */
export function buildXlsxBytes(rows: Array<Array<string | number>>): Uint8Array {
  // brief 笔误修正：原稿 `const enc = new TextEncoder()` 不可调用（enc('…') 抛 TypeError），
  // 改为编码函数；五处调用点保持原稿逐字不变。
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const sheetData = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => xlsxCell(ri + 1, ci, v)).join('')}</row>`).join('');
  // 列宽自适应：宽度=列内最大显示宽+2，钳制 [8,60]；任务表恒 7 列各一 col（空列/缺失列落下限 8）
  const colWidths = XLSX_COLS.map(
    (_, ci) => Math.min(60, Math.max(8, rows.reduce((m, r) => Math.max(m, ci < r.length ? displayWidth(r[ci]) : 0), 0) + 2)),
  );
  const cols = `<cols>${colWidths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`;
  return zipEntries({
    '[Content_Types].xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="任务表" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${sheetData}</sheetData></worksheet>`),
  });
}

/** Excel 任务表导出（2026-11-15 需求方拍板：列与 CSV 7 列对齐）：`文件名.xlsx`；
 *  序号/进度为数字单元格，其余 inlineStr 文本；缩进/空值口径与 CSV 逐格一致。 */
export function exportXlsx(doc: Y.Doc, title: string, nameOf: (userId: string) => string): void {
  const rows: Array<Array<string | number>> = [['序号', '主题', '负责人', '截止时间', '进度', '状态', '优先级']];
  let i = 0;
  for (const c of listCanvases(doc)) {
    for (const r of flattenCanvas(doc, c.id, c.rootId)) {
      i += 1;
      rows.push([
        i,
        `${'　'.repeat(r.depth)}${r.title || '（未命名）'}`,
        r.owners.map(nameOf).join('/'),
        r.dueDate ?? '',
        r.progress,
        STATUS_LABEL[r.status],
        r.priority ?? '',
      ]);
    }
  }
  downloadBytes(`${title}.xlsx`, buildXlsxBytes(rows), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
