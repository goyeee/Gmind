import { expect, test } from '@playwright/test';
import { addAssignee, addCanvas, addChild, createTemplateDoc, docToState, getNode, ORIGIN_USER, rootIdOf, setCustomColumns, setNodeTask, setAssigneeProgress } from '@gmind/core';
import { apiRegister, registerAndLogin } from './helpers/auth';

/**
 * 我的待办 / 待办空间 UI e2e（第二期批次 B/C）：
 * - 造数经 API（PUT doc-state 带 core 构造的任务节点）→ 触发服务端任务索引抽取；
 * - 页面断言：统计卡计数、行内直改（进度/完成）、tabs 流转、生成日报（MD 剪贴板）、
 *   待办空间统计与人员聚合。
 */

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test('我的待办：跨文件任务汇总 → 行内进度直改 → 勾选完成 → 生成日报（MD 剪贴板）', async ({ page }) => {
  const { token } = await registerAndLogin(page);
  const me = (await (await page.request.get('/api/users/me', { headers: auth(token) })).json()) as { id: string };

  // 造带任务的文件（PUT doc-state 触发索引抽取，异步——页面断言自带重试窗口）
  const created = await page.request.post('/api/files', { headers: auth(token), data: { title: '待办验证' } });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  const today = new Date().toISOString().slice(0, 10);
  const doc = createTemplateDoc({ title: '待办验证', children: [{ text: '写周报' }, { text: '不进待办' }] });
  const kids = getNode(doc, 'root')!.childIds;
  setNodeTask(doc, kids[0]!, { owners: [me.id], dueDate: today, status: 'doing', progress: 50 });
  const state = Buffer.from(docToState(doc)).toString('base64');
  const put = await page.request.put(`/api/files/${fileId}/doc-state`, {
    headers: auth(token),
    data: { docState: state },
  });
  expect(put.status()).toBe(200);

  await page.goto('/todos');
  await expect(page.getByTestId('todos-page')).toBeVisible();
  // 2026-10-27 原型改版：默认页签=今日待办（含已逾期）——造数 dueDate=今天故在列
  const row = page.getByTestId('todo-row').filter({ hasText: '写周报' });
  await expect(row).toBeVisible({ timeout: 10_000 }); // 抽取异步，重试窗口覆盖
  await expect(page.getByTestId('todo-count-all')).toHaveText('1');
  // 无任务节点（「不进待办」）不出现
  await expect(page.getByTestId('todo-row').filter({ hasText: '不进待办' })).toHaveCount(0);

  // 行内进度直改：50 → 80（滑条，服务端写回 docState + 重建索引，reload 后仍 80）
  await row.getByTestId('todo-progress-range').fill('80');
  await page.reload();
  await expect(page.getByTestId('todo-row').filter({ hasText: '写周报' }).getByTestId('todo-progress-range')).toHaveValue('80');

  // 勾选完成：open 消失、done 出现（受控 checkbox——click+后置断言，check() 会因
  // 重渲染未及时翻状态误报，同 error-copy ⑩ 先例）
  await row.getByTestId('todo-check').click();
  await expect(page.getByTestId('todo-row')).toHaveCount(0);
  await page.getByTestId('todo-tab-done').click();
  const doneRow = page.getByTestId('todo-row').filter({ hasText: '写周报' });
  await expect(doneRow).toBeVisible();

  // 取消完成也必须明确选择新进度；确认 40% 后回到待办
  await doneRow.getByTestId('todo-check').click();
  const reopen = page.getByTestId('task-dialog-overlay');
  await expect(reopen).toBeVisible();
  await reopen.getByTestId('task-dialog-progress-input').fill('40');
  await reopen.getByTestId('task-dialog-progress-confirm').click();
  await expect(page.getByTestId('todo-row')).toHaveCount(0);
  await page.getByTestId('todo-tab-all').click();
  const reopenedRow = page.getByTestId('todo-row').filter({ hasText: '写周报' });
  await expect(reopenedRow).toBeVisible();
  await expect(reopenedRow.getByTestId('todo-progress-range')).toHaveValue('40');

  // 生成日报：剪贴板 Markdown 含任务与文件名
  await page.getByTestId('todo-daily-report').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('写周报');
  expect(clip).toContain('待办验证');
});

test('统计面板：统计卡 + 人员聚合 + 生成完成报告', async ({ page }) => {
  const { token } = await registerAndLogin(page);
  const me = (await (await page.request.get('/api/users/me', { headers: auth(token) })).json()) as { id: string };

  const created = await page.request.post('/api/files', { headers: auth(token), data: { title: '空间验证' } });
  const fileId = ((await created.json()) as { id: string }).id;
  const doc = createTemplateDoc({ title: '空间验证', children: [{ text: '聚合任务' }] });
  const kids = getNode(doc, 'root')!.childIds;
  setNodeTask(doc, kids[0]!, { owners: [me.id], status: 'doing', progress: 30 });
  await page.request.put(`/api/files/${fileId}/doc-state`, {
    headers: auth(token),
    data: { docState: Buffer.from(docToState(doc)).toString('base64') },
  });

  await page.goto('/todo-space');
  await expect(page.getByTestId('todo-space-page')).toBeVisible();
  await expect(page.getByTestId('space-total')).toHaveText('1', { timeout: 10_000 });
  // 人员聚合行（自己）：总数 1、进行中 1
  const row = page.getByTestId('space-row').filter({ hasText: '聚合任务' }).first();
  await expect(page.getByTestId('space-row').first()).toBeVisible();
  void row;
  // 生成完成报告：剪贴板含统计头
  await page.getByTestId('todo-report-btn').click();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('【完成报告】');
  expect(clip).toContain('任务总数 1');
  expect(clip).toContain('用户');
});

/**
 * 任务第二轮（2026-11-21，spec 2026-11-21-task-round2-design §5.2/§5.3）：
 * - 文件→画布两级分组（含第二画布任务）；行上角色徽章（执行人/总负责人）；
 * - 「我的子进度 %」点击 → 9 档选盘写入（服务端把我的全部执行来源一起改）；
 * - 「我的子进度未完成」chip；「动态」页签（跨文件任务动态流 + 行点击跳编辑器）；
 * - 待办空间聚合表负责/参与拆计数 + 明细参与人列。
 */
test('我的待办第二轮：画布分组 + 角色徽章 + 我的子进度选盘 + 动态页签', async ({ page }) => {
  const { token } = await registerAndLogin(page);
  const me = (await (await page.request.get('/api/users/me', { headers: auth(token) })).json()) as { id: string };
  const other = await apiRegister(page.request, { nickname: '组长甲' });
  const otherAuth = auth(other.token);
  const otherId = (await (await page.request.get('/api/users/me', { headers: otherAuth })).json()) as { id: string };

  // 组长建文件：画布一「协作任务」（组长负责、我在人员列 50%）；画布二「第二画布任务」（我负责）
  const created = await page.request.post('/api/files', { headers: otherAuth, data: { title: '二轮验证' } });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  await page.request.post(`/api/files/${fileId}/collaborators`, { headers: otherAuth, data: { userIds: [me.id] } });
  const today = new Date().toISOString().slice(0, 10);
  const doc = createTemplateDoc({ title: '二轮验证', children: [{ text: '协作任务' }] });
  setCustomColumns(doc, [{ id: 'col-a', name: '执行组', type: 'assignee' }]);
  const c1 = getNode(doc, 'root')!.childIds[0]!;
  setNodeTask(doc, c1, { owners: [otherId.id], dueDate: today, status: 'doing', progress: 60 });
  addAssignee(doc, c1, 'col-a', me.id);
  setAssigneeProgress(doc, c1, 'col-a', me.id, 50);
  const canvas2 = addCanvas(doc, { name: '画布二' });
  const c2 = addChild(doc, rootIdOf(doc, canvas2), { text: '第二画布任务' }, ORIGIN_USER, canvas2);
  setNodeTask(doc, c2, { owners: [me.id], dueDate: today, status: 'doing', progress: 30 }, ORIGIN_USER, canvas2);
  const put = await page.request.put(`/api/files/${fileId}/doc-state`, {
    headers: otherAuth,
    data: { docState: Buffer.from(docToState(doc)).toString('base64') },
  });
  expect(put.status()).toBe(200);

  await page.goto('/todos');
  const row1 = page.getByTestId('todo-row').filter({ hasText: '协作任务' });
  await expect(row1).toBeVisible({ timeout: 15_000 });
  const row2 = page.getByTestId('todo-row').filter({ hasText: '第二画布任务' });
  await expect(row2).toBeVisible({ timeout: 15_000 });

  // 画布两级分组：两个画布名分组头都在
  await expect(page.getByTestId('todo-canvas-name').filter({ hasText: '画布 1' })).toBeVisible();
  await expect(page.getByTestId('todo-canvas-name').filter({ hasText: '画布二' })).toBeVisible();

  // 角色徽章：参与人=执行人、负责人=总负责人；执行人另显我的子进度
  await expect(row1.getByTestId('todo-role-badge')).toHaveText('执行人');
  await expect(row2.getByTestId('todo-role-badge')).toHaveText('总负责人');
  await expect(row1.getByTestId('todo-my-progress')).toContainText('我的子进度 50%');
  await expect(row2.getByTestId('todo-my-progress')).toHaveCount(0); // 负责人未设子进度不显示

  // chip：我的子进度未完成（只有协作任务 50% 未满）
  await expect(page.getByTestId('todo-chip-mine-unfinished')).toContainText('我的子进度未完成 1');

  // 9 档选盘写入：点开 → 选 75 档 → 行回显 75%（服务端直记动态，供动态页签断言）
  await row1.getByTestId('todo-my-progress').click();
  const picker = page.getByTestId('todo-my-progress-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('todo-my-progress-value-p75').click();
  await expect(row1.getByTestId('todo-my-progress')).toContainText('我的子进度 75%');

  // 动态页签：跨文件任务动态流（选盘写入直记 task_progress）+ 行点击跳编辑器
  await page.getByTestId('todo-tab-activity').click();
  const activityItem = page.getByTestId('todo-activity-item').filter({ hasText: '协作任务' });
  await expect(activityItem.first()).toBeVisible({ timeout: 10_000 });
  await expect(activityItem.first()).toContainText('75%');
  await activityItem.first().click();
  await expect(page).toHaveURL(new RegExp(`/edit/${fileId}`));
});

test('待办空间第二轮：负责/参与拆计数 + 明细参与人列', async ({ page }) => {
  const { token, nickname } = await registerAndLogin(page);
  const me = (await (await page.request.get('/api/users/me', { headers: auth(token) })).json()) as { id: string };
  const other = await apiRegister(page.request, { nickname: '组长乙' });
  const otherAuth = auth(other.token);
  const otherId = (await (await page.request.get('/api/users/me', { headers: otherAuth })).json()) as { id: string };

  const created = await page.request.post('/api/files', { headers: otherAuth, data: { title: '空间二轮' } });
  const fileId = ((await created.json()) as { id: string }).id;
  await page.request.post(`/api/files/${fileId}/collaborators`, { headers: otherAuth, data: { userIds: [me.id] } });
  const doc = createTemplateDoc({ title: '空间二轮', children: [{ text: '协作任务' }, { text: '我负责的' }] });
  setCustomColumns(doc, [{ id: 'col-a', name: '执行组', type: 'assignee' }]);
  const kids = getNode(doc, 'root')!.childIds;
  setNodeTask(doc, kids[0]!, { owners: [otherId.id], status: 'doing', progress: 40 });
  addAssignee(doc, kids[0]!, 'col-a', me.id);
  setAssigneeProgress(doc, kids[0]!, 'col-a', me.id, 40);
  setNodeTask(doc, kids[1]!, { owners: [me.id], status: 'doing', progress: 20 });
  const put = await page.request.put(`/api/files/${fileId}/doc-state`, {
    headers: otherAuth,
    data: { docState: Buffer.from(docToState(doc)).toString('base64') },
  });
  expect(put.status()).toBe(200);

  await page.goto('/todo-space');
  const myRow = page.getByTestId('space-row').filter({ hasText: nickname }).first();
  await expect(myRow).toBeVisible({ timeout: 15_000 });
  // 我：负责 1（我负责的）+ 参与 1（协作任务）
  await expect(myRow.getByTestId('space-responsible')).toHaveText('1');
  await expect(myRow.getByTestId('space-participating')).toHaveText('1');
  // 明细表：有参与人的任务第 4 列（参与人）非「—」；无参与人的任务为「—」
  const withPart = page.getByTestId('space-item').filter({ hasText: '协作任务' });
  await expect(withPart).toBeVisible({ timeout: 15_000 });
  await expect(withPart.locator('.cell').nth(3)).not.toHaveText('—');
  const withoutPart = page.getByTestId('space-item').filter({ hasText: '我负责的' });
  await expect(withoutPart).toBeVisible();
  await expect(withoutPart.locator('.cell').nth(3)).toHaveText('—');

  // 名字解析（2026-11-21 修正）：非登录者且无组织挂靠的成员显示 users 表真昵称，
  // 不再掉「成员+id尾段」兜底
  const otherRow = page.getByTestId('space-row').filter({ hasText: '组长乙' });
  await expect(otherRow).toBeVisible();
  await expect(otherRow.getByText(/成员 [0-9A-Z]{4}/)).toHaveCount(0);

  // 头像（2026-11-21 修正）：有头像的成员渲染真实头像图片，不再是名字首字文本块
  await page.request.patch('/api/users/me/avatar', { headers: otherAuth, data: { avatarUrl: '/avatars/preset-1.svg' } });
  await page.reload();
  await expect(page.getByTestId('space-row').filter({ hasText: '组长乙' })).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByTestId('space-row').filter({ hasText: '组长乙' }).locator('img.space-avatar-img'),
  ).toBeVisible();

  // 下钻（2026-11-21 修正）：明细池=统计池——选「组长乙」行能看到他负责的任务
  // （此前明细只含我自己的任务，选他人行必空）
  await otherRow.click();
  const otherItem = page.getByTestId('space-item').filter({ hasText: '协作任务' });
  await expect(otherItem).toBeVisible();
  await expect(page.getByTestId('space-item').filter({ hasText: '我负责的' })).toHaveCount(0);
  await page.getByTestId('space-clear-selection').click();

  // 范围解耦（2026-11-21 需求方实测场景）：切「今日」（fixture 任务无截止日 → 统计
  // 聚合收缩），明细仍列出全部任务且负责人解析真名——不再因范围外而显示「成员+id尾段」
  await page.getByTestId('todo-range-today').click();
  const todayItem = page.getByTestId('space-item').filter({ hasText: '协作任务' });
  await expect(todayItem).toBeVisible({ timeout: 10_000 });
  await expect(todayItem.locator('.cell').nth(2)).toHaveText('组长乙');
  await expect(todayItem.locator('.cell').nth(2)).not.toContainText('成员 ');
});

/**
 * 参与范围配置（2026-11-21 需求方追加）：待办页「⚙ 配置」弹窗——文件/画布两级开关，
 * 关掉后列表即时消失、打开恢复；分组 chips 只显示能筛出内容的分组。
 */
test('参与范围配置：弹窗开关即时生效；分组 chips 只显示有内容的分组', async ({ page }) => {
  const { token } = await registerAndLogin(page);
  const me = (await (await page.request.get('/api/users/me', { headers: auth(token) })).json()) as { id: string };
  const other = await apiRegister(page.request, { nickname: '范围组长' });
  const otherAuth = auth(other.token);

  const created = await page.request.post('/api/files', { headers: otherAuth, data: { title: '范围验证' } });
  expect(created.status()).toBe(201);
  const fileId = ((await created.json()) as { id: string }).id;
  await page.request.post(`/api/files/${fileId}/collaborators`, { headers: otherAuth, data: { userIds: [me.id] } });
  const today = new Date().toISOString().slice(0, 10);
  const doc = createTemplateDoc({ title: '范围验证', children: [{ text: '范围任务' }] });
  const kids = getNode(doc, 'root')!.childIds;
  setNodeTask(doc, kids[0]!, { owners: [me.id], dueDate: today, status: 'doing', progress: 40 });
  const put = await page.request.put(`/api/files/${fileId}/doc-state`, {
    headers: otherAuth,
    data: { docState: Buffer.from(docToState(doc)).toString('base64') },
  });
  expect(put.status()).toBe(200);

  await page.goto('/todos');
  const row = page.getByTestId('todo-row').filter({ hasText: '范围任务' });
  await expect(row).toBeVisible({ timeout: 15_000 });

  // 分组 chips：任务相关人（我/组长）都无组织分组 → 不出现「全部分组」与任何分组 chip
  // （旧实现会把目录里其他成员的分组全列出来）
  const chipsRow = page.getByTestId('todo-group-chips');
  await expect(chipsRow.getByRole('button')).toHaveCount(1); // 仅「我的子进度未完成」chip
  await expect(chipsRow.getByText('全部分组')).toHaveCount(0);

  // 配置弹窗：文件在清单且开关为「参与」；关掉 → 列表即时消失；打开 → 恢复
  await page.getByTestId('todo-scope-toggle').click();
  const dialog = page.getByTestId('todo-scope-dialog');
  await expect(dialog).toBeVisible();
  const fileSwitch = dialog.getByTestId(`todo-scope-file-switch-${fileId}`);
  await expect(fileSwitch).toBeVisible();
  await expect(fileSwitch).toHaveAttribute('aria-checked', 'true');
  await fileSwitch.click();
  await expect(fileSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('todo-row')).toHaveCount(0);
  // 统计卡同步归零（服务端同口径）
  await expect(page.getByTestId('todo-count-all')).toHaveText('0');
  await fileSwitch.click();
  await expect(fileSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(row).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('todo-scope-close').click();
  await expect(dialog).toHaveCount(0);
});
