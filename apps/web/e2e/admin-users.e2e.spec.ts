import { expect, test, type Page } from '@playwright/test';
import { apiRegister, injectToken } from './helpers/auth';

/**
 * 账号管理 UI E2E（移植 mindgrid 账号体系）：超管入口门 + 成员表 + 添加账号 + 停用踢号 +
 * member 无入口。依赖库里有可用超管（API_ORIGIN 指向的 server）。
 *
 * 超管号说明（2026-11-12 账号重做邮箱化）：探测候选改邮箱 `demo@gmind.dev`（任务 8
 * seed-demo 落地的演示超管，密码统一 demo123456）。任务 8 完成前探测不到 → 整文件
 * skip（环境缺超管，非产品缺陷，计划内中间态）。
 * 固定成员号 member0002@gmind.dev：首跑经 UI 添加创建；重跑已存在则接受 409 幂等，
 * 各用例自行为其铺「存在且启用」前置（API ensureMember），互不依赖执行顺序。
 * 2026-11-12 UI 改造（任务 7）：登录走新 LoginPage 邮箱+密码表单（testid 驱动），
 * 添加账号表单改邮箱（add-user-email），成员标识列改 user-email。
 */

// 2026-10-21 起列表分页化（页 20 行 + q 搜索），用例一律搜索定位目标行；
// 断言超时仍放宽（防抖 300ms + 开发库往返余量）
expect.configure({ timeout: 15_000 });

/** 超管候选（按序探测）：任务 8 seed-demo 的演示超管。 */
const ADMIN_EMAIL_CANDIDATES = ['demo@gmind.dev'];
/** 超管密码：与任务 8 seed-demo 统一（demo123456）。 */
const ADMIN_PASSWORD = 'demo123456';
/** 固定成员号（添加账号用例造出；member 视角复用）。 */
const MEMBER_EMAIL = 'member0002@gmind.dev';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface AdminItem {
  id: string;
  email: string;
  nickname: string;
  systemRole: 'super_admin' | 'member';
  status: 'active' | 'disabled';
}

async function apiLogin(page: Page, account: string, password: string): Promise<string | null> {
  const res = await page.request.post('/api/auth/login', { data: { account, password } });
  if (!res.ok()) return null;
  return ((await res.json()) as { token: string }).token;
}

/** 探测结果缓存（worker 进程内）：避免每个用例×每次 ensureMember 都重打登录+me+列表。 */
let cachedAdmin: { email: string; token: string } | null = null;

/** 探测可用超管：登录 → GET /users/me 断言 systemRole（任务口径「先断言，不是则报告」）。 */
async function superAdmin(page: Page): Promise<{ email: string; token: string }> {
  if (cachedAdmin) return cachedAdmin;
  for (const email of ADMIN_EMAIL_CANDIDATES) {
    const token = await apiLogin(page, email, ADMIN_PASSWORD);
    if (!token) continue; // 号不存在（或密码不符）→ 试下一个候选
    const me = await page.request.get('/api/users/me', { headers: auth(token) });
    const body = (await me.json()) as { systemRole?: string };
    if (body.systemRole === 'super_admin') {
      cachedAdmin = { email, token };
      return cachedAdmin;
    }
    // 报告分支：候选号存在但非超管，终端留痕后继续探测
    console.warn(`[admin-users.e2e] 候选超管 ${email} 实为 ${body.systemRole ?? '未知'}，继续探测/回落`);
  }
  test.skip(true, `库内无可用超管（${ADMIN_EMAIL_CANDIDATES.join('/')} 均非 super_admin），任务 8 seed-demo 后重跑`);
  throw new Error('unreachable after skip');
}

/** 幂等前置：member0002 存在且启用（缺则建、停则启），供停用/登录/member 用例铺底。
 *  2026-10-21 分页契约：列表响应 { items, total, ... }，按 q 精确搜邮箱定位。 */
async function ensureMember(page: Page): Promise<void> {
  const admin = await superAdmin(page);
  const res0 = await page.request.get(`/api/admin/users?q=${MEMBER_EMAIL}`, { headers: auth(admin.token) });
  const found = ((await res0.json()) as { items: AdminItem[] }).items.find((u) => u.email === MEMBER_EMAIL);
  if (!found) {
    const res = await page.request.post('/api/admin/users', {
      headers: auth(admin.token),
      data: { email: MEMBER_EMAIL, nickname: '成员二号' },
    });
    expect(res.status()).toBe(201);
  } else if (found.status !== 'active') {
    const res = await page.request.patch(`/api/admin/users/${found.id}`, {
      headers: auth(admin.token),
      data: { status: 'active' },
    });
    expect(res.ok()).toBeTruthy();
  }
}

/** UI 登录（先清旧 token，避免上一用例会话串扰）；不落 URL 断言，由调用方按预期裁剪。
 *  2026-11-12 任务 7：驱动重做后的 LoginPage（login-account/login-password/login-submit
 *  testid，邮箱+密码表单）。 */
async function uiLogin(page: Page, account: string, password = ADMIN_PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.evaluate(() => localStorage.removeItem('gmind.token'));
  await page.getByTestId('login-account').fill(account);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
}

/** 按邮箱定位成员行（邮箱列唯一，不会误中昵称/时间列）。 */
function rowOf(page: Page, account: string) {
  return page.locator('[data-testid="admin-user-row"]').filter({ hasText: account });
}

test('超管：工作台「账号管理」入口 → 列表渲染，自己那行停用/降级禁用', async ({ page }) => {
  const admin = await superAdmin(page);
  await ensureMember(page); // 铺一个非自己的成员行（否则「他行可操作」反例无对象可断言）
  await uiLogin(page, admin.email);
  await expect(page).toHaveURL(/\/workspace/);

  await page.getByTestId('nav-org').click(); // 组织管理=侧栏一级入口（仅超管渲染，原型同款）
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByTestId('admin-users-page')).toBeVisible();
  await expect(page.getByTestId('admin-user-table')).toBeVisible();

  // 分页器渲染（2026-10-21 分页化）
  await expect(page.getByTestId('admin-pager')).toBeVisible();

  // 列表含自己：角色徽标=超级管理员（蓝），停用/角色切换禁用（title 防呆，后端 409 兜底）。
  // 分页后目标行不在首页——搜索手机号定位（防抖 300ms，断言自动重试覆盖）
  await page.getByTestId('admin-user-search').fill(admin.email);
  const selfRow = rowOf(page, admin.email);
  await expect(selfRow).toBeVisible();
  await expect(selfRow.getByTestId('user-role')).toHaveText('超级管理员');
  await expect(selfRow.getByTestId('toggle-status-btn')).toBeDisabled();
  await expect(selfRow.getByTestId('role-select')).toBeDisabled();
  // 反例：非自己的成员行操作可点
  await page.getByTestId('admin-user-search').fill(MEMBER_EMAIL);
  const otherRow = rowOf(page, MEMBER_EMAIL);
  await expect(otherRow).toBeVisible();
  await expect(otherRow.getByTestId('toggle-status-btn')).toBeEnabled();
  await expect(otherRow.getByTestId('role-select')).toBeEnabled();
});

test('添加账号 member0002（邮箱） → 列表出现（重跑幂等：已存在则 409 文案、行仍启用）', async ({ page }) => {
  const admin = await superAdmin(page);
  // 前置：若历史跑过已存在，先铺回启用态，保证「列表出现且状态=启用」断言稳定
  const res0 = await page.request.get(`/api/admin/users?q=${MEMBER_EMAIL}`, { headers: auth(admin.token) });
  const existed = ((await res0.json()) as { items: AdminItem[] }).items.find((u) => u.email === MEMBER_EMAIL);
  if (existed && existed.status !== 'active') {
    await page.request.patch(`/api/admin/users/${existed.id}`, { headers: auth(admin.token), data: { status: 'active' } });
  }

  await uiLogin(page, admin.email);
  await page.getByTestId('nav-org').click();
  await expect(page.getByTestId('admin-users-page')).toBeVisible();

  await page.getByTestId('add-user-btn').click();
  await expect(page.getByTestId('add-user-modal')).toBeVisible();
  await page.getByTestId('add-user-email').fill(MEMBER_EMAIL);
  await page.getByTestId('add-user-nickname').fill('成员二号');
  await page.getByTestId('add-user-confirm').click();

  // 首跑 201 →「已添加」；重跑 409 →「已绑定」（服务端两段式文案），两者都算通过
  await expect(page.getByTestId('toast')).toContainText(/已添加|已绑定/);
  await page.getByTestId('admin-user-search').fill(MEMBER_EMAIL); // 分页后搜索定位
  const row = rowOf(page, MEMBER_EMAIL);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('user-email')).toHaveText(MEMBER_EMAIL);
  await expect(row.getByTestId('user-status')).toContainText('启用');
  await expect(row.getByTestId('user-role')).toHaveText('成员');
});

test('停用（confirm）→ 状态即时变停用；有密码成员停用后登录逐字报「账号已被停用」', async ({ page }) => {
  await ensureMember(page);
  const admin = await superAdmin(page);

  await uiLogin(page, admin.email);
  // 经入口按钮走 SPA 导航（整页 reload 在 1.6 万行的开发库下更慢，且入口本身已另有用例覆盖）
  await page.getByTestId('nav-org').click();
  await expect(page.getByTestId('admin-user-table')).toBeVisible();

  await page.getByTestId('admin-user-search').fill(MEMBER_EMAIL); // 分页后搜索定位
  const row = rowOf(page, MEMBER_EMAIL);
  await expect(row.getByTestId('user-status')).toContainText('启用');
  page.once('dialog', (d) => d.accept()); // 只吃停用 confirm，不吞其他对话框
  await row.getByTestId('toggle-status-btn').click();
  await expect(row.getByTestId('user-status')).toContainText('停用');
  await expect(row.getByTestId('toggle-status-btn')).toHaveText('启用'); // 操作后控件随状态翻转

  // 停用闸区分度（2026-11-13 终审 Important）：原腿拿 member0002 登录断言「密码错误」
  // 无区分度——管理员建号无密码，密码闸（核密先于停用闸，auth.service.ts:41-48）先
  // 命中，停用闸坏了也过。改 apiRegister 造有密码成员 → admin API 停用 → UI 登录
  // 逐字断言停用文案；member0002 无密码死路已由 login-page.e2e ⑥b 覆盖，不再重复。
  const victim = await apiRegister(page.request);
  const listed = await page.request.get(`/api/admin/users?q=${victim.email}`, { headers: auth(admin.token) });
  const victimId = ((await listed.json()) as { items: AdminItem[] }).items.find((u) => u.email === victim.email)?.id;
  expect(victimId, '刚注册的成员必须能在管理列表搜到').toBeTruthy();
  const disabled = await page.request.patch(`/api/admin/users/${victimId}`, {
    headers: auth(admin.token),
    data: { status: 'disabled' },
  });
  expect(disabled.ok()).toBeTruthy();

  await uiLogin(page, victim.email, victim.password);
  await expect(page.locator('.error')).toContainText('账号已被停用，请联系管理员');
  await expect(page).toHaveURL(/\/login/);
});

test('member（邮箱注册）：工作台无「账号管理」入口', async ({ page }) => {
  // member 视角改经 helper 邮箱造号（apiRegister 即有密码可登录；member0002 无密码
  // 无法走 UI 登录——管理员建号的登录死路由 login-page.e2e ⑥b 钉死）
  const member = await apiRegister(page.request);
  await injectToken(page, member.token);
  await page.goto('/workspace');
  await expect(page).toHaveURL(/\/workspace/);

  // 对照组：member 侧栏无「组织管理」入口（原型口径：仅管理员可见）
  await expect(page.getByTestId('nav-org')).toHaveCount(0);
});

test('组织管理三页签（批次 A）：建部门/分组 → 账号行挂靠 → 回显；删除防呆', async ({ page }) => {
  const admin = await superAdmin(page);
  await uiLogin(page, admin.email);
  await expect(page).toHaveURL(/\/workspace/); // 等 token 落地（goto 整页刷新早于登录写入会弹回登录页）
  await page.goto('/admin/users');
  await expect(page.getByTestId('org-tabs')).toBeVisible();

  // 部门管理：新增 + 列表出现
  await page.getByTestId('org-tab-departments').click();
  const deptName = `研发部-${Date.now() % 100000}`;
  await page.getByTestId('dept-name-input').fill(deptName);
  await page.getByTestId('dept-add-btn').click();
  const deptItem = page.getByTestId('dept-item').filter({ hasText: deptName });
  await expect(deptItem).toBeVisible();

  // 账号管理：行内下拉挂部门 + 分组管理建组后挂靠
  await page.getByTestId('org-tab-groups').click();
  const groupName = `前端组-${Date.now() % 100000}`;
  await page.getByTestId('group-name-input').fill(groupName);
  await page.getByTestId('group-add-btn').click();
  await expect(page.getByTestId('group-item').filter({ hasText: groupName })).toBeVisible();

  await page.getByTestId('org-tab-accounts').click();
  await page.getByTestId('admin-user-search').fill(admin.email);
  const selfRow = rowOf(page, admin.email);
  await selfRow.getByTestId('account-dept-select').selectOption({ label: deptName });
  await expect(selfRow.getByTestId('account-dept-select')).toHaveValue(/.+/);
  // 分组 popover 勾选（勾选即存，popover 关闭由 mask）
  await selfRow.locator('[data-testid^="account-groups-btn-"]').click();
  await selfRow.locator('[data-testid^="groups-popover-"]').locator('label').filter({ hasText: groupName }).click();
  // mask 全屏铺底、popover 浮其上——点视口左上角避开浮层本体
  await page.locator('.popover-mask').click({ position: { x: 5, y: 5 } });
  await expect(selfRow.locator('.group-tag').filter({ hasText: groupName })).toBeVisible();

  // 删除防呆：账号仍挂部门 → 删除 409 文案 toast
  await page.getByTestId('org-tab-departments').click();
  await page.on('dialog', (d) => d.accept());
  await deptItem.getByRole('button', { name: '删除' }).click();
  await expect(page.getByTestId('toast')).toContainText('请先转移账号');
});
