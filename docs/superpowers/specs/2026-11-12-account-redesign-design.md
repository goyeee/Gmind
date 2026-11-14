# 账号体系重做设计（邮箱注册制）

- 日期：2026-11-12
- 状态：已批准（需求方当日两轮问答拍板全部口径，计划文件与本文档一致）
- 性质："从头开始优化"系列第一步；里程碑级工作，按 AGENTS.md §三.9 SDD 流程执行
- 实施计划：`docs/superpowers/plans/2026-11-12-account-system.md`（writing-plans 产出）

## 一、背景与目标

现状（探查确认，file:line 为 2026-11-12 HEAD 2adcadb）：

- 登录即注册：任意手机号+固定验证码 `123456` 即自动建号（`apps/server/src/auth/providers/dev-phone.provider.ts:12-16`、`auth.service.ts:21-30`），无真正注册流程；
- 三通道身份各自为政：phone/email/wechat_openid 三列可空+各自唯一（`user.entity.ts:10-17`），无统一根基；开发态微信登录为共享账号（`dev-wechat.provider.ts:14`）；
- 密码可选、无忘记密码流程；邮箱从未真正验证（验证码写死，`dev-email.provider.ts:18-21` 不发信）；
- 管理后台仅手机号建号且不能设密码（`admin.service.ts:89-106`）；
- 邮件基建未接 SMTP 认证、发件人写死、全系统无发验证码邮件路径（`mail.service.ts:7,25-28`）。

目标：**邮箱注册制**——邮箱验证码验证通过才能建号，邮箱+密码登录；手机号退化为可补填资料；微信删除登录通道、保留绑定占位。

## 二、需求方裁定（2026-11-12，逐条）

| # | 裁定 |
| --- | --- |
| 1 | 注册=邮箱验证码验证通过后建号；表单=邮箱+验证码+密码+昵称。昵称沿用 `nickname` 字段、必填、可自助改 |
| 2 | 登录=邮箱+密码。手机号本期不可登录（未验证真伪不作登录凭证；等短信服务+补验后再开） |
| 3 | 用户 ID 沿用 ULID（char(26)，已唯一） |
| 4 | 邮箱可换绑、全库不可重复；注册即视为已验证（无需 email_verified 列） |
| 5 | 手机号可补填/换绑、不可重复、UI 标"未验证"、不加验证列 |
| 6 | 密码规则维持 6~64 位（改密现状 8~64 一并统一为 6~64） |
| 7 | 登录态默认 7 天，登录页"记住我"勾选 30 天（服务端 `session.service.ts:26-28` 已支持，本次前端接线） |
| 8 | 注册后保留自动创建 3 个示例文件（`files.service.ts:184-190`，触发点改至 register） |
| 9 | 保持开放注册（不搞邀请制） |
| 10 | 存量数据清库重来（开发/演示数据）；迁移走增量新迁移，不改历史迁移文件 |
| 11 | 微信登录通道删除；保留 `wechat_openid` 列+设置页"绑定微信"占位入口（提示"暂未开通"）；**后续要支持微信扫码登录**（本次预留 `wechat_unionid` 列），真实绑定/扫码登录等公众号与开放平台条件就绪另做任务 |
| 12 | 管理员建号=邮箱+昵称、无密码（本人经"忘记密码"首设）——因此 `password_hash` 保持可空，`hasPassword=false` 成为 admin 建号常态 |

需求方确认的延伸理解（批准计划时确认）：①自助改昵称端点补齐；②忘记密码重置成功后吊销该账号全部会话；③开发/测试环境验证码恒用固定码 `123456`（不真发信），生产强制 SMTP 配置（漏配拒绝启动）且忽略固定码环境变量。

## 三、非目标（本期不做，登记待办另开任务）

微信扫码登录（需开放平台账号）；微信真实绑定（公众号带参二维码+回调）；手机号验证与手机号登录；管理员重置密码；验证码 IP 级限流与图形验证码；手机号换绑补验证码；首注册 super_admin 并发竞态加固（`users.service.ts:101-104` 竞态注释在案，窗口极小）。

## 四、总体设计

### 4.1 数据模型

新迁移 `20261112100000-auth-email-foundation`（类 `AuthEmailFoundation20261112100000`，显式注册 `data-source.ts:31`，守卫测试自动覆盖）：

```sql
ALTER TABLE `users`
  MODIFY COLUMN `email` varchar(191) NOT NULL,
  ADD COLUMN `wechat_unionid` varchar(64) NULL,
  ADD UNIQUE KEY `uk_users_unionid` (`wechat_unionid`);
```

`password_hash` 保持可空；`uk_users_phone/email/wechat` 原样保留；不建新表（验证码存 Redis）。实体 `user.entity.ts` email 改非空、新增 `wechatUnionid` 映射。

### 4.2 API 契约（`packages/shared/src/api/auth.ts` 全量重写）

| 方法/路径 | 请求 | 响应/错误 |
| --- | --- | --- |
| POST `/api/auth/email-code` | `{scene: 'register'\|'password_reset'\|'email_bind', email}` | 204；register 已注册→409；reset 未注册→404；60s 重发→429；发信失败→500 |
| POST `/api/auth/register` | `{email, code, password, nickname}` | 200 LoginResponse（注册即登录）；码错/过期→401；邮箱被占→409 |
| POST `/api/auth/login` | `{account, password, rememberMe?}` | 200 LoginResponse；账号不存在/密码错/停用→401（两段式文案） |
| POST `/api/auth/password-reset` | `{email, code, newPassword}` | 204；成功吊销该用户全部会话 |
| POST `/api/auth/logout` | 已存在（`auth.controller.ts:35-41`），不动 | |
| POST `/api/users/me/password` | `{currentPassword, newPassword}` | 204；删验证码核身分支；强度 6~64 |
| POST `/api/users/me/email` | `{email, code, currentPassword}` | 204；换绑邮箱=密码+新邮箱码（scene=email_bind）；被占→409 |
| POST `/api/users/me/phone` | `{phone, currentPassword}` | 204；仅密码核身；被占→409 |
| PATCH `/api/users/me` | `{nickname}` | 200 fullUser；自助改昵称 |
| POST `/api/admin/users` | `{email, nickname}` | 201；无密码 active member、不种示例文件；重复→409 |

- 邮箱统一 trim+lowercase 归一（schema 单点 transform；MySQL utf8mb4_unicode_ci 唯一索引兜底）。
- `loginSchema.account` 字段名为将来手机号登录预留形状（本期仅收邮箱）。
- 废弃：method 三分支登录体、`/users/me/rebind`（拆 me/email+me/phone）、`LoginMethod` 枚举（`enums.ts:6` 删除）、改密验证码核身分支。
- `LoginResponse` 形状不变；`req.fullUser`（`user.guard.ts:29-37`）形状不变（`hasPassword` 保留：admin 建号=false，设置页据此显示引导）。

错误文案两段式清单：见 §六 验收口径表（原因+下一步，NFR-USE-005）。

### 4.3 服务端

- 删 `auth/providers/` 整目录；新增 `auth/email-code.service.ts`：Redis `email_code:{scene}:{email}`（EX 600）+ 重发等待键（SET NX EX 60）+ 失败计数（≥5 作废）；dev/test 恒用 `DEV_MAIL_CODE`，生产恒随机码+真实发信。
- `auth.service.ts` 重写 login/register/resetPassword（保留停用闸 `:33` 与邀请回填 `:37-43` 结构、种示例文件 `:29` 改挂 register）。
- `users.service.ts`：`createByEmail` 替代 `create(identity)`（保留首注册 super_admin）；`changePassword` 只留旧密码分支；rebind 拆 `rebindEmail`/`rebindPhone`（占用 409 沿用 `:143-149` 形态）；新增 `updateNickname`。
- `session.service.ts` 新增 `revokeAllForUser`（per-user zset `:22-24` 即索引）。
- `mail.service.ts`：transport 增 `auth`（SMTP_USER/SMTP_PASS）、发件人 `SMTP_FROM`；"未配置仅 log 不抛错"语义保留（邀请/摘要/回收站三调用方零改动）；验证码发送是唯一把 false 当失败的调用方。
- `config/env.ts` 增 SMTP_USER/SMTP_PASS/SMTP_FROM/DEV_MAIL_CODE + 生产守卫（未配 SMTP 拒启动，同 `:36-40` 纪律）。
- `admin.service.ts:89-106` 建号改邮箱；`dev/dev-e2e.controller.ts` 按 email 找用户；`invite.service.ts` 零改动（email 匹配天然兼容）。

### 4.4 前端

- `LoginPage.tsx` 重做：三视图 `login|register|forgot`（微信 tab 删除）；登录=邮箱+密码+记住我；注册=邮箱+获取验证码（60s 倒计时）+验证码+密码+昵称，成功即登录；忘记密码=邮箱+码+新密码→回登录视图。新 testid：`login-*`/`reg-*`/`forgot-*`。`safeRedirect`（`:11-19`）不动。
- `SettingsPage.tsx`：改密卡（无密码→引导文案+禁用表单）；换绑拆邮箱区/手机号区（手机号带"未验证"徽标）；新增"账号资料"卡（改昵称）与"绑定微信"占位卡；头像/通知偏好不动。
- `client.ts`/`RequireAuth` 不动（token 仍 localStorage `gmind.token`；会话有效性由服务端 TTL+401→clearToken 闭环）。
- `AdminUsersPage.tsx` 添加账号表单改邮箱。

### 4.5 清库序列（顺序硬约束）

```bash
docker compose -f docker/docker-compose.yml --env-file docker/.env down -v   # MySQL+MinIO 卷
redis-cli -p 16379 -n 0 FLUSHDB; redis-cli -p 16379 -n 1 FLUSHDB            # Redis 两库
rm -rf apps/server/.data/storage apps/server/.data/storage-e2e               # 本地对象存储
pnpm compose:up && pnpm db:migrate                                           # 空库跑全量迁移
# DROP DATABASE gmind_test（e2e 首跑自动重建）
# 起服务 → seed-demo（首个注册号自动成为 super_admin）
```

不清库直接迁移会撞存量 email NULL 行；Redis 不清会残留指向已删用户的会话。

## 五、测试策略

- 服务端：新增 `test/support/auth-test.ts`（`createAccount`/`loginToken` 走真实 API）；13 个绕道 spec 机械替换 `users.create({method:'phone'})`→`createAccount(app)`（58 处）；6 个直登 spec 重写（auth.e2e 全量：注册/重复 409/码错/记住我 +7d vs +30d expiresAt 断言/重置后旧 token 全 401 等）；无新表，`app-test.ts` DELETE 清单不变。
- web：新增 `apps/web/e2e/helpers/auth.ts`（API 造号+`addInitScript` 注 token，settings.e2e:72-86 先例放大），**必须先于 LoginPage 改动**；39 份 `registerAndLogin` 副本收敛为 1 份；新建 `login-page.e2e.spec.ts` 走 UI 覆盖三视图+记住我+错误文案；admin-users.e2e 超管探测改邮箱候选（`demo@gmind.dev`）。
- 收敛门禁（验收前 grep=0，helper/专项 spec 除外）：`验证码（开发环境固定 123456）`、`async function registerAndLogin`、`method: 'phone'|'wechat'`。
- 单测：shared `auth.test.ts`、`auth.service.test.ts`、`users.service.test.ts`、`session.service.test.ts`（+revokeAllForUser）、`mail.service.test.ts`（auth/from 断言）、`dev-e2e.controller.test.ts`。

## 六、验收口径

错误文案（两段式）：

| 场景 | 文案 | 码 |
| --- | --- | --- |
| 发码(register)邮箱已注册 | 该邮箱已注册，请直接登录或换用其他邮箱 | 409 |
| 发码(reset)邮箱不存在 | 该邮箱尚未注册，请确认后重试或先注册 | 404 |
| 发码过频 | 验证码发送过于频繁，请 60 秒后再试 | 429 |
| 发信失败 | 邮件发送失败，请稍后重试；若持续失败请联系管理员 | 500 |
| 验证码错误/过期 | 验证码错误或已过期，请重新获取后再试 | 400/401 |
| 登录账号不存在 | 账号不存在，请先注册 | 401 |
| 登录密码错误 | 密码错误，请重新输入或找回密码 | 401 |
| 注册/换绑邮箱被占 | 该邮箱已注册/已绑定其他账号，请直接登录/换用其他邮箱 | 409 |
| 换绑手机号被占 | 该手机号已绑定其他账号，请换用其他手机号 | 409 |
| 停用登录 | 账号已被停用，请联系管理员（不变） | 401 |

门禁五件套全绿 + §五收敛 grep=0 + 手工冒烟链路（注册收码建号→示例文件→登录 7/30 天→忘记密码重置旧会话失效→改密→换绑邮箱→补手机号→改昵称→admin 建号→受邀邮箱注册自动获得协作权）。

## 七、风险与对策

1. 生产漏配 SMTP 却开放注册 → fail-closed 拒启动+单测钉死；生产忽略 DEV_MAIL_CODE；
2. 清库顺序错误 → §4.5 固定序列，每步带校验；
3. 40 文件替换遗漏 → 收敛 grep 门禁+全量 e2e 兜底，分批替换；
4. 验证码防刷（60s/10min/错 5 次作废）；IP 限流不做（登记）；
5. 手机号换绑弱核身 → 登记（短信就绪后补码）；
6. 首注册 super_admin 竞态 → 不修、登记。

## 八、文档同步义务（交付时）

`docs/project-status.md` §二 新状态行 + §三 记录推翻旧裁定（2026-10-27 吸收轮第⑴条"登录注册双模式不实现"→ 2026-11-12 新裁定邮箱注册制）；`README.md:19` 登录说明；`docs/testing-conventions.md` 测试号判据改邮箱域（server `@test.dev`、web `@e2e.gmind.dev`）；产出 `docs/features/login.md`（AGENTS.md §四 五栏目+当日 file:line）；`AGENTS.md` 与历史验收文档（m0-acceptance）不改。

## 九、上线外部依赖（需求方侧，不阻塞开发）

生产环境需配置可发信的 SMTP（如企业邮箱/邮件推送服务）：`SMTP_HOST/PORT/USER/PASS/FROM`。未配置则服务拒绝启动（守卫）。开发环境可用 MailHog（`docker compose --profile extras up`）联调真实收信。
