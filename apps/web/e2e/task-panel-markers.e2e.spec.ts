import { expect, test, type Page } from '@playwright/test';

/**
 * 任务面板标记内嵌 E2E —— 2026-10-10 需求方裁定：「优先级 / 标记」区块重做为
 * 内嵌目录（MarkerPanel 锚定弹层与「在标记面板中编辑」按钮整体退役）。
 *
 * 形态：优先级 9 枚 + 进度 9 枚**平铺常显**（可直接点）；其余六组（心情/数字/箭头/
 * 旗帜/其他/表情）**折叠行**（task-panel-marker-toggle-{group} 点组名开合，网格
 * 常驻 DOM 外仅展开时渲染）。逐值 testid `marker-{group}-{slug}` 沿用（渲染位置从
 * 弹层换到任务面板区块内）。
 *
 * 语义：single 组（优先级/心情/数字/箭头/旗帜）再点当前值取消；multi 组（其他/
 * 表情）core toggle 叠加；**进度组 radio + 全量联动**——点档位 = 写任务进度百分比
 * （PROGRESS_STAGE_PCT：p50→50…done→100），徽章由 core setNodeTask 同事务回写；
 * 反向改进度数字/状态联动（已完成→100、回退待开始→0）同步徽章档位；父节点进度行
 * 只读（父级 Σ 自动汇总，与 ProgressField 一致）。
 *
 * 画布渲染侧不变：.gm-markers 容器 + 逐值 g.gm-marker-badge
 * [data-marker-group][data-marker-value]。
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

/** 打开任务面板（已开时跳过 task-toggle——toggle 语义，再点会收面板）。 */
async function openTaskPanel(page: Page) {
  if ((await page.getByTestId('task-panel').count()) === 0) await page.getByTestId('task-toggle').click();
  const panel = page.getByTestId('task-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** 展开折叠标记组（常显行 priority/progress 无折叠头，调用方不传这两组）。 */
async function expandMarkerGroup(page: Page, group: string): Promise<void> {
  const toggle = page.getByTestId(`task-panel-marker-toggle-${group}`);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
}

// 用例 1：区块结构——优先级/进度两组平铺常显（值域与企微目录一致），其余六组折叠
// 头（默认收起）；弹层与跳转按钮不再存在。
test('任务面板标记：优先级/进度平铺常显 + 六组折叠，弹层与跳转按钮退役', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openTaskPanel(page);
  // 常显行：优先级 9 / 进度 9（含首位「未开始」none），组名中文
  const priorityRow = panel.getByTestId('task-panel-marker-row-priority');
  await expect(priorityRow.locator('.task-marker-row-label')).toHaveText('优先级');
  await expect(priorityRow.locator('[data-testid^="marker-priority-"]')).toHaveCount(9);
  const progressRow = panel.getByTestId('task-panel-marker-row-progress');
  await expect(progressRow.locator('.task-marker-row-label')).toHaveText('进度');
  await expect(progressRow.locator('[data-testid^="marker-progress-"]')).toHaveCount(9);
  // 折叠组：六组头默认收起（网格未渲染），组名与企微目录一致
  for (const [group, label] of [
    ['mood', '心情'],
    ['number', '数字'],
    ['arrow', '箭头'],
    ['flag', '旗帜'],
    ['other', '其他'],
    ['emoji', '表情'],
  ] as const) {
    const head = panel.getByTestId(`task-panel-marker-toggle-${group}`);
    await expect(head).toBeVisible();
    await expect(head).toHaveAttribute('aria-expanded', 'false');
    await expect(head.locator('.task-marker-row-label')).toHaveText(label);
  }
  // 展开旗帜（3 枚）与表情（28 枚）
  await expandMarkerGroup(page, 'flag');
  await expect(panel.getByTestId('task-panel-marker-group-flag').locator('[data-testid^="marker-flag-"]')).toHaveCount(3);
  await expandMarkerGroup(page, 'emoji');
  await expect(panel.getByTestId('task-panel-marker-group-emoji').locator('[data-testid^="marker-emoji-"]')).toHaveCount(28);
  // 退役断言：无弹层面板、无「在标记面板中编辑」按钮
  await expect(page.getByTestId('marker-panel')).toHaveCount(0);
  await expect(page.getByTestId('task-panel-markers-edit')).toHaveCount(0);
});

// 用例 2：折叠组写入——旗帜写入渲染 + pressed 回显；再点同值取消（single 组语义）；
// 已选计数徽标随折叠头回显。
test('任务面板标记：折叠组旗帜写入渲染与 pressed 回显，再点同值取消', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openTaskPanel(page);
  await expandMarkerGroup(page, 'flag');
  const flag = panel.getByTestId('marker-flag-flag');
  await expect(flag).toHaveAttribute('title', '旗帜');
  await flag.click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  await expect(flag).toHaveAttribute('aria-pressed', 'true');
  // 折叠头已选计数 = 1（收起后也有回显）
  await page.getByTestId('task-panel-marker-toggle-flag').click(); // 收起
  await expect(page.getByTestId('task-panel-marker-toggle-flag').locator('.task-marker-count')).toHaveText('1');
  await page.getByTestId('task-panel-marker-toggle-flag').click(); // 再展开
  // 再点同值 = 取消：徽章清空、pressed 回落
  await flag.click();
  await expect(markerBadges(page, '周一')).toHaveCount(0);
  await expect(flag).toHaveAttribute('aria-pressed', 'false');
});

// 用例 3（核心）：进度档位↔百分比全量联动——点档位写百分比（面板数字/pressed
// 同步；画布徽章 2026-10-12 起退役不渲染，数据链写而不画——此处断言画布无进度
// 徽章）；改进度数字同步档位；状态联动（已完成→100+done、回退待开始→0+none）。
test('任务面板标记：进度档位与百分比全量联动——点档位/改数字/状态联动（画布徽章已退役）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周报复盘'); // 叶子节点（种子 周一/三/五 全为父级：进度行按父级只读）
  const panel = await openTaskPanel(page);
  const progressInput = panel.getByTestId('task-panel-progress');
  // 初始（进度 0）：none 档 pressed（radio 恒有一档）
  await expect(panel.getByTestId('marker-progress-none')).toHaveAttribute('aria-pressed', 'true');
  // 画布无进度徽章（2026-10-12 需求方裁定「标题前的进度图标不要了」——数据在而
  // gm-markers 不渲染进度组；进度由任务行头像弧环/右侧 % 表达）。
  await expect(markerBadgeByValue(page, '周报复盘', 'none')).toHaveCount(0);
  // 点 p50：面板数字 50 + pressed 迁移（徽章数据链联动仍写——画布不渲染）
  await panel.getByTestId('marker-progress-p50').click();
  await expect(progressInput).toHaveValue('50');
  await expect(markerBadgeByValue(page, '周报复盘', 'p50')).toHaveCount(0); // 画布退役
  await expect(panel.getByTestId('marker-progress-p50')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByTestId('marker-progress-none')).toHaveAttribute('aria-pressed', 'false');
  // 改数字 88：pressed 随档位换算（round(88/12.5)=7 → p87）
  await progressInput.fill('88');
  await page.keyboard.press('Enter');
  await expect(markerBadgeByValue(page, '周报复盘', 'p87')).toHaveCount(0); // 画布退役
  await expect(panel.getByTestId('marker-progress-p87')).toHaveAttribute('aria-pressed', 'true');
  // 状态已完成：进度拉满 100 + done 档（联动链同步）
  await panel.getByTestId('task-panel-status-done').click();
  await expect(progressInput).toHaveValue('100');
  await expect(markerBadgeByValue(page, '周报复盘', 'done')).toHaveCount(0); // 画布退役
  await expect(panel.getByTestId('marker-progress-done')).toHaveAttribute('aria-pressed', 'true');
  // 回退待开始：进度清零 + none 档（M7b-W1 裁定链路）
  await panel.getByTestId('task-panel-status-todo').click();
  await expect(progressInput).toHaveValue('0');
  await expect(markerBadgeByValue(page, '周报复盘', 'none')).toHaveCount(0); // 画布退役
  await expect(panel.getByTestId('marker-progress-none')).toHaveAttribute('aria-pressed', 'true');
});

// 用例 3b：父节点进度行只读（父级进度按子级自动汇总，与 ProgressField 只读一致）；
// 优先级行不受限。
test('任务面板标记：父节点进度行禁用（Σ 自动汇总），优先级可编', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '本周计划'); // 根节点（有子级）
  const panel = await openTaskPanel(page);
  await expect(panel.locator('.task-marker-hint')).toHaveText('父节点进度按子级自动汇总');
  await expect(panel.getByTestId('marker-progress-p50')).toBeDisabled();
  // 优先级行不受父级限制
  const p0 = panel.getByTestId('marker-priority-p0');
  await p0.click();
  await expect(p0).toHaveAttribute('aria-pressed', 'true');
});

// 用例 4：回显按节点独立——换选另一节点后 pressed 不串台；优先级与旗帜异组并存。
test('任务面板标记：切换节点回显独立，优先级与旗帜异组并存', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  const panel = await openTaskPanel(page);
  await expandMarkerGroup(page, 'flag');
  await panel.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
  // 换选 周三：面板跟随（点其他节点跟随语义），旗帜不 pressed（回显随节点）
  await selectNodeByText(page, '周三');
  await expect(panel.getByTestId('marker-flag-flag')).toHaveAttribute('aria-pressed', 'false');
  // 优先级 P1：异组并存
  await panel.getByTestId('marker-priority-p1').click();
  await panel.getByTestId('marker-flag-flag').click();
  await expect(markerBadgeByValue(page, '周三', 'p1')).toHaveCount(1);
  await expect(markerBadgeByValue(page, '周三', 'flag')).toHaveCount(1);
  // 周一 的旗帜不受 周三 操作影响（节点间独立）
  await expect(markerBadgeByValue(page, '周一', 'flag')).toHaveCount(1);
});

// 用例 5：无选中节点 → TaskPanel 空态、无内嵌标记区块（原「无标记编辑入口」口径）。
test('任务面板标记：无选中节点时 TaskPanel 空态、无标记区块', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.locator('.editor-canvas svg').click({ position: { x: 6, y: 6 } });
  await page.getByTestId('task-toggle').click();
  await expect(page.getByTestId('task-panel')).toBeVisible();
  await expect(page.locator('.task-panel-empty')).toHaveText('选中节点后查看与编辑任务');
  await expect(page.getByTestId('task-panel-marker-row-priority')).toHaveCount(0);
  await expect(page.getByTestId('task-panel-marker-toggle-emoji')).toHaveCount(0);
});

// 用例 6（保留）：链接编辑走格式面板既有入口（插入菜单删除后路径）。
test('格式面板：链接输入框入口（插入菜单删除后路径）', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await selectNodeByText(page, '周一');
  await page.getByTestId('format-toggle').click();
  await expect(page.getByTestId('rich-panel')).toBeVisible();
  await expect(page.locator('input[aria-label="节点链接"]')).toBeVisible();
});
