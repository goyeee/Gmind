import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 工作台 UI E2E —— 2026-10-20 整体重设计（spec 2026-10-20-workspace-redesign-design）
 * 随新信息架构全量重写：左侧栏导航（nav-*）+ 顶栏（搜索/导入/新建/通知铃/头像）+
 * 卡片流（file-card）。旧 .file-list/view-tabs/row-menu/文件夹树契约全部退役。
 *
 * 复用 M0 登录模式（新手机号注册即赠 3 个种子文件，每用例独立用户）。覆盖：
 * 新建即开 + 行内重命名、星标切换、删除→回收站→还原、彻底删除二次确认、搜索命中
 * 与清除、Ctrl+Shift+F 聚焦、协作空间（grant-collaborator 编排）+ 最近使用筛选、
 * 模板库画廊/预览/一键套用、用户菜单（账号设置/退出登录）。
 */

/** 注册并登录（UI 全流程），返回所用手机号。 */
async function registerAndLogin(page: Page): Promise<string> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.getByTestId('mine-grid').getByTestId('file-card')).toHaveCount(3); // 3 个种子
  return phone;
}

/** 新建一个脑图（即建即开编辑器）后返回工作台。 */
async function createFileNamed(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-file-btn').click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text').first()).toBeVisible();
  // 编辑器标题改名（即建即开后的命名路径）再返回
  await page.getByTestId('title-input').fill(title);
  await page.getByTestId('back-btn').click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(mineCardOf(page, title)).toBeVisible();
}

/** 文件卡片定位器（默认全域；操作类交互用 mineCardOf 定界我的文件网格——首页
 *  最近/我的双网格同文件双卡并存，不定界会命中双卡）。 */
function cardOf(page: Page, title: string) {
  return page.getByTestId('file-card').filter({ hasText: title });
}
function mineCardOf(page: Page, title: string) {
  return page.getByTestId('mine-grid').getByTestId('file-card').filter({ hasText: title });
}

/** 卡片 ⋯ 菜单 → 重命名（行内就地编辑，Enter 提交）。 */
async function renameCard(page: Page, from: string, to: string): Promise<void> {
  const card = mineCardOf(page, from);
  await card.hover();
  await card.getByTestId('card-menu-btn').click();
  await page.getByTestId('card-menu').getByRole('button', { name: '重命名' }).click();
  // 注意：重命名开始后卡内标题文本被输入框替换，原 hasText 过滤器会失配——
  // 输入框改按 testid 全局定位（同一时刻至多一个重命名输入框）
  const input = page.getByTestId('rename-input');
  await expect(input).toBeVisible();
  await input.fill(to);
  await input.press('Enter');
  await expect(cardOf(page, to)).toBeVisible();
}

/** 经 API 注册/登录第二个用户（手机验证码首登即注册）并返回 token。 */
async function apiLogin(request: APIRequestContext, phone: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { method: 'phone', phone, code: '123456' } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

const randomPhone = () => '138' + String(Math.floor(10000000 + Math.random() * 89999999));

test('新建脑图即建即开，行内重命名落库', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('new-file-btn').click();
  // 新建即开编辑器（参考图「空白脑图」卡语义）
  await expect(page).toHaveURL(/\/edit\//);
  await page.getByTestId('back-btn').click();
  await expect(page).toHaveURL(/\/workspace/);
  await renameCard(page, '未命名脑图', '会议记录');
});
test('星标切换：加入星标收藏视图，取消后移出', async ({ page }) => {
  await registerAndLogin(page);
  const card = cardOf(page, '本周计划');
  await card.hover();
  await card.getByTestId('star-btn').click();
  await expect(card.getByTestId('star-btn')).toHaveText('★');
  await page.getByTestId('nav-starred').click();
  await expect(cardOf(page, '本周计划')).toBeVisible();
  // 取消星标 → 星标视图为空
  await page.getByTestId('nav-mine').click();
  const card2 = cardOf(page, '本周计划');
  await card2.hover();
  await card2.getByTestId('star-btn').click();
  await page.getByTestId('nav-starred').click();
  await expect(cardOf(page, '本周计划')).toHaveCount(0);
  await expect(page.locator('.grid-empty')).toBeVisible();
});

test('删除文件进入回收站，还原后回到列表', async ({ page }) => {
  await registerAndLogin(page);
  await createFileNamed(page, '待删除文档');
  const card = cardOf(page, '待删除文档');
  await card.hover();
  await card.getByTestId('card-menu-btn').click();
  await page.getByTestId('card-menu').getByRole('button', { name: '删除', exact: true }).click();
  await expect(cardOf(page, '待删除文档')).toHaveCount(0);

  await page.goto('/trash');
  await expect(page.getByTestId('trash-page')).toBeVisible();
  await expect(page.getByText('回收站内容保留 30 天')).toBeVisible();
  const entry = page.locator('.trash-list li', { hasText: '待删除文档' });
  await expect(entry).toContainText('删除时间');
  await expect(entry).toContainText('删除人');
  await entry.getByTestId('restore-btn').click();
  await expect(page.locator('.trash-list li', { hasText: '待删除文档' })).toHaveCount(0);

  await page.goto('/workspace');
  await expect(cardOf(page, '待删除文档')).toBeVisible();
});

test('彻底删除需二次确认（不可恢复），确认后条目消失', async ({ page }) => {
  await registerAndLogin(page);
  await createFileNamed(page, '彻底删除目标');
  const card = cardOf(page, '彻底删除目标');
  await card.hover();
  await card.getByTestId('card-menu-btn').click();
  await page.getByTestId('card-menu').getByRole('button', { name: '删除', exact: true }).click();
  await page.goto('/trash');
  const entry = page.locator('.trash-list li', { hasText: '彻底删除目标' });
  await entry.getByTestId('purge-btn').click();
  await expect(page.getByTestId('purge-confirm')).toBeVisible();
  await expect(page.getByTestId('purge-confirm')).toContainText('不可恢复');
  await page.getByTestId('purge-confirm-btn').click();
  await expect(page.getByTestId('purge-confirm')).toHaveCount(0);
  await expect(page.locator('.trash-list li', { hasText: '彻底删除目标' })).toHaveCount(0);
  await expect(page.locator('.trash-list li.empty')).toBeVisible();
});

test('卡片 ⋯ 菜单溢出卡片下缘不被裁剪（2026-10-21 修遮挡回归）：最末项可点', async ({ page }) => {
  await registerAndLogin(page);
  await createFileNamed(page, '菜单遮挡回归');
  const card = mineCardOf(page, '菜单遮挡回归');
  await card.hover();
  await card.getByTestId('card-menu-btn').click();
  const menu = page.getByTestId('card-menu');
  await expect(menu).toBeVisible();
  // 几何断言：菜单下缘超出卡片下缘（overflow 裁剪修复后菜单不再被卡片截断）
  const cardBox = await card.boundingBox();
  const menuBox = await menu.boundingBox();
  expect(menuBox!.y + menuBox!.height).toBeGreaterThan(cardBox!.y + cardBox!.height);
  // 点击最末项（删除）成功——若被 overflow:hidden 裁掉则点击不可达
  await menu.getByRole('button', { name: '删除', exact: true }).click();
  await expect(cardOf(page, '菜单遮挡回归')).toHaveCount(0);
});

test('真实内容缩略图：编辑保存后卡片出真实快照 img；未编辑卡回退装饰图（2026-10-21 裁定）', async ({ page }) => {
  await registerAndLogin(page);
  // 打开种子文档写一笔（格式填充）→ persisted ack 触发快照上传（首次无节流）
  await mineCardOf(page, '本周计划').click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '周三' })).toBeVisible();
  await page.locator('.editor-canvas svg .gm-text', { hasText: '周三' }).click();
  await page.getByTestId('format-toggle').click();
  await page.getByTestId('rich-panel').getByTitle('填充-红').click();
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/);
  // 回工作台：本周计划卡片出真实快照（懒加载 + 服务端往返，重试窗口放宽）
  await page.goto('/workspace');
  const edited = mineCardOf(page, '本周计划');
  await expect(edited.getByTestId('file-thumb-img')).toBeVisible({ timeout: 10_000 });
  // 未编辑过的种子卡仍回退装饰性示意图
  const untouched = mineCardOf(page, '欢迎使用 Gmind');
  await expect(untouched.locator('.file-thumb-svg')).toBeVisible();
  await expect(untouched.getByTestId('file-thumb-img')).toHaveCount(0);
});

test('搜索命中标题并展示结果卡片，清除后回到当前视图', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('search-input').fill('本周');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(cardOf(page, '本周计划')).toBeVisible();
  await expect(cardOf(page, '产品需求评审纪要')).toHaveCount(0);
  await page.getByTestId('search-clear').click();
  await expect(page.getByTestId('ws-greeting')).toBeVisible(); // 回首页
  await expect(page.getByTestId('file-card')).toHaveCount(3);
});

test('Ctrl/Cmd+Shift+F 聚焦搜索框（FR-FIL-008 收口）', async ({ page }) => {
  await registerAndLogin(page);
  await expect(page.getByTestId('search-input')).not.toBeFocused();
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByTestId('search-input')).toBeFocused();
});

test('协作空间与最近使用筛选：协作文件带图标、筛选器按归属过滤（2026-10-20 裁定 3）', async ({ page, request }) => {
  const phoneA = await registerAndLogin(page);
  // B 经 API 注册并新建文件，把 A 加为协作者（dev-e2e 编排端点）
  const phoneB = randomPhone();
  const tokenB = await apiLogin(request, phoneB);
  const created = await request.post('/api/files', {
    headers: { Authorization: `Bearer ${tokenB}` },
    data: { title: '乙的协作文件' },
  });
  expect(created.ok()).toBeTruthy();
  const fileId = ((await created.json()) as { id: string }).id;
  const granted = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone: phoneA } });
  expect(granted.ok()).toBeTruthy();

  // 协作空间（侧栏一级入口）= 协作文件集合
  await page.getByTestId('nav-collab').click();
  await expect(cardOf(page, '乙的协作文件')).toBeVisible();
  await expect(cardOf(page, '本周计划')).toHaveCount(0);
  // 我的文件不含协作件
  await page.getByTestId('nav-mine').click();
  await expect(cardOf(page, '乙的协作文件')).toHaveCount(0);
  // 打开协作文件 → 最近使用出现且带协作图标；筛选器切「协作」只剩它、切「个人」不见
  await page.getByTestId('nav-collab').click();
  await cardOf(page, '乙的协作文件').click();
  await expect(page).toHaveURL(/\/edit\//);
  // 等编辑器装载完成（last_opened_at 由装载期 POST /open 打点）再离开，防打点竞态
  await expect(page.locator('.editor-canvas svg .gm-text').first()).toBeVisible();
  await page.goto('/workspace');
  await page.getByTestId('nav-recent').click();
  const collabCard = cardOf(page, '乙的协作文件');
  await expect(collabCard).toBeVisible();
  await expect(collabCard.getByLabel('协作文件')).toBeVisible();
  await page.getByTestId('recent-filter-collab').click();
  await expect(cardOf(page, '本周计划')).toHaveCount(0);
  await page.getByTestId('recent-filter-mine').click();
  await expect(cardOf(page, '乙的协作文件')).toHaveCount(0);
});

test('协作文件的卡片菜单收敛：无删除（owner-only），重命名/复制保留', async ({ page, request }) => {
  const phoneA = await registerAndLogin(page);
  const phoneB = randomPhone();
  const tokenB = await apiLogin(request, phoneB);
  const created = await request.post('/api/files', {
    headers: { Authorization: `Bearer ${tokenB}` },
    data: { title: '乙的共享件' },
  });
  const fileId = ((await created.json()) as { id: string }).id;
  await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone: phoneA } });

  await page.getByTestId('nav-collab').click();
  const card = cardOf(page, '乙的共享件');
  await card.hover();
  await card.getByTestId('card-menu-btn').click();
  const menu = page.getByTestId('card-menu');
  await expect(menu.getByRole('button', { name: '重命名' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(menu.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);
});

test('模板库：画廊 → 预览 → 使用模板一键建文档并打开', async ({ page }) => {
  await registerAndLogin(page);
  // 侧栏进模板库：内置精选模板画廊
  await page.getByTestId('nav-templates').click();
  await expect(page.getByTestId('template-grid')).toBeVisible();
  await expect(page.getByTestId('template-card-okr')).toBeVisible();
  // 预览 → 使用模板 → 即建即开编辑器，内容为模板结构
  await page.getByTestId('template-card-okr').click();
  await expect(page.getByTestId('template-preview')).toBeVisible();
  await page.getByTestId('template-use').click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '目标 O1' })).toBeVisible();
  // 回工作台：新文档出现在我的文件
  await page.getByTestId('back-btn').click();
  await expect(cardOf(page, 'OKR 目标管理')).toBeVisible();
});

test('首页快速创建卡：从模板创建卡直达模板库', async ({ page }) => {
  await registerAndLogin(page);
  await expect(page.getByTestId('ws-greeting')).toContainText('，用户'); // 时段问候+昵称
  await page.getByTestId('quick-create-template').click();
  await expect(page.getByTestId('template-grid')).toBeVisible();
});

test('用户菜单：账号设置入口 + 退出登录清 token 回登录页', async ({ page }) => {
  await registerAndLogin(page);
  // 左下用户卡 → 菜单（账号设置/退出登录；账号管理仅超管——本用例普通 member 不见）
  await page.getByTestId('user-card').click();
  const menu = page.getByTestId('user-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('settings-entry')).toBeVisible();
  await expect(menu.getByTestId('admin-users-entry')).toHaveCount(0);
  await menu.getByTestId('logout-button').click();
  await expect(page).toHaveURL(/\/login/);
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  expect(token === null || token === '').toBeTruthy();
});
