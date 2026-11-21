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
  // e2e- 前缀=判据化命名（AGENTS 六.6）：globalTeardown 清理脚本按 name LIKE 'e2e-%' 删
  const deptName = `e2e-研发部-${Date.now() % 100000}`;
  await page.getByTestId('dept-name-input').fill(deptName);
  await page.getByTestId('dept-add-btn').click();
  const deptItem = page.getByTestId('dept-item').filter({ hasText: deptName });
  await expect(deptItem).toBeVisible();

  // 账号管理：行内下拉挂部门 + 分组管理建组后挂靠
  await page.getByTestId('org-tab-groups').click();
  const groupName = `e2e-前端组-${Date.now() % 100000}`;
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


/** 分组快速连选回归（2026-11-21 需求方反馈「设置不上也关闭不了」）：
 *  弹层里快速连选 3 个分组（不等列表回刷）——草稿基准修复后全部保留；随后逐个
 *  取消也全部生效（此前每次点击拿旧 props 全量 PATCH，慢回刷窗口内互相覆盖）。 */
test('分组连选/取消不互相覆盖：快速三连选全保留，逐个取消全生效', async ({ page }) => {
  const admin = await superAdmin(page);
  await uiLogin(page, admin.email);
  await page.waitForURL(/workspace/); // 登录跳转完成再进管理页（否则 goto 抢跑回登录页）
  await page.goto('/admin/users');
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();

  // 造 3 个独立分组（避免与既有勾选纠缠）；断言建组成功——dev server 重启窗口里
  // 代理会 500，静默吞掉会让后续「弹层找不到 label」变成无头悬案（2026-11-21 实录）
  const stamp = Date.now() % 1000000;
  const names = [`e2e-连选甲-${stamp}`, `e2e-连选乙-${stamp}`, `e2e-连选丙-${stamp}`];
  for (const name of names) {
    const created = await page.request.post('/api/org/groups', { headers: auth(admin.token), data: { name } });
    expect(created.status()).toBe(201);
  }
  await page.reload();
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();

  // 定位固定成员号行并打开弹层
  await page.getByTestId('admin-user-search').fill(MEMBER_EMAIL);
  const row = rowOf(page, MEMBER_EMAIL);
  await expect(row).toBeVisible();
  await row.locator('[data-testid^="account-groups-btn-"]').click();
  const pop = row.locator('[data-testid^="groups-popover-"]');

  // 快速三连选（中间不等回刷——复现旧缺陷的节奏）
  for (const name of names) {
    await pop.locator('label').filter({ hasText: name }).locator('input').click();
  }
  // 回刷完成后三个全保留
  await page.waitForTimeout(1500);
  for (const name of names) {
    await expect(pop.locator('label').filter({ hasText: name }).locator('input')).toBeChecked();
    // 行标签取 groups-cell 直接子级（弹层里的同名 group-tag 不算）
    await expect(row.locator('.groups-cell > .group-tag').filter({ hasText: name })).toBeVisible();
  }
  // 接口复核
  const saved = await page.evaluate(async (email) => {
    const r = await fetch(`/api/admin/users?page=1&size=20&q=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('gmind.token') ?? ''}` },
    });
    const d = (await r.json()) as { items: Array<{ email: string; groupIds: string[] }> };
    return d.items.find((x) => x.email === email)?.groupIds;
  }, MEMBER_EMAIL);
  for (const name of names) {
    const id = await page.evaluate(async (n) => {
      const r = await fetch('/api/org/groups', { headers: { Authorization: `Bearer ${localStorage.getItem('gmind.token') ?? ''}` } });
      const d = await r.json();
      return (d as Array<{ id: string; name: string }>).find((g) => g.name === n)!.id;
    }, name);
    expect(saved).toContain(id);
  }

  // 逐个取消（同样快速）→ 全部生效
  for (const name of names) {
    await pop.locator('label').filter({ hasText: name }).locator('input').click();
  }
  await page.waitForTimeout(1500);
  for (const name of names) {
    await expect(pop.locator('label').filter({ hasText: name }).locator('input')).not.toBeChecked();
    await expect(row.locator('.groups-cell > .group-tag').filter({ hasText: name })).toHaveCount(0);
  }
});

/** 小视口布局回归（2026-11-21 需求方反馈「点击编辑没反应 / 列表无法向下滚动」）：
 *  ws-content 是 flex 纵向容器，admin-user-table 曾带 overflow:hidden + 默认
 *  flex-shrink——行多时表格被压进视口且不产生滚动条，行内分组弹层也被表格底边
 *  裁掉（弹层实际开着但不可见，用户后续点击全落在透明 mask 上，表现为
 *  「设置不上也关闭不了」）。修复=表格 overflow:visible + flex:none（滚动交给
 *  ws-content），本用例小视口锁死两处计算样式 + 底部行弹层真实可点。 */
test('组织管理小视口：列表可滚动，底部行分组弹层不被表格裁剪', async ({ page }) => {
  const admin = await superAdmin(page);
  await uiLogin(page, admin.email);
  await page.waitForURL(/workspace/);
  await page.goto('/admin/users');
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();

  // 压到 420 高：无论库内账号多少，列表都必然超过视口（触发旧病的条件）
  await page.setViewportSize({ width: 1000, height: 420 });

  // 修复点锁死：表格不自裁剪、不被 flex 压缩（滚动交给 ws-content）
  const layout = await page.evaluate(() => {
    const table = document.querySelector('[data-testid="admin-user-table"]');
    const content = document.querySelector('.ws-content.admin-users-page');
    return {
      tableOverflow: getComputedStyle(table!).overflow,
      tableFlex: getComputedStyle(table!).flex,
      scrollable: content!.scrollHeight > content!.clientHeight,
    };
  });
  expect(layout.tableOverflow).toBe('visible');
  expect(layout.tableFlex).toBe('0 0 auto');
  expect(layout.scrollable).toBe(true);

  // 行为回归：滚到底后末行弹层真实可点——若表格回归 overflow:hidden，
  // 末行不可见/弹层被裁，此处的可见性与命中检查直接失败
  const lastRow = page.locator('[data-testid="admin-user-row"]').last();
  await lastRow.scrollIntoViewIfNeeded();
  await expect(lastRow.locator('.groups-edit-btn')).toBeVisible();
  await lastRow.locator('[data-testid^="account-groups-btn-"]').click();
  const pop = lastRow.locator('[data-testid^="groups-popover-"]');
  const firstItem = pop.locator('.groups-popover-item').first();
  await firstItem.scrollIntoViewIfNeeded();
  // 勾两次=净零，不留下测试数据（AGENTS 六.6）
  await firstItem.locator('input').click();
  await expect(firstItem.locator('input')).toBeChecked();
  await firstItem.locator('input').click();
  await expect(firstItem.locator('input')).not.toBeChecked();
});

/** 矮行分组弹层真实点击回归（2026-11-21 需求方反馈「按钮点击没反应/分组功能无法使用」）：
 *  .admin-table-row .cell 的 overflow:hidden（0-2-0）压过 .groups-cell 的 visible
 *  （0-1-0）——无标签矮行（22px）里 absolute 弹层（top:26px 起整块在格外）被裁剪成
 *  **不可见也不可命中**，而 fixed 透明 mask（z=90）不受裁剪照常全屏生效，任何点击
 *  都落在 mask 上关闭弹层，表现为「点了没反应」。定位器点击走不到真实命中路径
 *  （修复前也能过），本用例全程 page.mouse.click 真实坐标 + elementFromPoint 命中
 *  断言，锁定「弹层看得见且点得着」。 */
test('分组弹层真实点击：无标签矮行上弹层可见可点、外点关闭（裁剪回归）', async ({ page }) => {
  const admin = await superAdmin(page);
  await uiLogin(page, admin.email);
  await page.waitForURL(/workspace/);
  await page.goto('/admin/users');
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();

  // 无标签矮行（groups-cell 无直接 group-tag 子级——弹层整块落在格外，裁剪必现条件）
  const shortRow = page
    .locator('[data-testid="admin-user-row"]:has(.groups-cell:not(:has(> .group-tag)))')
    .first();
  await expect(shortRow).toBeVisible();

  // 真实鼠标点开弹层
  const btn = shortRow.locator('[data-testid^="account-groups-btn-"]');
  const bb = await btn.boundingBox();
  await page.mouse.click(bb!.x + bb!.width / 2, bb!.y + bb!.height / 2);
  const pop = shortRow.locator('[data-testid^="groups-popover-"]');
  await expect(pop).toBeVisible();

  // 命中断言：勾选框中心的最顶层元素必须是勾选框本身（裁剪病发作时是 .popover-mask）
  const hit = await pop.locator('input').first().evaluate((el) => {
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return { tag: top?.tagName.toLowerCase(), cls: String(top?.className), inPop: !!top?.closest('[data-testid^="groups-popover-"]') };
  });
  expect(hit.inPop, `弹层被裁剪/被遮罩压住：命中了 ${hit.tag}.${hit.cls}`).toBe(true);

  // 真实鼠标勾选：状态变化且弹层不关（草稿机制）；再勾一次=净零不留数据（AGENTS 六.6）
  const input = pop.locator('input').first();
  const cb = await input.boundingBox();
  await page.mouse.click(cb!.x + cb!.width / 2, cb!.y + cb!.height / 2);
  await expect(input).toBeChecked();
  await expect(pop).toBeVisible();
  await page.mouse.click(cb!.x + cb!.width / 2, cb!.y + cb!.height / 2);
  await expect(input).not.toBeChecked();

  // 真实鼠标外点（页头空白处）→ 弹层关闭
  await page.mouse.click(60, 100);
  await expect(pop).toHaveCount(0);
});
