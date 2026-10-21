// 平台修正（2026-10-21）：macOS 原生 paste 走 Cmd+V，Windows/Linux 走 Ctrl+V——
// 图片粘贴必须真实原生 paste 事件（应用内键盘通道只读文本/内部 payload），按平台选键。
const PASTE_KEY = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 节点图片交互 E2E —— 粘贴（真键盘）/ 缩放 / 预览大图。
 *
 * 与 rich-content.e2e.spec.ts 的差异（本轮修复的针对性）：那条用例用
 * `new ClipboardEvent('paste', …)` 直接 document.dispatchEvent —— 绕过了
 * keydown 层，因此「keydown 对 Ctrl+V 调 preventDefault 会把原生 paste 事件
 * 掐掉」这个真实缺陷在它那里永远看不见。本文件一律走**真实键盘 + 真实系统剪贴板**
 * （navigator.clipboard.write 写真图 + page.keyboard.press(PASTE_KEY)）。
 */

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pixel.png');

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3);
}

async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

/** 节点 `<g>` 在引擎节点层里的序（结构位置代理：重排顺序变了 = 被拖动换位）。 */
function nodeIndex(page: Page, text: string): Promise<number> {
  return page.evaluate((t) => {
    const nodes = [...document.querySelectorAll('.editor-canvas svg .gm-nodes > g[data-node-id]')];
    return nodes.findIndex((el) => el.textContent?.includes(t));
  }, text);
}

/** 把夹具 PNG 写进真实系统剪贴板（模拟截图后复制）。 */
async function copyFixtureImage(page: Page): Promise<void> {
  const b64 = readFileSync(FIXTURE_PNG).toString('base64');
  await page.evaluate(async (b) => {
    const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, b64);
}

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

// 测试进程共享 OS 剪贴板：用例写完图片后清成文本，避免串到后续「同文件粘贴」用例。
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => navigator.clipboard.writeText('gmind-e2e-clipboard-reset'))
    .catch(() => {});
});

// 用例 1（回归，FR-EDT-020 第三种插入方式）：真实键盘 Ctrl+V 粘贴截图 → 直插选中节点。
// 缺陷史：attachKeyboardMap 对每个绑定动作无条件 e.preventDefault()（含 paste），
// 浏览器因此不再派发原生 paste 事件，"document paste 监听"这条唯一图片入口永不触发；
// 键盘路径的 handlePaste 只读文本 MIME，图片剪贴板读不到文本 → 静默无操作。
test('图片：真实键盘 Ctrl+V 粘贴截图直插选中节点', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周五');
  await copyFixtureImage(page);

  await page.keyboard.press(PASTE_KEY);

  const image = nodeGroup(page, '周五').locator('image.gm-image');
  await expect(image).toBeVisible(); // 上传 + setImage + 重渲染（断言自动重试）
  expect(await image.getAttribute('href')).toContain('/api/images/files/');
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
});

// —— 以下为 2026-10-15 需求方「拖拽图片周边改尺寸 + 双击预览大图」 ——

/** 面板上传夹具图片到当前选中节点，返回该节点的图片元素定位器。 */
async function uploadFixtureImage(page: Page, text: string) {
  await selectNodeByText(page, text);
  await page.getByTestId('format-toggle').click();
  const panel = page.getByTestId('rich-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('image-input').setInputFiles(FIXTURE_PNG);
  const image = nodeGroup(page, text).locator('image.gm-image');
  await expect(image).toBeVisible();
  return image;
}

function imageSize(image: Locator): Promise<{ w: number; h: number }> {
  return image.evaluate((el) => ({
    w: Number(el.getAttribute('width')),
    h: Number(el.getAttribute('height')),
  }));
}

/** 拖四角手柄：从手柄中心按下，按 (dx,dy) 屏幕像素拖动后松手。 */
async function dragHandle(page: Page, corner: string, dx: number, dy: number): Promise<void> {
  const handle = page.locator(`.gm-image-resize-handle[data-corner="${corner}"]`);
  await expect(handle).toHaveCount(1);
  const box = await handle.boundingBox();
  if (!box) throw new Error('手柄不可见');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy + dy, { steps: 8 });
  await page.mouse.up();
}

test('图片缩放：单选有图出 4 个角手柄，多选/只读不出', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  await expect(image).toBeVisible();

  const handles = page.locator('.gm-image-resize-handle');
  await expect(handles).toHaveCount(4);
  await expect(page.locator('.gm-image-resize-handle[data-corner="se"]')).toHaveCount(1);

  // 多选（Ctrl+点击另一节点）→ 手柄收起（单选才有明确缩放对象）
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click({
    modifiers: ['Control'],
  });
  await expect(handles).toHaveCount(0);

  // 回到单选 → 手柄回来。点图不点文字：引擎现版把图片画在 x=nodePaddingX、y=0，
  // 与同样起于 nodePaddingX 的标题垂直居中重叠（render.ts:22 头注「图与文本的节点内
  // 堆叠视觉仍后置」），文字中心会被 <image> 挡住点不到。
  await image.click();
  await expect(handles).toHaveCount(4);
});

test('图片缩放：拖右下角等比放大且长边钳到 200px，刷新后仍在', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  expect(await imageSize(image)).toEqual({ w: 16, h: 64 }); // 夹具原始尺寸

  await dragHandle(page, 'se', 200, 200); // 远超上限的拖动

  // 等比锁定：16:64 = 1:4 → 长边钳 200 → 50×200（FR-EDT-020 上限不突破）
  await expect
    .poll(async () => imageSize(image))
    .toEqual({ w: 50, h: 200 });
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);

  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  expect(await imageSize(nodeGroup(page, '周五').locator('image.gm-image'))).toEqual({
    w: 50,
    h: 200,
  });
});

test('图片缩放：一次拖拽 = 一步撤销（Ctrl+Z 回到原尺寸）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  // 越过 captureTimeout(500ms)：让拖拽自成一撤销单元。否则「上传写」与紧随的拖拽写
  // 会被 Y.UndoManager 合并成**同一**撤销单元（undo.ts 既有语义：500ms 内连续用户写
  // 合并），一次 Ctrl+Z 会把图片一并撤掉——那不是本用例要验的东西，探针实测确认。
  await page.waitForTimeout(700);

  await dragHandle(page, 'se', 16, 64); // 位移×2 灵敏度 → 等效 (32,128) → 3 倍：48×192
  await expect.poll(async () => imageSize(image)).toEqual({ w: 48, h: 192 });

  await page.keyboard.press('Control+Z');
  // 一次拖拽（帧内多次 setImage）必须只退一步；图片仍在（若撤到上传前，元素会消失
  // → 本断言失败，正是我们要挡的回归）。
  await expect.poll(async () => imageSize(image)).toEqual({ w: 16, h: 64 });
});

test('图片缩放：拖手柄只改图片尺寸——节点不被拖走、选中不丢、不弹右键菜单', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  // 「没被 DragController 当节点拖走」的代理断言：节点在场景中的**结构位置**
  // 不变（重排顺序 index 不变；被拖到别处/root 末尾会让 index 变）。transform
  // 本身会因图片变大而随布局重算，不作为不变量。
  const indexBefore = await nodeIndex(page, '周五');
  const countBefore = await page.locator('.editor-canvas svg .gm-nodes > g[data-node-id]').count();

  await dragHandle(page, 'nw', -16, -64); // 反向角：向左上拖 = 放大（×2 → 48×192）

  await expect.poll(async () => imageSize(image)).toEqual({ w: 48, h: 192 });
  expect(await nodeIndex(page, '周五')).toBe(indexBefore);
  expect(await page.locator('.editor-canvas svg .gm-nodes > g[data-node-id]').count()).toBe(
    countBefore,
  );
  await expect(page.getByTestId('context-menu')).toHaveCount(0);
  await expect(page.locator('.gm-image-resize-handle')).toHaveCount(4); // 选中未丢
});

test('图片预览：双击图片弹大图浮层，Esc 与关闭钮均可关；预览不改数据', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  const src = await image.getAttribute('href');

  const overlay = page.getByTestId('image-preview-overlay');
  await expect(overlay).toHaveCount(0); // 默认不出

  await image.dblclick();
  await expect(overlay).toBeVisible();
  expect(await page.getByTestId('image-preview').locator('img').getAttribute('src')).toBe(src);

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);

  await image.dblclick();
  await page.getByTestId('image-preview-close').click();
  await expect(overlay).toHaveCount(0);
  expect(await imageSize(image)).toEqual({ w: 16, h: 64 }); // 预览只读，尺寸未变
});

test('图片预览：只读（移动端）下无手柄但双击仍可预览', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  await expect(page.locator('.gm-image-resize-handle')).toHaveCount(4);

  // 收到移动端视口宽度 → 只读降级（useIsMobileViewport 768px）
  await page.setViewportSize({ width: 600, height: 800 });

  await expect(page.locator('.gm-image-resize-handle')).toHaveCount(0); // 写交互禁用
  await image.dblclick(); // 读操作仍可用
  await expect(page.getByTestId('image-preview-overlay')).toBeVisible();
});

test('回归：双击非图片区域仍进节点编辑（图片让位只限图片区）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await uploadFixtureImage(page, '周五'); // 让画布里存在带图节点

  // 无图节点双击文字 → 仍进就地编辑（新分支只拦 .gm-image）
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).dblclick();
  await expect(page.locator('.gm-text-editor')).toBeVisible();
});

test('图片预览：滚轮放大/缩小预览图（25%~800%），不改节点图片尺寸', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  await image.dblclick();

  const overlay = page.getByTestId('image-preview-overlay');
  await expect(overlay).toBeVisible();
  const previewImg = page.getByTestId('image-preview').locator('img');
  const badge = page.getByTestId('image-preview-zoom');
  const zoomPct = async (): Promise<number> =>
    Number((await badge.textContent())?.replace('%', '') ?? 0);
  const scale = async (): Promise<number> =>
    previewImg.evaluate((el) => {
      const t = getComputedStyle(el).transform;
      if (!t || t === 'none') return 1;
      return Number(t.slice(t.indexOf('(') + 1, t.indexOf(',')).trim());
    });

  await expect(badge).toHaveText('100%');
  expect(await scale()).toBeCloseTo(1, 3);

  await previewImg.hover();
  await page.mouse.wheel(0, -120);
  await expect.poll(zoomPct).toBeGreaterThan(100);
  expect(await scale()).toBeGreaterThan(1);

  await page.mouse.wheel(0, -100000);
  await expect(badge).toHaveText('800%'); // 上限钳制
  await page.mouse.wheel(0, 100000);
  await expect(badge).toHaveText('25%'); // 下限钳制

  // 只改预览层 transform，不写节点图片尺寸
  expect(await imageSize(image)).toEqual({ w: 16, h: 64 });
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);

  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);
});

test('图片预览：底部灰底工具栏/下载/右键复制，点图片外关闭', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  await image.dblclick();

  const overlay = page.getByTestId('image-preview-overlay');
  await expect(overlay).toBeVisible();
  const previewImg = page.getByTestId('image-preview').locator('img');

  // 底部半透明灰底工具栏可见；关闭钮在视口右上角（不随图片缩放）
  await expect(page.getByTestId('image-preview-toolbar')).toBeVisible();
  const overlayBox = await overlay.boundingBox();
  const closeBox = await page.getByTestId('image-preview-close').boundingBox();
  expect(overlayBox && closeBox).toBeTruthy();
  if (overlayBox && closeBox) {
    expect(closeBox.x + closeBox.width).toBeGreaterThan(overlayBox.x + overlayBox.width - 60);
    expect(closeBox.y).toBeLessThan(overlayBox.y + 60);
  }

  // 下载：真实下载事件，文件名保留存储键扩展名；下载不关闭预览
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('image-preview-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.(png|jpe?g|gif|webp)$/i);
  await expect(overlay).toBeVisible();

  // 图片右键「复制图片」：系统剪贴板确实含 PNG
  await previewImg.click({ button: 'right' });
  await expect(page.getByTestId('image-preview-context-menu')).toBeVisible();
  await page.getByTestId('image-preview-copy').click();
  await expect(page.getByTestId('image-preview-copy-status')).toHaveText('已复制图片');
  const clipTypes = await page.evaluate(async () =>
    (await navigator.clipboard.read()).flatMap((item) => item.types),
  );
  expect(clipTypes).toContain('image/png');

  // 点图片外区域关闭（右上角关闭钮/底栏以外的遮罩留白）
  await overlay.click({ position: { x: 8, y: 8 } });
  await expect(overlay).toHaveCount(0);
});

// 2026-10-20 需求方走查：选中轮廓区分——点图片只描图片轮廓（整节点退回普通边框），
// 点文字仍描整节点蓝框。
test('图片选中轮廓：点图片描图片边、点文字描整节点蓝框', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周五');
  const group = nodeGroup(page, '周五');
  const nodeRect = group.locator(':scope > rect').first();

  // 先把选区移到别的节点，避免「再点开任务面板」干扰（uploadFixtureImage 已选中周五）。
  await selectNodeByText(page, '周一');

  // 点图片：节点选中 + 图片聚焦——出现图片轮廓，整节点不是选中蓝。
  await image.click();
  await expect(group).toHaveClass(/gm-selected/);
  await expect(group).toHaveClass(/gm-image-focused/);
  const outline = page.getByTestId('image-focus-outline');
  await expect(outline).toBeVisible();
  const imgBox = await image.boundingBox();
  const outBox = await outline.boundingBox();
  expect(imgBox && outBox).toBeTruthy();
  if (imgBox && outBox) {
    // 轮廓外接盒含 2.5px 描边（各边外扩一半），与图片几何盒差 ≤3px
    expect(Math.abs(outBox.x - imgBox.x)).toBeLessThan(3);
    expect(Math.abs(outBox.y - imgBox.y)).toBeLessThan(3);
    expect(Math.abs(outBox.width - imgBox.width)).toBeLessThan(3);
    expect(Math.abs(outBox.height - imgBox.height)).toBeLessThan(3);
  }
  const strokeFocused = await nodeRect.evaluate((el) => getComputedStyle(el).stroke);
  expect(strokeFocused).not.toBe('rgb(51, 112, 255)');

  // 点文字：整节点恢复选中蓝框，图片轮廓消失（同 id 再点 selectOnly 不 emit，
  // 这条路径同时守住「显式重刷类」的接线）。
  await group.locator('.gm-text').click();
  await expect(group).toHaveClass(/gm-selected/);
  await expect(group).not.toHaveClass(/gm-image-focused/);
  await expect(page.getByTestId('image-focus-outline')).toHaveCount(0);
  const strokeNode = await nodeRect.evaluate((el) => getComputedStyle(el).stroke);
  expect(strokeNode).toBe('rgb(51, 112, 255)');
});
