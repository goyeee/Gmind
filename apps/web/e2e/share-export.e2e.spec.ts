import * as fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parseXmind, unzipEntries } from '@gmind/xmind-io';
import { registerAndLogin } from './helpers/auth';
import { buildFixtureXmind } from './helpers/xmind-fixture';

/**
 * 分享弹框导出页签 E2E（2026-11-15 轮 1 分享导出改版 Task 4）——编辑器顶栏
 * share-btn 打开分享弹框 →「导出」页签五项逐一真实下载断言。
 *
 * 覆盖：五项齐全（xmind/jpg/md/csv/xlsx +「图片按当前折叠状态导出」说明行）、XMind 走
 * 既有导出通道（与工具栏往返用例同源同种子口径）、图片统一 JPG 白底（PNG
 * 2026-11-15 退役，弹框固定 2×）、Markdown 大纲、CSV 7 列任务表（BOM+表头）、
 * Excel 最小 OOXML（PK 魔数）+「已导出 ✓」按钮反馈。
 *
 * 2026-11-15 导出保真第三波追加：XMind 产物 v2.3 形状断言（unzipEntries 解包）——
 * theme 逐字借真实 XMind 金样、manifest.json file-entries 登记；2026-11-15 主题按
 * 结构选型批（build v2.4）同步：种子文档结构=mindmap → theme 断言=THEME_MINDMAP
 * curve 金样（roundedElbow→curve，随批更新）；带图文档
 * resources/ 写回链路（walk→fetch /api/images→zip+manifest+topic.image）用既有导入
 * 夹具造带图文档后经分享弹框真实导出断言（种子文档无图，夹具自带 4×4 PNG，
 * 零新增图片数据；抓取失败计数 toast 路径由 xmind-export.test.ts 单测钉住）。
 *
 * 写法沿用 import-export.e2e.spec.ts 既有模式：openSeedDoc 打开种子文档「本周计划」
 * （无折叠 → XMind/JPG 通道不弹 confirm），下载断言
 * Promise.all([waitForEvent('download'), click]) + fs.promises.readFile(download.path())
 * + suggestedFilename()。「已导出 ✓」反馈只在 xlsx 用例断言（1800ms 回落，含下载
 * 用例的回落时序易抖；xlsx 字节结构已由 unit 层 docExport.test.ts 覆盖）。
 */

/** 打开种子文件进入编辑器，等待 root 文本渲染（同 import-export.e2e.spec.ts 的既定模式）。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** 打开分享弹框并切到「导出」页签（新注册用户=种子文件 owner：默认页签是邀请协作）。 */
async function openShareExportTab(page: Page): Promise<void> {
  await page.getByTestId('share-btn').click();
  await expect(page.getByTestId('share-dialog')).toBeVisible();
  await page.getByTestId('share-tab-export').click();
}

/** content.json 原始 topic 形状（仅断言所需字段， XMind 2020+ JSON 结构）。 */
interface RawTopic {
  title?: string;
  image?: { src?: string; width?: number; height?: number; align?: string };
  children?: { attached?: RawTopic[] };
}

/** 先序递归找 title 命中的原始 topic（import-export.e2e.spec.ts findTitle 同款模式）。 */
function findTopicByTitle(node: RawTopic, title: string): RawTopic | null {
  if (node.title === title) return node;
  for (const child of node.children?.attached ?? []) {
    const hit = findTopicByTitle(child, title);
    if (hit) return hit;
  }
  return null;
}

// 用例 1：导出页签五项齐全（xmind/jpg/md/csv/xlsx 逐项可见），说明行含
// 「图片按当前折叠状态导出」（分段口径：XMind/表格类含折叠全部节点、图片按当前
// 折叠态导出——2026-11-15 终审 Important#2 改文案，替换旧「包含已折叠的节点」
// 整句——旧句对图片项失实且沿自已删除的折叠确认框语义）。
test('导出页签五项齐全：xmind/jpg/md/csv/xlsx 逐项可见+「图片按当前折叠状态导出」说明', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  await expect(page.getByTestId('share-export-xmind')).toBeVisible();
  await expect(page.getByTestId('share-export-jpg')).toBeVisible();
  await expect(page.getByTestId('share-export-jpg-scale')).toHaveValue('2');
  await expect(page.getByTestId('share-export-md')).toBeVisible();
  await expect(page.getByTestId('share-export-csv')).toBeVisible();
  await expect(page.getByTestId('share-export-xlsx')).toBeVisible();
  await expect(page.locator('.share-export-note')).toContainText('图片按当前折叠状态导出');
});

// 用例 2：XMind 走既有导出通道（onExport('xmind')=工具栏 export-xmind 同源），
// 下载产物用 @gmind/xmind-io 直接解析（种子文档=单画布单 Sheet，root=本周计划）。
// v2.3（2026-11-15 导出保真第三波）起经 unzipEntries 解包断言 theme 与 manifest 登记；
// v2.4（2026-11-15 主题按结构选型批）起 theme 按画布结构二选一——种子文档结构=
// mindmap → 断言 curve 金样（即需求方「思维导图页线条直愣愣」二次反馈的修复点），
// roundedElbow 断言值随批更新（logic 金样不回归由 build.test.ts v2.4 用例钉住）。
test('分享弹框导出 XMind：下载 .xmind 可解析（单 Sheet/root 本周计划/三分支）+theme/manifest 形状', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-xmind').click(),
  ]);
  expect(download.suggestedFilename()).toBe('本周计划.xmind');
  const bytes = new Uint8Array(await fs.promises.readFile(await download.path()));
  const parsed = parseXmind(bytes);
  expect(parsed.sheets).toHaveLength(1); // 种子文档单画布 → 单 Sheet（裁定 8）
  expect(parsed.sheets[0].root.title).toBe('本周计划');
  expect(parsed.sheets[0].root.children.map((c) => c.title)).toEqual(['周一', '周三', '周五']);

  // v2.4 形状（2026-11-15 主题按结构选型批同步）：种子文档结构=mindmap → theme=
  // THEME_MINDMAP（逐字借真实思维导图金样「邢安家2025.08.01.xmind」，mainTopic/
  // subTopic line-class=curve、无 skeletonThemeId——金样本无，实现不得自造）；
  // manifest file-entries 恰登记两核心条目（不变）。
  const entries = unzipEntries(bytes);
  const sheet0 = JSON.parse(new TextDecoder().decode(entries['content.json']!))[0] as {
    theme?: {
      mainTopic?: { properties?: Record<string, string> };
      subTopic?: { properties?: Record<string, string> };
      skeletonThemeId?: string;
    };
    rootTopic?: {
      extensions?: Array<{ provider: string; content: Array<{ name: string; content: string }> }>;
    };
  };
  expect(sheet0.theme?.mainTopic?.properties?.['line-class']).toBe(
    'org.xmind.branchConnection.curve',
  );
  expect(sheet0.theme?.subTopic?.properties?.['line-class']).toBe(
    'org.xmind.branchConnection.curve',
  );
  expect('skeletonThemeId' in (sheet0.theme ?? {})).toBe(false);
  // 分侧忠实还原（2026-11-15 Task 4；终审 Important#1 改口径）：种子文档三分支无持久 side
  // （模板装载通道不写），导出计数镜像引擎折算口径（index 0-2 视右）→ 前三支居右=3；根扩展
  // 金样逐字形状，解析侧读回同值（前缀布局逐支一致；非前缀首开按计数重排一次，见 export 头注）
  expect(sheet0.rootTopic?.extensions).toEqual([
    { provider: 'org.xmind.ui.map.unbalanced', content: [{ name: 'right-number', content: '3' }] },
  ]);
  expect(parsed.sheets[0].rightCount).toBe(3);
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as {
    'file-entries': Record<string, unknown>;
  };
  expect(Object.keys(manifest['file-entries']).sort()).toEqual(['content.json', 'metadata.json']);
});

// 用例 2b：带图文档导出 resources/ 写回链路（2026-11-15 导出保真第三波）。种子文档
// 无图，带图载荷取自既有导入夹具（helpers/xmind-fixture 全保真件自带 4×4 PNG，经
// 真实两段式上传落库——零新增图片数据）：导入 → 打开 → 分享弹框导出 XMind →
// 解包断言 zip 含 resources/ 图片（PNG 魔数）＋manifest 登记 extra＋content.json
// topic.image 写回（fetch 抓取成功链路；失败计数 toast 路径由单测钉住）。资源名=
// storage 键尾段 ulid（运行期生成），故断言「恰一个 resources/ 条目」不钉具体名。
test('分享弹框导出带图文档 XMind：zip 含 resources/ 图片、manifest 登记且 topic.image 写回', async ({ page }) => {
  await registerAndLogin(page);
  await page.goto('/workspace'); // 导入入口=首页「导入文件」卡
  await page.getByTestId('quick-create-import').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '示例.xmind',
    mimeType: 'application/octet-stream',
    buffer: buildFixtureXmind(),
  });
  // 唯一降级源=陌生标记 arrow-refresh（「图标 1」）——toast 逐字对上即证明夹具
  // 的 4×4 PNG 两段式上传零降级（导入侧用例 7 同款断言）
  await expect(page.getByTestId('toast')).toHaveText('未导入：图标 1');
  await page.getByTestId('file-card').filter({ hasText: '示例' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '根节点' })).toBeVisible();
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-xmind').click(),
  ]);
  expect(download.suggestedFilename()).toBe('示例.xmind'); // 导出文件名=编辑器标题（2026-11-14 拍板）
  const bytes = new Uint8Array(await fs.promises.readFile(await download.path()));
  const entries = unzipEntries(bytes);
  // resources/：恰一条图片条目（单图文档），字节为 PNG 魔数（\x89PNG）
  const resKeys = Object.keys(entries).filter((k) => k.startsWith('resources/') && !k.endsWith('/'));
  expect(resKeys).toHaveLength(1);
  expect(Buffer.from(entries[resKeys[0]]!.subarray(0, 4)).toString('hex')).toBe('89504e47');
  // manifest 登记 extra 全部键（v2.3）：两核心条目＋resources 图片条目
  const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']!)) as {
    'file-entries': Record<string, unknown>;
  };
  expect(Object.keys(manifest['file-entries'])).toEqual(
    expect.arrayContaining(['content.json', 'metadata.json', resKeys[0]]),
  );
  // content.json 写回：待办一 topic.image 四键——src='xap:'+path（build 层拼法）、
  // width/height=导入侧 readImageSize 真实字节 4×4（200px 钳制不动）、align=夹具 bottom 原值
  const content = JSON.parse(new TextDecoder().decode(entries['content.json']!)) as Array<{
    rootTopic: RawTopic;
  }>;
  const todo = findTopicByTitle(content[0]!.rootTopic, '待办一');
  expect(todo?.image).toEqual({ src: `xap:${resKeys[0]}`, width: 4, height: 4, align: 'bottom' });
});

// 用例 3：弹框图片项保留 JPG 白底 1×/2×/3×，默认 2×；逐档下载均为合法 JPEG。
test('分享弹框导出图片：同一图片行可选 JPG 1×/2×/3×并分别下载', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  const scale = page.getByTestId('share-export-jpg-scale');
  await expect(scale).toHaveValue('2');
  for (const value of ['1', '2', '3']) {
    await scale.selectOption(value);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('share-export-jpg').click(),
    ]);
    expect(download.suggestedFilename()).toBe('本周计划.jpg');
    const jpg = await fs.promises.readFile(await download.path());
    expect(jpg.length).toBeGreaterThan(0);
    expect(jpg.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  }
});

// 用例 4：Markdown 大纲（docExport.exportMarkdown：首行 `# 标题`，子节点无序列表）。
test('分享弹框导出 Markdown：# 本周计划 开头且含「- 周一」', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-md').click(),
  ]);
  expect(download.suggestedFilename()).toBe('本周计划.md');
  const md = await fs.promises.readFile(await download.path(), 'utf8');
  expect(md.startsWith('# 本周计划')).toBe(true);
  expect(md).toContain('- 周一');
});

// 用例 5：CSV 任务表（docExport.exportCsv：BOM 保证 Excel 直开 UTF-8，
// 表头 7 列=序号/主题/负责人/截止时间/进度/状态/优先级）。
test('分享弹框导出 CSV：BOM+7 列表头（序号,主题,负责人,截止时间,进度,状态,优先级）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-csv').click(),
  ]);
  expect(download.suggestedFilename()).toBe('本周计划.csv');
  const csv = await fs.promises.readFile(await download.path(), 'utf8');
  expect(csv.startsWith('\ufeff序号,主题,负责人,截止时间,进度,状态,优先级')).toBe(true); // BOM+表头
  expect(csv).toContain('周一'); // 数据行进表（root 不进表）
});

// 用例 6：Excel 任务表（docExport.exportXlsx：手写最小 OOXML=zip 容器，PK 魔数；
// 点击行按钮反馈「已导出 ✓」——断言放在含下载的 Promise.all 之后，不做 1800ms
// 回落时序断言，状态机由 unit 层覆盖）。
test('分享弹框导出 Excel：本周计划.xlsx 为 zip 魔数且按钮变「已导出 ✓」', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-xlsx').click(),
  ]);
  expect(download.suggestedFilename()).toBe('本周计划.xlsx');
  const xlsx = await fs.promises.readFile(await download.path());
  expect(xlsx.subarray(0, 4).toString('hex')).toBe('504b0304'); // PK\x03\x04（zip 容器）
  await expect(page.getByTestId('share-export-xlsx')).toContainText('已导出 ✓');
});
