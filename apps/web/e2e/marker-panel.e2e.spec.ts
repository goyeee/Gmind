import { expect, test, type Page } from '@playwright/test';

/**
 * 节点标记面板 E2E —— 插入菜单锚定弹出层（企微「标记」面板对标，M7b-W3 竖层重做）。
 *
 * 形态：工具栏「插入」下拉（insert-menu）→「图标」项（insert-icons）打开锚定弹出层
 * marker-panel（absolute 于 .insert-wrap，顶贴按钮下沿、向下展开；开面板收菜单，
 * 二者同挂 insert-wrap 互斥）；「表情」项（insert-emoji）同层直开表情页签。
 * 面板内分段页签 marker-tab-icon / marker-tab-emoji 切换；图标页七组竖排（心情/
 * 优先级/数字/箭头/旗帜/进度/其他，M7b-W1 目录单源 MARKER_CATALOG），表情页 28 枚
 * emoji 网格（emoji-picker 容器，逐值 testid marker-emoji-{char}）。
 *
 * 语义（M7b-W1/W3）：按钮 testid `marker-{group}-{slug}`（旗帜 = marker-flag-flag）；
 * 点击 = 批量 setIcon（「全含则移除否则设置」，单事务）；single 组（心情/优先级/数字/
 * 箭头/旗帜/进度）组内单选替换，multi 组（其他/表情）组内多选叠加；回显按当前选中
 * 集**交集口径** aria-pressed；无选中节点 → 面板禁用 + 提示「选中节点后添加标记」。
 * Esc / 外点关闭整个插入层（菜单 + 面板）。
 *
 * 画布渲染侧（M7b-W1 起）：.gm-markers 容器 + 逐值 g.gm-marker-badge
 * [data-marker-group][data-marker-value]（旧 .gm-icons 文本槽已移除）。
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

/** 节点标记徽标集合（渲染层 .gm-markers + 逐值 .gm-marker-badge）。 */
function markerBadges(page: Page, text: string) {
  return nodeGroup(page, text).locator('.gm-markers .gm-marker-badge');
}

function markerBadgeByValue(page: Page, text: string, value: string) {
  return nodeGroup(page, text).locator(`.gm-markers .gm-marker-badge[data-marker-value="${value}"]`);
}

/** 打开插入菜单 → 点「图标」→ 锚定弹出层标记面板可见（菜单收起，面板互斥展开）。 */
async function openMarkerPanel(page: Page) {
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-icons').click();
  const panel = page.getByTestId('marker-panel');
  await expect(panel).toBeVisible();
  return panel;
}

// 用例 1：面板结构——页签 + 图标页七组齐全（组名 + 值域网格）+ 表情页 28 枚；
// 面板锚定弹出（顶贴插入按钮下沿，向下展开）。
test('标记面板：插入菜单锚定弹出层展开，页签 + 七组值域 + 表情页齐全', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openMarkerPanel(page);
  // 开面板收菜单（同挂 insert-wrap 互斥）
  await expect(page.getByTestId('insert-icons')).toHaveCount(0);
  // 分段页签：图标（默认）/ 表情
  await expect(panel.getByTestId('marker-tab-icon')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByTestId('marker-tab-emoji')).toHaveAttribute('aria-selected', 'false');
  // 图标页七个标记组行（组名中文，M7b-W1 目录组序）
  for (const [group, label] of [
    ['mood', '心情'],
    ['priority', '优先级'],
    ['number', '数字'],
    ['arrow', '箭头'],
    ['flag', '旗帜'],
    ['progress', '进度'],
    ['other', '其他'],
  ] as const) {
    const row = panel.getByTestId(`marker-group-${group}`);
    await expect(row).toBeVisible();
    await expect(row.locator('.marker-group-label')).toHaveText(label);
  }
  // 值域与企微目录一致（2026-10-01 需求方反馈任务 3 补档）：心情 5 / 优先级 9 / 数字 10 /
  // 箭头 5 / 旗帜 3 / 进度 9（含首位「未开始」none）/ 其他 27
  await expect(panel.locator('[data-testid^="marker-mood-"]')).toHaveCount(5);
  await expect(panel.locator('[data-testid^="marker-priority-"]')).toHaveCount(9);
  await expect(panel.locator('[data-testid^="marker-number-"]')).toHaveCount(10);
  await expect(panel.locator('[data-testid^="marker-arrow-"]')).toHaveCount(5);
  await expect(panel.locator('[data-testid^="marker-flag-"]')).toHaveCount(3);
  await expect(panel.locator('[data-testid^="marker-progress-"]')).toHaveCount(9);
  await expect(panel.locator('[data-testid^="marker-other-"]')).toHaveCount(27);
  // 表情页：28 枚 emoji 平铺网格（emoji-picker 容器 + marker-emoji-{char} 逐值；
  // 前缀匹配须圈定 picker 内部——容器 testid marker-emoji-page 同前缀会多计 1）
  await panel.getByTestId('marker-tab-emoji').click();
  const picker = panel.getByTestId('emoji-picker');
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-testid^="marker-emoji-"]')).toHaveCount(28);
  // 面板锚定弹出：顶贴「插入」按钮下沿（panel.y > menu.y，向下展开）
  const menuBox = (await page.getByTestId('insert-menu').boundingBox())!;
  const panelBox = (await panel.boundingBox())!;
  expect(panelBox.y).toBeGreaterThan(menuBox.y);
});

// 用例 2：点旗帜 → 节点 .gm-markers 旗帜徽标 + 按钮 pressed；再点同值取消（批量
// 口径「全含则移除」）；Esc 关闭整个插入层（菜单 + 面板）。
test('标记面板：旗帜写入渲染与 pressed 回显，再点同值取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openMarkerPanel(page);
  const flag = panel.getByTestId('marker-flag-flag');
  await expect(flag).toHaveAttribute('title', '旗帜');
  await flag.click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  await expect(flag).toHaveAttribute('aria-pressed', 'true');
  // 再点同值 = 取消（批量「全含则移除」）：槽位清空、pressed 回落
  await flag.click();
  await expect(markerBadges(page, '周一')).toHaveCount(0);
  await expect(flag).toHaveAttribute('aria-pressed', 'false');
  // Esc 关闭整个插入层（菜单 + 右侧面板）
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
});

// 用例 2b（2026-10-01 需求方反馈任务 3/4）：进度组首位「未开始」（none）写入 →
// 画布绿环+播放三角徽章（2026-10-01 需求方反馈任务 3 改版：旧 0% 空心环退役）；
// 组名「进度」与按钮悬停标题（目录中文 label）齐备。
test('标记面板：进度组「未开始」写入绿环播放三角徽章，组名与悬停标题齐备', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openMarkerPanel(page);
  const group = panel.getByTestId('marker-group-progress');
  await expect(group.locator('.marker-group-label')).toHaveText('进度');
  const none = panel.getByTestId('marker-progress-none');
  await expect(none).toHaveAttribute('title', '进度 未开始');
  await none.click();
  const badge = markerBadgeByValue(page, '周一', 'none');
  await expect(badge).toHaveCount(1);
  // 徽章悬停标题：SVG <title> 子元素 = 原生 tooltip（与面板按钮 title 同源 label）
  await expect(badge.locator('title')).toHaveText('进度 未开始');
  // 参考图样式：绿描边圆环 + 内部绿色实心播放三角（polygon）
  await expect(badge.locator('circle[stroke="#34c724"][fill="none"]')).toHaveCount(1);
  await expect(badge.locator('polygon[fill="#34c724"]')).toHaveCount(1);
});

// 用例 3：回显按节点独立——换选另一节点后原 pressed 不串台；异组并存（优先级+旗帜）。
test('标记面板：切换节点回显独立，优先级与旗帜异组并存', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  let panel = await openMarkerPanel(page);
  await panel.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  // 换选 周三：锚定面板悬在画布上方会挡住节点点击，先 Esc 收起插入层（Esc/外点关
  // 闭语义），换选后重开面板：旗帜不 pressed（回显随节点）
  await page.keyboard.press('Escape');
  await selectNodeByText(page, '周三');
  panel = await openMarkerPanel(page);
  await expect(panel.getByTestId('marker-flag-flag')).toHaveAttribute('aria-pressed', 'false');
  // 优先级 P1：异组并存（组序 priority 在 flag 前）
  await panel.getByTestId('marker-priority-p1').click();
  await panel.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周三', 'p1')).toHaveCount(1);
  await expect(markerBadgeByValue(page, '周三', 'flag')).toHaveCount(1);
  // 周一 的旗帜不受 周三 操作影响（组间/节点间独立）
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
});

// 用例 4：无选中节点 → 面板禁用 + 提示「选中节点后添加标记」。
test('标记面板：无选中节点时禁用并提示', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 点空白画布清空选择（远离自适应居中的内容）
  await page.locator('.editor-canvas svg').click({ position: { x: 6, y: 6 } });
  const panel = await openMarkerPanel(page);
  await expect(panel.getByTestId('marker-hint')).toHaveText('选中节点后添加标记');
  await expect(panel.getByTestId('marker-flag-flag')).toBeDisabled();
  await expect(panel.getByTestId('marker-priority-p1')).toBeDisabled();
  // 表情页同样禁用
  await panel.getByTestId('marker-tab-emoji').click();
  await expect(panel.getByTestId('marker-emoji-😊')).toBeDisabled();
});

// 用例 5：插入菜单「链接」项——先开格式右列（E3 回归修复：openRichAndFocus 先
// setFormatOpen 再下一帧聚焦），链接输入框聚焦可达；仅无选中节点时才落提示 toast。
test('插入菜单：链接项打开格式右列并聚焦链接输入框', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  await page.getByTestId('insert-menu').click();
  await page.getByTestId('insert-link').click();
  await expect(page.getByTestId('rich-panel')).toBeVisible();
  await expect(page.locator('input[aria-label="节点链接"]')).toBeFocused();
});
