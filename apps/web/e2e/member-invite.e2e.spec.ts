import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 成员面板邀请对话框 E2E — M4 Task 2（M3b 缺口收口，FR-SHR-004 的 UI 面）。
 *
 * 复用 rich-content/share spec 的登录模式（新手机号注册即赠 3 个种子文件）。覆盖：
 * - owner 粘贴多地址批量邀请成功（toast 计数）+ 非法地址整批拒绝且逐条列出
 *   （服务端 400 message 原样透出，非法条目全列）；
 * - 仅 owner 可见邀请区：协作者（经分享链接加入）打开成员面板无 invite-section。
 *
 * API 口径以 M3b 已交付实现为准：200 {invited, skipped}（skipped = 重邀 no-op 计数）、
 * 400 {message}（message 已含全部非法条目）、非 owner 404。
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

/** 打开种子文件进入编辑器，等待 root 文本渲染（rich-content spec 同款 helper）。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** 经 API 注册/登录（手机验证码首登即注册）并返回 token（share spec 同款 helper）。 */
async function apiLogin(request: APIRequestContext, phone: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { method: 'phone', phone, code: '123456' } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

/** 随机手机号（share spec 同款 helper）。 */
const randomPhone = () => '138' + String(Math.floor(10000000 + Math.random() * 89999999));

// 用例 1：owner 批量邀请成功 toast 计数；非法地址整批拒绝且逐条列出
// （2026-10-11 起粘贴框折叠为次要入口：先点 invite-contacts-toggle 展开）
test('成员面板邀请：粘贴多个地址批量邀请成功；非法地址逐条报错', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('members-btn').click();
  const panel = page.getByTestId('member-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('invite-section')).toBeVisible(); // owner 可见邀请区
  await panel.getByTestId('invite-contacts-toggle').click(); // 展开站外联系人粘贴框
  const input = page.getByTestId('invite-input');
  await input.fill('a@test.dev, 13900000001\nb@test.dev');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('已邀请 3 位');
  await expect(input).toHaveValue(''); // 成功后输入清空
  // 非法整批拒绝且逐条列出（服务端 400 message 原样透出）
  await input.fill('bad-email');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('bad-email');
});

// 用例 2（仅 owner 显示）：协作者（分享链接加入）打开成员面板无邀请区
test('成员面板邀请区仅 owner 可见：协作者不显示', async ({ browser, request }) => {
  // A（owner）经 API 建文件 + 建 active 分享链接（share spec 同款编排）
  const aToken = await apiLogin(request, randomPhone());
  const created = await request.post('/api/files', {
    data: { title: '协作者视图文档' },
    headers: authHeader(aToken),
  });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  const share = await request.post(`/api/files/${fileId}/share`, { headers: authHeader(aToken) });
  expect(share.status()).toBe(201);
  const shareToken = ((await share.json()) as { shareToken: string }).shareToken;

  // B：新账号打开链接 → 登录回跳自动加入 → 编辑器画布渲染
  const context = await browser.newContext();
  const page = await context.newPage();
  await registerAndLogin(page);
  await page.goto(`/s/${shareToken}`);
  await expect(page).toHaveURL(new RegExp(`/edit/${fileId}`));
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '中心主题' })).toBeVisible();

  // B 打开成员面板：面板可见但无邀请区（非 owner）
  await page.getByTestId('members-btn').click();
  await expect(page.getByTestId('member-panel')).toBeVisible();
  await expect(page.getByTestId('invite-section')).toHaveCount(0);
  await context.close();
});

// 用例 3（M5 清偿）：混合批次 toast 分计数「已邀请 N 位，M 位已在邀请中」
// （skipped 不再并入 N；M=0 保持旧文案形态）+ textarea 经 aria-label 可定位。
test('成员面板邀请：混合批次 toast 分计数；M=0 保持旧文案；textarea aria-label', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('members-btn').click();
  await expect(page.getByTestId('invite-section')).toBeVisible();
  await page.getByTestId('invite-contacts-toggle').click(); // 2026-10-11 起折叠为次要入口

  // textarea aria-label（M5 清偿）：以 label 定位即断言其存在
  const input = page.getByLabel('邀请联系人（邮箱或手机号，逗号/空格/换行分隔）');

  // 首批 2 新邀：M=0 → 旧文案形态「已邀请 2 位」
  await input.fill('mix-a@test.dev, mix-b@test.dev');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('已邀请 2 位');

  // 混合批：1 新邀 + 1 pending 重邀（skipped 分开计）
  await input.fill('mix-a@test.dev, mix-c@test.dev');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('已邀请 1 位，1 位已在邀请中');

  // 全重邀批次：0 新邀 + 2 已在邀请中
  await input.fill('mix-a@test.dev, mix-c@test.dev');
  await page.getByTestId('invite-submit').click();
  await expect(page.getByTestId('toast')).toContainText('已邀请 0 位，2 位已在邀请中');
});

// 用例 4（2026-10-11 需求方裁定）：站内用户 picker——搜索过滤 → 勾选 → 一键拉取
// 直接成为协作者（无需对方接受）；拉取后目录排除该用户。B 经 API 注册（登录即注册）。
test('成员面板拉取站内用户：搜索过滤 → 勾选 → 一键拉取为协作者', async ({ page, request }) => {
  // B：站内用户（API 注册即建号），昵称 = 用户 + 手机号后 4 位
  const bPhone = randomPhone();
  await apiLogin(request, bPhone);
  const bNick = `用户${bPhone.slice(-4)}`;

  await openSeedDoc(page, '本周计划');
  await page.getByTestId('members-btn').click();
  const panel = page.getByTestId('member-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('invite-user-list')).toBeVisible();

  // 搜索过滤（手机号）→ 只剩 B；勾选 → 一键拉取
  await panel.getByTestId('invite-user-search').fill(bPhone);
  const row = panel.getByTestId('invite-user-row').filter({ hasText: bNick });
  await expect(row).toHaveCount(1);
  await expect(panel.getByTestId('invite-selected-count')).toHaveText('已选 0 人');
  await expect(panel.getByTestId('invite-pull-submit')).toBeDisabled();
  await row.click();
  await expect(panel.getByTestId('invite-selected-count')).toHaveText('已选 1 人');
  await panel.getByTestId('invite-pull-submit').click();
  await expect(page.getByTestId('toast')).toContainText('已拉取 1 位协作者');
  // 拉取后目录重取并排除 B（选择清空、计数归零）
  await expect(panel.getByTestId('invite-selected-count')).toHaveText('已选 0 人');
  await expect(panel.getByTestId('invite-user-row').filter({ hasText: bNick })).toHaveCount(0);
});
