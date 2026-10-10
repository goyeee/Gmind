import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { MAX_DOC_NODES } from '@gmind/shared';
import { addChild, createTemplateDoc, ROOT_NODE_ID } from '@gmind/core';
import { exportImage } from '../src/editor/image-export';
import { QUOTA_ADD_BLOCKED, QUOTA_STATUS } from '../src/editor/saveLoop';

/**
 * NFR-USE-005 错误文案走查（M5 Task 7）——逐分支断言「失败原因 + 用户可执行的
 * 下一步动作」，禁止仅「操作失败」形态。
 *
 * 走查清单（PRD 高频异常分支 10 条）与各分支的断言层级：
 * ① 离线提示（FR-EDT-034 第三态）——e2e（__gmindCollab.setReachable 确定性断 WS，
 *   collab.e2e.spec.ts 用例 2/3/4 已覆盖行为，此处钉文案两半）；
 * ② 配额拦截（quota-exceeded）——常量级（QUOTA_STATUS/QUOTA_ADD_BLOCKED 是唯一
 *   渲染源：EditorPage statusText/addBlockedByQuota 直接消费）；e2e 编排 >500 节点
 *   代价过高（perf-editor.spec.ts 全程压在 ≤500），登记为常量级断言；
 * ③ 404 文件不存在——e2e（/edit/<26 位 ULID 形状> → EditorPage 错误态）；
 * ④ 401 登录过期——e2e（注入失效 token → 工作台错误条 + token 清除断言；
 *   「跳转登录」行为由 m0-acceptance.e2e.spec.ts 的 RequireAuth 用例钉死）；
 * ⑤ 分享链接失效页——e2e（/s/<未知 token>；share.e2e.spec.ts 已覆盖「链接已失效」
 *   + 返回工作台，此处补「联系分享者」下一步的钉子）；
 * ⑥ 导入三归因——大小超限/损坏走 e2e（import-export.e2e.spec.ts 同款夹具），
 *   格式不受支持（合法 zip 缺 content.*）构造依赖 fflate（xmind-io 私有依赖，
 *   e2e 进程不可解析）——unit 级钉在 src/editor/xmind-import.test.ts；
 * ⑦ 导出过大——node 级（exportImage 的 >MAX_DOC_NODES 客户端闸门先于一切 DOM
 *   操作，guard 语义在 node 进程可直接复现）；
 * ⑧ 评论 501 字 / 图片超限——e2e（评论面板 400 透出服务端 message；图片前置
 *   拦截 toast）；
 * ⑨ 邀请批量非法——e2e 轻重断言（主覆盖 member-invite.e2e.spec.ts 用例 1）；
 * ⑩ 改绑被占 409——e2e（B 账号先占用手机号 → A 改绑 → SettingsPage 错误条）。
 */

/** collab.ts 的 dev-only 断连钩子（collab.e2e.spec.ts 同款声明）。 */
interface CollabHooks {
  setReachable(reachable: boolean): void;
}

async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
}

/** 打开种子文件进入编辑器，等待 root 文本渲染（editor spec 既定模式）。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: title }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

/** 经 API 注册/登录并返回 token（share spec 同款 helper）。 */
async function apiLogin(request: APIRequestContext, phone: string): Promise<string> {
  const res = await request.post('/api/auth/login', { data: { method: 'phone', phone, code: '123456' } });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { token: string }).token;
}

const randomPhone = () => '138' + String(Math.floor(10000000 + Math.random() * 89999999));

// ① 离线提示：原因「离线编辑中」+ 下一步「恢复联网后自动同步」（M2 交付文案，
//    EditorPage OFFLINE_STATUS 单一渲染源）
test('① 断网编辑：save-status 离线文案含原因与「恢复联网后自动同步」下一步', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.evaluate(() => {
    (window as unknown as { __gmindCollab?: CollabHooks }).__gmindCollab?.setReachable(false);
  });
  const status = page.getByTestId('save-status');
  await expect(status).toContainText('离线编辑中', { timeout: 10_000 });
  await expect(status).toContainText('恢复联网后自动同步');
});

// ② 配额拦截：两处文案（PUT 403 终态 / WS 广播新增拦截）均含「上限（500）」原因
//    与「删除部分节点」动作。常量即渲染源（EditorPage statusText('quota') 与
//    addBlockedByQuota toast 直接消费），常量级断言等价于 UI 呈现。
test('② 配额拦截文案：上限数值（原因）+ 删除节点（下一步）——saveLoop 常量级', () => {
  expect(QUOTA_STATUS).toContain(`文档节点数超过上限（${MAX_DOC_NODES}）`);
  expect(QUOTA_STATUS).toContain('请删除部分节点');
  expect(QUOTA_ADD_BLOCKED).toContain(`文档节点数已达上限`);
  expect(QUOTA_ADD_BLOCKED).toContain('请删除部分节点');
});

// ③ 404：错误态文案含存在性/权限归因 + 「返回工作台」行动入口（按钮与文案同屏）
test('③ 404 文件不存在：错误态含「可能已被删除或无权限」+ 返回工作台入口', async ({ page }) => {
  await registerAndLogin(page);
  // 26 位 ULID 形状但不存在的 fileId（telemetry spec 同款口径：无 IndexedDB 副本）
  await page.goto('/edit/01ARZ3NDEKTSV4RRFFQ69G5FAV');
  const err = page.locator('.editor-error');
  await expect(err).toBeVisible();
  await expect(err).toContainText('文件不存在');
  await expect(err).toContainText('可能已被删除或无权限');
  await expect(err.getByRole('button', { name: '返回工作台' })).toBeVisible();
});

// ④ 401 过期：带 token 请求 401 → 错误条含「登录已过期」原因 + 「请重新登录」下一步；
//    token 已被清除（此后任意导航经 RequireAuth 落登录页——m0-acceptance 已钉）
test('④ 401 登录过期：错误文案含「请重新登录」且本地 token 已清除', async ({ page }) => {
  await page.addInitScript(
    (t) => localStorage.setItem('gmind.token', t),
    'expired-token-for-copy-walkthrough',
  );
  await page.goto('/workspace');
  const error = page.locator('.error');
  await expect(error).toContainText('登录已过期');
  await expect(error).toContainText('请重新登录');
  expect(await page.evaluate(() => localStorage.getItem('gmind.token'))).toBeNull();
});

// ⑤ 分享失效页：原因「链接已失效/不存在或已被关闭」+ 下一步「联系分享者」与
//    返回工作台入口（share.e2e.spec.ts 已钉「链接已失效」+按钮，此处补联系分享者）
test('⑤ 分享链接失效页：链接已失效（原因）+ 联系分享者 / 返回工作台（下一步）', async ({ page }) => {
  await page.goto(`/s/${'ff'.repeat(16)}`);
  const invalid = page.getByTestId('share-invalid');
  await expect(invalid).toBeVisible();
  await expect(invalid).toContainText('链接已失效');
  await expect(invalid).toContainText('联系分享者');
  await expect(invalid.getByRole('button', { name: '返回工作台' })).toBeVisible();
});

// ⑥ 导入三归因（大小超限/损坏 e2e；格式不受支持 unit 级见 xmind-import.test.ts）：
//    两半 = 归因文案（verbatim）+ 「请…后重试」动作
test('⑥ 导入归因：大小超限/已损坏 toast 含原因与下一步动作', async ({ page }) => {
  await registerAndLogin(page);
  // 大小预检先于解析：21MB 恒定填充即触发
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '超大.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(21 * 1024 * 1024, 0),
  });
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('文件大小超过 20MB 上限');
  await expect(toast).toContainText('请压缩后重试');

  // 非 zip 乱字节 → 解析损坏归因
  await page.getByTestId('import-button').click();
  await page.getByTestId('import-input').setInputFiles({
    name: '损坏.xmind',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(1024, 0x07),
  });
  await expect(toast).toContainText('文件已损坏，无法解析');
  await expect(toast).toContainText('请检查文件后重试');
});

// ⑦ 导出过大（FR-IO-005 客户端闸门）：原因「文件过大」+ 下一步「拆分后导出」。
//    guard 在任何 DOM/Canvas 操作之前，node 进程内构造 >500 节点 doc 直接复现。
test('⑦ 导出过大：拒绝文案含「文件过大」+「拆分后导出」——node 级闸门复现', async () => {
  const doc = createTemplateDoc({ title: '超大文档', children: [] });
  for (let i = 0; i <= MAX_DOC_NODES; i += 1) {
    addChild(doc, ROOT_NODE_ID, { text: `分支${i}` });
  }
  await expect(
    exportImage(doc, '超大文档', { format: 'png', scale: 1, transparent: true }),
  ).rejects.toThrow('文件过大，请拆分后导出');
});

// ⑧a 评论 501 字：服务端 400 message 透出——含上限数值（原因）+ 精简动作（下一步）
test('⑧a 评论超 500 字：toast 含「500 字」上限数值与下一步动作', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  // 评论右列默认不渲染（M7b-R6）：工具栏 comment-toggle 开启（2026-10-10 插入菜单删除后路径）
  await page.getByTestId('comment-toggle').click();
  // 装配完成默认单选 root → 评论输入可用
  const input = page.getByTestId('comment-input');
  await expect(input).toBeEnabled();
  await input.fill('长'.repeat(501));
  await page.getByTestId('comment-send').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('评论内容最多 500 字');
  await expect(toast).toContainText('请精简后重发');
});

// ⑧b 图片超限：前置拦截 toast——含 10MB 数值（原因）+ 压缩动作（下一步）
test('⑧b 图片超 10MB：toast 含「10MB 限制」上限数值与下一步动作', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  const panel = page.getByTestId('rich-panel');
  await page.getByTestId('format-toggle').click(); // 右列默认隐藏（M7b-R6）：点格式开
  await expect(panel).toBeVisible();
  await panel.getByTestId('image-input').setInputFiles({
    name: '巨图.png',
    mimeType: 'image/png',
    buffer: Buffer.alloc(11 * 1024 * 1024, 1),
  });
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('图片大小超出 10MB 限制');
  await expect(toast).toContainText('请压缩后重试');
});

// ⑨ 邀请批量非法：服务端 400 逐条回列（原因）+ 修正重发提示（下一步）。
//    主覆盖 member-invite.e2e.spec.ts 用例 1，此处为文案两半的轻量再钉。
test('⑨ 邀请批量非法：toast 逐条原因 + 修正提示', async ({ page }) => {
  await openSeedDoc(page, '本周计划');
  await page.getByTestId('members-btn').click();
  await expect(page.getByTestId('invite-section')).toBeVisible();
  await page.getByTestId('invite-input').fill('bad-email');
  await page.getByTestId('invite-submit').click();
  const toast = page.getByTestId('toast');
  await expect(toast).toContainText('联系人格式非法');
  await expect(toast).toContainText('bad-email');
  await expect(toast).toContainText('请修正后重新发送');
});

// ⑩ 改绑被占 409：服务端「已绑定其他账号」（原因）+ 换用其他手机号（下一步）。
//    B 账号先占用目标手机号（API 注册）→ A（UI 登录）改绑必 409。
test('⑩ 改绑被占 409：错误文案含「已绑定其他账号」+ 换用其他手机号', async ({ page, request }) => {
  const occupiedPhone = randomPhone();
  await apiLogin(request, occupiedPhone); // B：占用该手机号
  await registerAndLogin(page); // A：另一新账号
  await page.getByTestId('settings-entry').click();
  await expect(page.getByTestId('settings-page')).toBeVisible();
  // 等 me 身份装载完成再操作：reload() 异步到达时的 setChannel 会重置渠道选择
  // （手机号注册用户缺省换邮箱），先于装载的 selectOption 会被覆盖回 email
  await expect(page.getByTestId('rebind-section').locator('.settings-hint')).toContainText('当前绑定：手机号');
  await page.getByTestId('rebind-channel').selectOption('phone');
  await page.getByTestId('rebind-identity').fill(occupiedPhone);
  await page.getByTestId('rebind-code').fill('123456');
  await page.getByTestId('rebind-save').click();
  const err = page.getByTestId('rebind-section').locator('.error');
  await expect(err).toContainText('该手机号已绑定其他账号');
  await expect(err).toContainText('请换用其他手机号');
});
