import { expect, test, type Page } from '@playwright/test';

/**
 * 节点标记面板 E2E —— 插入菜单右侧层（企微「标记」面板对标，2026-09-28）。
 *
 * 形态：工具栏「插入」下拉（insert-menu）在结构/主题组旁；「标记」项（insert-markers）
 * 不关菜单，而是从菜单**右侧展开一层宽面板**（marker-panel，同一弹层容器内
 * menu 左 / panel 右的 flex 布局）。面板内分组竖排：优先级（①-⑨ 圆徽）/ 进度
 * （百分比圆环）/ 旗帜（彩旗）/ 星标（彩星），每行组名左列窄栏 + 图标横排网格；
 * 下方表情区带分类 tab（emoji-tab-{name} / emoji-item-{char} testid 沿用 M6 T5 契约）。
 *
 * 语义（数据模型零改动）：按钮 testid `marker-{group}-{slug}`（旗帜红 =
 * marker-flag-flag-red）；title 沿用 RichPanel 旧帮助文案（旗帜-红 / 优先级 1…）；
 * 点击 = setIcon(doc, id, group, value)，同值再点 = setIcon null（组内单选取消），
 * 组间并存（M6 T5 冻结语义）；回显按当前选中节点 icons 设 aria-pressed；
 * 无选中节点 → 面板禁用 + 提示「选中节点后添加标记」。
 *
 * 插入菜单其余项为右面板控件聚焦入口：备注/链接 focus 对应输入框、图片触发
 * image-input click（真实可用，非死按钮）。
 *
 * 复用 rich-content 的登录/种子文件模式（新手机号注册即赠 3 个种子文件）。
 */

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
}

async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

async function selectNodeByText(page: Page, text: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: text }).click();
}

function nodeGroup(page: Page, text: string) {
  return page.locator('.editor-canvas svg g[data-node-id]').filter({ hasText: text });
}

/** 打开插入菜单 → 点「标记」→ 右侧层标记面板可见（菜单保持开）。 */
async function openMarkerPanel(page: Page) {
  await page.getByTestId('insert-menu').click();
  await expect(page.getByTestId('insert-markers')).toBeVisible();
  await page.getByTestId('insert-markers').click();
  const panel = page.getByTestId('marker-panel');
  await expect(panel).toBeVisible();
  return panel;
}

// 用例 1：面板结构——四组齐全（组名 + 值域网格）+ 表情分类 tab；菜单在面板左侧同层展开。
test('标记面板：插入菜单右侧层展开，四组值域 + 表情 tab 齐全', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openMarkerPanel(page);
  // 菜单保持开（右侧层形态：标记面板展开不关菜单）
  await expect(page.getByTestId('insert-markers')).toBeVisible();
  // 四个标记组行（组名中文：优先级/进度/旗帜/星标）
  for (const [group, label] of [
    ['priority', '优先级'],
    ['progress', '进度'],
    ['flag', '旗帜'],
    ['star', '星标'],
  ] as const) {
    const row = panel.getByTestId(`marker-group-${group}`);
    await expect(row).toBeVisible();
    await expect(row.locator('.marker-group-label')).toHaveText(label);
  }
  // 值域与现状一致：优先级 p1-p9 / 进度 8 档 / 旗帜 6 色 / 星标 5 色
  await expect(panel.locator('[data-testid^="marker-priority-p"]')).toHaveCount(9);
  await expect(panel.locator('[data-testid^="marker-progress-"]')).toHaveCount(8);
  await expect(panel.locator('[data-testid^="marker-flag-"]')).toHaveCount(6);
  await expect(panel.locator('[data-testid^="marker-star-"]')).toHaveCount(5);
  // 表情区：三分类 tab + 默认 tab 24 项（emoji testid 契约不变）
  for (const name of ['表情', '手势', '符号']) {
    await expect(panel.getByTestId(`emoji-tab-${name}`)).toBeVisible();
  }
  await expect(panel.locator('[data-testid^="emoji-item-"]')).toHaveCount(24);
  // 面板位于插入菜单右侧（右侧层：panel.x > insert-menu.x）
  const menuBox = (await page.getByTestId('insert-menu').boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.x).toBeGreaterThan(menuBox.x);
});

// 用例 2：点旗帜红 → 节点 .gm-icons ⚑ + 按钮 pressed；再点同值取消（组内单选 toggle）。
test('标记面板：旗帜红写入渲染与 pressed 回显，再点同值取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openMarkerPanel(page);
  const red = panel.getByTestId('marker-flag-flag-red');
  await expect(red).toHaveAttribute('title', '旗帜-红');
  await red.click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  await expect(red).toHaveAttribute('aria-pressed', 'true');
  // 再点同值 = 取消（setIcon null）：槽位清空、pressed 回落
  await red.click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveCount(0);
  await expect(red).toHaveAttribute('aria-pressed', 'false');
  // Esc 关闭整个插入层（菜单 + 右侧面板）
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
  await expect(page.getByTestId('insert-markers')).toHaveCount(0);
});

// 用例 3：回显按节点独立——换选另一节点后原 pressed 不串台；异组并存（优先级+旗帜）。
test('标记面板：切换节点回显独立，优先级与旗帜异组并存', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  let panel = await openMarkerPanel(page);
  await panel.getByTestId('marker-flag-flag-red').click();
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
  // 换选 周三（画布点击收起插入层）→ 重开面板：红旗不 pressed（回显随节点）
  await selectNodeByText(page, '周三');
  panel = await openMarkerPanel(page);
  await expect(panel.getByTestId('marker-flag-flag-red')).toHaveAttribute('aria-pressed', 'false');
  // 优先级 1：异组并存，固定组序 priority 在 flag 前
  await panel.getByTestId('marker-priority-p1').click();
  await panel.getByTestId('marker-flag-flag-red').click();
  await expect(nodeGroup(page, '周三').locator('.gm-icons')).toHaveText('①⚑');
  // 周一 的旗帜不受 周三 操作影响（组间/节点间独立）
  await expect(nodeGroup(page, '周一').locator('.gm-icons')).toHaveText('⚑');
});

// 用例 4：无选中节点 → 面板禁用 + 提示「选中节点后添加标记」。
test('标记面板：无选中节点时禁用并提示', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 点空白画布清空选择（远离自适应居中的内容）
  await page.locator('.editor-canvas svg').click({ position: { x: 6, y: 6 } });
  await expect(page.getByTestId('rich-panel').getByTestId('style-hint')).toBeVisible();
  const panel = await openMarkerPanel(page);
  await expect(panel.getByTestId('marker-hint')).toHaveText('选中节点后添加标记');
  await expect(panel.getByTestId('marker-flag-flag-red')).toBeDisabled();
  await expect(panel.getByTestId('marker-priority-p1')).toBeDisabled();
  await expect(panel.getByTestId('emoji-item-😀')).toBeDisabled();
});

// 用例 5：插入菜单备注/链接项聚焦右面板对应控件（真实入口，非死按钮）。
test('插入菜单：备注/链接项聚焦右面板输入框', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-note').click();
  await expect(page.getByLabel('节点备注')).toBeFocused();
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-link').click();
  await expect(page.getByLabel('节点链接')).toBeFocused();
});
