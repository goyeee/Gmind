import { expect, test, type Page } from '@playwright/test';

/**
 * 移动端只读 + 评论 E2E — M5 Task 5（OPEN-T-005）。
 *
 * 口径（BINDING，验收文档登记）：≤768px 视口 = 客户端能力降级为只读——隐藏全部
 * 编辑控件、禁用写交互；保留画布渲染、平移/缩放手势、折叠徽标点击、CommentPanel
 * （查看+发表，经工具栏「评论」开关的底部抽屉）、评论角标点击过滤；装载仍走同一
 * WS（实时旁观）。**客户端能力降级而非安全边界**：服务端不拒绝移动端写请求。
 *
 * 断言锚点走 React 分支产出的 testid（非 CSS 断点兜底——editor.css 的媒体查询
 * 只是防御层，e2e 必须钉住「控件未装配」而非「被样式隐藏」）。
 *
 * 覆盖面：
 * - 移动端：画布照常渲染；编辑控件 toHaveCount(0)（结构/主题/撤销/重做/全屏/
 *   导出/标题输入/星标/版本/快捷键/成员）；右列 RichPanel 不装配；保留返回工作台/
 *   标题只读展示（title-display）/保存状态指示；
 * - 移动端写交互禁用：单击/双击节点不进文本编辑覆盖层；Tab/Delete 键盘写路径
 *   不装配（keyboardMap 未挂载）且节点不丢；
 * - 桌面视口折叠 root → 视口切窄即时降级（matchMedia change 监听）→ 折叠徽标
 *   点击展开恢复（保留交互，FR-EDT-030 移动侧）；
 * - 移动端评论闭环：面板默认收起 →「评论」开关打开 → 选中节点发表 → 线程出现 →
 *   收起面板画布角标可见 → 角标点击进入单节点过滤视图（「查看全部」返回）；
 * - 桌面回归：默认视口全部编辑控件可见、评论面板常驻右列、Tab 键盘写路径仍装配。
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

/** 打开种子文件进入编辑器，等待 root 文本渲染。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** 移动端视口（≤768px 断点内，iPhone SE 量级）。 */
async function useMobileViewport(page: Page): Promise<void> {
  await page.setViewportSize({ width: 375, height: 667 });
}

/** 移动端只读分支应不装配的工具栏编辑控件（桌面回归用例反向断言可见）。
 *  insert-menu（标记面板任务的插入菜单）随桌面工具栏分支装配——T5 口径：
 *  标记写入是编辑动作，移动端只读不提供入口。theme-select 下拉已移除
 *  （M7b-W2 #6：主题只留面板按钮），不再列入清单。structure-select 已随
 *  2026-09-30 结构面板改版替换为 structure-toggle（口径不变：编辑控件不装配）。 */
const EDITING_TESTIDS = [
  'structure-toggle',
  'theme-panel-toggle',
  'undo-btn',
  'redo-btn',
  'fullscreen-btn',
  'insert-menu',
  'export-menu',
  'title-input',
  'star-toggle',
  'versions-toggle',
  'help-toggle',
  'members-btn',
] as const;

test('移动端：画布照常渲染，编辑控件不装配，保留返回/标题只读/保存状态', async ({ page }) => {
  test.setTimeout(60_000);
  await useMobileViewport(page);
  await openSeedDoc(page, '本周计划');
  // 画布渲染（只读不减渲染面）：root + 子 + 孙
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
  // 编辑控件未装配（React 分支：toHaveCount(0)，非 CSS 隐藏）
  for (const tid of EDITING_TESTIDS) {
    await expect(page.getByTestId(tid)).toHaveCount(0);
  }
  await expect(page.getByTestId('rich-panel')).toHaveCount(0); // 右列富内容面板整列不装配
  await expect(page.locator('.editor-right')).toHaveCount(0);
  // 保留项：返回工作台 / 标题只读展示（无输入框）/ 保存状态指示 / 评论入口
  await expect(page.getByTestId('back-btn')).toBeVisible();
  await expect(page.getByTestId('title-display')).toHaveText('本周计划');
  await expect(page.getByTestId('save-status')).toBeVisible();
  await expect(page.getByTestId('comment-toggle')).toBeVisible();
});

test('移动端：写交互禁用——单击/双击不进编辑，键盘写路径不装配', async ({ page }) => {
  test.setTimeout(60_000);
  await useMobileViewport(page);
  await openSeedDoc(page, '本周计划');
  const zhou1 = page.locator('.editor-canvas svg .gm-text', { hasText: '周一' }).first();
  // 单击 = 选择（评论落点依赖），不进文本编辑覆盖层
  await zhou1.click();
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  // 双击（双触）同样不进编辑
  await zhou1.dblclick();
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  // 键盘写路径未装配：Tab 不新建、Delete 不删除
  await page.keyboard.press('Tab');
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周一' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
});

test('移动端：折叠徽标可点展开；桌面→移动视口切换即时降级', async ({ page }) => {
  test.setTimeout(60_000);
  // 桌面视口（默认）打开 → Ctrl+/ 折叠 root（桌面键盘路径）
  await openSeedDoc(page, '本周计划');
  await page.keyboard.press('Control+/');
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(1);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toHaveCount(0);
  // 视口切窄跨过 768px 断点 → matchMedia change 即时降级为只读
  await useMobileViewport(page);
  await expect(page.getByTestId('undo-btn')).toHaveCount(0);
  await expect(page.getByTestId('title-input')).toHaveCount(0);
  await expect(page.getByTestId('title-display')).toBeVisible();
  // 折叠徽标点击 → 展开恢复（保留交互；FR-EDT-030 移动侧只剩徽标点击通道）
  await page.locator('.editor-canvas svg .gm-collapse-badge').click();
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周会对齐' })).toBeVisible();
  await expect(page.locator('.editor-canvas svg .gm-collapse-badge')).toHaveCount(0);
});

test('移动端：评论面板开关——选中节点发表评论，角标出现并可点击过滤', async ({ page }) => {
  test.setTimeout(90_000);
  await useMobileViewport(page);
  await openSeedDoc(page, '本周计划');
  // 面板默认收起（底部抽屉由工具栏「评论」开关控制）
  await expect(page.getByTestId('comment-panel')).toHaveCount(0);
  // 先选中「周三」（画布全宽可见），再打开面板（抽屉不遮画布顶部选区操作）
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).first().click();
  await page.getByTestId('comment-toggle').click();
  await expect(page.getByTestId('comment-panel')).toBeVisible();
  // 发表评论：POST 成功 + 广播回流 → 面板出现线程
  await page.getByTestId('comment-input').fill('移动端只读评论');
  await page.getByTestId('comment-send').click();
  await expect(
    page.locator('[data-testid="comment-thread"]', { hasText: '移动端只读评论' }),
  ).toBeVisible({ timeout: 10_000 });
  // 收起面板 → 画布角标出现（计数 1）→ 点击角标进入单节点过滤
  await page.getByTestId('comment-toggle').click();
  await expect(page.getByTestId('comment-panel')).toHaveCount(0);
  const badge = page
    .locator('.editor-canvas svg [data-node-id]', { hasText: '周三' })
    .locator('.gm-comment-badge');
  await expect(badge).toHaveText('1', { timeout: 10_000 });
  await badge.click();
  // 角标点击已置过滤 → 重开面板为过滤视图（「查看全部」返回 + 恰 1 线程）
  await page.getByTestId('comment-toggle').click();
  await expect(page.getByTestId('comment-back-all')).toBeVisible();
  await expect(page.getByTestId('comment-thread')).toHaveCount(1);
  await page.getByTestId('comment-back-all').click();
  await expect(page.getByTestId('comment-thread')).toHaveCount(1); // 全部也恰 1 线程
});

test('桌面回归：默认视口编辑控件齐全，右列默认不渲染，键盘写路径仍装配（惰性）', async ({ page }) => {
  test.setTimeout(60_000);
  await openSeedDoc(page, '本周计划'); // 默认视口（1280×720，>768px 断点外）
  for (const tid of EDITING_TESTIDS) {
    await expect(page.getByTestId(tid)).toBeVisible();
  }
  await expect(page.getByTestId('title-display')).toHaveCount(0); // 移动端标题展示不装配
  await expect(page.getByTestId('comment-toggle')).toHaveCount(0); // 移动端评论开关不装配
  // 右列默认不渲染（M7b-R6 需求方裁定：格式按钮/插入菜单评论项开右列）
  await expect(page.getByTestId('rich-panel')).toHaveCount(0);
  await expect(page.getByTestId('comment-pane')).toHaveCount(0);
  // 键盘写路径在桌面仍装配：Tab 惰性创建「新主题」节点并选中（敲字才进编辑框；
  // 补开首键纪律见 editor.e2e pressFirstCharToOpen：ASCII 首键带重试）
  await page.keyboard.press('Tab');
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '新主题' })).toBeVisible();
  const editor = page.locator('.gm-text-editor');
  for (let i = 0; i < 20 && (await editor.count()) === 0; i += 1) {
    await page.keyboard.press('x');
    await page.waitForTimeout(25);
  }
  await expect(editor).toBeVisible();
  await page.keyboard.press('Escape'); // 编辑框已开：Esc 只关框不回收（回收语义由 editor spec 钉）
  await expect(page.locator('.gm-text-editor')).toHaveCount(0);
});
