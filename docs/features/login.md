# 登录与注册（邮箱注册制）

> 功能逻辑文档（AGENTS.md §四 五栏目，写给人看）。核对日期与代码版本见文末「最后核对」；行号是核对当日读码所得，后续代码变动请当日重新 grep 再引用。

## ① 这是什么

登录/注册页，是进入 Gmind 的唯一入口。浏览器没登录时打开任何页面都会被带到 `/login`（`apps/web/src/App.tsx:16`）；登录成功后进入工作台 `/workspace`。从分享链接进来的人，登录后会自动回到原本要打开的那个文件（`apps/web/src/pages/LoginPage.tsx:27-33`）。

页面右侧表单有三个视图，靠底部小链接互相切换：**登录**、**注册新账号**、**忘记密码**（`apps/web/src/pages/LoginPage.tsx:25`；切换链接见 `:238-244`、`:295-299`、`:344-348`）。2026-11-12 重做后只有「邮箱」一种身份通道：注册靠邮箱验证码，登录靠邮箱+密码；旧的手机号验证码登录、微信登录都已下线。

## ② 规则（逐条）

1. **注册（邮箱验证码制）**：填 4 项——邮箱、邮箱验证码、密码、昵称（`apps/web/src/pages/LoginPage.tsx:254-291`）。验证码点「获取验证码」发到邮箱；提交成功**即已登录**，并自动获得 3 个示例文件（`apps/server/src/auth/auth.service.ts:56-70`，种文件在 `:67`）。
2. **登录**：填邮箱+密码，可选勾「记住我（30 天内免登录）」（`apps/web/src/pages/LoginPage.tsx:210-234`）。表单字段名叫 `account`，但它本期只收邮箱——这个名字是给将来手机号登录预留的（`packages/shared/src/api/auth.ts:7`、`:55-59`）。
3. **忘记密码**：填邮箱+验证码+新密码（`apps/web/src/pages/LoginPage.tsx:308-343`）。重置成功回到登录视图，提示「密码已重置，请使用新密码登录」，邮箱自动回填省一次输入（`apps/web/src/pages/LoginPage.tsx:148-153`）。重置成功会把该账号**所有已登录的端全部踢下线**（`apps/server/src/auth/auth.service.ts:74-80`，批量吊销在 `apps/server/src/session/session.service.ts:58-67`）。
4. **登录态有效期**：缺省 7 天，勾「记住我」30 天（`apps/server/src/session/session.service.ts:26-28`）。同一账号最多同时 5 个登录，超出时**最早的**被踢（`apps/server/src/session/session.service.ts:6`、`:35-42`）。
5. **邮箱唯一即身份**：一个邮箱只有一个账号；登录、注册、忘记密码都按邮箱查号（`apps/server/src/auth/auth.service.ts:41`）。邮箱首尾空格和大小写自动归一，`Foo@X.com ` 和 `foo@x.com` 是同一账号（`packages/shared/src/api/auth.ts:28-33`）。
6. **密码 6~64 位**：注册、登录、重置密码三处同一口径（`packages/shared/src/api/auth.ts:50`、`:57`、`:65`）。
7. **验证码三条规则**：10 分钟内有效（`apps/server/src/auth/email-code.service.ts:9`）；60 秒内不能重发（`apps/server/src/auth/email-code.service.ts:11`，服务端在 `:58-61` 强制；前端发码成功才起倒计时，`apps/web/src/pages/useCodeCountdown.ts:8-17`、`apps/web/src/pages/LoginPage.tsx:88`）；**连续输错 5 次作废**，须重新获取（`apps/server/src/auth/email-code.service.ts:13`、`:79-89`）。
8. **发码前先查场景**：注册场景邮箱已被注册 → 直接 409「该邮箱已注册，请直接登录或换用其他邮箱」；忘记密码场景邮箱未注册 → 404「该邮箱尚未注册，请确认后重试或先注册」（`apps/server/src/auth/auth.controller.ts:38-43`）。
9. **验证码全环境恒为随机 6 位数字并尝试真实发信**（`apps/server/src/auth/email-code.service.ts:50-52`、`:63-72`）。开发/测试环境**万能码 `123456` 并存**：只要系统给这个邮箱发过码（存在存量码），输入 123456 也算通过（`email-code.service.ts` verify 的 masterOk 分支、默认值在 `apps/server/src/config/env.ts:31`）——没发过码时 123456 无效；生产环境不认万能码，只认真实验证码。开发环境没配 SMTP 时发信静默跳过（不影响用万能码），配了就真发信；`SMTP_PORT=465` 时使用 SSL 加密连接，其他端口保持非隐式 TLS 协商。已配 SMTP 但真实发信失败时，页面显示失败原因、不启动重发倒计时，并解除服务端重发锁；本地仍可使用万能验证码继续流程。`@e2e.gmind.dev` 测试邮箱的主动拦截不属于失败，不触发错误提示。本机从 `scripts/dev-local.env.example` 复制出 `scripts/dev-local.env`（git 已忽略）并填写；macOS / Linux 跑 `scripts/dev-restart.sh`，Windows 跑 `powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 restart` 生效。
10. **手机号只是资料**：可以在设置页补填/换绑手机号（需当前密码核身，`apps/server/test/users.e2e-spec.ts:236`），页面标「未验证」（`apps/web/src/pages/SettingsPage.tsx:468`）；**手机号本期不能用来登录**（登录 schema 只收邮箱，`packages/shared/src/api/auth.ts:55-59`）。
11. **页面布局（2026-11-17 Figma 16:708 实读校准）**：宽屏左侧依次为连线标志、脑图插画、介绍文案，三块正常排列、不互相覆盖；蓝紫背景光晕、四个特点图标、文案和间距按原型实现（`apps/web/src/pages/LoginPage.tsx:31-59`、`:196-218`；`apps/web/src/styles.css:33-60`）。左栏占 11/21，登录页以一屏高度为边界，脑图在剩余空间里等比缩放；常见桌面窗口不需要滚动即可看全（`apps/web/src/styles.css:32`、`:45-46`）。右侧表单水平、垂直居中，底部保留视口高度 4% 的空间，使视觉重心略向上（`apps/web/src/styles.css:61`）。特点与版权文字为 12.25px，介绍最大宽度 448px，右侧标题为 28px；复选框和底部链接不再被通用输入框、按钮高度撑大（`apps/web/src/styles.css:51-64`、`:78-84`）。宽度不超过 900px 时隐藏左栏，只显示表单（`apps/web/src/styles.css:87-91`）。这只是视觉布局，不改变三视图的填写、提交和跳转逻辑。
12. **脑图动效**：二级及以下连线在 700ms 内淡入，延迟为「层级 × 180ms」；节点也在 700ms 内淡入，延迟为「100ms + 层级 × 180ms」。一级连线和中心主题不额外添加动画（`apps/web/src/pages/InfiniteMap.tsx:100-121`；`apps/web/src/styles.css:47-48`）。系统开启「减少动态效果」时不播放（`apps/web/src/styles.css:90-92`）。

## ③ 特殊情况

- **验证码过期或输错**：提示「验证码错误或已过期，请重新获取后再试」（`apps/server/src/auth/email-code.service.ts:85`）；连错 5 次后原码作废，就算第 6 次输对也不认，必须重新发码（`apps/server/src/auth/email-code.service.ts:84`）。重新发码成功会清空失败计数（`:75`）。
- **注册邮箱被占**：发码这一步就会被拦（见规则 8）；极小概率的并发双开（两个人同时用同一邮箱提交注册）由数据库唯一键兜底，后到的拿 409「该邮箱已注册，请直接登录」（`apps/server/src/auth/auth.service.ts:62-65`）。
- **账号被停用**：密码正确也拒绝登录，提示「账号已被停用，请联系管理员」（`apps/server/src/auth/auth.service.ts:48`）。
- **账号不存在 / 密码错误**：分别提示「账号不存在，请先注册」（`apps/server/src/auth/auth.service.ts:42`）、「密码错误，请重新输入或找回密码」（`:44`）。
- **管理员建出的号没有密码**：这类账号**无法用密码登录**（服务端按「密码错误，请重新输入或找回密码」拒绝，有 e2e 钉死无密码死路，`apps/server/test/auth.e2e-spec.ts:229`）。本人要登录，走「忘记密码」用邮箱验证码设一个密码即可；登录前设置页的改密卡对无密码账号显示引导文案并禁用表单（`apps/web/e2e/login-page.e2e.spec.ts:148`）。
- **发码太频繁**：60 秒内重复点「获取验证码」→ 429「验证码发送过于频繁，请 60 秒后再试」（`apps/server/src/auth/email-code.service.ts:58-61`）；前端在倒计时结束前按钮本来就是禁用的（`apps/web/src/pages/LoginPage.tsx:269`、`:323`）。
- **密码发码接口不会泄露账号是否存在**：注册场景「已注册」、忘记密码场景「未注册」都有明确文案（见规则 8），这是产品口径（两段式文案逐字裁定），不算泄露面收窄。

## ④ 待需求方确认

以下细节是 agent 按当前实现如实登记的，需求方尚未逐字认过；要改就是新任务。

1. **手机号登录将来开放的口径**：需要先有短信服务和存量手机号补验流程；「补验通过的历史手机号是否直接可登录」没有裁定记录（现有裁定只写到「本期不可登录」，spec `docs/superpowers/specs/2026-11-12-account-redesign-design.md` §二 裁定 2）。
2. **微信扫码登录的后续路线**：需要微信开放平台账号；现在设置页「绑定微信」只是占位，点击提示「微信绑定暂未开通，敬请期待」（`apps/web/src/pages/SettingsPage.tsx:497-500`），数据库已预留 `wechat_unionid` 列（`apps/server/src/database/migrations/20261112100000-auth-email-foundation.ts:16`）。
3. **演示管理员昵称「演示管理员」**：seed 脚本里写死的昵称与邮箱（demo@gmind.dev，`apps/server/scripts/seed-demo.ts:89`），昵称用词未经你逐字确认。

## ⑤ 最后核对

- 功能规则 1–10 的核对日期：2026-11-13；代码版本：commit `aeb91bd709e14ea3c097f2013031e7c970379adf`（main）。
- 规则 9 的本机 SMTP 配置说明核对日期：2026-11-18；代码版本：commit `ebc53c250a86c44cbf348d8edbbc82377ba6295d` 加当日尚未提交的开发配置改动。
- 视觉规则 11–12 的核对日期：2026-11-17；代码版本：commit `08f5750682d32e5c0a10f269a2442856dc705ada` 加当日尚未提交的登录页改动。本次只改布局与动效，功能规则未改。
