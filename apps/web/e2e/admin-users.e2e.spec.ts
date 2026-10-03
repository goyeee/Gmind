import { expect, test, type Page } from '@playwright/test';

/**
 * 账号管理 UI E2E（移植 mindgrid 账号体系）：超管入口门 + 成员表 + 添加账号 + 停用踢号 +
 * member 无入口。依赖开发库（API_ORIGIN 指向的 server + gmind 库）。
 *
 * 超管号说明（任务口径：以 13800000001 为「现库超管」，脚本内先 GET me 断言、不是则报告）：
 * 实测 2026-10-03 开发库中 13800000001 为 member——迁移实际升的最早用户是 13900009999
 * （dbg 调试号）。故按序探测候选号：13800000001 优先，非超管时 console.warn 报告并回落
 * 13900009999；两者都不可用时 skip（环境缺超管，非产品缺陷）。
 * 固定成员号 13900000002（任务指定）：首跑经 UI 添加创建；重跑已存在则接受 409 幂等，
 * 各用例自行为其铺「存在且启用」前置（API ensureMember），互不依赖执行顺序。
 */

// 开发库常年累积 e2e 注册号（1.6 万+），列表渲染/断言天然偏慢：本文件放宽断言超时
expect.configure({ timeout: 15_000 });

/** 超管候选（按序探测）：[0] 为任务假定号；[1] 为当前开发库迁移实际升的超管。 */
const ADMIN_PHONE_CANDIDATES = ['13800000001', '13900009999'];
/** 任务指定的固定成员号（添加账号用例造出；member 视角复用）。 */
const MEMBER_PHONE = '13900000002';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

interface AdminItem {
  id: string;
  phone: string | null;
  nickname: string;
  systemRole: 'super_admin' | 'member';
  status: 'active' | 'disabled';
}

async function apiLogin(page: Page, phone: string): Promise<string | null> {
  const res = await page.request.post('/api/auth/login', { data: { method: 'phone', phone, code: '123456' } });
  if (!res.ok()) return null;
  return ((await res.json()) as { token: string }).token;
}

/** 探测结果缓存（worker 进程内）：避免每个用例×每次 ensureMember 都重打登录+me+列表。 */
let cachedAdmin: { phone: string; token: string } | null = null;

/** 探测可用超管：登录 → GET /users/me 断言 systemRole（任务口径「先断言，不是则报告」）。 */
async function superAdmin(page: Page): Promise<{ phone: string; token: string }> {
  if (cachedAdmin) return cachedAdmin;
  for (const phone of ADMIN_PHONE_CANDIDATES) {
    const token = await apiLogin(page, phone);
    if (!token) continue; // 号不存在（或登录失败）→ 试下一个候选
    const me = await page.request.get('/api/users/me', { headers: auth(token) });
    const body = (await me.json()) as { systemRole?: string };
    if (body.systemRole === 'super_admin') {
      cachedAdmin = { phone, token };
      return cachedAdmin;
    }
    // 报告分支：候选号存在但非超管（含任务假定的 13800000001），终端留痕后继续探测
    console.warn(`[admin-users.e2e] 候选超管 ${phone} 实为 ${body.systemRole ?? '未知'}，继续探测/回落`);
  }
  test.skip(true, `开发库无可用超管（${ADMIN_PHONE_CANDIDATES.join('/')} 均非 super_admin），请先指定超管后重跑`);
  throw new Error('unreachable after skip');
}

/** 幂等前置：13900000002 存在且启用（缺则建、停则启），供停用/登录/member 用例铺底。 */
async function ensureMember(page: Page): Promise<void> {
  const admin = await superAdmin(page);
  const list = (await (await page.request.get('/api/admin/users', { headers: auth(admin.token) })).json()) as AdminItem[];
  const found = list.find((u) => u.phone === MEMBER_PHONE);
  if (!found) {
    const res = await page.request.post('/api/admin/users', {
      headers: auth(admin.token),
      data: { phone: MEMBER_PHONE, nickname: '成员二号' },
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

/** UI 登录（先清旧 token，避免上一用例会话串扰）；不落 URL 断言，由调用方按预期裁剪。 */
async function uiLogin(page: Page, phone: string): Promise<void> {
  await page.goto('/login');
  await page.evaluate(() => localStorage.removeItem('gmind.token'));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

/** 按手机号定位成员行（手机号列唯一，不会误中昵称/时间列）。 */
function rowOf(page: Page, phone: string) {
  return page.locator('[data-testid="admin-user-row"]').filter({ hasText: phone });
}

test('超管：工作台「账号管理」入口 → 列表渲染，自己那行停用/降级禁用', async ({ page }) => {
  const admin = await superAdmin(page);
  await ensureMember(page); // 铺一个非自己的成员行（否则「他行可操作」反例无对象可断言）
  await uiLogin(page, admin.phone);
  await expect(page).toHaveURL(/\/workspace/);

  await expect(page.getByTestId('admin-users-entry')).toBeVisible();
  await page.getByTestId('admin-users-entry').click();
  await expect(page).toHaveURL(/\/admin\/users/);
  await expect(page.getByTestId('admin-users-page')).toBeVisible();
  await expect(page.getByTestId('admin-user-table')).toBeVisible();

  // 列表含自己：角色徽标=超级管理员（蓝），停用/角色切换禁用（title 防呆，后端 409 兜底）
  const selfRow = rowOf(page, admin.phone);
  await expect(selfRow).toBeVisible();
  await expect(selfRow.getByTestId('user-role')).toHaveText('超级管理员');
  await expect(selfRow.getByTestId('toggle-status-btn')).toBeDisabled();
  await expect(selfRow.getByTestId('role-select')).toBeDisabled();
  // 反例：非自己的成员行操作可点
  const otherRow = rowOf(page, MEMBER_PHONE);
  await expect(otherRow.getByTestId('toggle-status-btn')).toBeEnabled();
  await expect(otherRow.getByTestId('role-select')).toBeEnabled();
});

test('添加账号 13900000002 → 列表出现（重跑幂等：已存在则 409 文案、行仍启用）', async ({ page }) => {
  const admin = await superAdmin(page);
  // 前置：若历史跑过已存在，先铺回启用态，保证「列表出现且状态=启用」断言稳定
  const list = (await (await page.request.get('/api/admin/users', { headers: auth(admin.token) })).json()) as AdminItem[];
  const existed = list.find((u) => u.phone === MEMBER_PHONE);
  if (existed && existed.status !== 'active') {
    await page.request.patch(`/api/admin/users/${existed.id}`, { headers: auth(admin.token), data: { status: 'active' } });
  }

  await uiLogin(page, admin.phone);
  await page.getByTestId('admin-users-entry').click();
  await expect(page.getByTestId('admin-users-page')).toBeVisible();

  await page.getByTestId('add-user-btn').click();
  await expect(page.getByTestId('add-user-modal')).toBeVisible();
  await page.getByTestId('add-user-phone').fill(MEMBER_PHONE);
  await page.getByTestId('add-user-nickname').fill('成员二号');
  await page.getByTestId('add-user-confirm').click();

  // 首跑 201 →「已添加」；重跑 409 →「已注册」（服务端两段式文案），两者都算通过
  await expect(page.getByTestId('toast')).toContainText(/已添加|已注册/);
  const row = rowOf(page, MEMBER_PHONE);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('user-phone')).toHaveText(MEMBER_PHONE);
  await expect(row.getByTestId('user-status')).toContainText('启用');
  await expect(row.getByTestId('user-role')).toHaveText('成员');
});

test('停用 13900000002（confirm）→ 状态即时变停用，该号登录被拒', async ({ page }) => {
  await ensureMember(page);
  const admin = await superAdmin(page);

  await uiLogin(page, admin.phone);
  // 经入口按钮走 SPA 导航（整页 reload 在 1.6 万行的开发库下更慢，且入口本身已另有用例覆盖）
  await page.getByTestId('admin-users-entry').click();
  await expect(page.getByTestId('admin-user-table')).toBeVisible();

  const row = rowOf(page, MEMBER_PHONE);
  await expect(row.getByTestId('user-status')).toContainText('启用');
  page.once('dialog', (d) => d.accept()); // 只吃停用 confirm，不吞其他对话框
  await row.getByTestId('toggle-status-btn').click();
  await expect(row.getByTestId('user-status')).toContainText('停用');
  await expect(row.getByTestId('toggle-status-btn')).toHaveText('启用'); // 操作后控件随状态翻转

  // 停用踢号：该号登录被拒（401 文案两段式），停留登录页
  await uiLogin(page, MEMBER_PHONE);
  await expect(page.locator('.error')).toContainText('账号已被停用');
  await expect(page).toHaveURL(/\/login/);
});

test('member（13900000002 启用后）：工作台无「账号管理」入口', async ({ page }) => {
  await ensureMember(page);
  await uiLogin(page, MEMBER_PHONE);
  await expect(page).toHaveURL(/\/workspace/);

  // 对照组：头部已渲染（账号设置在），仅账号管理入口不渲染
  await expect(page.getByTestId('settings-entry')).toBeVisible();
  await expect(page.getByTestId('admin-users-entry')).toHaveCount(0);
});
