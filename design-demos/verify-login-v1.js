const { chromium } = require('C:/Users/guoyue/code/front-project/Gmind/apps/web/node_modules/@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('file:///C:/Users/guoyue/code/front-project/Gmind/design-demos/Gmind-Login.html');
  await page.waitForTimeout(2200); // 分枝生长动画
  const submitDisabled0 = await page.$eval('#submitBtn', b => b.disabled);
  const codeDisabled0 = await page.$eval('#codeBtn', b => b.disabled);
  await page.fill('#phone', '13800138000');
  const codeEnabled = await page.$eval('#codeBtn', b => !b.disabled);
  await page.click('#codeBtn');
  await page.waitForTimeout(1200);
  const countingText = await page.textContent('#codeBtn');
  await page.fill('#code', '123456');
  const submitEnabled = await page.$eval('#submitBtn', b => !b.disabled);
  await page.click('#submitBtn');
  await page.waitForTimeout(1200);
  const finalText = await page.textContent('#submitBtn');
  await page.screenshot({ path: 'C:/Users/guoyue/code/front-project/Gmind/design-demos/login-interact.png' });
  console.log(JSON.stringify({ submitDisabled0, codeDisabled0, codeEnabled, countingText, submitEnabled, finalText, errors }, null, 2));
  await browser.close();
})();
