# 测试约定（2026-10-28 P1 成文）

> 目的：e2e 钉**行为契约**，不钉 UI 计数/位置——这几轮每改 UI 都要人肉适配十几处计数断言（图标钮 16→15→14 这类）的摩擦，根源是断言写错了层次。本约定自今日起生效，新写/新改 e2e 必须遵守；存量断言随动随改，不推倒重写。

## 一、定位器优先级

1. **`data-testid`（语义名）**：交互入口、容器、关键状态位。testid 一旦发布就视为公共契约，改名=同步全部引用并在状态表登记。
2. **`getByRole(..., { name })`**：按钮/菜单项/页签的**行为**定位（用户视角的名字，比 testid 更抗结构调整）。
3. CSS 类名/结构选择器：仅限视觉/几何断言（折叠徽标位置、溢出裁切等），不用于行为触发。

## 二、禁止的断言形态

- ❌ **计数断言**（`toHaveCount(N)` / `toHaveLength(N)`）：按钮数量、分组数量、图标数量、标签数量。UI 加减入口是常态演进，计数必然随动。
- ❌ **组序/坐标断言**（`boundingBox().x` 比较、offsetTop 相等）：仅当「顺序本身是需求」时才允许（如工具栏组序裁定），且必须在该用例头注明裁定出处。
- ❌ 文案断言绑定**非需求文案**（占位文案、提示语）。需求级文案（错误两段式=原因+下一步）可以断言。

## 三、推荐的替代写法

- 计数 → 改为「关键元素存在且可见」+「被移除的元素不存在」（toHaveCount(0) 针对**特定项**合法）。
- 组序 → 改为「每个入口可达且功能正确」。
- 视觉对齐 → 截图走查（Orca）而非坐标断言；必须几何断言时写清「这是布局裁定」。

## 四、存量处理

- 已存在的计数/组序断言保留可用，但**下一次因 UI 变化而失败时，必须按本约定改写为行为断言**，不允许只把 N 改成新数字。
- 每次改动若涉及计数断言，在状态表 e2e 基线登记里写明「已按约定改写为行为断言」或「仍保留计数（理由）」。

## 五、开发库卫生与测试账号判据

- 测试账号判据（2026-11-13 起随邮箱注册制改判）：以**邮箱域**识别测试账号——server e2e 造号统一 `@test.dev`（`apps/server/test/support/auth-test.ts:21`，`uniqueEmail` 默认域），web e2e 造号统一 `@e2e.gmind.dev`（`apps/web/e2e/helpers/auth.ts:22`，`E2E_DOMAIN` 勿改）。清理走 `apps/server/scripts/cleanup-test-users.ts`（**dry-run 默认**，`--apply` 才真删）：只清「邮箱属上述两域 + 名下无文件无协作」的账号（判据 SQL 见该脚本 `:41`），不误伤真实使用账号（演示号 @gmind.dev 等不在判据内）；旧「昵称 用户NNNN + 手机号 138 前缀」判据随手机号注册通道删除退役（存量旧手机号账号已随本次清库重来移除）。
- **环境事实①——gmind_test 库需存在**：compose 首次启动由 `docker/mysql/init/01-databases.sql:2` 建好 `gmind_test`（utf8mb4_unicode_ci）；compose 卷已初始化后再手动 DROP 该库不会自动重建，需手工 `CREATE DATABASE gmind_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`——`createTestApp` 只跑迁移不建库（`apps/server/test/support/app-test.ts:17-19`）。
- **环境事实②——`createTestApp` 会 flush Redis db1**（`apps/server/test/support/app-test.ts:29-35`）：server e2e 每个测试文件启动前清空 Redis db1（验证码 60s 重发冷却键与旧会话残留全清，否则固定邮箱一分钟内重跑同 spec 撞 429）；本地 dev 默认用 db0（`REDIS_URL` 缺省 `redis://127.0.0.1:16379/0`），勿把 dev 指到 db1，否则联调中的验证码/会话会被 e2e 连带清掉。

## 六、web e2e 并行度（2026-11-13 裁定）

- `apps/web/playwright.config.ts:36-37`：`workers: 4` + `retries: 1`。教训一句话：默认 workers=cpu/2（本机 14 核=7）时 ~28 路并发打满 dev API 的 DB 连接池（TypeORM 默认 10）+ 单实例 MySQL 5.6 + 单 vite，断言默认 5s 窗口随机饿死——失败集合逐轮漂移（两轮 193/9、195/5 仅 3 例重合）、隔离重跑全过的负载相关偶发失败；降并行+失败重试后全量稳定。
