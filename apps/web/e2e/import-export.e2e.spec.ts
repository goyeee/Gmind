import * as fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { buildXmind, parseXmind, unzipEntries, type XmindNode } from '@gmind/xmind-io';
import { registerAndLogin } from './helpers/auth';
import { buildCleanXmind, buildFixtureXmind } from './helpers/xmind-fixture';

/**
 * XMind 导入端到端（M4 Task 4，FR-IO-001/002）——工作台导入入口。
 *
 * 夹具在测试内用 @gmind/xmind-io 的 buildXmind 构造 .xmind bytes（web 测试进程能
 * import workspace 包，同 e2e 直接 import 依赖的先例）。登录走公共 helper（helpers/auth）：新手机号
 * 注册即赠 3 个种子文件，每用例独立用户、互不共享状态。
 * 覆盖：正常导入（新文件出现 + 层级/备注渲染）、25MB 超限（大小文案）、损坏文件（已损坏文案）、
 * 导出往返（M4 Task 5：导出菜单下载 .xmind → xmind-io 解析断言 → 下载产物回灌导入）。
 */

/** 夹具树：root「项目根主题」+ 两级子树，分支A 带备注（层级/备注渲染的断言依据）。
 *  文件名「项目.xmind」与 root 标题共同满足列表行 hasText「项目」的契约。 */
const FIXTURE_TREE = {
  title: '项目根主题',
  children: [
    { title: '分支A', note: '分支A的备注', children: [{ title: '孙1', children: [] }] },
    { title: '分支B', children: [] },
  ],
};


/** 打开种子文件进入编辑器，等待 root 文本渲染（同 editor.e2e.spec.ts 的既定模式）。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

async function openShareExportTab(page: Page): Promise<void> {
  if (await page.getByTestId('share-dialog').count() === 0) await page.getByTestId('share-btn').click();
  await page.getByTestId('share-tab-export').click();
}

async function clickSharedJpg(page: Page, scale: 1 | 2 | 3): Promise<void> {
  await page.getByTestId('share-export-jpg-scale').selectOption(String(scale));
  await page.getByTestId('share-export-jpg').click();
}

test('工作台导入 .xmind：新文件出现且层级/备注正确渲染', async ({ page }) => {
  await registerAndLogin(page);
  await page.goto('/workspace'); // 导入入口=首页「导入文件」卡
  await page.getByTestId('quick-create-import').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '项目.xmind',
    mimeType: 'application/octet-stream',
    // setInputFiles 的 buffer 契约为 Buffer（buildXmind 产物是 Uint8Array，需包一层）
    buffer: Buffer.from(buildXmind([{ title: '', root: FIXTURE_TREE }])),
  });
  // 新文件出现在列表（标题 = 根主题「项目根主题」，命中「项目」）
  await expect(page.getByTestId('file-card').filter({ hasText: '项目' }).first()).toBeVisible();
  await page.getByTestId('file-card').filter({ hasText: '项目' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  // 层级渲染：root 与两级子节点；备注以角标呈现（分支A 持有唯一的 note 角标）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '根主题' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '分支A' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '孙1' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-note-badge')).toHaveCount(1);
});

test('导入 25MB 超限：提示大小上限+压缩重试；损坏文件：提示已损坏+检查重试', async ({ page }) => {
  await registerAndLogin(page);
  // 超限 buffer 用恒定填充（大小检查先于解析，垃圾内容不会进入解析器）
  await page.goto('/workspace'); // 导入入口=首页「导入文件」卡
  await page.getByTestId('quick-create-import').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '超大.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(21 * 1024 * 1024, 0),
  });
  await expect(page.getByTestId('toast')).toHaveText('文件大小超过 20MB 上限，请压缩后重试');

  // 损坏文件（< 20MB 乱字节，非 zip）：归因「文件已损坏，无法解析」且不产生新文件
  await page.goto('/workspace'); // 导入入口=首页「导入文件」卡
  await page.getByTestId('quick-create-import').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '损坏.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024, 0x07),
  });
  await expect(page.getByTestId('toast')).toHaveText('文件已损坏，无法解析，请检查文件后重试');
  await expect(page.getByTestId('quick-create-blank')).toBeVisible(); // 首页落点（换装后种子文件在「我的文件」视图）
  await page.goto('/workspace?view=files');
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
});

/** 先序查找 title 命中的节点（导出往返断言辅助）。 */
function findTitle(node: XmindNode, title: string): XmindNode | null {
  if (node.title === title) return node;
  for (const child of node.children) {
    const hit = findTitle(child, title);
    if (hit) return hit;
  }
  return null;
}

/** 打开种子文件「本周计划」并给「周一」写备注「评审要点」。备注 UI（格式面板
 *  「简介」区/插入菜单项）已随 2026-10-01 需求方反馈任务 2 回退隐藏（恢复 M7b #3
 *  裁定的隐藏态），种子数据改在页面上下文内经 @gmind/core 操作 API setNote 直写
 *  （唯一写入口纪律不变；动态 import('/@id/@gmind/core') 复用页面同一模块实例，
 *  perf-editor 同款模式）。角标可见即备注已入本地 doc——导出读本地 doc，无需等
 *  网络落库。 */
async function openSeedDocWithNote(page: Page): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: '本周计划' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await page.evaluate(async () => {
    const bare = ['/@id/', '@gmind/core'].join(''); // 动态拼串：vite dev 的 bare-id 路由
    const core = (await import(bare)) as {
      ROOT_NODE_ID: string;
      getNode: (doc: unknown, id: string) => { text: string; deleted: boolean } | null;
      childrenIds: (doc: unknown, id: string) => string[];
      setNote: (doc: unknown, id: string, note: string) => void;
    };
    const doc = (window as unknown as { __gmind?: { getDoc: () => unknown } }).__gmind?.getDoc();
    if (!doc) throw new Error('window.__gmind 未就绪');
    const kidIds = core.childrenIds(doc, core.ROOT_NODE_ID);
    for (const id of kidIds) {
      const snap = core.getNode(doc, id);
      if (snap && !snap.deleted && snap.text === '周一') {
        core.setNote(doc, id, '评审要点');
        return;
      }
    }
    throw new Error('种子节点「周一」未找到');
  });
  await expect(
    page.locator('.editor-canvas svg g[data-node-id]', { hasText: '周一' }).locator('.gm-note-badge'),
  ).toBeVisible();
}

// 用例 3（M4 Task 5，FR-IO-004 一期 XMind 部分）：导出菜单 → 下载 .xmind →
// xmind-io 直接解析断言层级/文本/备注 → 下载产物回灌工作台导入，新文件出现且渲染一致。
test('导出 XMind 并往返导入：层级/文本/备注一致', async ({ page }) => {
  page.on('console', (m) => {
    if (m.text().includes('[probe:loadFiles]')) console.log('[page]', m.text());
  });
  await openSeedDocWithNote(page);
  // 工具栏「导出」按钮点开下拉（Task 9 前仅 XMind 一项），点击触发下载
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-xmind').click(),
  ]);
  // 下载名 = 编辑器标题（header 与 getMeta(doc).title 同源）+ .xmind
  expect(download.suggestedFilename()).toBe('本周计划.xmind');
  const path = await download.path();
  const bytes = new Uint8Array(await fs.promises.readFile(path));
  // 导出产物直接用 @gmind/xmind-io 断言结构（root=本周计划、层级完整、周一持备注）
  const parsed = parseXmind(bytes);
  expect(parsed.sheets).toHaveLength(1); // 单画布文档导出单 Sheet（裁定 8：多画布才多 Sheet）
  expect(parsed.sheets[0].title).toBe('画布 1'); // Sheet 标题 = 画布名（裁定 8：导出全画布多 Sheet）
  const firstRoot = parsed.sheets[0].root;
  expect(firstRoot.title).toBe('本周计划');
  expect(firstRoot.children.map((c) => c.title)).toEqual(['周一', '周三', '周五']);
  const monday = findTitle(firstRoot, '周一');
  expect(monday?.note).toBe('评审要点');
  expect(monday?.children.map((c) => c.title)).toEqual(['周会对齐']);
  expect(parsed.degraded).toEqual([]);

  // 往返：下载产物 setInputFiles 回灌导入 → 新文件出现（4 行 = 3 种子 + 导入件，
  // 新件 updated_at 最新置顶）
  await page.goto('/workspace'); // 导入入口=首页「导入文件」卡
  await page.getByTestId('quick-create-import').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '本周计划.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(bytes),
  });
  // SPA 切「我的文件」（导入完成后 importXmind 亦切到此视图）；网格 = 3 种子 + 导入件，
  // 15s 窗口覆盖「导入 POST 落库 + 视图装载」的端到端时序
  await page.getByTestId('nav-files').click();
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(4, { timeout: 15_000 });
  await page.getByTestId('mine-grid').getByTestId('file-card').first().click();
  await expect(page).toHaveURL(/\/edit\//);
  // 导入件渲染一致：层级（root/周一/周会对齐）与备注角标（恰 1 个）
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-note-badge')).toHaveCount(1);
});

// ─────────────── M4 Task 9：图片导出（FR-IO-003；2026-11-15 PNG 透明档退役，统一 JPG 白底） ───────────────

/** JPEG SOF0/2 段扫描取宽高（基准 PNG IHDR 断言的 JPEG 等价物：JPG 尺寸信息在
 *  SOF 标记段，位置不定——逐 marker 跳段直到 C0/C2）。 */
function jpegSize(bytes: Buffer): { w: number; h: number } {
  for (let i = 2; i < bytes.length - 9;) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xc0 || marker === 0xc2) return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  throw new Error('JPEG 无 SOF 段');
}

// 用例 4：无折叠直接导出 JPG 3x——下载产物为合法 JPEG 且 SOF 尺寸可被 3 整除
// （1x 布局包围盒取整 ×3，binding 意图「3x 输出为 1x 布局的三倍」）。
test('导出 JPG 3x：下载产物 JPEG 尺寸可被 3 整除；无折叠不弹确认', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  let dialogCount = 0;
  page.on('dialog', () => {
    dialogCount += 1;
  });
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickSharedJpg(page, 3),
  ]);
  expect(dialogCount).toBe(0); // 无折叠：直接导出，不弹 confirm
  expect(download.suggestedFilename()).toBe('本周计划.jpg');
  const jpg = await fs.promises.readFile(await download.path());
  expect(jpg.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG 魔数（SOI）
  const { w, h } = jpegSize(jpg);
  expect(w).toBeGreaterThan(0);
  expect(w % 3).toBe(0);
  expect(h % 3).toBe(0);
});

// 用例 5（2026-11-15 导出返工批裁定：按当前折叠状态导出、不自动展开、无确认框）：
// 折叠态下点导出不再弹「检测到 N 处折叠」确认框，直接出图；导出只作用于快照克隆
// ——画布折叠态不变（徽标仍在、孙节点仍隐藏）。图内折叠节点出「+N」徽标、交互
// 折叠钮剥离（stripCollapseToggles，语义由 image-export 单测钉住——JPEG 像素层
// 无法在 e2e 断言）。
test('折叠态导出：不弹确认框直接导出（画布折叠态不变）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 折叠 root（默认选中）：Ctrl+/（同 editor.e2e.spec.ts 用例 6 的操作路径）
  await page.keyboard.press('Control+/');
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(1);
  let dialogCount = 0;
  page.on('dialog', () => {
    dialogCount += 1;
  });
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickSharedJpg(page, 1),
  ]);
  expect(dialogCount).toBe(0); // 折叠态也直接导出：确认框已删
  expect(download.suggestedFilename()).toBe('本周计划.jpg');
  const jpg = await fs.promises.readFile(await download.path());
  expect(jpg.length).toBeGreaterThan(0);
  expect(jpg.subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG 魔数（SOI）
  // 折叠态不变：徽标仍在、孙节点仍隐藏（仅导出快照不改画布）
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toHaveCount(0);
});

// 用例 6：JPG 导出冒烟（终审修复补覆盖——FR-IO-003 JPG 链路此前零自动化）：
// 无图片节点种子文档 → export-menu → export-jpg-1x → 下载产物为 JPEG（FF D8 FF
// 魔数：SOI + 下一段标记高字节）且非空、命名 .jpg。
test('导出 JPG 1x：下载产物为 JPEG 魔数（FF D8 FF）且 .jpg 命名', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    clickSharedJpg(page, 1),
  ]);
  expect(download.suggestedFilename()).toBe('本周计划.jpg');
  const jpg = await fs.promises.readFile(await download.path());
  expect(jpg.length).toBeGreaterThan(0);
  expect(jpg.subarray(0, 3).toString('hex')).toBe('ffd8ff');
});

// ─────────── 2026-11-14 导入保真 Task 6：合成夹具（helpers/xmind-fixture） ───────────

/** 画布节点组（task-panel-markers.e2e.spec.ts 同款锚点：g[data-node-id] 平级不嵌套）。 */
function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

/** 画布标记徽章（按值定位，data-marker-value 与任务面板 chip 同名契约）。 */
function markerBadge(page: Page, text: string, value: string) {
  return nodeGroup(page, text).locator(`.gm-markers .gm-marker-badge[data-marker-value="${value}"]`);
}

/** 经工作台导入入口导入 buffer 并等 toast 出现（恒弹，裁定 3）。 */
async function importFromWorkspace(page: Page, name: string, buffer: Buffer, toast: string): Promise<void> {
  await page.goto('/workspace'); // 导入入口=首页「导入文件」卡
  await page.getByTestId('quick-create-import').click();
  await page.getByTestId('import-input').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await expect(page.getByTestId('toast')).toHaveText(toast);
}

// 用例 7：全保真夹具（标记四族/图片/概要/超链接/样式/结构类，helpers/xmind-fixture
// 文件头注）导入 → toast 逐项点名（唯一降级源=陌生标记 arrow-refresh，精确全文同时
// 证明两段式图片导入零额外降级）→ 画布落位逐项断言。
test('导入合成夹具：标记/图片/概要/超链接/样式/结构落位，toast 逐项点名', async ({ page }) => {
  await registerAndLogin(page);
  await importFromWorkspace(page, '示例.xmind', buildFixtureXmind(), '未导入：图标 1');
  // 文件卡按原文件名（2026-11-14 拍板：导入文件名=原文件名去后缀；画布中心主题仍是「根节点」）
  await page.getByTestId('file-card').filter({ hasText: '示例' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '根节点' })).toBeVisible();

  // 标记族（画布 .gm-markers + 逐值徽章；progress 族画布不渲染——2026-10-12 退役，
  // 落任务行「%」与任务面板档位，见下方两处断言）：mood.smile / arrow.up / other 组并存
  await expect(markerBadge(page, '分支一', 'smile')).toHaveCount(1);
  await expect(markerBadge(page, '分支一', 'smile').locator('title')).toHaveText('心情 微笑');
  await expect(markerBadge(page, '分支二', 'up')).toHaveCount(1);
  await expect(markerBadge(page, '分支二', 'up').locator('title')).toHaveText('箭头 向上');
  await expect(markerBadge(page, '分支二', 'like')).toHaveCount(1);
  await expect(markerBadge(page, '分支二', 'person')).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-marker-badge')).toHaveCount(4); // 恰四枚（陌生标记不落画布）

  // 进度落位（task-done→100%、task-half→50%：setIcon 联动任务行有效进度右栏）
  await expect(nodeGroup(page, '分支一').locator('text.gm-task-progress')).toHaveText('100%');
  await expect(nodeGroup(page, '待办二').locator('text.gm-task-progress')).toHaveText('50%');

  // 图片：4×4 PNG 经两段式上传回挂（.gm-image + placement 属性，image-placement 同款锚点）
  const image = nodeGroup(page, '待办一').locator('image.gm-image');
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('data-image-placement', 'bottom');

  // 超链接角标 + 概要（标签文本随两段式引用进画布）
  await expect(nodeGroup(page, '待办一').locator('.gm-link-badge')).toBeVisible();
  await expect(page.locator('.editor-canvas svg [data-summary-id]')).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-summary-label')).toHaveText('示例概要');

  // 样式抽查：svg:fill 落节点主 rect（entry 首个子 rect，render.ts applyNode）
  await expect(nodeGroup(page, '待办二').locator('rect').first()).toHaveAttribute('fill', '#e8f0fe');

  // 结构类：根 structureClass=logic.right → 画布结构面板 logic 卡片高亮（editor 用例 5b 同款）
  await page.getByTestId('structure-toggle').click();
  await expect(page.getByTestId('structure-item-logic')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape'); // Esc 关闭，不留浮层

  // 进度档位目录 label（任务面板 chip：marker-progress-done 高亮 + aria-label「进度 完成」）
  await page.locator('.editor-canvas svg .gm-text', { hasText: '分支一' }).click();
  await page.getByTestId('task-toggle').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('marker-progress-done')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('marker-progress-done')).toHaveAttribute('aria-label', '进度 完成');
  await panel.getByTestId('task-panel-close').click();
});

// 用例 8：纯净水树（buildXmind 直出，零降级源）→ 恒弹 toast「已完整导入」（裁定 3）。
// 分侧忠实还原 Task 4 起夹具带根扩展 right-number=1（helpers/xmind-fixture sheet 参数），
// 补往返无损断言：导入按存储值定侧 → 打开 → 导出 → content.json 根扩展 right-number
// 与夹具值逐字一致（导出计数镜像引擎渲染=持久 side 1 个，往返不改写用户内容）。
test('导入纯净水树：toast「已完整导入」、新文件出现且 right-number 往返无损', async ({ page }) => {
  await registerAndLogin(page);
  await importFromWorkspace(page, '示例树.xmind', buildCleanXmind(), '已完整导入');
  await expect(page.getByTestId('file-card').filter({ hasText: '示例树' }).first()).toBeVisible();
  // 往返：打开导入件 → 导出菜单下载 → 解包断言根扩展与夹具值（right-number='1'）一致
  await page.getByTestId('file-card').filter({ hasText: '示例树' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '示例树' })).toBeVisible();
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-xmind').click(),
  ]);
  expect(download.suggestedFilename()).toBe('示例树.xmind'); // 文件名=编辑器标题（=原文件名去后缀）
  const bytes = new Uint8Array(await fs.promises.readFile(await download.path()));
  const entries = unzipEntries(bytes);
  const content = JSON.parse(new TextDecoder().decode(entries['content.json']!)) as Array<{
    rootTopic: { extensions?: Array<{ provider: string; content: Array<{ name: string; content: string }> }> };
  }>;
  // 金样逐字形状（build rightNumberExtensions 同款）：provider=map.unbalanced + right-number='1'
  expect(content[0]!.rootTopic.extensions).toEqual([
    { provider: 'org.xmind.ui.map.unbalanced', content: [{ name: 'right-number', content: '1' }] },
  ]);
});

// 用例 9：导出往返（spec §3.2 roundtrip 口径）——夹具导入产物经导出菜单下载，node 端
// parseXmind 断言 marker 集合 Gmind 值级稳定（导入的 icons == 导出再解析的 icons）；
// 陌生标记 arrow-refresh 导入即弃，往返不复活；href/style 随导出写回（spec §六）。
test('往返：夹具导入→导出→parse，marker 集合 Gmind 值级稳定', async ({ page }) => {
  await registerAndLogin(page);
  await importFromWorkspace(page, '示例.xmind', buildFixtureXmind(), '未导入：图标 1');
  // 文件卡按原文件名（2026-11-14 拍板：导入文件名=原文件名去后缀；画布中心主题仍是「根节点」）
  await page.getByTestId('file-card').filter({ hasText: '示例' }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '根节点' })).toBeVisible();
  await openShareExportTab(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('share-export-xmind').click(),
  ]);
  expect(download.suggestedFilename()).toBe('示例.xmind'); // 导出文件名=编辑器标题（2026-11-14 拍板：导入文件名=原文件名）
  const bytes = new Uint8Array(await fs.promises.readFile(await download.path()));
  const parsed = parseXmind(bytes);
  expect(parsed.degraded).toEqual([]);
  expect(parsed.sheets).toHaveLength(1);
  const root = parsed.sheets[0].root;
  expect(root.title).toBe('根节点');
  expect(root.children.map((c) => c.title)).toEqual(['分支一', '分支二']);
  // 值级稳定（marker-id 层对实测 id 恒同形）：progress/mood/arrow/other 四组逐一比对
  const branchA = findTitle(root, '分支一');
  expect(branchA?.icons).toEqual({ progress: ['done'], mood: ['smile'] });
  const branchB = findTitle(root, '分支二');
  expect(branchB?.icons).toEqual({ arrow: ['up'], other: ['like', 'person'] });
  expect(findTitle(root, '待办二')?.icons).toEqual({ progress: ['p50'] });
  expect(findTitle(root, '待办一')?.icons).toBeUndefined();
  expect(findTitle(root, '待办三')?.icons).toBeUndefined(); // arrow-refresh 不复活
  // 导出写回 v2（spec §六）：href 原值、style 四键逆映射（fontSize 产 "14px"）
  expect(findTitle(root, '待办一')?.href).toBe('https://example.com/gmind-e2e');
  expect(findTitle(root, '待办二')?.style).toEqual({ fill: '#e8f0fe', color: '#1a73e8', fontSize: '14' });
});
