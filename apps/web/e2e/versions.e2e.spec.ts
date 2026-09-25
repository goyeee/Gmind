import { expect, test, type Page } from '@playwright/test';

/**
 * 版本面板 E2E — M4 Task 8（FR-VER-004 UI：时间轴/只读预览/一键恢复）。
 *
 * 造数方式（brief 落定）：服务端 dev-only 路由 POST /api/files/:id/versions/snapshot
 * （NODE_ENV!=='production' 才生效，collab.snapshotIfDirty 包装）——服务端 e2e 已覆盖
 * 真实快照链路（3 分钟节流/卸载兜底），web e2e 用它绕开节流窗口按需落 auto 行。
 * 鉴权口径同 editor.e2e：localStorage token 直填 Authorization 头（page.request 不共享
 * 页面 localStorage）。
 *
 * 场景：改「周一」→'计划B' 等已保存 → 快照 v1 → 再改 '计划C' → 快照 v2 → 打开面板
 * 断言两条时间轴 → 预览第二次修改前的快照（v1，含 root 原文与 计划B、不含 计划C）→
 * 关闭预览 → 对该条目点恢复（confirm 绑定文案）→ 画布经 y-sync 恢复广播回滚（无 reload）
 * → toast「已恢复」→ 列表刷新且顶部出现「恢复前存档」条目。
 *
 * 面板列表时序口径：服务端 createdAt DESC（新→旧），v1 显示在第二行——预览/恢复目标
 * 按内容判定（「第二次修改前的快照」），与 controller 指令的括号说明一致。
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

/** 双击节点进编辑态 → 覆盖键入 → Enter 提交，等待「已保存」（WS persisted ack）。 */
async function renameNode(page: Page, from: string, to: string): Promise<void> {
  await page.locator('.editor-canvas svg .gm-text', { hasText: from }).dblclick();
  const editor = page.locator('.gm-text-editor');
  await expect(editor).toBeVisible();
  await page.keyboard.type(to); // 覆盖全选文本
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('save-status')).toHaveText(/已保存/, { timeout: 15000 });
}

/** dev-only 快照路由（Task 8）：触发一次 auto 快照，断言确实落行。 */
async function postSnapshot(page: Page, fileId: string, token: string): Promise<void> {
  const res = await page.request.post(`/api/files/${fileId}/versions/snapshot`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { created: boolean }).created).toBe(true);
}

test('版本面板：时间轴/只读预览/一键恢复', async ({ page }) => {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  const fileId = page.url().split('/').pop() ?? '';
  const token = await page.evaluate(() => localStorage.getItem('gmind.token') ?? '');

  // —— 造两版：周一→计划B 落 v1；计划B→计划C 落 v2 ——
  await renameNode(page, '周一', '计划B');
  await postSnapshot(page, fileId, token);
  await renameNode(page, '计划B', '计划C');
  await postSnapshot(page, fileId, token);

  // —— 打开版本历史面板：两条时间轴 ——
  await page.getByTestId('versions-toggle').click();
  const panel = page.getByTestId('version-panel');
  await expect(panel).toBeVisible();
  const items = panel.locator('[data-testid^="version-item-"]');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('自动'); // 类型徽标（auto='自动'）

  // —— 只读预览：第二条 = 第二次修改前的快照（列表新→旧）——
  const target = items.nth(1);
  await target.locator('.version-item-main').click();
  const preview = page.getByTestId('version-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('svg').first()).toBeVisible();
  // 快照即修改前状态：root 原文 + 计划B 在，计划C 不在
  await expect(preview.locator('.gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(preview.locator('.gm-text', { hasText: '计划B' })).toBeVisible();
  await expect(preview.locator('.gm-text', { hasText: '计划C' })).toHaveCount(0);
  await page.getByTestId('version-preview-close').click();
  await expect(preview).toHaveCount(0);

  // —— 一键恢复：confirm 绑定文案（含条目同款时间）→ 画布经广播回滚，无 reload ——
  await page.evaluate(() => {
    (window as unknown as { __gmindNoReload?: string }).__gmindNoReload = 'alive';
  });
  let confirmMessage = '';
  page.on('dialog', (d) => {
    confirmMessage = d.message();
    void d.accept();
  });
  await target.locator('[data-testid^="version-restore-"]').click();
  const expectedCopy = '当前内容将自动存档为「恢复前版本」，确定恢复到 ';
  await expect.poll(() => confirmMessage, { timeout: 5000 }).toContain(expectedCopy);
  const targetTime = await target.locator('.version-item-time').innerText();
  expect(confirmMessage).toContain(targetTime);
  expect(confirmMessage).toContain(' 的快照吗？');

  await expect(page.getByTestId('toast')).toHaveText('已恢复');
  // y-sync 恢复广播：画布文本回到快照内容（计划C → 计划B），页面不重载
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '计划B' })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '计划C' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __gmindNoReload?: string }).__gmindNoReload)).toBe('alive');

  // —— 列表刷新：新的 pre_restore 条目出现在顶部（新→旧）——
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('恢复前存档');
});

// 终审修复回归（Fix 2）：面板关闭必须重置预览态。面板组件 open=false 时保持挂载
// （return null 隐藏而非卸载），若不重置 preview state，重开面板会立即渲染陈旧 dialog
// ——而新挂载的空 <svg> 不触发渲染 effect（deps [preview] 未变）→ 空白遮罩挡住面板。
test('版本面板：关闭面板重置预览态——重开不残留旧预览，同条目可再次预览', async ({ page }) => {
  await registerAndLogin(page);
  await page.locator('.file-list li', { hasText: '本周计划' }).click();
  await expect(page).toHaveURL(/\/edit\//);
  await expect(page.locator('.editor-canvas svg .gm-text', { hasText: '本周计划' })).toBeVisible();
  const fileId = page.url().split('/').pop() ?? '';
  const token = await page.evaluate(() => localStorage.getItem('gmind.token') ?? '');

  // 造一版：周一 → 计划B（快照 = root 原文 + 计划B）
  await renameNode(page, '周一', '计划B');
  await postSnapshot(page, fileId, token);

  // 打开面板 → 预览该条目（内容非空）→ 直接关面板（不是关预览 dialog）
  await page.getByTestId('versions-toggle').click();
  const panel = page.getByTestId('version-panel');
  await expect(panel).toBeVisible();
  const items = panel.locator('[data-testid^="version-item-"]');
  await expect(items).toHaveCount(1);
  await items.nth(0).locator('.version-item-main').click();
  const preview = page.getByTestId('version-preview');
  await expect(preview).toBeVisible();
  await expect(preview.locator('.gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(preview.locator('.gm-text', { hasText: '计划B' })).toBeVisible();
  // 预览遮罩（fixed inset:0 z-1300）盖住面板关闭钮——纯指针点击不可达，DOM click()
  // 直发同一 onClose 事件路径（真实 React onClick 分发），构造「预览开着关面板」的
  // open→false 状态迁移（回归点：open=false 时组件保持挂载，preview state 曾残留）。
  await page.evaluate(() =>
    (document.querySelector('[data-testid="version-panel-close"]') as HTMLElement).click(),
  );
  await expect(panel).toHaveCount(0);
  await expect(preview).toHaveCount(0); // 预览随面板关闭重置（曾残留致重开即空白遮罩）

  // 重开面板：无残留预览 → 点同一条目 → 预览再次渲染预期内容（非空白）
  await page.getByTestId('versions-toggle').click();
  await expect(panel).toBeVisible();
  await expect(preview).toHaveCount(0);
  await expect(items).toHaveCount(1);
  await items.nth(0).locator('.version-item-main').click();
  await expect(preview).toBeVisible();
  await expect(preview.locator('.gm-text', { hasText: '本周计划' })).toBeVisible();
  await expect(preview.locator('.gm-text', { hasText: '计划B' })).toBeVisible();
});
