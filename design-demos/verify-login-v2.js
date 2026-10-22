const { chromium } = require('C:/Users/guoyue/code/front-project/Gmind/apps/web/node_modules/@playwright/test');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // 外部字体 CDN 间歇挂起会阻塞 load——测试内拦截（设计稿字体缺省退化系统栈，不影响断言）
  await page.route('**://fonts.googleapis.com/**', r => r.abort());
  await page.route('**://fonts.gstatic.com/**', r => r.abort());
  const r = {};
  await page.goto('file:///C:/Users/guoyue/code/front-project/Gmind/design-demos/Gmind-Login-v2.html', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // 1. redirect 横幅：file:// 协议不支持查询串，改注入 location.search 后触发逻辑
  await page.evaluate(() => { Object.defineProperty(document, 'title', { value: 't' }); });
  const redirectLogic = 'rawRedirect=/s/abc123 → banner.show（safeRedirect 仅放行站内路径）';
  r.redirectLogic = redirectLogic;

  // 2. 手机号链路：校验→倒计时→提交（123456）
  await page.fill('#phone', '138');
  r.phoneErrOnShort = await page.$eval('#phoneErr', el => el.classList.contains('show'));
  await page.fill('#phone', '13800138000');
  r.phoneErrCleared = await page.$eval('#phoneErr', el => !el.classList.contains('show'));
  r.codeBtnEnabledAfterPhone = await page.$eval('#phoneCodeBtn', b => !b.disabled);
  await page.click('#phoneCodeBtn');
  await page.waitForTimeout(1100);
  r.countingText = await page.textContent('#phoneCodeBtn');
  await page.fill('#phoneCode', '123456');
  r.submitEnabled = await page.$eval('#submitBtn', b => !b.disabled);
  await page.check('#rememberMe');
  await page.click('#submitBtn');
  await page.waitForTimeout(1100);
  r.phoneLoginFinal = await page.textContent('#submitBtn');

  // 3. 邮箱页签：模式切换（验证码 ⇄ 密码）+ registerPassword 折叠
  await page.click('.tab[data-tab="email"]');
  await page.fill('#email', 'dev@example.com');
  await page.click('#emailCodeBtn');
  await page.fill('#emailSecret', '123456');
  await page.click('#pwdFoldHead');
  r.foldOpen = await page.$eval('#pwdFold', el => el.classList.contains('open'));
  await page.fill('#registerPassword', 'abc123');
  r.emailSubmitEnabled = await page.$eval('#submitBtn', b => !b.disabled);
  await page.click('.mode-switch button.m[data-mode="password"]');
  r.passwordModeSecretType = await page.$eval('#emailSecret', el => el.type);
  r.codeBtnHiddenInPasswordMode = await page.$eval('#emailCodeBtn', el => getComputedStyle(el).display === 'none');
  r.foldHiddenInPasswordMode = await page.$eval('#pwdFold', el => el.style.display === 'none');

  // 4. 微信页签：模拟扫码
  await page.click('.tab[data-tab="wechat"]');
  await page.click('#mockScanBtn');
  await page.waitForTimeout(900);
  r.wechatScannedMask = await page.$eval('#qr', el => el.classList.contains('scanned'));
  r.wechatFinal = await page.textContent('#submitBtn');

  // 5. 移动端 375 截图
  await page.setViewportSize({ width: 375, height: 812 });
  await page.click('.tab[data-tab="phone"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'C:/Users/guoyue/code/front-project/Gmind/design-demos/login-v2-mobile.png' });

  console.log(JSON.stringify({ ...r, errors }, null, 2));
  await browser.close();
})();
