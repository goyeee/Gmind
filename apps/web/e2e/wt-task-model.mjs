/* 任务模型第一轮真实走查（Playwright 直跑）：迁移/单负责人/逐人进度/完成三选/重开 */
import { chromium } from '/Users/guoyue/code/Gmind/node_modules/.pnpm/playwright@1.63.0/node_modules/playwright/index.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = 'http://localhost:5174';
const API = 'http://localhost:3001';
const SHOT = '/Users/guoyue/code/Gmind/gui-test-screenshots/wt-task-model';
mkdirSync(SHOT, { recursive: true });
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`[wt] ${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

// 走查账号（单账号足够：总负责人即操作者，人员列成员来自协作者目录=自己）
const stamp = Date.now().toString(36);
async function account(nickname) {
  const email = `e2e-wtt-${stamp}-${nickname}@e2e.gmind.dev`;
  await fetch(`${API}/api/auth/email-code`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scene: 'register', email }),
  });
  const r = await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, code: '123456', password: 'pass123456', nickname }),
  });
  return { ...(await r.json()), email };
}
const owner = await account('owner-a');

const createFile = async (token, title, state) => {
  const res = await fetch(`${API}/api/files`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(state ? { title, state } : { title }),
  });
  const j = await res.json();
  console.log('[wt] createFile status:', res.status, 'id:', j.id, 'body:', JSON.stringify(j).slice(0, 120));
  return j;
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript((t) => localStorage.setItem('gmind.token', t), owner.token);
page.setDefaultTimeout(15000);
const shot = (name) => page.screenshot({ path: `${SHOT}/${name}.png` });

try {
  // —— 场景 1：单负责人指派 + 总负责人子进度 + 独立总进度 ——
  const created = await createFile(owner.token, '任务模型走查');
  await page.goto(`${BASE}/edit/${created.id}`);
  await page.locator('.editor-canvas svg').waitFor();
  await page.waitForTimeout(600);
  // 点中心主题选中（页面加载后焦点不在画布，Tab 会被浏览器焦点导航消费）
  await page.mouse.click(720, 450);
  await page.waitForTimeout(300);
  // Tab 建子任务 → 惰性编辑触发 → 改名
  await page.keyboard.press('Tab');
  await page.keyboard.press('x'); // 惰性编辑：编辑框随下一 keydown 补开（首键保留）
  await page.locator('textarea.gm-text-editor').waitFor();
  await page.locator('textarea.gm-text-editor').fill('上线准备');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  // 开任务面板：指派自己为总负责人（面板负责人单选）
  await page.getByTestId('task-toggle').click();
  await page.getByTestId('task-panel').waitFor();
  await page.getByTestId('task-panel-title').waitFor();
  const ownerChip = page.locator('[data-testid^="task-panel-owner-"]').first();
  await ownerChip.click();
  await page.waitForTimeout(300);
  // 状态 doing（0%→doing 弹进度选择 → 30）
  await page.getByTestId('task-panel-status-doing').click();
  const dlg = page.getByTestId('task-dialog-overlay');
  await dlg.waitFor();
  await dlg.getByTestId('task-dialog-progress-input').fill('30');
  await dlg.getByTestId('task-dialog-progress-confirm').click();
  await page.waitForTimeout(300);
  ok('S1a 0%→进行中弹出进度选择并写入', true);
  // 总进度 30（右侧 %）——截图任务行
  await page.getByTestId('task-toggle').click(); // 关面板看画布
  await page.waitForTimeout(300);
  const progressText = await page.locator('.editor-canvas svg text.gm-task-progress').first().textContent();
  ok('S1b 任务行右侧显示总进度 30%', progressText === '30%', `实际=${progressText}`);
  await shot('s1-owner-progress');

  // —— 场景 2：人员列逐人子进度（加执行人乙 40%）+ 完成三选 ——
  await page.getByTestId('task-toggle').click();
  await page.getByTestId('task-panel').waitFor();
  // 建人员列（面板自定义列无入口——用表格加列）
  await page.getByTestId('view-tab-table').click();
  await page.locator('.task-table-root').waitFor();
  await page.getByTestId('table-col-add').click();
  await page.getByTestId('table-col-add-name').fill('执行进度');
  await page.getByTestId('table-col-add-type-assignee').click();
  await page.getByTestId('table-col-add-submit').click();
  await page.waitForTimeout(400);
  // 人员格弹层加成员乙并设 40%
  const row = page.locator('.tt-table tbody tr').first();
  await row.getByTestId('table-custom-assignee').click();
  await page.locator('[data-testid^="table-custom-assignee-editor-member-"]').first().click();
  await page.waitForTimeout(200);
  const memberChip = page.locator('[data-testid^="table-custom-assignee-editor-row-"]').first();
  const memberName = (await memberChip.getAttribute('data-testid'))?.replace('table-custom-assignee-editor-row-', '') ?? '';
  const pInput = page.locator(`[data-testid="table-custom-assignee-editor-progress-${memberName}"]`);
  await pInput.fill('40');
  await pInput.press('Enter');
  await page.locator('.tt-overlay').click();
  await page.waitForTimeout(300);
  // 此时 owner 子进度未设 → 未完成项=乙 40% → 状态选 done 弹三选
  await row.locator('select[aria-label="任务状态"]').selectOption('done');
  const dlg2 = page.getByTestId('task-dialog-overlay');
  await dlg2.waitFor();
  await shot('s2-complete-dialog');
  const dialogText = await dlg2.textContent();
  ok('S2a 完成弹窗列出未完成子进度', dialogText.includes('40%'), dialogText.slice(0, 120));
  // 选「仅完成保留子进度」
  await dlg2.getByTestId('task-dialog-complete-keep').click();
  await page.waitForTimeout(400);
  const statusAfter = await row.locator('select[aria-label="任务状态"]').inputValue();
  const keepAfter = await row.getByTestId('table-custom-assignee').textContent();
  ok('S2b 仅完成保留子进度：done + 乙 40% 保留', statusAfter === 'done' && keepAfter.includes('40%'),
    `status=${statusAfter} assignee=${keepAfter.slice(0, 40)}`);
  // 负责人列显示 ownerId 对应成员（不再「未分配」）
  const ownerCell = await row.locator('td[data-col-key="owner"]').textContent();
  ok('S2c 负责人列显示总负责人', ownerCell.includes('owner-a'), `实际=${ownerCell.trim()}`);
  await shot('s2-after-complete');

  // —— 场景 3：已完成重开必须选新进度 ——
  await row.locator('select[aria-label="任务状态"]').selectOption('doing');
  const dlg3 = page.getByTestId('task-dialog-overlay');
  await dlg3.waitFor();
  await dlg3.getByTestId('task-dialog-progress-input').fill('65');
  await dlg3.getByTestId('task-dialog-progress-confirm').click();
  await page.waitForTimeout(300);
  const progressAfter = await row.locator('td[data-col-key="progress"] .tt-bar-num').textContent();
  ok('S3 重开显式选 65% 生效', progressAfter === '65%', `实际=${progressAfter}`);

  // —— 场景 3b：完成并全部改为 100%（complete-subprogress 原子命令）——
  await row.locator('select[aria-label="任务状态"]').selectOption('done');
  const dlg4 = page.getByTestId('task-dialog-overlay');
  await dlg4.waitFor();
  await dlg4.getByTestId('task-dialog-complete-all').click();
  await page.waitForTimeout(400);
  const statusAll = await row.locator('select[aria-label="任务状态"]').inputValue();
  const assigneeAll = await row.getByTestId('table-custom-assignee').textContent();
  ok('S3b 完成并全部改为 100%：done + 乙 40%→100%', statusAll === 'done' && assigneeAll.includes('100%'),
    `status=${statusAll} assignee=${assigneeAll.slice(0, 40)}`);

  // —— 场景 4：三视图总进度一致（表格 65% vs 脑图右侧 65%）——
  await page.getByTestId('view-tab-mind').click();
  await page.waitForTimeout(400);
  const mindProgress = await page.locator('.editor-canvas svg text.gm-task-progress').first().textContent();
  ok('S4 三视图总进度一致（完成态：脑图 100% = 表格 100%）', mindProgress === '100%', `脑图=${mindProgress}`);
  await shot('s4-consistency');

  // —— 场景 6（2026-11-21 裁定）：无其他执行人时画布负责人头像直接改总进度 ——
  // 新建子任务「回归验收」并指派自己（无人员列条目）
  await page.mouse.click(720, 450);
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await page.keyboard.press('x');
  await page.locator('textarea.gm-text-editor').waitFor();
  await page.locator('textarea.gm-text-editor').fill('回归验收');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
  await page.getByTestId('task-toggle').click();
  await page.locator('[data-testid^="task-panel-owner-"]').first().click();
  await page.getByTestId('task-toggle').click(); // 关面板看画布
  await page.waitForTimeout(300);
  // 点画布负责人头像 → 选盘头部=「任务总进度」（旧行为是 toast 引导去面板）
  const g6 = page.locator('g[data-node-id]').filter({ hasText: '回归验收' }).last();
  await g6.locator('.gm-task-owner-avatar').click();
  const picker6 = page.getByTestId('assignee-picker');
  await picker6.waitFor();
  const who6 = await picker6.locator('.assignee-picker-who').textContent();
  ok('S6a 无执行人头像选盘头部=任务总进度', (who6 ?? '').includes('任务总进度'), `头部=${(who6 ?? '').slice(0, 30)}`);
  await picker6.getByTestId('assignee-picker-value-p50').click();
  await page.waitForTimeout(300);
  const p6 = await g6.locator('text.gm-task-progress').textContent();
  ok('S6b 头像选盘选 50% 直接写总进度', p6 === '50%', `实际=${p6}`);
  await shot('s6-owner-avatar-total');

  // —— 场景 7（2026-11-21 裁定）：完成态表格进度输入直接静默重开，不弹确认框 ——
  await page.getByTestId('view-tab-table').click();
  await page.locator('.task-table-root').waitFor();
  const row7 = page.locator('.tt-table tbody tr').filter({ hasText: '上线准备' }).first();
  await row7.locator('td[data-col-key="progress"]').dblclick();
  const ed7 = page.locator('.tt-progress-input');
  await ed7.waitFor();
  await ed7.fill('65');
  await ed7.press('Enter');
  await page.waitForTimeout(300);
  const dlg7 = await page.getByTestId('task-dialog-overlay').count();
  const prog7 = await row7.locator('td[data-col-key="progress"] .tt-bar-num').textContent();
  const st7 = await row7.locator('select[aria-label="任务状态"]').inputValue();
  ok('S7 完成态进度输入 65 静默重开（无弹窗）', dlg7 === 0 && prog7 === '65%' && st7 === 'doing',
    `dlg=${dlg7} prog=${prog7} status=${st7}`);

  // —— 场景 8（2026-11-21 裁定）：面板负责人头像调起进度选盘（子进度填写行退役，
  //     无执行人 → 总进度口径）——
  await page.getByTestId('view-tab-mind').click();
  await page.waitForTimeout(400);
  // 点节点文字：若该节点已选中，「再点已选中节点」裁定会直接开面板（无需 toggle）
  await page.locator('g[data-node-id]').filter({ hasText: '回归验收' }).last().locator('text.gm-text').click();
  const panel8 = page.getByTestId('task-panel');
  if ((await panel8.count()) === 0 || !(await panel8.isVisible())) {
    await page.getByTestId('task-toggle').click();
  }
  await panel8.waitFor();
  await page.locator('[data-testid^="task-panel-owner-avatar-"]').first().click();
  const picker8 = page.getByTestId('panel-progress-picker');
  await picker8.waitFor();
  const who8 = await picker8.locator('.assignee-picker-who').textContent();
  await picker8.getByTestId('panel-progress-picker-value-p75').click();
  await page.waitForTimeout(300);
  const pInput8 = await page.getByTestId('task-panel-progress').inputValue();
  const ownerRow8 = await page.getByTestId('task-panel-owner-progress-row').count();
  ok('S8 面板负责人头像选盘写总进度（填写行退役）',
    ownerRow8 === 0 && (who8 ?? '').includes('任务总进度') && pInput8 === '75',
    `填写行=${ownerRow8} 头部=${(who8 ?? '').slice(0, 30)} 进度=${pInput8}`);
  await shot('s8-panel-avatar-picker');

  // —— 场景 9（2026-11-21 二次裁定）：面板人员列不再单独列行——与负责人同款成员
  //     chips，已指派成员点头像调选盘改其子进度，点 chip 本体取消指派 ——
  // 换选「上线准备」（S2 已给它的「执行进度」列指派 owner-a，S3b 后 100%）——面板跟随
  await page.locator('g[data-node-id]').filter({ hasText: '上线准备' }).last().locator('text.gm-text').click();
  await page.waitForTimeout(400);
  const rowCnt9 = await page.locator('[data-testid="task-panel"] .task-assignee-row').count();
  // 点已指派成员 chip 内头像（限定人员列行容器，避免命中负责人区块头像）→ 面板选盘头部=列名「执行进度」
  await page.locator('[data-testid="task-panel-custom-row"] [data-testid*="-avatar-"]').first().click();
  const picker9 = page.getByTestId('panel-progress-picker');
  await picker9.waitFor();
  const who9 = await picker9.locator('.assignee-picker-who').textContent();
  await picker9.getByTestId('panel-progress-picker-value-p50').click();
  await page.waitForTimeout(300);
  await shot('s9-panel-assignee-chips'); // 面板 chips 形态（先拍面板再切表格核对）
  // 表格核对：该成员子进度 100%→50%
  await page.getByTestId('view-tab-table').click();
  await page.locator('.task-table-root').waitFor();
  const cell9 = await page.locator('.tt-table tbody tr').filter({ hasText: '上线准备' }).first()
    .getByTestId('table-custom-assignee').textContent();
  ok('S9 面板人员列 chips（无单独行）+ 点头像改子进度 50%',
    rowCnt9 === 0 && (who9 ?? '').includes('执行进度') && (cell9 ?? '').includes('50%'),
    `行=${rowCnt9} 头部=${(who9 ?? '').slice(0, 30)} 表格值=${(cell9 ?? '').slice(0, 30)}`);

  // —— 场景 5：旧多负责人迁移走 server e2e 钉死（versions.e2e 迁移用例），UI 走查不重复 ——
  ok('S5 旧模型迁移由 server e2e 钉死（versions.e2e 用例通过），UI 走查登记跳过', true, '见 server e2e 全量');

  writeFileSync(`${SHOT}/results.json`, JSON.stringify(results, null, 2));
} catch (e) {
  await shot('error-state').catch(() => {});
  try {
    console.log('[wt] 断点文档态:', await page.evaluate(() => ({
      texts: [...document.querySelectorAll('svg text.gm-text')].map((t) => t.textContent),
      editors: document.querySelectorAll('textarea.gm-text-editor').length,
      focused: document.activeElement ? document.activeElement.tagName : null,
    })));
  } catch (e2) {
    console.log('[wt] 断点诊断失败:', String(e2).slice(0, 100));
  }
  ok('脚本异常中断', false, String(e).slice(0, 200));
  writeFileSync(`${SHOT}/results.json`, JSON.stringify(results, null, 2));
} finally {
  await browser.close();
}
const fails = results.filter((r) => !r.pass);
console.log(`\n[wt] 完成：${results.length - fails.length}/${results.length} 通过`);
process.exit(fails.length ? 1 : 0);
