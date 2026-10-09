import { expect, test, type Page } from '@playwright/test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * M1 验收缺口补线 E2E — M1b Task 15（FR-EDT-008/010/015/027/028）。
 *
 * 复用 Task 11 登录模式（新手机号注册即赠 3 个种子文件）；各用例独立注册、互不共享
 * 状态、可并行：
 * - ① 框选：空白左键拖拽（M7b-W3 改道：需求方裁定「按住滑动直接框选」，原
 *   Shift+左键改无修饰左拖；平移改道空格+左拖/中键）→
 *   相交入选、空结果清空；Ctrl/Cmd+点击加/减选（FR-EDT-008）；
 * - ② 样式面板基础版：填充（含子树）/字号（仅当前节点）两态 + 撤销（FR-EDT-015）；
 * - ③ 缩放快捷档位 50%~200% 与页面级全屏按钮（FR-EDT-027/028）；
 * - ④ 跨文件粘贴图片 remap（FR-EDT-010）：复制端点产生目标文件新 key；同文件
 *   粘贴走 key 前缀短路沿用原 key（裁决：避免存储翻倍）。
 */

const FIXTURE_PNG = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pixel.png');
const RED = '#f53f3f';

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

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

/** 全部节点分组定位器。 */
function allGroups(page: Page) {
  return page.locator('.editor-canvas svg g[data-node-id]');
}

// ─────────────── ① 框选 + Ctrl/Cmd 加减选（FR-EDT-008） ───────────────

test('框选：空白左键拖拽相交节点全选，橡皮筋出现后移除（M7b-W3 无修饰左拖）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const svgBox = (await page.locator('.editor-canvas svg').boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  // 以「周一」「周五」两盒的并集定框选终点（右上角向外扩 10px，钳制进画布）；
  // 起点在画布左下角空白处 → 实际框选矩形 = 起点↔终点归一化，断言按同一矩形计算
  const a = (await nodeGroup(page, '周一').boundingBox()) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  const b = (await nodeGroup(page, '周五').boundingBox()) as typeof a;
  const end = {
    x: Math.min(svgBox.x + svgBox.width - 2, Math.max(a.x + a.width, b.x + b.width) + 10),
    y: Math.min(svgBox.y + svgBox.height - 2, Math.min(a.y, b.y) - 10),
  };

  // 起点：画布左下角（若无节点占据；否则沿底边右移扫描找空白）——空白按下才成框选
  let start = { x: svgBox.x + 5, y: svgBox.y + svgBox.height - 5 };
  const count = await allGroups(page).count();
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    boxes.push((await allGroups(page).nth(i).boundingBox()) as typeof a);
  }
  const hitsNode = (p: { x: number; y: number }): boolean =>
    boxes.some((bb) => p.x >= bb.x - 2 && p.x <= bb.x + bb.width + 2 && p.y >= bb.y - 2 && p.y <= bb.y + bb.height + 2);
  for (let dx = 0; hitsNode(start) && dx < 200; dx += 10) {
    start = { x: start.x + dx, y: start.y };
  }
  expect(hitsNode(start)).toBe(false); // 起点必须空白，否则是指针拖拽节点而非框选

  const dragRect = {
    x1: Math.min(start.x, end.x),
    y1: Math.min(start.y, end.y),
    x2: Math.max(start.x, end.x),
    y2: Math.max(start.y, end.y),
  };

  // M7b-W3：无修饰左键空白拖拽即框选（原 Shift+左拖改道；平移走空格+左拖/中键）
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  // 拖动中橡皮筋可见，抬起后移除
  await expect(page.locator('.editor-canvas svg .gm-marquee')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.editor-canvas svg .gm-marquee')).toHaveCount(0);
  // 相交（含边界）入选，框外不入选——按各盒与实际矩形的几何关系逐个断言
  const intersects = (bb: { x: number; y: number; width: number; height: number }): boolean =>
    bb.x <= dragRect.x2 && bb.x + bb.width >= dragRect.x1 && bb.y <= dragRect.y2 && bb.y + bb.height >= dragRect.y1;
  for (let i = 0; i < count; i += 1) {
    const selected = await allGroups(page).nth(i).evaluate((el) => el.classList.contains('gm-selected'));
    expect(selected, `节点 #${i}`).toBe(intersects(boxes[i] as typeof a));
  }
  // 周一/周五 必在其中；root（本周计划）在框外则必不在
  await expect(nodeGroup(page, '周一')).toHaveClass(/gm-selected/);
  await expect(nodeGroup(page, '周五')).toHaveClass(/gm-selected/);
});

test('加减选：Cmd/Ctrl+点击加选/再点减选不影响他者，Shift+点击节点忽略', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // macOS 上 Ctrl+左键被浏览器原生征用为右键（contextmenu），等价键为 Cmd；其余平台用 Ctrl
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const monday = page.locator('.editor-canvas svg .gm-text', { hasText: '周一' });
  const friday = page.locator('.editor-canvas svg .gm-text', { hasText: '周五' });

  await monday.click();
  await expect(nodeGroup(page, '周一')).toHaveClass(/gm-selected/);
  // Cmd/Ctrl+点击周五 → 加选：两个都在选区
  await friday.click({ modifiers: [mod] });
  await expect(nodeGroup(page, '周一')).toHaveClass(/gm-selected/);
  await expect(nodeGroup(page, '周五')).toHaveClass(/gm-selected/);
  // 再 Cmd/Ctrl+点击周一 → 减选：周一移除且不影响周五（FR-EDT-008 验收原文）
  await monday.click({ modifiers: [mod] });
  const mondayOff = await nodeGroup(page, '周一').evaluate((el) => el.classList.contains('gm-selected'));
  expect(mondayOff).toBe(false);
  await expect(nodeGroup(page, '周五')).toHaveClass(/gm-selected/);
  // Shift+点击节点 = 框选起点保留位：忽略，选中集不变
  const wednesday = page.locator('.editor-canvas svg .gm-text', { hasText: '周三' });
  await wednesday.click();
  await expect(nodeGroup(page, '周三')).toHaveClass(/gm-selected/);
  await wednesday.click({ modifiers: ['Shift'] });
  await expect(nodeGroup(page, '周三')).toHaveClass(/gm-selected/);
});

// ─────────────── ② 样式面板基础版（FR-EDT-015） ───────────────

test('样式：填充红作用域含子树 → 本节点与子节点 rect 同变，Ctrl+Z 恢复', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click();
  const panel = page.getByTestId('rich-panel');
  await page.getByTestId('format-toggle').click(); // 右列默认隐藏（M7b-R6）：点格式开
  await expect(panel.getByTestId('style-section')).toBeVisible();
  await expect(panel.getByTestId('style-scope-select')).toHaveValue('subtree'); // 默认含子树
  await panel.getByTitle('填充-红').click();
  await expect(nodeGroup(page, '周三').locator('rect')).toHaveAttribute('fill', RED);
  await expect(nodeGroup(page, '方案评审').locator('rect')).toHaveAttribute('fill', RED);
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 撤销：一次 Ctrl+Z 恢复整棵子树（undo → rAF 重渲染异步落地，用 expect.poll 重试
  // 断言替代即时 getAttribute——测试债清偿，与下方字号用例同口径）
  await page.keyboard.press('Control+Z');
  await expect
    .poll(() => nodeGroup(page, '周三').locator('rect').getAttribute('fill'), { timeout: 5000 })
    .not.toBe(RED);
  await expect
    .poll(() => nodeGroup(page, '方案评审').locator('rect').getAttribute('fill'), { timeout: 5000 })
    .not.toBe(RED);
});

test('样式：作用域切「仅当前节点」设字号 24 → 子节点字号不变', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click();
  const panel = page.getByTestId('rich-panel');
  await page.getByTestId('format-toggle').click(); // 右列默认隐藏（M7b-R6）：点格式开
  await expect(panel.getByTestId('style-scope-select')).toBeVisible();
  const childText = nodeGroup(page, '方案评审').locator('.gm-text');
  const childBefore = await childText.getAttribute('font-size');
  await panel.getByTestId('style-scope-select').selectOption('single');
  await panel.getByTestId('font-size-select').selectOption('24');
  await expect(nodeGroup(page, '周三').locator('.gm-text')).toHaveAttribute('font-size', '24');
  await expect(childText).toHaveAttribute('font-size', childBefore ?? '');
  // 焦点移出下拉（keyboardMap 对 select 让路；画布点击清选——面板不收，2026-10-09 裁定）后撤销恢复
  await page.locator('.editor-canvas svg').click({ position: { x: 30, y: 30 } });
  await page.keyboard.press('Control+Z');
  await expect
    .poll(() => nodeGroup(page, '周三').locator('.gm-text').getAttribute('font-size'), { timeout: 5000 })
    .not.toBe('24');
});

// ─────────────── ③ 缩放档位 + 全屏（FR-EDT-027/028） ───────────────

test('缩放档位：选 150% → 百分比精确显示且档位选中态；离档回退占位', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('zoom-select').selectOption('150');
  await expect(page.getByTestId('zoom-pct')).toHaveText('150%');
  await expect(page.getByTestId('zoom-select')).toHaveValue('150');
  // - 按钮 ×1/1.2：150 → 125，不在档位 → 下拉回占位、百分比如实显示
  await page.getByTestId('zoom-out').click();
  await expect(page.getByTestId('zoom-pct')).toHaveText('125%');
  await expect(page.getByTestId('zoom-select')).toHaveValue('');
  // 全屏按钮存在可点，点击进入页面级全屏，再点切换退出（headless 无浏览器 UI 消费 Esc）
  const btn = page.getByTestId('fullscreen-btn');
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await btn.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
});

// ─────────────── ④ 跨文件粘贴图片 remap（FR-EDT-010） ───────────────

test('跨文件粘贴：图片随迁到目标文件新 key；同文件粘贴沿用原 key（前缀短路）', async ({ page }) => {
  await openSeedDoc(page, '本周计划'); // 文件 A
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周五' }).click();
  const panel = page.getByTestId('rich-panel');
  await page.getByTestId('format-toggle').click(); // 右列默认隐藏（M7b-R6）：点格式开
  await expect(panel.getByTestId('image-input')).toBeVisible();
  await panel.getByTestId('image-input').setInputFiles(FIXTURE_PNG);
  const imageA = nodeGroup(page, '周五').locator('image.gm-image');
  await expect(imageA).toBeVisible();
  const hrefA = (await imageA.getAttribute('href')) as string;
  expect(hrefA).toContain('/api/images/files/');

  // 右键菜单复制（含图节点；点节点组避免 gm-image 拦截文本命中）→ 同文件粘贴：key 前缀短路，沿用原 key 不产生副本
  await nodeGroup(page, '周五').click({ button: 'right' });
  await page.getByTestId('context-menu').getByRole('button', { name: '复制' }).click();
  await page.keyboard.press('Control+V');
  const imagesA = page.locator('.editor-canvas svg image.gm-image');
  await expect(imagesA).toHaveCount(2); // 粘贴为异步（含 remap 管线）：重试等渲染
  const hrefsSameFile = await imagesA.evaluateAll((els) => els.map((e) => e.getAttribute('href')));
  expect(new Set(hrefsSameFile)).toEqual(new Set([hrefA])); // 无新 key：存储不翻倍

  // 打开文件 B 粘贴 → remap 产生 files/{B}/ 新 key 且可读回
  await page.getByTestId('back-btn').click();
  await expect(page).toHaveURL(/\/workspace/);
  await page.waitForTimeout(800); // 卸载冲刷保存落库
  await page.locator('.file-list li', { hasText: '产品需求评审纪要' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text').first()).toBeVisible();
  await page.keyboard.press('Control+V');
  const imagesB = page.locator('.editor-canvas svg image.gm-image');
  await expect(imagesB).toHaveCount(1);
  const hrefB = (await imagesB.getAttribute('href')) as string;
  const fileIdB = page.url().split('/').pop() ?? '';
  expect(hrefB).not.toBe(hrefA);
  expect(hrefB).toContain(`/api/images/files/${fileIdB}/`); // 图片随迁至目标文档存储
  expect(await page.request.get(hrefB)).toBeOK(); // GET /api/images 新 key 200
  expect(await page.request.get(hrefA)).toBeOK(); // 原文件图片不受影响
});
