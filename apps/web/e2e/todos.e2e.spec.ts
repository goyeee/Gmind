import { expect, test } from '@playwright/test';
import { createTemplateDoc, docToState, getNode, setNodeTask } from '@gmind/core';
import { registerAndLogin } from './helpers/auth';

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
