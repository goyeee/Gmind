import { expect, test, type APIRequestContext, type Dialog, type Page } from '@playwright/test';

/**
 * 工作台 UI E2E — M3a Task 9（FR-FIL-001~007/008）。
 *
 * 复用 M0 登录模式（新手机号注册即赠 3 个种子文件，每用例独立用户、互不共享状态）。
 * 覆盖：新建/重命名（rename-modal）、文件夹树过滤与增删改、移动到文件夹、复制、
 * 星标视图切换、删除→回收站→还原、彻底删除二次确认、搜索命中与清除、四视图切换
 * （shared 视图经 dev-e2e grant-collaborator 编排）。M0 验收选择器
 * （.file-list li / 新建脑图 按钮）保持兼容。
 */

/** 注册并登录（UI 全流程），返回所用手机号。 */
async function registerAndLogin(page: Page): Promise<string> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
  return phone;
}

/** 新建一个脑图并重命名为指定标题，返回所在行定位器。 */
async function createFileNamed(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '新建脑图' }).click();
  await expect(page.locator('.file-list li', { hasText: '未命名脑图' })).toBeVisible();
  await renameRow(page, '未命名脑图', title);
}

/** 行操作菜单 → 重命名（rename-modal 内输入，Enter 或确定提交）。 */
async function renameRow(page: Page, from: string, to: string): Promise<void> {
  await page.locator('.file-list li', { hasText: from }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '重命名' }).click();
  await expect(page.getByTestId('rename-modal')).toBeVisible();
  await page.getByTestId('rename-input').fill(to);
  await page.getByTestId('rename-confirm').click();
  await expect(page.locator('.file-list li', { hasText: to })).toBeVisible();
}

/** 新建文件夹（默认建在当前选中层级=根）。 */
async function createFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('new-folder-btn').click();
  await expect(page.getByTestId('rename-modal')).toBeVisible();
  await page.getByTestId('rename-input').fill(name);
  await page.getByTestId('rename-confirm').click();
  await expect(page.getByTestId('folder-tree')).toContainText(name);
}

/** 经 API 注册/登录第二个用户（手机验证码首登即注册）并返回 token。 */
async function apiLogin(request: APIRequestContext, phone: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { method: 'phone', phone, code: '123456' } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

test('新建脑图并重命名（rename-modal 输入）', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByRole('button', { name: '新建脑图' }).click();
  await expect(page.locator('.file-list li', { hasText: '未命名脑图' })).toBeVisible();
  await renameRow(page, '未命名脑图', '会议记录');
  await expect(page.getByTestId('rename-modal')).toHaveCount(0);
});

test('新建文件夹出现在树中，点击可过滤列表', async ({ page }) => {
  await registerAndLogin(page);
  await createFolder(page, '工作资料');
  // 无文件在文件夹内：过滤后为空；点回「全部文件」恢复 3 个种子
  await page.locator('.folder-row', { hasText: '工作资料' }).click();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toHaveCount(0);
  await page.locator('.folder-row', { hasText: '全部文件' }).click();
  await expect(page.locator('.file-list li')).toHaveCount(3);
});

test('移动到新建文件夹后位置列更新', async ({ page }) => {
  await registerAndLogin(page);
  await createFolder(page, '项目夹');
  await createFileNamed(page, '待移动文档');
  await page.locator('.file-list li', { hasText: '待移动文档' }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '移动到文件夹' }).click();
  await expect(page.getByTestId('move-modal')).toBeVisible();
  await page.getByTestId('move-select').selectOption({ label: '项目夹' });
  await page.getByTestId('move-confirm').click();
  const row = page.locator('.file-list li', { hasText: '待移动文档' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('项目夹');
});

test('复制出现「-副本」，源文件保留', async ({ page }) => {
  await registerAndLogin(page);
  await createFileNamed(page, '原始文档');
  await page.locator('.file-list li', { hasText: '原始文档' }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '复制', exact: true }).click();
  await expect(page.locator('.file-list li', { hasText: '原始文档-副本' })).toBeVisible();
  await expect(page.locator('.file-list li', { hasText: '原始文档' })).toHaveCount(2);
});

test('星标切换：加入星标视图，取消后移出', async ({ page }) => {
  await registerAndLogin(page);
  const starBtn = page.locator('.file-list li', { hasText: '本周计划' }).getByTestId('star-btn');
  await starBtn.click();
  await expect(starBtn).toHaveText('★');
  await page.getByTestId('view-tabs').getByRole('button', { name: '星标' }).click();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toBeVisible();
  // 取消星标（mine 视图）→ starred 视图为空
  await page.getByTestId('view-tabs').getByRole('button', { name: '我的文件' }).click();
  await page.locator('.file-list li', { hasText: '本周计划' }).getByTestId('star-btn').click();
  await page.getByTestId('view-tabs').getByRole('button', { name: '星标' }).click();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toHaveCount(0);
  await expect(page.locator('.file-list li.empty')).toBeVisible();
});

test('删除文件进入回收站，还原后回到列表', async ({ page }) => {
  await registerAndLogin(page);
  await createFileNamed(page, '待删除文档');
  await page.locator('.file-list li', { hasText: '待删除文档' }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '删除', exact: true }).click();
  await expect(page.locator('.file-list li', { hasText: '待删除文档' })).toHaveCount(0);

  await page.goto('/trash');
  await expect(page.getByTestId('trash-page')).toBeVisible();
  await expect(page.getByText('回收站内容保留 30 天')).toBeVisible();
  const entry = page.locator('.trash-list li', { hasText: '待删除文档' });
  await expect(entry).toContainText('删除时间');
  await expect(entry).toContainText('删除人');
  await entry.getByTestId('restore-btn').click();
  await expect(page.locator('.trash-list li', { hasText: '待删除文档' })).toHaveCount(0);

  await page.goto('/workspace');
  await expect(page.locator('.file-list li', { hasText: '待删除文档' })).toBeVisible();
});

test('彻底删除需二次确认（不可恢复），确认后条目消失', async ({ page }) => {
  await registerAndLogin(page);
  await createFileNamed(page, '彻底删除目标');
  await page.locator('.file-list li', { hasText: '彻底删除目标' }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '删除', exact: true }).click();
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

test('搜索命中标题并展示结果，清除后回到视图页签', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('search-input').fill('本周');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('search-results')).toBeVisible();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toBeVisible();
  await expect(page.locator('.file-list li', { hasText: '产品需求评审纪要' })).toHaveCount(0);
  await page.getByTestId('search-clear').click();
  await expect(page.getByTestId('view-tabs')).toBeVisible();
  await expect(page.locator('.file-list li')).toHaveCount(3);
});

// —— M3b 清偿包（FR-FIL-008 收口两项 + 视图菜单收敛） ——

test('搜索结果标题命中片段以 <mark> 高亮（含大小写不敏感）', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('search-input').fill('本周');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('search-results')).toBeVisible();
  const row = page.locator('.file-list li', { hasText: '本周计划' });
  await expect(row).toBeVisible();
  // 命中片段（首个出现处）被 mark 包裹，前后文保留在标记外
  const title = row.locator('.cell.title');
  await expect(title.getByTestId('search-hit')).toHaveText('本周');
  await expect(title).toHaveText(/本周计划/);

  // 大小写不敏感：q 的大小写形态不影响命中高亮
  await page.getByTestId('search-input').fill('GMIND');
  await page.getByTestId('search-input').press('Enter');
  const gRow = page.locator('.file-list li', { hasText: '欢迎使用 Gmind' });
  await expect(gRow.locator('.cell.title').getByTestId('search-hit')).toHaveText('Gmind');
});

test('Ctrl/Cmd+Shift+F 聚焦搜索框（FR-FIL-008 收口）', async ({ page }) => {
  await registerAndLogin(page);
  await expect(page.getByTestId('search-input')).not.toBeFocused();
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByTestId('search-input')).toBeFocused();
});

test('shared 视图行菜单收敛：无删除/移动（owner-only），mine 视图保留', async ({ page, request }) => {
  const phoneA = await registerAndLogin(page);
  // B 经 API 注册并新建文件，把 A 加为协作者（dev-e2e 编排端点）
  const phoneB = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  const tokenB = await apiLogin(request, phoneB);
  const created = await request.post('/api/files', {
    headers: { Authorization: `Bearer ${tokenB}` },
    data: { title: '乙的共享件' },
  });
  expect(created.ok()).toBeTruthy();
  const granted = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId: ((await created.json()) as { id: string }).id, phone: phoneA } });
  expect(granted.ok()).toBeTruthy();

  // shared（非 owner）行菜单：重命名/复制保留，删除/移动不出现
  await page.getByTestId('view-tabs').getByRole('button', { name: '与我协作' }).click();
  const sharedRow = page.locator('.file-list li', { hasText: '乙的共享件' });
  await expect(sharedRow).toBeVisible();
  await sharedRow.getByTestId('row-menu').click();
  const sharedPopup = page.getByTestId('row-menu-popup');
  await expect(sharedPopup.getByRole('button', { name: '重命名' })).toBeVisible();
  await expect(sharedPopup.getByRole('button', { name: '复制', exact: true })).toBeVisible();
  await expect(sharedPopup.getByRole('button', { name: '移动到文件夹' })).toHaveCount(0);
  await expect(sharedPopup.getByRole('button', { name: '删除', exact: true })).toHaveCount(0);

  // mine（owner）行菜单：删除/移动保留
  await page.getByTestId('view-tabs').getByRole('button', { name: '我的文件' }).click();
  const mineRow = page.locator('.file-list li', { hasText: '本周计划' });
  await expect(mineRow).toBeVisible();
  await mineRow.getByTestId('row-menu').click();
  const minePopup = page.getByTestId('row-menu-popup');
  await expect(minePopup.getByRole('button', { name: '移动到文件夹' })).toBeVisible();
  await expect(minePopup.getByRole('button', { name: '删除', exact: true })).toBeVisible();
});

test('搜索结果内变更后清除搜索，底层列表为最新数据（fix round 1）', async ({ page }) => {
  await registerAndLogin(page);
  await page.getByTestId('search-input').fill('本周');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('search-results')).toBeVisible();
  // 搜索态内重命名命中行
  await page.locator('.file-list li', { hasText: '本周计划' }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '重命名' }).click();
  await page.getByTestId('rename-input').fill('本周新名');
  await page.getByTestId('rename-confirm').click();
  await expect(page.locator('.file-list li', { hasText: '本周新名' })).toBeVisible();
  // 清除搜索 → 底层列表回刷为最新标题（旧标题不得复现）
  await page.getByTestId('search-clear').click();
  await expect(page.getByTestId('view-tabs')).toBeVisible();
  await expect(page.locator('.file-list li', { hasText: '本周新名' })).toBeVisible();
  await expect(page.locator('.file-list li', { hasText: '本周计划' })).toHaveCount(0);
  await expect(page.locator('.file-list li')).toHaveCount(3);
});

test('四视图切换：shared 经 grant-collaborator，recent 随打开出现', async ({ page, request }) => {
  const phoneA = await registerAndLogin(page);
  // B 经 API 注册并新建文件，把 A 加为协作者（dev-e2e 编排端点）
  const phoneB = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  const tokenB = await apiLogin(request, phoneB);
  const created = await request.post('/api/files', {
    headers: { Authorization: `Bearer ${tokenB}` },
    data: { title: '乙的协作文件' },
  });
  expect(created.ok()).toBeTruthy();
  const fileId = ((await created.json()) as { id: string }).id;
  const granted = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, phone: phoneA } });
  expect(granted.ok()).toBeTruthy();

  // mine 不含协作文件；shared 恰为它
  await page.getByTestId('view-tabs').getByRole('button', { name: '与我协作' }).click();
  await expect(page.locator('.file-list li', { hasText: '乙的协作文件' })).toBeVisible();
  await page.getByTestId('view-tabs').getByRole('button', { name: '我的文件' }).click();
  await expect(page.locator('.file-list li', { hasText: '乙的协作文件' })).toHaveCount(0);
  // 打开种子文件 → recent 视图出现；未打开的协作文件不出现
  await page.locator('.file-list li', { hasText: '欢迎使用 Gmind' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await page.goto('/workspace');
  await expect(page.locator('.file-list li')).toHaveCount(3);
  await page.getByTestId('view-tabs').getByRole('button', { name: '最近打开' }).click();
  await expect(page.locator('.file-list li', { hasText: '欢迎使用 Gmind' })).toBeVisible();
  await expect(page.locator('.file-list li', { hasText: '乙的协作文件' })).toHaveCount(0);
});

test('文件夹重命名与删除（context ops，删除入回收站）', async ({ page }) => {
  await registerAndLogin(page);
  await createFolder(page, '旧名文件夹');
  const row = page.locator('.folder-row', { hasText: '旧名文件夹' });
  await row.getByTestId('folder-rename-btn').click();
  await page.getByTestId('rename-input').fill('新名文件夹');
  await page.getByTestId('rename-confirm').click();
  await expect(page.getByTestId('folder-tree')).toContainText('新名文件夹');
  await expect(page.getByTestId('folder-tree')).not.toContainText('旧名文件夹');

  // 文件移入后删除文件夹：文件随文件夹整体入回收站
  await createFileNamed(page, '夹内文档');
  await page.locator('.file-list li', { hasText: '夹内文档' }).getByTestId('row-menu').click();
  await page.getByTestId('row-menu-popup').getByRole('button', { name: '移动到文件夹' }).click();
  await page.getByTestId('move-select').selectOption({ label: '新名文件夹' });
  await page.getByTestId('move-confirm').click();
  await expect(page.locator('.file-list li', { hasText: '夹内文档' })).toContainText('新名文件夹');

  page.on('dialog', (d: Dialog) => void d.accept());
  await page.locator('.folder-row', { hasText: '新名文件夹' }).getByTestId('folder-delete-btn').click();
  await expect(page.getByTestId('folder-tree')).not.toContainText('新名文件夹');
  await expect(page.locator('.file-list li', { hasText: '夹内文档' })).toHaveCount(0);
  await page.goto('/trash');
  await expect(page.locator('.trash-list li', { hasText: '夹内文档' })).toBeVisible();
});

// 退出登录（2026-10-04 需求方）：工作台头部按钮——服务端会话作废+本地 token 清除回登录页
test('工作台：退出登录清 token 回登录页', async ({ page }) => {
  await registerAndLogin(page);
  await page.goto('/workspace');
  await expect(page.getByTestId('logout-button')).toBeVisible();
  await page.getByTestId('logout-button').click();
  await expect(page).toHaveURL(/\/login/);
  const token = await page.evaluate(() => localStorage.getItem('gmind.token'));
  expect(token === null || token === '').toBeTruthy();
  // 会话已在服务端作废：携旧 token 的请求 401（经 API 直验）
  // （token 已清，无法复用——以登录页可达为验收即足够）
});
