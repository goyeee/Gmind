const { chromium } = require('C:/Users/guoyue/code/front-project/Gmind/apps/web/node_modules/@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
  await page.goto('file:///C:/Users/guoyue/code/front-project/Gmind/design-demos/Gmind-Editor-Redesign.html');
  await page.waitForTimeout(2000);

  // 1. 点击节点 → 检查器应打开
  await page.click('.node[data-id="b3"]');
  await page.waitForTimeout(400);
  const inspOpen = await page.$eval('#inspector', el => el.classList.contains('show'));

  // 2. Tab 插入子级 → 节点数 27 → 28
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  const countAfterInsert = await page.textContent('#nodeCount');

  // 3. ⌘Z 撤销 → 回到 27
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const countAfterUndo = await page.textContent('#nodeCount');

  // 4. ⌘K 打开命令面板并过滤
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  await page.fill('#cmdkInput', '导出');
  await page.waitForTimeout(200);
  const cmdkRows = await page.$$eval('#cmdkList .row', rs => rs.length);
  await page.keyboard.press('Escape');

  // 5. 右键节点 → 菜单出现（先关掉检查器，避免遮挡画布右侧节点）
  await page.click('#inspClose');
  await page.waitForTimeout(400);
  await page.click('.node[data-id="n5"]', { button: 'right' });
  await page.waitForTimeout(300);
  const ctxOpen = await page.$eval('#ctx', el => el.classList.contains('show'));
  await page.keyboard.press('Escape');

  // 6. 主题弹层 → 切换到「湖蓝」
  await page.click('#themeBtn');
  await page.waitForTimeout(300);
  await page.click('#themeGrid .theme-cell:nth-child(2)');
  await page.waitForTimeout(300);

  // 7. ⌘F 查找
  await page.keyboard.press('Control+f');
  await page.fill('#findInput', '导出');
  await page.waitForTimeout(300);
  const findCount = await page.textContent('#findCount');
  await page.keyboard.press('Escape');

  await page.screenshot({ path: '../../design-demos/final-interact.png' });
  console.log(JSON.stringify({ inspOpen, countAfterInsert, countAfterUndo, cmdkRows, ctxOpen, findCount, errors }, null, 2));
  await browser.close();
})();
