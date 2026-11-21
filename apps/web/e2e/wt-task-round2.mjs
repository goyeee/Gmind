/* 任务第二轮真实走查（Playwright 直跑）：待办页画布分组/徽章/我的子进度选盘/动态页签 + 空间拆计数 + 参与人筛选 */
import { chromium } from '/Users/guoyue/code/Gmind/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5174';
const API = 'http://localhost:3001';
const SHOT = '/Users/guoyue/code/Gmind/gui-test-screenshots/wt-task-round2';
mkdirSync(SHOT, { recursive: true });
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`[wt] ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

const stamp = Date.now().toString(36);
async function account(nickname, slug) {
  const email = `e2e-wt2-${stamp}-${slug}@e2e.gmind.dev`;
  await fetch(`${API}/api/auth/email-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene: 'register', email }),
  });
  const r = await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: '123456', password: 'pass123456', nickname }),
  });
  const j = await r.json();
  return { token: j.token, id: j.user?.id ?? j.id, nickname: j.user?.nickname ?? nickname, email };
}
const auth = (t) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });
const owner = await account('组长甲', 'owner');
const member = await account('组员乙', 'member');
const ownerId = ((await (await fetch(`${API}/api/users/me`, { headers: auth(owner.token) })).json())).id;
const memberId = ((await (await fetch(`${API}/api/users/me`, { headers: auth(member.token) })).json())).id;

// 组长建文件：画布一「协作任务」（组员乙参与 40%）+ 画布二「我负责的」（组员乙负责）
const created = await (await fetch(`${API}/api/files`, { method: 'POST', headers: auth(owner.token), body: JSON.stringify({ title: '二轮走查文件' }) })).json();
await fetch(`${API}/api/files/${created.id}/collaborators`, { method: 'POST', headers: auth(owner.token), body: JSON.stringify({ userIds: [memberId] }) });
const core = await import('@gmind/core');
const { createTemplateDoc, setNodeTask, setCustomColumns, addAssignee, setAssigneeProgress, addCanvas, addChild, getNode, ORIGIN_USER, rootIdOf, docToState } = core;
const doc = createTemplateDoc({ title: '二轮走查文件', children: [{ text: '协作任务' }] });
setCustomColumns(doc, [{ id: 'col-a', name: '执行组', type: 'assignee' }]);
const taskA = getNode(doc, 'root').childIds[0];
const today = new Date().toISOString().slice(0, 10);
setNodeTask(doc, taskA, { owners: [ownerId], dueDate: today, status: 'doing', progress: 60 });
addAssignee(doc, taskA, 'col-a', memberId);
setAssigneeProgress(doc, taskA, 'col-a', memberId, 40);
addAssignee(doc, taskA, 'col-a', ownerId);
setAssigneeProgress(doc, taskA, 'col-a', ownerId, 70);
const canvas2 = addCanvas(doc, { name: '画布二' });
const c2 = addChild(doc, rootIdOf(doc, canvas2), { text: '我负责的' }, ORIGIN_USER, canvas2);
setNodeTask(doc, c2, { owners: [memberId], dueDate: today, status: 'doing', progress: 30 }, ORIGIN_USER, canvas2);
const put = await fetch(`${API}/api/files/${created.id}/doc-state`, {
  method: 'PUT', headers: auth(owner.token),
  body: JSON.stringify({ docState: Buffer.from(docToState(doc)).toString('base64') }),
});
console.log('[wt] PUT', put.status);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript((t) => localStorage.setItem('gmind.token', t), member.token);
page.setDefaultTimeout(15000);
const shot = (name) => page.screenshot({ path: `${SHOT}/${name}.png` });

try {
  // —— 场景 1：待办页画布分组 + 角色徽章 + 我的子进度选盘 ——
  await page.goto(`${BASE}/todos`);
  const row1 = page.getByTestId('todo-row').filter({ hasText: '协作任务' });
  await row1.waitFor();
  ok('S1 待办页汇总参与人任务', true);
  await page.getByTestId('todo-canvas-name').filter({ hasText: '画布 1' }).waitFor();
  await page.getByTestId('todo-canvas-name').filter({ hasText: '画布二' }).waitFor();
  ok('S2 文件→画布两级分组', true);
  await shot('01-todos-canvas-groups');
  const badge1 = await row1.getByTestId('todo-role-badge').textContent();
  const badge2 = await page.getByTestId('todo-row').filter({ hasText: '我负责的' }).getByTestId('todo-role-badge').textContent();
  ok('S3 角色徽章', badge1 === '执行人' && badge2 === '总负责人', `${badge1}/${badge2}`);
  await row1.getByTestId('todo-my-progress').click();
  await page.getByTestId('todo-my-progress-picker').waitFor();
  await shot('02-my-progress-picker');
  await page.getByTestId('todo-my-progress-value-p62').click();
  await page.waitForTimeout(800);
  const sub = await row1.getByTestId('todo-my-progress').textContent();
  ok('S4 我的子进度选盘写入 63%（p62 档）', sub.includes('63%'), sub);
  const chip = await page.getByTestId('todo-chip-mine-unfinished').textContent();
  ok('S5 我的子进度未完成 chip', chip.includes('1'), chip);

  // —— 场景 2：动态页签（选盘写入直记事件）——
  await page.getByTestId('todo-tab-activity').click();
  const item = page.getByTestId('todo-activity-item').filter({ hasText: '协作任务' }).first();
  await item.waitFor();
  const txt = await item.textContent();
  ok('S6 动态页签任务事件', txt.includes('63%') && txt.includes(member.nickname), txt.slice(0, 60));
  await shot('03-todos-activity');
  await item.click();
  await page.waitForURL(/\/edit\//);
  ok('S7 动态行点击跳文件', true);
  await page.waitForTimeout(800);
  // 打开文档动态抽屉看盖章任务事件
  await page.getByTestId('activity-toggle').click();
  await page.getByTestId('activity-panel').waitFor();
  const drawerItem = page.locator('[data-testid^="activity-item-"]', { hasText: '子进度' }).first();
  await drawerItem.waitFor();
  await shot('04-editor-activity-drawer');
  ok('S8 文档动态抽屉任务事件', true);

  // —— 场景 3：筛选弹窗参与人块 ——
  await page.getByTestId('map-filter-toggle').click();
  const pop = page.getByTestId('map-filter-pop');
  await pop.waitFor();
  const partBlock = pop.getByTestId('map-filter-participants');
  await partBlock.waitFor();
  // 跨画布候选：当前在画布二（无人员条目），画布一任务A 的组长甲（离线、非协作者）应出现
  await partBlock.getByText('组长甲').waitFor();
  await shot('05-filter-participants');
  ok('S9 筛选弹窗参与人多选块（跨画布候选含组长甲）', true);

  // —— 场景 3.5：分组 chips 只显示有内容的分组 + 参与范围配置弹窗 ——
  // 走查账号无组织分组 → chips 行只有「我的子进度未完成」，无「全部分组」/分组 chip
  await page.goto(`${BASE}/todos`);
  await page.getByTestId('todo-row').first().waitFor();
  const chipButtons = await page.getByTestId('todo-group-chips').getByRole('button').count();
  const hasAllGroup = await page.getByTestId('todo-group-chips').getByText('全部分组').count();
  ok('S11 分组 chips 只显示有内容分组（无分组账号=0 个分组 chip）', chipButtons === 1 && hasAllGroup === 0, `chips=${chipButtons}`);
  await shot('07-todos-chips-filtered');
  await page.getByTestId('todo-scope-toggle').click();
  const scopeDialog = page.getByTestId('todo-scope-dialog');
  await scopeDialog.waitFor();
  const scopeSwitch = page.locator('[data-testid^="todo-scope-file-switch-"]').first();
  await scopeSwitch.waitFor();
  await scopeSwitch.click(); // 关掉第一个文件 → 待办行即时减少
  await page.waitForTimeout(600);
  const rowsAfterOff = await page.getByTestId('todo-row').count();
  await shot('08-scope-dialog-off');
  await scopeSwitch.click(); // 恢复
  await page.waitForTimeout(600);
  const rowsAfterOn = await page.getByTestId('todo-row').count();
  ok('S12 配置弹窗关/开文件即时生效', rowsAfterOff < rowsAfterOn, `关后=${rowsAfterOff} 开后=${rowsAfterOn}`);
  await page.getByTestId('todo-scope-close').click();

  // —— 场景 4：待办空间负责/参与拆计数 ——
  await page.goto(`${BASE}/todo-space`);
  const myRow = page.getByTestId('space-row').filter({ hasText: member.nickname }).first();
  await myRow.waitFor();
  const resp = await myRow.getByTestId('space-responsible').textContent();
  const part = await myRow.getByTestId('space-participating').textContent();
  ok('S10 空间负责/参与拆计数', resp === '1' && part === '1', `负责=${resp} 参与=${part}`);
  await shot('06-space-split-counts');
} catch (e) {
  ok('EXCEPTION', false, String(e).slice(0, 200));
  await shot('99-exception');
}
await browser.close();
const pass = results.filter((r) => r.pass).length;
console.log(`[wt] 走查完成：${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
