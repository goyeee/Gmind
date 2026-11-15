# 分享弹框·导出改版（原型同步轮 1）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 分享弹框导出页签收敛为五项（XMind / 图片 JPG 白底 / Markdown / CSV / Excel 新增），工具栏导出菜单 PNG 退役，补齐分享导出 e2e。

**Architecture:** Excel 走手写最小 OOXML（零新依赖，zip 经 @gmind/xmind-io 既有 fflate 开口）；图片导出统一 JPG 白底（现有 image-export JPG 通道，去 PNG/透明分支）；弹框 UI 按原型 11-14 版五项列表+「导出→已导出」反馈。

**Tech Stack:** React + vitest + Playwright；fflate（经 xmind-io `zipEntries`/新增 `unzipEntries` 开口，web 不直引）。

**Spec:** 需求方 2026-11-15 拍板（勾选「分享弹框按设计稿改」+ 修正口径「图片要白底 JPG」「CSV/Excel 真项目必须有」「Excel 第一版列跟 CSV 对齐」）；原型 11-14 版 `ShareModal.tsx` 导出页签为视觉蓝本。路线图：`~/.claude/plans/ai-ai-mock-ai-expressive-lerdorf.md` 轮 1。

## Global Constraints

- **不 commit**：需求方未发指令（AGENTS §二），全部改动停在工作树等验收。
- engine/core 只增不改；本轮只动 `apps/web` 与 `packages/xmind-io`（后者只增）。
- 零新依赖：xlsx 手写；图标用内联 SVG（lucide 非 apps/web 依赖）。
- testid 契约：保留 `export-menu` / `export-xmind` / `export-jpg-{1,2,3}x` / `share-export-xmind|md|csv`；退役 `export-transparent` / `export-png-{1,2,3}x` / `share-export-png-{1,2,3}x` / `share-export-jpg-{1,2,3}x`（后两者零 e2e 引用，已核实）；新增 `share-export-jpg` / `share-export-xlsx`。
- 文案两段式（原因+下一步）不涉及新错误面；toast 文案沿既有句式（「已导出 X」「导出失败」）。
- XMind 导出（M4 高保真版）逻辑不动。
- 门禁五件套（收官跑）：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`。

---

### Task 1: Excel 导出模块（unzipEntries 开口 + buildXlsxBytes/exportXlsx + 单测）

**Files:**
- Modify: `packages/xmind-io/src/index.ts`（zipEntries 旁追加 unzipEntries 开口）
- Modify: `packages/xmind-io/src/roundtrip.test.ts`（追加 unzipEntries 往返用例）
- Modify: `apps/web/src/editor/docExport.ts`（新增 buildXlsxBytes/exportXlsx/downloadBytes，CSV 抽 STATUS_LABEL 常量去重）
- Test: `apps/web/src/editor/docExport.test.ts`（新建）

**Interfaces:**
- Produces: `unzipEntries(bytes: Uint8Array): Record<string, Uint8Array>`（xmind-io 命名导出）；`buildXlsxBytes(rows: Array<Array<string | number>>): Uint8Array`、`exportXlsx(doc: Y.Doc, title: string, nameOf: (userId: string) => string): void`（docExport 命名导出，签名与 exportCsv 同形）。Task 2/4 消费。

- [ ] **Step 1: xmind-io 加 unzipEntries 并写往返用例（先测后码）**

`packages/xmind-io/src/index.ts` 在 zipEntries（:33-35）旁追加：

```ts
/** 解包 zip（fflate unzipSync 包装，与 zipEntries 对称的测试/工具开口；导入主链路不使用）。 */
export function unzipEntries(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}
```

（fflate import 行补 `unzipSync`。）`roundtrip.test.ts` 末尾追加：

```ts
import { zipEntries, unzipEntries } from './index';

describe('unzipEntries（zipEntries 对称开口）', () => {
  it('zip 后解包字节一致', () => {
    const payload = new TextEncoder().encode('{"hello":"世界"}');
    const packed = zipEntries({ 'a/b.json': payload, 'c.txt': new TextEncoder().encode('x') });
    const out = unzipEntries(packed);
    expect(new TextDecoder().decode(out['a/b.json'])).toBe('{"hello":"世界"}');
    expect(new TextDecoder().decode(out['c.txt'])).toBe('x');
  });
});
```

- [ ] **Step 2: 跑 xmind-io 用例确认过**：`pnpm --filter @gmind/xmind-io test`
- [ ] **Step 3: docExport.ts 加 buildXlsxBytes/exportXlsx（先写 docExport.test.ts 失败用例再实现）**

`docExport.test.ts`（新建，断言点钉死）：

```ts
import { describe, expect, it } from 'vitest';
import { unzipEntries } from '@gmind/xmind-io';
import { buildXlsxBytes } from './docExport';

const sheetXml = (bytes: Uint8Array): string =>
  new TextDecoder().decode(unzipEntries(bytes)['xl/worksheets/sheet1.xml']);

describe('buildXlsxBytes（最小 OOXML 任务表）', () => {
  it('zip 含五个标准部件', () => {
    const parts = Object.keys(unzipEntries(buildXlsxBytes([['序号']])));
    expect(parts).toEqual(expect.arrayContaining([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml',
    ]));
  });
  it('表头 7 列与 CSV 同序', () => {
    const xml = sheetXml(buildXlsxBytes([['序号','主题','负责人','截止时间','进度','状态','优先级']]));
    for (const h of ['序号','主题','负责人','截止时间','进度','状态','优先级']) {
      expect(xml).toContain(`<t>${h}</t>`);
    }
  });
  it('字符串经 XML 实体转义', () => {
    expect(sheetXml(buildXlsxBytes([['主题&<1>']]))).toContain('主题&amp;&lt;1&gt;');
  });
  it('数字单元格 t="n"（序号/进度用），文本单元格 inlineStr', () => {
    const xml = sheetXml(buildXlsxBytes([[1, '甲', '', '', 85, '', '']]));
    expect(xml).toContain('<c r="A1" t="n"><v>1</v></c>');
    expect(xml).toContain('<v>85</v>');
    expect(xml).toContain('<c r="B1" t="inlineStr"><is><t>甲</t></is></c>');
  });
});
```

`docExport.ts` 实现（追加；`STATUS_LABEL` 抽出同时替换 exportCsv 内三元链）：

```ts
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

/** 行模型 → 最小 xlsx 字节（手写 OOXML：ContentTypes/.rels/workbook/worksheet 五部件，
 *  zip 经 xmind-io zipEntries=fflate，零新依赖；不支持公式/样式，挂账候选）。 */
export function buildXlsxBytes(rows: Array<Array<string | number>>): Uint8Array {
  const enc = new TextEncoder();
  const sheetData = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => xlsxCell(ri + 1, ci, v)).join('')}</row>`).join('');
  return zipEntries({
    '[Content_Types].xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
    '_rels/.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="任务表" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': enc('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': enc(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetData}</sheetData></worksheet>`),
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
```

同时 exportCsv 的状态三元链换成 `STATUS_LABEL[r.status]`（输出字节不变）。

- [ ] **Step 4: 跑 web 单测**：`pnpm --filter @gmind/web test -- docExport`（4 用例过）；`pnpm --filter @gmind/web exec tsc --noEmit` 过（等价门禁由收官跑，此处快速类型自检）

### Task 2: 分享弹框导出页签改版（五项列表 + 已导出反馈）

**Files:**
- Modify: `apps/web/src/editor/ShareDialog.tsx`（:5 import、:22-35 Props.onExport 收窄、:115-123 runTextExport 加 xlsx、:208-235 导出页签重写）
- Modify: `apps/web/src/editor/share-dialog.css`（:134-152 导出列表样式重写）
- Modify: `apps/web/src/pages/EditorPage.tsx`（:5166-5178 onExport 转发收窄 'png' 分支）

**Interfaces:**
- Consumes: Task 1 的 `exportXlsx(doc, title, nameOf)`。
- Produces: `ShareDialogProps.onExport(kind: 'xmind' | 'jpg', scale?: 1 | 2 | 3)`（Task 3 沿用）。

- [ ] **Step 1: ShareDialog.tsx 改版**（原型 11-14 版 ShareModal 导出页签为蓝本，结构照搬、数据源换真实现）：

```tsx
import { exportCsv, exportMarkdown, exportXlsx } from './docExport';
// Props:
/** 既有导出通道转发（2026-11-15 图片统一 JPG 白底，PNG 退役）。 */
onExport(kind: 'xmind' | 'jpg', scale?: 1 | 2 | 3): void;
// 组件内：
const [exported, setExported] = useState('');
const runTextExport = (kind: 'md' | 'csv' | 'xlsx'): void => {
  if (!p.doc) return;
  try {
    if (kind === 'md') exportMarkdown(p.doc, p.title || '未命名');
    else if (kind === 'csv') exportCsv(p.doc, p.title || '未命名', p.nameOf);
    else exportXlsx(p.doc, p.title || '未命名', p.nameOf);
  } catch (e) {
    p.showToast(e instanceof Error ? e.message : '导出失败');
  }
};
interface ExportItem { id: string; testid: string; title: string; ext: string; desc: string; tint: string; bg: string; run: () => void }
const EXPORTS: ExportItem[] = [
  { id: 'xmind', testid: 'share-export-xmind', title: 'XMind', ext: '.xmind', desc: '可在 XMind 中继续编辑，保留完整层级，含全部画布', tint: '#f43f5e', bg: '#fdeceb', run: () => p.onExport('xmind') },
  { id: 'jpg', testid: 'share-export-jpg', title: '图片', ext: '.jpg', desc: '白底高清整图（2×），适合插入文档与汇报', tint: '#0ea5e9', bg: '#eaf5ff', run: () => p.onExport('jpg', 2) },
  { id: 'md', testid: 'share-export-md', title: 'Markdown', ext: '.md', desc: '层级大纲文本，可粘贴到笔记与文档工具', tint: '#8b5cf6', bg: '#f1edff', run: () => runTextExport('md') },
  { id: 'csv', testid: 'share-export-csv', title: 'CSV 表格', ext: '.csv', desc: '任务表 7 列，可用 Excel 打开', tint: '#14b8a6', bg: '#e9f8f4', run: () => runTextExport('csv') },
  { id: 'xlsx', testid: 'share-export-xlsx', title: 'Excel 表格', ext: '.xlsx', desc: '任务表电子表格，可用 Excel/WPS 打开', tint: '#16a34a', bg: '#e9f9ef', run: () => runTextExport('xlsx') },
];
const runExport = (e: ExportItem): void => {
  try {
    e.run();
    setExported(e.id);
    p.showToast(`已导出 ${e.title}`);
    setTimeout(() => setExported((x) => (x === e.id ? '' : x)), 1800);
  } catch (err) {
    p.showToast(err instanceof Error ? err.message : '导出失败');
  }
};
```

导出页签 JSX（统一下载图标为内联 SVG，五项各配色盒）：

```tsx
{tab === 'export' && (
  <div className="share-dialog-body share-dialog-export">
    <p className="share-export-note">导出「{p.title}」的完整内容，包含已折叠的节点</p>
    <ul className="share-export-list">
      {EXPORTS.map((e) => (
        <li key={e.id}>
          <button type="button" className="share-export-row" data-testid={e.testid} onClick={() => runExport(e)}>
            <span className="share-export-icon" style={{ background: e.bg, color: e.tint }} aria-hidden>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
            </span>
            <span className="share-export-text">
              <b>{e.title}<i className="share-export-ext">{e.ext}</i></b>
              <span>{e.desc}</span>
            </span>
            <span className={'share-export-btn' + (exported === e.id ? ' done' : '')}>{exported === e.id ? '已导出 ✓' : '导出'}</span>
          </button>
        </li>
      ))}
    </ul>
  </div>
)}
```

文件头注 :18-19 的导出说明同步改写（XMind/JPG 转发 + MD/CSV/XLSX 真实下载，PNG 退役）。

- [ ] **Step 2: share-dialog.css**：`.share-dialog-export` 改列表样式（`.share-export-note` 12px #86909c、`.share-export-row` 全宽 flex 圆角边框 hover、`.share-export-icon` 40×40 圆角盒、`.share-export-ext` 11px 灰底徽标、`.share-export-btn` 右侧 32px 高圆角小钮 done 态绿底）。替换原 :134-152 的 grid 平铺按钮样式。
- [ ] **Step 3: EditorPage.tsx**：`onExport` 转发（:5166-5178）参数类型收窄为 `'xmind' | 'jpg'`——`png` 分支删除（`runImageExport(kind, scale ?? 1)` 分支不变，TS 收窄后 kind 仅 jpg）；:5157 附近头注同步（「PNG/JPG」→「JPG（PNG 2026-11-15 退役）」）。
- [ ] **Step 4: 验证**：`pnpm --filter @gmind/web exec tsc --noEmit` + `pnpm --filter @gmind/web test`（既有全绿，ShareDialog 无组件单测——e2e 由 Task 4 补）；`grep -rn "share-export-png\|share-export-jpg-" apps/web/src` 零残留。

### Task 3: 工具栏导出菜单收敛（PNG 退役）+ image-export 修剪 + 受影响 e2e

**Files:**
- Modify: `apps/web/src/pages/EditorPage.tsx`（:746 exportTransparent state、:1291-1304 runImageExport、工具栏导出菜单块）
- Modify: `apps/web/src/editor/image-export.ts`（ImageExportOptions/头部注/rasterize 修剪）
- Modify: `apps/web/e2e/import-export.e2e.spec.ts`（用例 4 重写为 JPG 3x、用例 5 改 jpg 通道）
- Modify: `apps/web/e2e/canvas-scope.e2e.spec.ts`（png-1x → jpg-1x）

**Interfaces:**
- Produces: `ImageExportOptions { format: 'jpg'; scale: 1 | 2 | 3; canvasId?: string }`（transparent 字段删除）；`runImageExport(format: 'jpg', scale: 1 | 2 | 3)`。

- [ ] **Step 1: image-export.ts 修剪**：`ImageExportOptions` 删 `transparent`、`format` 收窄 `'jpg'`；exportImage 删 `opts.format === 'jpg' || !opts.transparent` 判定（恒铺白底）、toBlob 恒 `'image/jpeg'`、文件扩展名恒 `.jpg`；rasterize 删 `opaque` 形参（恒 fillRect 白底）；头注改写（「PNG/JPG 导出胶水」→「JPG 导出胶水（2026-11-15 PNG 透明档随需求方裁定退役，git 历史留 PNG 双格式实现）」）。
- [ ] **Step 2: EditorPage**：删 `exportTransparent` state 与 `export-transparent` checkbox；删 `export-png-{n}x` 按钮组；`runImageExport(format: 'jpg', scale)`、调用处删 transparent；工具栏头注同步。**保留** `export-menu`/`export-xmind`/`export-jpg-{1,2,3}x` 三个 testid（契约红线）。
- [ ] **Step 3: e2e 重写**
  - import-export 用例 4 →「导出 JPG 3x：下载产物为 JPEG 且宽高可被 3 整除；无折叠不弹确认」：`export-jpg-3x` 点击，`export-transparent` 断言删除；JPEG 尺寸断言用 SOF0/2 扫描（替代 PNG IHDR）：

```ts
function jpegSize(bytes: Buffer): { w: number; h: number } {
  for (let i = 2; i < bytes.length - 9;) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xc0 || marker === 0xc2) return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('JPEG 无 SOF 段');
}
```

  断言 `w % 3 === 0 && h % 3 === 0`、文件名 `本周计划.jpg`、`dialogCount === 0`。
  - 用例 5（折叠）：`export-png-1x` → `export-jpg-1x`，断言文件名 `本周计划.jpg`，其余（confirm 文案、折叠态不变）不动。
  - 用例 6（JPG 1x 冒烟）不动。
  - canvas-scope：`export-png-1x` → `export-jpg-1x`、断言 `本周计划-画布B.jpg`。
- [ ] **Step 4: 残留清零**：`grep -rn "export-png\|export-transparent\|share-export-png" apps/web` 零命中；`pnpm --filter @gmind/web exec tsc --noEmit` 过；`pnpm --filter @gmind/web test` 全绿（image-export.test 只测文件名口径，无需改）。

### Task 4: 分享导出 e2e 新建 + 文档三件套

**Files:**
- Create: `apps/web/e2e/share-export.e2e.spec.ts`
- Modify: `docs/features/import-export.md`、`docs/m4-acceptance.md`、`docs/project-status.md`

**Interfaces:** Consumes Task 1-3 全部产物（五个 testid + 下载行为）。

- [ ] **Step 1: 新建 spec**（helper import 与下载断言模式照抄 import-export.e2e.spec.ts 既有写法：`openSeedDoc` + `Promise.all([waitForEvent('download'), click])`）。六个用例：
  1. 五项齐全：`share-btn` → `share-dialog` → `share-tab-export` → 五个 testid（xmind/jpg/md/csv/xlsx）逐一 `toBeVisible`，说明行含「包含已折叠的节点」。
  2. XMind：点 `share-export-xmind` → `本周计划.xmind` → `parseXmind` 断言 sheets 1、root 文本「本周计划」（工具栏往返用例同源口径）。
  3. 图片 JPG：点 `share-export-jpg` → `本周计划.jpg` → `ffd8ff` 魔数。
  4. Markdown：点 `share-export-md` → `本周计划.md` → 内容 `# 本周计划` 开头 + 含 `- 周一`。
  5. CSV：点 `share-export-csv` → `本周计划.csv` → BOM+`序号,主题,负责人,截止时间,进度,状态,优先级` 表头。
  6. Excel+反馈：点 `share-export-xlsx` → `本周计划.xlsx` → `PK\x03\x04` 魔数；该行按钮文字变「已导出 ✓」（`share-export-xlsx` 内含文本断言）；同时 md 行反馈回落不做时序断言（1.8s 计时易抖，unit 层已覆盖状态逻辑）。
- [ ] **Step 2: 跑新 spec**：`WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/share-export.e2e.spec.ts`（6/6 过）
- [ ] **Step 3: 文档三件套（当日 grep 行号，禁止转抄）**
  - `docs/features/import-export.md`：导出规则更新（五项清单/JPG 白底 2×弹框+1-3×工具栏/Excel 列口径=CSV 7 列、序号进度数字单元格/PNG 退役）；④ 追加「xlsx 为最小 OOXML 手写件：公式/样式/多 sheet 不支持（挂账候选）」。
  - `docs/m4-acceptance.md`：轮 1 补记节（原型 11-14 分享导出改版落地、PNG 退役依据、Excel 选型=零依赖手写件、测试数字）。
  - `docs/project-status.md`：§三 追加一行（2026-11-15 轮 1 跟进）。
- [ ] **Step 4: 收官门禁五件套全绿**（见 Global Constraints），汇报等验收。

## Self-Review

- 覆盖核对：需求方口径五项 ✓（T1 xlsx、T2 五项 UI、T3 JPG 统一、T4 e2e）；「包含已折叠节点」说明 ✓（T2）；XMind 不动 ✓（无任务触碰 xmind-export）；PNG 退役 ✓（T2 弹框/T3 工具栏/库修剪/e2e 重写）。
- 占位扫描：无 TBD；T2 组件无单测属既定（e2e 于 T4 钉），已在步骤注明。
- 类型一致性：`onExport('xmind'|'jpg', scale?)` T2 产出=T3 沿用 ✓；`exportXlsx(doc,title,nameOf)` T1 产出=T2 消费 ✓；`buildXlsxBytes(Array<Array<string|number>>)` T1 内一致 ✓。
