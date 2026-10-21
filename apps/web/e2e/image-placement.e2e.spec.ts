// 平台修正（2026-10-21）：macOS 原生 paste 走 Cmd+V，Windows/Linux 走 Ctrl+V——
// 图片粘贴必须真实原生 paste 事件（应用内键盘通道只读文本/内部 payload），按平台选键。
const PASTE_KEY = process.platform === 'darwin' ? 'Meta+V' : 'Control+V';

import { expect, test, type Locator, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 节点图文四槽位 E2E（2026-10-20 需求方裁定）：
 * - 默认文字在上、图片在下（bottom）；
 * - 鼠标悬停图片显示四向 move 光标，按住图片本体拖到同一节点上/下/左/右四槽位；
 * - 可拖到其他节点（目标已有图直接替换），一次拖拽 = 一步撤销；
 * - 图片独立右键「复制 / 剪切」，粘回画布沿用原 key（不重复上传）。
 */

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pixel.png');

test.beforeEach(async ({ context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

// 测试进程共享 OS 剪贴板：用例写完图片后清成文本，避免串到后续「同文件粘贴」用例。
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => navigator.clipboard.writeText('gmind-e2e-clipboard-reset'))
    .catch(() => {});
});

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

function nodeGroup(page: Page, text: string): Locator {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

async function selectNode(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

/** 面板上传夹具图片到指定节点，返回图片元素定位器。 */
async function uploadFixtureImage(page: Page, text: string): Promise<Locator> {
  await selectNode(page, text);
  await page.getByTestId('format-toggle').click();
  const panel = page.getByTestId('rich-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('image-input').setInputFiles(FIXTURE_PNG);
  const image = nodeGroup(page, text).locator('image.gm-image');
  await expect(image).toBeVisible();
  return image;
}

/** 悬停图片 → 四向 move 光标；按住图片本体拖到屏幕坐标 (x,y) 后松手。 */
async function dragImage(page: Page, image: Locator, x: number, y: number): Promise<void> {
  await image.hover();
  await expect(image).toHaveCSS('cursor', 'move');
  const box = await image.boundingBox();
  if (!box) throw new Error('图片不可见');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  // 引导必须真的画出来（2026-10-20 走查：小节点上细带几乎不可见 → 外框 + 加粗）
  await expect(page.getByTestId('image-drop-outline')).toBeVisible();
  await expect(page.getByTestId('image-drop-guides')).toBeVisible();
  await expect(page.locator('[data-testid^="image-drop-band-"]')).toHaveCount(4);
  await expect(page.locator('.gm-image-drop-band.is-active')).toHaveCount(1);
  // 图片本体起拖必须只走页面层换位，不能再触发 engine 的节点拖动芯片。
  await expect(page.locator('.gm-drag-ghost')).toHaveCount(0);
  await page.mouse.up();
}

/** 目标节点的槽位落点（屏幕坐标）：top/bottom 取水平中线，left/right 取垂直中线。 */
async function slotPoint(
  page: Page,
  text: string,
  slot: 'top' | 'bottom' | 'left' | 'right',
): Promise<{ x: number; y: number }> {
  const box = await nodeGroup(page, text).boundingBox();
  if (!box) throw new Error(`节点不可见：${text}`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  if (slot === 'top') return { x: cx, y: box.y + 4 };
  if (slot === 'bottom') return { x: cx, y: box.y + box.height - 4 };
  if (slot === 'left') return { x: box.x + 4, y: cy };
  return { x: box.x + box.width - 4, y: cy };
}

test('图文四槽位：默认 bottom；悬停图片显示 move 光标，拖图片本体到 top 并持久化', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周一');

  // 默认：文字在上、图片在下（image y > 0，placement=bottom）
  await expect(image).toHaveAttribute('data-image-placement', 'bottom');
  expect(Number(await image.getAttribute('y'))).toBeGreaterThan(0);

  // 图片本体起拖不牺牲单击：先选别的节点，单击图片仍回到本节点（≤4px 走 click）
  await selectNode(page, '周三');
  await image.click();
  await expect(nodeGroup(page, '周一')).toHaveClass(/gm-selected/);

  const top = await slotPoint(page, '周一', 'top');
  await dragImage(page, image, top.x, top.y);

  await expect(image).toHaveAttribute('data-image-placement', 'top');
  // top：图片回到盒内 y=0（文字被推到图片下方）
  await expect.poll(async () => Number(await image.getAttribute('y'))).toBe(0);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);

  await page.reload();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  const reloaded = nodeGroup(page, '周一').locator('image.gm-image');
  await expect(reloaded).toHaveAttribute('data-image-placement', 'top');
});

test('图文四槽位：跨节点拖图直接替换目标图，一次拖拽 = 一步撤销', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周一');
  const href = await image.getAttribute('href');
  // 让「上传写」越过 captureTimeout(500ms)，拖拽自成一撤销单元
  await page.waitForTimeout(700);

  const left = await slotPoint(page, '周三', 'left');
  await dragImage(page, image, left.x, left.y);

  // 源图清空、目标接手同一 key、目标槽位 = left
  await expect(nodeGroup(page, '周一').locator('image.gm-image')).toHaveCount(0);
  const moved = nodeGroup(page, '周三').locator('image.gm-image');
  await expect(moved).toBeVisible();
  await expect(moved).toHaveAttribute('href', href ?? '');
  await expect(moved).toHaveAttribute('data-image-placement', 'left');

  // 单事务：一次 Ctrl+Z 同时还原两端
  await page.keyboard.press('Control+Z');
  await expect(nodeGroup(page, '周一').locator('image.gm-image')).toHaveAttribute(
    'href',
    href ?? '',
  );
  await expect(nodeGroup(page, '周三').locator('image.gm-image')).toHaveCount(0);
});

test('图片右键：复制/剪切菜单；粘回画布沿用原 key（不重复上传）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const image = await uploadFixtureImage(page, '周一');
  const href = await image.getAttribute('href');

  // 复制图片：菜单只含图片动作
  await image.click({ button: 'right' });
  await expect(page.getByTestId('context-menu')).toBeVisible();
  await expect(page.getByTestId('menu-image-copy')).toBeVisible();
  await expect(page.getByTestId('menu-image-cut')).toBeVisible();
  await page.getByTestId('menu-image-copy').click();
  await expect(page.getByTestId('toast')).toHaveText(/已复制图片/);
  // 系统剪贴板确实含 PNG（外部应用可直接粘贴）
  const clipTypes = await page.evaluate(async () =>
    (await navigator.clipboard.read()).flatMap((item) => item.types),
  );
  expect(clipTypes).toContain('image/png');

  // 选中另一节点 Ctrl+V：沿用原 key（若走了原生上传链路，href 会变成新 key）
  await selectNode(page, '周三');
  await page.keyboard.press(PASTE_KEY);
  const pasted = nodeGroup(page, '周三').locator('image.gm-image');
  await expect(pasted).toHaveAttribute('href', href ?? '');

  // 剪切图片：节点图清空；再粘到第三个节点仍复用同一 key
  await image.click({ button: 'right' });
  await page.getByTestId('menu-image-cut').click();
  await expect(nodeGroup(page, '周一').locator('image.gm-image')).toHaveCount(0);
  await selectNode(page, '周五');
  await page.keyboard.press(PASTE_KEY);
  await expect(nodeGroup(page, '周五').locator('image.gm-image')).toHaveAttribute(
    'href',
    href ?? '',
  );
});
