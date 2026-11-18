import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { registerAndLogin } from './helpers/auth';

/**
 * 轮 2 筛选双层化 e2e（2026-11-15 需求方拍板）：
 * ①筛选改动默认仅自己可见（「· 仅你可见」标记）；
 * ②「对所有人生效」写入文档成为公共筛选，他人打开默认使用；
 * ③队友发布时，无个人调整者自动跟随 + toast「xx 更改了筛选条件」，
 *   有个人调整者筛选不动、仅弹 toast；
 * ④「恢复为公共筛选」回到团队公共状态；
 * ⑤公共筛选不含 keyword（搜索关键词仅本次会话）；
 * ⑥旧 localStorage 视图（scope:'me'）自动迁移为「负责人=我」。
 */

/** 打开种子文件进入编辑器（collab.e2e 同款辅助）。 */
async function openSeedDoc(page: Page, title: string): Promise<void> {
  await registerAndLogin(page);
  await page.getByTestId('file-card').filter({ hasText: title }).first().click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: title })).toBeVisible();
}

function fileIdFromUrl(page: Page): string {
  const m = /\/edit\/([0-9A-Za-z]+)/.exec(page.url());
  if (!m || !m[1]) throw new Error(`URL 中无 fileId：${page.url()}`);
  return m[1];
}

async function grantCollaborator(
  request: APIRequestContext,
  fileId: string,
  email: string,
): Promise<void> {
  const res = await request.post('/api/dev-e2e/grant-collaborator', { data: { fileId, email } });
  if (!res.ok()) throw new Error(`授予协作者失败：${res.status()}`);
}

/** 经当前条件构建器添加「负责人=我」（旧版负责人下拉已退役）。 */
async function pickOwner(page: Page): Promise<string> {
  await page.getByTestId('map-filter-toggle').click();
  const pop = page.getByTestId('map-filter-pop');
  await expect(pop).toBeVisible();
  await pop.getByRole('button', { name: '＋ 添加筛选条件' }).click();
  await pop.getByRole('menuitem', { name: '负责人', exact: true }).click();
  await pop.getByTestId('map-filter-owners').getByLabel('我', { exact: true }).check();
  // 再点 toggle 关闭弹窗（Escape 可能被全局键盘监听拦截）
  await page.getByTestId('map-filter-toggle').click();
  await expect(pop).toHaveCount(0);
  return '我';
}

test.describe('轮 2 筛选双层化', () => {
  test('筛选弹窗：点击画布空白自动收起（pointerdown 外点关闭）', async ({ page }) => {
    await openSeedDoc(page, '本周计划');
    await page.getByTestId('map-filter-toggle').click();
    await expect(page.getByTestId('map-filter-pop')).toBeVisible();
    // 画布空白点击：onSvgPointerDown 的 preventDefault 会抑制兼容性 mousedown，
    // 旧实现用 mousedown 监听因此收不起；pointerdown 修复后应立即收起
    // 画布空白点击：onSvgPointerDown 的 preventDefault 会抑制兼容性 mousedown，
    // 旧实现用 mousedown 监听因此收不起；pointerdown 修复后应立即收起。
    // 落点取画布中下部（30,30 会被顶部筛选弹窗本身覆盖，点不到画布）
    await page.locator('.editor-canvas').click({ position: { x: 600, y: 500 } });
    await expect(page.getByTestId('map-filter-pop')).toHaveCount(0);
    // 再点筛选按钮可重新打开（toggle 在 wrap 内，不被外点监听打断）
    await page.getByTestId('map-filter-toggle').click();
    await expect(page.getByTestId('map-filter-pop')).toBeVisible();
  });

  // 用例 ①：改动默认仅自己可见 → 点「对所有人生效」→ 新用户打开同文件看到相同筛选
  test('基础双层：改动仅你可见 → 对所有人生效 → 他人打开默认使用公共筛选', async ({ browser, request }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await openSeedDoc(pageA, '本周计划');
    const fileId = fileIdFromUrl(pageA);

    // 初始：无公共筛选 → 无「· 仅你可见」（空筛选 = 同步态）
    await expect(pageA.getByTestId('map-filter-personal-badge')).toHaveCount(0);

    // A 改筛选 → 出现「· 仅你可见」
    await pickOwner(pageA);
    await expect(pageA.getByTestId('map-filter-personal-badge')).toBeVisible();

    // A 点「对所有人生效」→ 「已同步给所有人」徽章出现，「· 仅你可见」消失
    await pageA.getByTestId('map-filter-toggle').click();
    await pageA.getByTestId('map-filter-publish').click();
    await expect(pageA.getByTestId('map-filter-synced-badge')).toBeVisible();
    await expect(pageA.getByTestId('map-filter-personal-badge')).toHaveCount(0);

    // B 打开同文件 → 默认使用公共筛选（无「· 仅你可见」，弹窗头显示已同步）
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const { email: emailB } = await registerAndLogin(pageB);
    await grantCollaborator(request, fileId, emailB);
    await pageB.goto(`/edit/${fileId}`);
    await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(pageB.getByTestId('map-filter-personal-badge')).toHaveCount(0);
    // B 是接收人：弹窗头不显示「已同步给所有人」
    await pageB.getByTestId('map-filter-toggle').click();
    await expect(pageB.getByTestId('map-filter-synced-badge')).toHaveCount(0);
    await pageB.getByTestId('map-filter-toggle').click(); // 关弹窗

    await ctxA.close();
    await ctxB.close();
  });

  // 用例 ②：A 发布时 B 无个人调整 → B 自动跟随 + toast；B 有个人调整 → B 筛选不动 + toast
  test('协同跟随 + 冲突保护：无个人调整者跟随，有个人调整者不动', async ({ browser, request }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await openSeedDoc(pageA, '本周计划');
    const fileId = fileIdFromUrl(pageA);

    // B 打开同文件（无个人调整 = 空筛选 = 与公共筛选一致）
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const { email: emailB } = await registerAndLogin(pageB);
    await grantCollaborator(request, fileId, emailB);
    await pageB.goto(`/edit/${fileId}`);
    await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
      timeout: 15_000,
    });

    // A 发布筛选（选一个负责人）
    await pickOwner(pageA);
    await pageA.getByTestId('map-filter-toggle').click();
    await pageA.getByTestId('map-filter-publish').click();
    await pageA.getByTestId('map-filter-toggle').click(); // 关弹窗

    // B（无个人调整）→ 自动跟随：筛选同步 + toast「xx 更改了筛选条件」
    // B 是接收人，弹窗头不显示「已同步给所有人」（需求方裁定：只有操作人显示）
    await expect(pageB.getByTestId('toast')).toContainText(/更改了筛选条件/, {
      timeout: 10_000,
    });
    await pageB.getByTestId('map-filter-toggle').click();
    await expect(pageB.getByTestId('map-filter-synced-badge')).toHaveCount(0);
    await expect(pageB.getByTestId('map-filter-personal-badge')).toHaveCount(0);
    await pageB.getByTestId('map-filter-toggle').click(); // 关弹窗

    // B 做个人调整（加「仅逾期」）→ 「· 仅你可见」出现
    await pageB.getByTestId('map-filter-toggle').click();
    await pageB.getByTestId('map-filter-pop').locator('text=仅逾期').click();
    await pageB.getByTestId('map-filter-toggle').click(); // 关弹窗
    await expect(pageB.getByTestId('map-filter-personal-badge')).toBeVisible();

    // A 再次发布（改筛选：加「仅未分配」）
    await pageA.getByTestId('map-filter-toggle').click();
    await pageA.getByTestId('map-filter-pop').locator('text=仅未分配').click();
    await pageA.getByTestId('map-filter-publish').click();
    await pageA.getByTestId('map-filter-toggle').click(); // 关弹窗

    // B（有个人调整）→ 筛选不动（「· 仅你可见」保留），但 toast 仍弹
    await expect(pageB.getByTestId('map-filter-personal-badge')).toBeVisible({ timeout: 10_000 });
    await expect(pageB.getByTestId('toast')).toContainText(/更改了筛选条件/, {
      timeout: 10_000,
    });

    await ctxA.close();
    await ctxB.close();
  });

  // 用例 ③：B 有个人调整 → 点「恢复为公共筛选」回到公共状态
  test('恢复为公共筛选：回到团队公共状态', async ({ browser, request }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await openSeedDoc(pageA, '本周计划');
    const fileId = fileIdFromUrl(pageA);

    // A 先发布一个公共筛选
    await pickOwner(pageA);
    await pageA.getByTestId('map-filter-toggle').click();
    await pageA.getByTestId('map-filter-publish').click();
    await pageA.getByTestId('map-filter-toggle').click(); // 关弹窗

    // B 打开同文件 → 有个人调整（加「仅逾期」）
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const { email: emailB } = await registerAndLogin(pageB);
    await grantCollaborator(request, fileId, emailB);
    await pageB.goto(`/edit/${fileId}`);
    await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
      timeout: 15_000,
    });
    await pageB.getByTestId('map-filter-toggle').click();
    await pageB.getByTestId('map-filter-pop').locator('text=仅逾期').click();
    await pageB.getByTestId('map-filter-toggle').click(); // 关弹窗
    await expect(pageB.getByTestId('map-filter-personal-badge')).toBeVisible();

    // B 点「恢复为公共筛选」→ 「· 仅你可见」消失
    await pageB.getByTestId('map-filter-toggle').click();
    await pageB.getByTestId('map-filter-restore-shared').click();
    // B 是接收人（非操作人）：恢复后弹窗头不显示「已同步给所有人」
    await expect(pageB.getByTestId('map-filter-synced-badge')).toHaveCount(0);
    await expect(pageB.getByTestId('map-filter-personal-badge')).toHaveCount(0);
    await pageB.getByTestId('map-filter-toggle').click(); // 关弹窗

    await ctxA.close();
    await ctxB.close();
  });

  // 用例 ④：keyword 隔离——A 发布公共筛选后 B 输 keyword 不影响公共筛选
  test('keyword 隔离：搜索关键词仅本次会话，不入公共筛选', async ({ browser, request }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await openSeedDoc(pageA, '本周计划');
    const fileId = fileIdFromUrl(pageA);

    // A 发布筛选
    await pickOwner(pageA);
    await pageA.getByTestId('map-filter-toggle').click();
    await pageA.getByTestId('map-filter-publish').click();
    await pageA.getByTestId('map-filter-toggle').click(); // 关弹窗

    // A 发布筛选后，从 Yjs doc 直接读 meta.sharedFilter 验证不含 keyword 键
    await pageA.waitForTimeout(2000); // 等 WS 同步落库
    const sharedFilterRaw = await pageA.evaluate(() => {
      // window.__gmindDoc 是 EditorPage 暴露的 Yjs doc（e2e 调试用）
      const doc = (window as unknown as { __gmindDoc?: { getMap: (k: string) => { get: (k: string) => unknown } } }).__gmindDoc;
      if (!doc) throw new Error('__gmindDoc 未暴露');
      return doc.getMap('meta').get('sharedFilter') as Record<string, unknown> | undefined;
    });
    // 公共筛选的 doc 持久态不含 keyword 键
    expect(sharedFilterRaw).toBeDefined();
    expect(sharedFilterRaw).not.toHaveProperty('keyword');

    // B 打开同文件 → 默认 synced（无「· 仅你可见」）
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const { email: emailB } = await registerAndLogin(pageB);
    await grantCollaborator(request, fileId, emailB);
    await pageB.goto(`/edit/${fileId}`);
    await expect(pageB.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(pageB.getByTestId('map-filter-personal-badge')).toHaveCount(0);
    // B 是接收人：弹窗头不显示「已同步给所有人」
    await pageB.getByTestId('map-filter-toggle').click();
    await expect(pageB.getByTestId('map-filter-synced-badge')).toHaveCount(0);
    await pageB.getByTestId('map-filter-toggle').click(); // 关弹窗

    await ctxA.close();
    await ctxB.close();
  });
});
