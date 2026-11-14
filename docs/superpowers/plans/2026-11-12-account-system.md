# 账号体系重做（邮箱注册制）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把"手机/邮箱/微信三通道登录即注册"重做为"邮箱验证码注册 + 邮箱密码登录"的账号体系。

**Architecture:** 契约先行（shared zod schema 全量重写）→ 数据迁移与验证码基建 → 服务端 auth/users/session/admin 重写（删 Provider 体系）→ 测试收敛（server helper + web helper 40 文件替换）→ UI 重做（登录三视图/设置页）→ 清库切换 → 文档同步。

**Tech Stack:** NestJS + TypeORM/MySQL 5.6 + Redis（ioredis）+ zod（packages/shared）+ React + Playwright。

**Spec:** `docs/superpowers/specs/2026-11-12-account-redesign-design.md`（本计划从它论证；执行者两份都要读）

**前置条件（T0）：** 需求方进行中工作的基线提交已完成（门禁五件套验证绿后单独提交）。本计划所有任务在干净基线上开始。

## Global Constraints

- MySQL 5.6：无 JSON/CTE/窗口函数；索引键 ≤191；实体列显式 snake_case。
- tsx 无 DI 元数据：Nest 注入一律显式 `@Inject(Token)`；迁移显式注册 `data-source.ts` 数组（守卫测试兜底）。
- 错误文案两段式=原因+下一步（NFR-USE-005）；文案逐字见 spec §六。
- UI 元素带 `data-testid`（语义命名 `login-*`/`reg-*`/`forgot-*`）。
- 不动 `packages/gmind-core`/`packages/engine`（本任务无引擎改动）。
- 邮箱归一：所有入口 schema `transform(trim + lowercase)`，服务端不再二次归一。
- dev/test 验证码恒为 `env.DEV_MAIL_CODE`（默认 `'123456'`）；production 忽略该变量且强制 SMTP 四项（HOST/PORT/USER/PASS）配置否则拒绝启动。
- **提交纪律**：每个任务的 Commit 步骤仅在需求方已授权该任务提交时执行（AGENTS.md §二）；基线提交已单独授权。执行交接时确认任务级授权方式。
- 任务间中间态允许 typecheck/e2e 局部变红（契约先行的必然代价）；终审门禁必须全绿。

## Review Focus

1. **邮箱变体绕过唯一性**（`A@X.com ` / 大小写混写应与 `a@x.com` 同一账号）——Task 1 schema transform 测试 + Task 4 rebindEmail 占用 409 测试钉死。
2. **生产漏配 SMTP 仍可启动/万能码复活**——Task 2 env 守卫单测（production 缺任一 SMTP 项 throw；production 忽略 DEV_MAIL_CODE）。
3. **验证码爆破与重放**（错 5 次码作废、同一码验证成功后失效）——Task 3 EmailCodeService 单测钉死。
4. **重置密码后旧会话仍有效**——Task 7 auth e2e 断言重置后旧 token 请求 401。
5. **无密码账号（admin 建号）登录/设置页死路**——Task 6 登录 401 文案、Task 9 设置页引导文案与 e2e 各钉一条。

---

### Task 1: shared 契约重写（auth schema 全量）

**Files:**
- Modify: `packages/shared/src/api/auth.ts`（全量重写）
- Modify: `packages/shared/src/enums.ts:6`（删 `LoginMethod`）
- Test: `packages/shared/src/api/auth.test.ts`（全量重写）

**Interfaces（Produces，后续任务全部依赖）:**

```ts
export const EMAIL_CODE_SCENES = ['register', 'password_reset', 'email_bind'] as const;
export type EmailCodeScene = (typeof EMAIL_CODE_SCENES)[number];
export const emailSchema: z.ZodString;              // .trim().toLowerCase().email() 归一，max 191
export const codeSchema: z.ZodString;               // /^\d{4,6}$/
export const emailCodeRequestSchema;                // { scene: z.enum(EMAIL_CODE_SCENES), email: emailSchema }
export const registerSchema;                        // { email, code: codeSchema, password: 6~64, nickname: 1~32 }
export const loginSchema;                           // { account: emailSchema, password: 6~64, rememberMe?: boolean }
export const passwordResetSchema;                   // { email, code, newPassword: 6~64 }
export interface LoginResponse { token: string; expiresAt: number; user: { id: string; nickname: string; avatarUrl: string | null }; }  // 形状不变
```

废弃不保留（直接删除，无兼容期）：`phoneLoginSchema`/`emailLoginBaseSchema`/`emailLoginSchema`/`wechatLoginSchema`/`loginSchema` 旧三分支 union、`LoginMethod`。

- [ ] **Step 1: 重写 `auth.test.ts`（先写失败测试）**——用例：①registerSchema 接受合法输入且 email 被归一（`' A@X.com '`→`'a@x.com'`）；②registerSchema 拒绝 5 位密码/空昵称/非数字验证码；③loginSchema 拒绝非邮箱 account、接受 rememberMe 缺省；④passwordResetSchema 形状；⑤emailCodeRequestSchema scene 枚举外的值被拒；⑥emailSchema 大小写/尾随空格归一（Review Focus #1）。
- [ ] **Step 2: 跑测试确认失败**——`pnpm --filter @gmind/shared test`，预期 FAIL（schema 尚是旧形状）。
- [ ] **Step 3: 实现**——按 Interfaces 重写 `auth.ts`；`enums.ts` 删 `LoginMethod`。文案常量（密码/昵称长度提示）带两段式文案。
- [ ] **Step 4: 跑测试确认通过**——`pnpm --filter @gmind/shared test` 全绿。
- [ ] **Step 5: 全仓 grep 确认旧符号引用面**——`grep -rn "LoginMethod\|phoneLoginSchema\|wechatLoginSchema" packages/shared/src apps/server/src apps/web/src`，命中清单记录到任务简报（Task 3/4/5/6 负责消红，web 侧若零命中则 Task 6 无契约改动）。
- [ ] **Step 6: Commit**——`feat(shared): 账号体系重做契约——邮箱注册/邮箱密码登录/验证码 scene`

### Task 2: 迁移 + env + mail + EmailCodeService

**Files:**
- Create: `apps/server/src/database/migrations/20261112100000-auth-email-foundation.ts`（类 `AuthEmailFoundation20261112100000`）
- Modify: `apps/server/src/database/data-source.ts:31`（注册迁移）、`apps/server/src/users/user.entity.ts`（email 非空 + `wechatUnionid` 列映射）、`apps/server/src/config/env.ts`、`apps/server/src/mail/mail.service.ts`
- Create: `apps/server/src/auth/email-code.service.ts`
- Test: `apps/server/src/config/env.test.ts`（守卫用例；文件已存在则追加）、`apps/server/src/auth/email-code.service.test.ts`、`apps/server/src/mail/mail.service.test.ts`（追加 auth/from 断言）

**Interfaces:**
- Consumes: Task 1 的 `EmailCodeScene`。
- Produces:
  - `EmailCodeService`（`@Inject` 注入方式与 `session.service.ts` 的 redis 客户端完全一致）：
    - `issue(scene: EmailCodeScene, email: string): Promise<void>`——60s 内重发 throw 429「验证码发送过于频繁，请 60 秒后再试」；dev/test 码恒 `env.DEV_MAIL_CODE`；production 随机 6 位数字；sendMail 返回 false → throw 500「邮件发送失败，请稍后重试；若持续失败请联系管理员」；成功后写 `email_code:{scene}:{email}` EX 600。
    - `verify(scene: EmailCodeScene, email: string, code: string): Promise<void>`——码不符/过期 → 失败计数 INCR（EX 600）并 throw 400「验证码错误或已过期，请重新获取后再试」；计数 ≥5 删除码；成功 → 删码+删计数。
  - Redis 键：`email_code:{scene}:{email}`、`email_code_wait:{scene}:{email}`、`email_code_fail:{scene}:{email}`。
  - env 新增：`SMTP_USER?`、`SMTP_PASS?`、`SMTP_FROM?`（默认 `'Gmind <noreply@gmind.local>'`）、`DEV_MAIL_CODE`（默认 `'123456'`，optional）；production 守卫：`NODE_ENV==='production' && (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS)` → throw（fail-closed）。
  - `mail.service.ts`：transport 增 `auth: env.SMTP_USER && env.SMTP_PASS ? { user, pass } : undefined`；`from: env.SMTP_FROM`；「无 SMTP 配置仅 log 返回 false」语义不变。

- [ ] **Step 1: 写失败测试**——env 守卫三条（production 缺 HOST/缺 USER/全部齐备不 throw；production 设置了 DEV_MAIL_CODE 仍被忽略——断言点在 EmailCodeService，放 Step 2）；EmailCodeService 五条（issue 后 Redis 有码、60s 二次 issue throw 429、verify 正确码通过且删码、verify 错码 throw 400、连错 5 次后正确码也 400）；mail 断言 transport auth/from。
- [ ] **Step 2: 跑测试确认失败**——`pnpm --filter @gmind/server test -- email-code`（及 env/mail），预期 FAIL。
- [ ] **Step 3: 实现**——迁移 SQL（spec §4.1 原文：MODIFY email NOT NULL + ADD wechat_unionid + ADD uk_users_unionid；down 全反向）、注册 data-source、实体两列、env 四项+守卫、mail auth/from、EmailCodeService（dev 分支：production 之外恒用 `env.DEV_MAIL_CODE`，即天然忽略 production 的固定码）。
- [ ] **Step 4: 跑测试确认通过**——上述单测全绿 + `pnpm --filter @gmind/server exec tsx src/database/data-source.test.ts` 不适用则 `pnpm test`（server 单测域）全绿。
- [ ] **Step 5: 迁移守卫**——`pnpm --filter @gmind/server test -- data-source` 绿（新迁移已注册）。
- [ ] **Step 6: 清理 gmind_test 库**（为 Task 7 铺路，存量 NULL email 行会让迁移在 e2e 库上失败）：`docker exec docker-mysql-1 mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS gmind_test"`（密码读 `docker/.env` 的 `MYSQL_ROOT_PASSWORD`）。
- [ ] **Step 7: Commit**——`feat(server): 邮箱注册基建——迁移/email-code 服务/SMTP 认证/生产守卫`

### Task 3: users 域重写（createByEmail/改密/换绑/昵称）

**Files:**
- Modify: `apps/server/src/users/users.service.ts`、`apps/server/src/users/users.controller.ts`、`apps/server/src/users/users-request.schema.ts`、`apps/server/src/auth/user.guard.ts`（fullUser 形状复核，不需改字段）
- Modify: `apps/server/src/session/session.service.ts`（新增 revokeAllForUser）
- Test: `apps/server/src/users/users.service.test.ts`（重写）、`apps/server/src/session/session.service.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 schema、Task 2 EmailCodeService（rebindEmail 验码用）。
- Produces:
  - `UsersService.findByEmail(email: string): Promise<User | null>`
  - `UsersService.createByEmail(input: { email: string; nickname: string; password: string }): Promise<User>`——bcrypt hash（cost 与现 `changePassword` 一致）；空库首注册=super_admin（沿用现 `:101-104` 逻辑）；不再有默认昵称派生（`defaultNickname` `:201-206` 删除）。
  - `UsersService.changePassword(userId: string, input: { currentPassword: string; newPassword: string }): Promise<void>`——旧密码错 throw 400「当前密码错误，请重新输入」；删验证码核身分支与 `verifyDevCode`（`:197-199`）。
  - `UsersService.rebindEmail(userId: string, input: { email: string; code: string; currentPassword: string }): Promise<void>`——先验当前密码（同上 400）→ `emailCode.verify('email_bind', email, code)` → 占用（他人）throw 409「该邮箱已绑定其他账号，请换用其他邮箱」。
  - `UsersService.rebindPhone(userId: string, input: { phone: string; currentPassword: string }): Promise<void>`——仅密码核身；占用 throw 409「该手机号已绑定其他账号，请换用其他手机号」。
  - `UsersService.updateNickname(userId: string, nickname: string): Promise<User>`
  - `UsersService.setPasswordForReset(userId: string, newPassword: string): Promise<void>`——无当前密码校验（resetPassword 专用）。
  - `SessionService.revokeAllForUser(userId: string): Promise<void>`——zrange 全量 del + 删 zset 键。
  - 路由：`POST /users/me/password`、`POST /users/me/email`、`POST /users/me/phone`、`PATCH /users/me`；`POST /users/me/rebind` 删除。
- [ ] **Step 1: 写失败测试**（users.service.test.ts 重写）——createByEmail 首注册 super_admin/第二人 member；changePassword 旧密错 400/成功；rebindEmail 密码错 400/码错 400/占用 409/成功；rebindPhone 占用 409/成功；updateNickname 落库；setPasswordForReset 覆写；session revokeAllForUser 后原 token validate=false。
- [ ] **Step 2: 跑测试确认失败**——`pnpm --filter @gmind/server test -- users.service session.service`，预期 FAIL。
- [ ] **Step 3: 实现**——按 Interfaces；controller/schema 同步（schema：changePassword 6~64 统一、phoneSchema 沿用 `/^1\d{10}$/`、nicknameSchema 1~32）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit**——`feat(server): users 域邮箱化——createByEmail/换绑拆分/自助昵称/会话批量吊销`

### Task 4: auth 域重写 + admin + dev-e2e（删 Provider 体系）

**Files:**
- Modify: `apps/server/src/auth/auth.service.ts`、`apps/server/src/auth/auth.controller.ts`、`apps/server/src/auth/auth-request.schema.ts`、`apps/server/src/auth/auth.module.ts`
- Delete: `apps/server/src/auth/providers/`（整目录：login-provider.interface/dev-phone/dev-email/dev-wechat）
- Modify: `apps/server/src/admin/admin.service.ts:89-106`、`apps/server/src/admin/admin-request.schema.ts:10-13`、`apps/server/src/dev/dev-e2e.controller.ts`
- Test: `apps/server/src/auth/auth.service.test.ts`（重写）、`apps/server/src/admin/admin.service.test.ts`（建号用例改邮箱）

**Interfaces:**
- Consumes: Task 1 schema、Task 2 EmailCodeService、Task 3 users/session 新方法。
- Produces:
  - `AuthService.login(account: string, password: string, rememberMe: boolean): Promise<LoginResponse>`——`findByEmail` 空→401「账号不存在，请先注册」；bcrypt compare 失败→401「密码错误，请重新输入或找回密码」；`status!=='active'`→401「账号已被停用，请联系管理员」（沿用 `:33`）；邀请回填 try/catch（沿用 `:37-43`）；`sessions.create(user.id, rememberMe)`；返回 `{token, expiresAt, user:{id,nickname,avatarUrl}}`。
  - `AuthService.register(input: RegisterInput): Promise<LoginResponse>`——`emailCode.verify('register', email, code)` → `createByEmail` → `createSeedFiles(user.id)` → 邀请回填 → `sessions.create(user.id, false)`；邮箱被占（并发兜底）→409「该邮箱已注册，请直接登录」。
  - `AuthService.resetPassword(input: { email: string; code: string; newPassword: string }): Promise<void>`——verify('password_reset') → `setPasswordForReset` → `revokeAllForUser`。
  - `POST /api/auth/email-code` controller：scene='register' 且 `findByEmail` 命中→409「该邮箱已注册，请直接登录或换用其他邮箱」；scene='password_reset' 且未命中→404「该邮箱尚未注册，请确认后重试或先注册」；然后 `emailCode.issue`。
  - admin：`createAccount({email, nickname})`（查重+唯一键兜底 409「该邮箱已绑定其他账号，请换用其他邮箱」沿用占位文案形态）；dev-e2e grant-collaborator 入参 phone→email。
- [ ] **Step 1: 写失败测试**——auth.service：register 成功（含种 3 文件断言/回填调用）/码错 400/被占 409；login 三条 401 文案分别断言；resetPassword 后 `revokeAllForUser` 被调用；admin 建号邮箱重复 409。
- [ ] **Step 2: 跑测试确认失败**——`pnpm --filter @gmind/server test -- auth.service admin.service`。
- [ ] **Step 3: 实现**——按 Interfaces；删 providers 目录；auth-request.schema.ts 改薄（直接 parse shared schema）；auth.module 装配 EmailCodeService；email-code 路由存在性前置检查在 controller。
- [ ] **Step 4: 跑测试确认通过** + `grep -rn "DevPhoneProvider\|DevEmailProvider\|DevWechatProvider\|LoginIdentity" apps/server/src` 为 0。
- [ ] **Step 5: Commit**——`feat(server): 邮箱注册制认证域——register/login/resetPassword+admin 邮箱建号，删三 Provider`

### Task 5: server e2e 收敛（helper + 13 替换 + 6 重写）

**Files:**
- Create: `apps/server/test/support/auth-test.ts`
- Modify: 13 个绕道 spec（collab/comments/events/file-content/files-views/files/folders/notify/share/storage/trash/users-me/versions 中含 `users.create({method:'phone'}` + 自定义 `tokenFor` 的文件，以当日 grep 为准）+ 6 个直登 spec（auth/users/share/todos/org/admin）
- Modify: `apps/server/test/support/app-test.ts`（无需加表；仅当 EmailCodeService 相关键需清理时在清库逻辑补 Redis flush）

**Interfaces:**
- Consumes: Task 2-4 的全部新端点。
- Produces:

```ts
// apps/server/test/support/auth-test.ts
export const TEST_CODE = '123456';                       // = DEV_MAIL_CODE 默认值
export function uniqueEmail(domain?: string): string     // 默认 'test.dev'，前缀 ts+随机
export interface TestAccount { id: string; email: string; token: string; }
export async function createAccount(app: INestApplication, opts?: { email?: string; password?: string; nickname?: string }): Promise<TestAccount>
  // = POST /api/auth/email-code(register) → POST /api/auth/register（code: TEST_CODE, password 默认 'pass123456', nickname 默认 '用户'+随机4位）
export async function loginToken(app: INestApplication, email: string, password?: string): Promise<string>
```

- [ ] **Step 1: 写 helper + 重写 `auth.e2e-spec.ts`**——用例清单：注册成功返回 token+3 个示例文件存在；重复邮箱 409；验证码错误 401；登录成功/账号不存在 401/密码错误 401/停用 401；rememberMe 缺省 expiresAt≈now+7d、true 时 ≈now+30d（±60s 容差）；email-code register 已注册 409 / reset 未注册 404 / 60s 重发 429；password-reset 成功后旧 token 全部 401（Review Focus #4）+新密码可登录；logout 仍工作。
- [ ] **Step 2: 13 个绕道 spec 机械替换**——`users.create({method:'phone', ...})`+`tokenFor` → `const { id, token } = await createAccount(app, {...})`；保留各 spec 对 nickname 的断言需求时传 `nickname`。
- [ ] **Step 3: 其余 5 个直登 spec 改口径**——users.e2e（改密=旧密码形态+rebind 拆 me/email/me/phone 用例）、admin.e2e（建号 {email,nickname}）、share/todos/org 的 `{method:'phone', code:'123456'}` → `loginToken`/`createAccount`。
- [ ] **Step 4: 跑全量 server e2e**——`pnpm --filter @gmind/server test:e2e` 全绿（gmind_test 已在 Task 2 Step 6 清过）。
- [ ] **Step 5: 收敛 grep**——`grep -rn "method: 'phone'\|method: 'wechat'\|'123456'" apps/server/test apps/server/src --include='*.ts' | grep -v auth-test.ts | grep -v email-code` 仅允许 dev/test 约定处命中（TEST_CODE 定义、env 默认值），其余为 0。
- [ ] **Step 6: Commit**——`test(server): e2e 收敛邮箱注册制——auth helper+全量替换`

### Task 6: web e2e helper + 40 文件替换（必须先于 Task 7）

**Files:**
- Create: `apps/web/e2e/helpers/auth.ts`
- Modify: 39 个含本地 `registerAndLogin` 的 spec + `admin-users.e2e.spec.ts`（三件套）+ 其余含占位串/API 登录的 spec（以当日 grep 清单为准；共 42 个 spec 文件）
- **不改**：`m0-acceptance.e2e.spec.ts` 的 UI 登录旅程（它存在的意义就是测 UI，归 Task 7 改造）。

**Interfaces:**
- Consumes: Task 4 的 register/login 端点（经 vite 代理 `/api`）。
- Produces:

```ts
// apps/web/e2e/helpers/auth.ts
export const E2E_DOMAIN = 'e2e.gmind.dev';
export interface WebAccount { email: string; password: string; nickname: string; token: string; }
export async function apiRegister(request: APIRequestContext, opts?: { email?: string; password?: string; nickname?: string }): Promise<WebAccount>
  // POST /api/auth/email-code + /api/auth/register（code '123456'；形态照 settings.e2e.spec.ts:71-86 先例）
export async function injectToken(page: Page, token: string): Promise<void>   // addInitScript 写 localStorage gmind.token
export async function registerAndLogin(page: Page, opts?: { nickname?: string }): Promise<WebAccount>
  // apiRegister(page.request) → injectToken → goto('/workspace') → 断言工作台可见（原副本落点语义）
```

- [ ] **Step 1: 建 helper**——按 Interfaces；`registerAndLogin` 保持旧调用形态兼容（多数副本只传 page；个别传昵称参数的映射到 `opts.nickname`，替换时逐文件核对调用点）。
- [ ] **Step 2: 分 4 批替换**（每批跑该批 spec 文件子集，命令 `pnpm --filter @gmind/web e2e <glob>`）：批A workspace/settings/admin-users/member-*；批B editor/task/markers 系；批C todos/org/comments/share 系；批D 其余+9 处 API 级登录改 `apiRegister`+`injectToken`。admin-users 三件套：`ADMIN_PHONE_CANDIDATES`→`ADMIN_EMAIL_CANDIDATES=['demo@gmind.dev']`、`apiLogin` 改 `{account, password}`、`uiLogin` 保留（Task 7 改造 LoginPage 后仍走 UI，本任务先改为邮箱表单占位实现）。
- [ ] **Step 3: 收敛 grep（验收门禁）**——`grep -rn "验证码（开发环境固定 123456）" apps/web/e2e --include='*.spec.ts'` 除 m0-acceptance 外为 0；`grep -rn "async function registerAndLogin" apps/web/e2e` 仅 helpers/auth.ts 命中。
- [ ] **Step 4: 全量 web e2e**——此时 LoginPage 仍旧 UI（旧登录端点已被 Task 4 删除，UI 登录必红）→ **预期结果：m0-acceptance 与任何仍走 UI 登录的用例红，其余全绿**。此为计划内中间态，记录红名单转 Task 7 消化。
- [ ] **Step 5: Commit**——`test(web): e2e 登录收敛为公共 helper（API 造号+注 token），40 文件替换`

### Task 7: web UI 重做（LoginPage 三视图/SettingsPage/AdminUsersPage）+ UI e2e

**Files:**
- Modify: `apps/web/src/pages/LoginPage.tsx`（重做）、`apps/web/src/pages/SettingsPage.tsx`、`apps/web/src/pages/AdminUsersPage.tsx`（添加表单 {email, nickname}）
- Test: `apps/web/e2e/login-page.e2e.spec.ts`（新建）、`apps/web/e2e/settings.e2e.spec.ts`、`apps/web/e2e/admin-users.e2e.spec.ts`、`apps/web/e2e/m0-acceptance.e2e.spec.ts`（改走新注册视图）

**Interfaces:**
- Consumes: Task 1 shared schema、Task 4 端点、Task 6 helper。

- [ ] **Step 1: LoginPage 三视图**——`view: 'login'|'register'|'forgot'` state machine；login=邮箱+密码+「记住我」checkbox（`login-remember`）+登录钮+「注册新账号」「忘记密码？」链接；register=邮箱+`reg-code-send`（60s 倒计时禁用）+验证码+密码+昵称+提交；forgot=邮箱+码+新密码→成功回 login 视图并提示「密码已重置，请使用新密码登录」；错误展示沿用 `.error` 容器；提交调 `loginSchema`/`registerSchema`/`passwordResetSchema` parse 后再发请求；成功 `setToken`+`navigate(safeRedirect)`。登录失败文案直接展示服务端两段式消息。
- [ ] **Step 2: SettingsPage**——改密卡（`me.hasPassword===false` → 引导文案「尚未设置密码，请通过登录页"忘记密码"用邮箱验证码设置」+禁用表单，Review Focus #5）；换绑拆邮箱区（新邮箱+`email_bind` 码+当前密码）/手机号区（当前手机号带「未验证」徽标+新手机号+当前密码）；新增「账号资料」卡（昵称行内编辑→PATCH /users/me）与「绑定微信」占位卡（点击 toast「微信绑定暂未开通，敬请期待」）。
- [ ] **Step 3: AdminUsersPage**——添加账号表单 phone→email。
- [ ] **Step 4: 写 UI e2e（先写测试）**——`login-page.e2e.spec.ts`：注册旅程（UI 收码填表→落工作台→3 示例文件可见）；登录失败文案断言；记住我勾选持久化（刷新后仍登录）；忘记密码→新密码登录成功；无密码账号（admin 建号）登录死路文案+设置页引导文案。m0-acceptance 改走新注册视图。
- [ ] **Step 5: 跑 Task 6 红名单+新 spec**——全绿（中间态清除）。
- [ ] **Step 6: Commit**——`feat(web): 登录三视图/设置页账号卡邮箱化/admin 邮箱建号`

### Task 8: 脚本邮箱化

**Files:**
- Modify: `apps/server/scripts/seed-demo.ts`（超管 `demo@gmind.dev`+4 同事邮箱账号，走 register API+固定码；昵称保留原设定；现 `:67` 的 PATCH /users/me 改昵称调用此时真实可用）、`apps/server/scripts/cleanup-test-users.ts:36-41`（判据改 email 后缀 `@test.dev`/`@e2e.gmind.dev` + 无文件无协作）

- [ ] **Step 1: 改 seed-demo**——演示账号邮箱清单：超管 `demo@gmind.dev`，同事 `chenmo@gmind.dev`/`zhouzhou@gmind.dev`/`xuran@gmind.dev`/`sunning@gmind.dev`（密码统一 `demo123456`），跑通 `pnpm --filter @gmind/server exec tsx scripts/seed-demo.ts`。
- [ ] **Step 2: 改 cleanup 判据** 并在 dev 库试运行（dry-run 输出命中清单）。
- [ ] **Step 3: admin-users e2e 探测回归**——`pnpm --filter @gmind/web e2e admin-users`（超管探测到 `demo@gmind.dev`，不再 skip）。
- [ ] **Step 4: Commit**——`chore(server): 演示/清理脚本邮箱化`

### Task 9: 清库切换 + 手工冒烟

- [ ] **Step 1: 按 spec §4.5 序列清库**——`down -v` → Redis 两库 FLUSHDB → `rm -rf apps/server/.data/storage*` → `compose:up` → `db:migrate` → `SHOW CREATE TABLE users` 确认 email NOT NULL + uk_users_unionid 存在。
- [ ] **Step 2: seed-demo 重建演示数据**（首个注册号=超管）。
- [ ] **Step 3: 手工冒烟 spec §六链路**（注册→登录 7/30 天→忘记密码旧会话失效→改密→换绑邮箱→补手机号→改昵称→admin 建号→受邀注册自动协作），结果逐条记入验收登记。
- [ ] **Step 4: 无 commit（数据操作）**。

### Task 10: 文档同步

**Files:**
- Modify: `docs/project-status.md`（§二 状态表新行；§三 记录 2026-11-12 新裁定：推翻「登录注册双模式不实现」旧裁定，邮箱注册制/手机号不可登录/微信删除登录通道+预留扫码登录路线/清库重来）
- Modify: `README.md:19`（登录说明改「邮箱验证码注册、邮箱+密码登录，开发环境验证码固定 123456」）、`README.md` 快速开始若涉及 seed 说明
- Modify: `docs/testing-conventions.md`（测试账号判据=邮箱域 `@test.dev`/`@e2e.gmind.dev`）
- Create: `docs/features/login.md`（AGENTS.md §四 五栏目：这是什么/规则逐条+当日 file:line/特殊情况/待需求方确认——手机号登录与微信扫码登录的将来开放口径/最后核对日期+commit）

- [ ] **Step 1: 逐文件更新**（project-status 的行按当日真实用例名与 grep 行号写，禁止转抄本计划）。
- [ ] **Step 2: 挂账登记**——`docs/m2-entry-checklist.md` 新增小节：微信扫码登录/微信真实绑定/手机号登录/管理员重置密码/IP 限流/手机号换绑补码/首注册竞态（逐条带验收语义）。
- [ ] **Step 3: Commit**——`docs: 账号体系重做验收同步——状态表/裁定变更/登录功能文档`

### Task 11: 终审

- [ ] **Step 1: 收敛 grep 三连**（Task 5 Step 5 + Task 6 Step 3 + `grep -rn "LoginMethod\|phoneLoginSchema\|wechatLoginSchema" packages/shared/src apps/server/src apps/web/src` = 0）。
- [ ] **Step 2: 门禁五件套全绿**：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`。
- [ ] **Step 3: 汇报**——按 AGENTS.md §五：先讲可感知变化，末尾「这次我替你做的决定」清单。

## 自查记录（Self-Review）

1. **Spec 覆盖**：spec §二 12 条裁定→Task 1-8 全覆盖；§4.5 清库→Task 9；§八 文档→Task 10；§六 验收→Task 5/7/9/11。无缺口。
2. **Step 扫描**：所有 code 步骤给到签名+文件+固定值；测试步骤给到用例名+断言点；无 TBD。
3. **类型一致性**：`EmailCodeScene` 三值在 Task 1/2/4 一致；`createAccount` 返回 `{id,email,token}` 在 Task 5/6 helper 一致；`revokeAllForUser` 命名 Task 3/4 一致。
4. **Review Focus**：5 条各有归属测试（Task 1⑥/2 Step1/3 Step1/5 Step1/7 Step4）。
5. **比例**：计划≈450 行 vs 预期代码量数千行，无转录。
