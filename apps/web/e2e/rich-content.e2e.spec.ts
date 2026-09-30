import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 富内容面板（备注/链接/图片/图标）+ 右键菜单 E2E — M1b Task 12（FR-EDT-018~021）。
 *
 * 复用 Task 11 登录模式（新手机号注册即赠 3 个种子文件）；各用例独立注册、互不共享
 * 状态、可并行。图片布局钉死（T6 carry-in 裁决）：夹具 pixel.png 为 16×64（高大于
 * 任何文本行高），断言 image 元素 y+h ≤ 节点 rect y+h —— 修复前盒高只含文本（≈20px）
 * 必失败。
 */

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pixel.png');

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
}

/** 打开种子文件进入编辑器，等待 root 文本渲染。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** 选中指定文本的节点（点击其文本），返回该节点的 <g data-node-id> 定位器。 */
async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

/** 打开工具栏「格式」右列样式/富内容面板（M7b-R6：右列默认不渲染，点格式开）。 */
async function openFormatPanel(page: Page) {
  await page.getByTestId('format-toggle').click();
  const panel = page.getByTestId('rich-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** 打开工具栏「插入」→「图标」标记面板（2026-09-28 图标区迁出 RichPanel 后的
 *  标记写入路径；「标记」项更名「图标」，表情独立为 insert-emoji），返回标记面板。 */
async function openMarkerPanel(page: Page) {
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-icons').click();
  const panel = page.getByTestId('marker-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** 节点标记徽标（M7b-W1 起渲染层为 .gm-markers 容器 + 逐值 .gm-marker-badge）。 */
function markerBadges(page: Page, text: string) {
  return nodeGroup(page, text).locator('.gm-markers .gm-marker-badge');
}

function markerBadgeByValue(page: Page, text: string, value: string) {
  return nodeGroup(page, text).locator(`.gm-markers .gm-marker-badge[data-marker-value="${value}"]`);
}

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

// 用例 1：面板写备注保存 → 画布备注角标出现（含 <title> 悬停预览）→ 刷新仍在（持久化）
test('富内容：面板写备注保存后角标出现且刷新仍在', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openFormatPanel(page); // 右列默认隐藏：点格式开
  await panel.getByLabel('节点备注').fill('评审要点');
  await panel.getByRole('button', { name: '保存备注' }).click();
  const g = nodeGroup(page, '周一');
  await expect(g.locator('.gm-note-badge')).toBeVisible();
  // 悬停预览为 SVG <title> 子元素（SVG 标准原生 tooltip；HTML title 属性在
  // SVG 元素上多数浏览器不渲染提示）
  await expect(g.locator('.gm-note-badge > title')).toHaveText(/评审要点/);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(nodeGroup(page, '周一').locator('.gm-note-badge')).toBeVisible();
  await expect(nodeGroup(page, '周一').locator('.gm-note-badge > title')).toHaveText(/评审要点/);
});

// 用例 2：设 https 链接角标出现；javascript: 被拒——toast 文案出现且角标不新增
test('富内容：https 链接显示角标，javascript: 提示错误且不写入', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周三');
  const panel = await openFormatPanel(page); // 右列默认隐藏：点格式开
  await panel.getByLabel('节点链接').fill('https://example.com');
  await panel.getByRole('button', { name: '保存链接' }).click();
  const g = nodeGroup(page, '周三');
  await expect(g.locator('.gm-link-badge')).toBeVisible();
  await panel.getByLabel('节点链接').fill('javascript:alert(1)');
  await panel.getByRole('button', { name: '保存链接' }).click();
  await expect(page.getByTestId('toast')).toContainText('链接仅支持 http/https');
  // 拒绝即零变更：仍是原链接的 1 个角标（未清除也未新增）
  await expect(g.locator('.gm-link-badge')).toHaveCount(1);
  await expect(g.locator('.gm-link-badge')).toBeVisible();
});

// 用例 2b（FR-EDT-019）：点击链接角标 → 新标签页打开，且不触发选中切换
// （链接指向本机 web 端点：headless 无外网依赖；另一节点保持选中钉住「只打开不选中」）
test('富内容：点击链接角标新标签页打开且不改变选中', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周三');
  const panel = await openFormatPanel(page); // 右列默认隐藏：点格式开
  const origin = new URL(page.url()).origin;
  await panel.getByLabel('节点链接').fill(`${origin}/login`);
  await panel.getByRole('button', { name: '保存链接' }).click();
  const badge = nodeGroup(page, '周三').locator('.gm-link-badge');
  await expect(badge).toBeVisible();
  // 选中他人（画布点击按外点语义收面板，链接角标点击不再需要面板）
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周五' }).click();
  await expect(nodeGroup(page, '周五')).toHaveClass(/gm-selected/);
  const [popup] = await Promise.all([page.waitForEvent('popup'), badge.click()]);
  expect(popup.url()).toBe(`${origin}/login`);
  // 角标点击只负责打开：周五的选中态不被抢占
  await expect(nodeGroup(page, '周五')).toHaveClass(/gm-selected/);
  await popup.close();
});

// 用例 3：上传 16×64 png → 节点 .gm-image 渲染且盒高计入图高；移除后消失
test('富内容：上传图片渲染且盒高计入图片，移除后消失', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周五');
  const panel = await openFormatPanel(page); // 右列默认隐藏：点格式开
  await panel.getByTestId('image-input').setInputFiles(FIXTURE_PNG);
  const g = nodeGroup(page, '周五');
  const image = g.locator('image.gm-image');
  await expect(image).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 布局钉死（T6 carry-in 裁决）：image y+h ≤ 节点 rect y+h（场景坐标属性直读，
  // 与视口无关）。夹具高 64 > 文本行高（14×1.4≈19.6），盒高未计入图高则必失败。
  const geo = await g.evaluate((el) => {
    const rect = el.querySelector('rect');
    const image = el.querySelector('image.gm-image');
    return {
      rectY: Number(rect?.getAttribute('y') ?? 0),
      rectH: Number(rect?.getAttribute('height') ?? 0),
      imgY: Number(image?.getAttribute('y') ?? 0),
      imgH: Number(image?.getAttribute('height') ?? 0),
    };
  });
  expect(geo.imgH).toBe(64); // 宽 16 ≤ 200：等比钳制不缩放
  expect(geo.imgY + geo.imgH).toBeLessThanOrEqual(geo.rectY + geo.rectH);
  expect(geo.rectH).toBeGreaterThanOrEqual(64);
  // 移除图片 → 元素消失
  await panel.getByTitle('移除图片').click();
  await expect(g.locator('image.gm-image')).toHaveCount(0);
});

// 用例 4：加旗帜 → ⚑；再加优先级 → 并存；换旗帜字形 → 仍一个旗帜徽标（组内替换）。
// 标记写入路径在插入菜单「图标」面板（M7b-W1 目录：旗帜组 = flag/flagRect/flagPennant，
// 优先级 p0-p4/急/高/中/低）；渲染层 .gm-markers 徽标按组序展开（priority 在 flag 前）。
test('富内容：图标组并存与组内替换', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openMarkerPanel(page);
  await panel.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1); // ⚑ 波浪旗
  await panel.getByTestId('marker-priority-p1').click();
  await expect(markerBadges(page, '周一')).toHaveCount(2); // 异组并存
  // 组内替换：换旗帜字形（flagRect 方旗）→ 旗帜仍恰一枚、优先级不动
  await panel.getByTestId('marker-flag-flagRect').click();
  await expect(markerBadgeByValue(page, '周一', 'flagRect')).toHaveCount(1);
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(0);
  await expect(markerBadgeByValue(page, '周一', 'p1')).toHaveCount(1);
  // 组内替换钉死：选中态由波浪旗迁到方旗
  await expect(panel.getByTestId('marker-flag-flagRect')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('marker-flag-flag')).toHaveAttribute('aria-pressed', 'false');
});

// 用例 5：右键菜单插入子级可用（惰性：插入即落位「新主题」，敲字才进编辑框）
test('富内容：右键菜单插入子级可用', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周五');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周五' }).click({ button: 'right' });
  const menu = page.getByTestId('context-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: '插入子级' }).click();
  const editor = page.locator('.gm-text-editor');
  // 落位渲染先行 + 惰性锁定；补开首键纪律见 editor.e2e pressFirstCharToOpen
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  await expect(editor).toHaveCount(0);
  for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
    await page.keyboard.press('x');
    await page.waitForTimeout(25);
  }
  await expect(editor).toBeVisible();
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('右键子节点');
  await page.keyboard.press('Enter');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '右键子节点' })).toBeVisible();
});

// 用例 6（FR-EDT-020）：编辑态画布粘贴截图（剪贴板图片文件）→ 上传并直插选中节点。
// 真实 Chromium 支持 new DataTransfer() + items.add(File) 组装 ClipboardEvent。
test('富内容：画布粘贴截图直插选中节点', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周五');
  const pngB64 = readFileSync(FIXTURE_PNG).toString('base64');
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const d = new DataTransfer();
    d.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    document.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }),
    );
  }, pngB64);
  const image = nodeGroup(page, '周五').locator('image.gm-image');
  await expect(image).toBeVisible(); // 上传 + setImage + 重渲染（断言自动重试）
  expect(await image.getAttribute('href')).toContain('/api/images/files/');
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
});

// 用例 7（测试债清偿 M2 Task 9）：链接 + 图片 + 图标三者齐设 → 刷新后全部仍在
// （三者走三条写路径 setHref/setImage/setIcon，组合持久化此前只有备注单品类覆盖）
test('富内容：链接/图片/图标齐设后刷新全部仍在', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周五');
  const panel = await openFormatPanel(page); // 右列默认隐藏：点格式开
  const g = nodeGroup(page, '周五');
  await panel.getByLabel('节点链接').fill('https://example.com/gmind');
  await panel.getByRole('button', { name: '保存链接' }).click();
  await expect(g.locator('.gm-link-badge')).toBeVisible();
  await panel.getByTestId('image-input').setInputFiles(FIXTURE_PNG);
  await expect(g.locator('image.gm-image')).toBeVisible();
  const markers = await openMarkerPanel(page); // 插入菜单「图标」面板（点击收格式右列）
  await markers.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周五', 'flag')).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 刷新（重连协同 + 从 doc_state 恢复）：三个角标全部仍在
  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  const gAfter = nodeGroup(page, '周五');
  await expect(gAfter.locator('.gm-link-badge')).toBeVisible();
  await expect(gAfter.locator('image.gm-image')).toBeVisible();
  await expect(markerBadgeByValue(page, '周五', 'flag')).toHaveCount(1);
});

// 用例 8（2026-09-30 需求方四条 UI 反馈任务 2/4）：插入菜单第六项「简介」= 开格式
// 右列并聚焦备注输入框（openRichAndFocus 模式）；面板内「简介（备注）」「描述」
// 两区块小节标题/输入框齐备；头部 × 关闭钮（rich-panel-close）收起右列。
test('富内容：插入菜单「简介」项聚焦备注框，面板 × 钮收起', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  await page.getByTestId('insert-menu').click();
  const noteItem = page.getByTestId('insert-note');
  await expect(noteItem).toBeVisible();
  await noteItem.click();
  // 右列格式面板随「简介」项打开，备注输入框聚焦（openRichAndFocus 一帧后聚焦）
  const panel = page.getByTestId('rich-panel');
  await expect(panel).toBeVisible();
  const noteArea = panel.getByLabel('节点备注');
  await expect(noteArea).toBeFocused();
  // 「简介（备注）」+「描述」两区块齐备（描述为 M7c-C1 字段的第二编辑入口）
  await expect(panel.getByLabel('节点描述')).toBeVisible();
  // 头部 × 关闭钮：收起右列（formatOpen=false，右列整列不渲染）
  await panel.getByTestId('rich-panel-close').click();
  await expect(panel).toHaveCount(0);
});
