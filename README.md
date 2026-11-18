# Gmind 在线协作脑图

浏览器端、协作为先的在线脑图工具。**进度：一期全部收官（M0~M6，2026-09-28）**——单机编辑内核、50 人实时协同、文件管理与分享、评论与通知、XMind 导入导出、PNG/JPG 导出、版本快照与恢复、设置页/快捷键面板/新手引导/埋点/移动端只读，以及企微对标包（图标化工具栏、查找替换、12 套主题、emoji、概要、格式刷、文档动态、协作者头像栏）。**2026-10-20 追加**：节点图文四槽位（上/下/左/右）与拖拽换位、图片独立右键复制/剪切（粘回沿用原 key）；图片大图预览支持滚轮 25%~800% 缩放、底部工具栏下载、右键复制图片与点图片外关闭；点图片显示图片轮廓、点文字显示整节点轮廓，拖角缩放灵敏度 ×2（200px 上限不变）。**2026-11-13 追加**：账号体系重做——邮箱验证码注册 + 邮箱密码登录（记住我 30 天）、忘记密码自助重置、管理员邮箱建号；手机号仅作资料（暂不可登录），微信仅留绑定入口。**2026-11-14 追加**：XMind 导入保真度升级——进度/表情/图标/图片/概要/超链接/样式全接入，降级提示逐项点名，导出对称写回。**2026-11-15 追加**：分享弹框导出改版五项（XMind/图片 JPG 白底/Markdown/CSV/Excel）；XMind 导出保真——结构写回（修复 XMind 8 打不开）、节点图片写回（图片打包进文件、缺图计数提示）、主题样式写回（真实 XMind 软件默认主题，曲线连接线），图片导出统一 JPG 白底；筛选双层化——改动默认仅自己可见（「· 仅你可见」）、可「对所有人生效」写入文件成为团队公共筛选、队友发布时无个人调整自动跟随+toast 提示、有个人调整不被覆盖、搜索关键词永远仅本次会话。**2026-11-16 追加**：顶栏成员头像堆在线绿点——在线成员头像右下角显示绿色小圆点、离线置灰、在线优先排序；登录页＋设置页视觉对齐——登录页左侧无限延伸脑图动效、表单与设置页样式规格对齐原型。**2026-11-16 追加**：头像刷新全链路——文件卡片显示真实创建者头像（悬停看昵称）、换头像后导航与编辑器同步更新；通知与侧栏用户菜单点击外部自动收起；编辑器右上角本人头像与个人中心弹框按需求方裁定删除（设置/退出走工作台侧栏用户卡）。**2026-11-18 追加**：弹框交互收尾——文件卡片 ⋯ 菜单与筛选弹窗点击外部自动收起；设置页原型结构对齐——预置头像选中态、部门/分组只读展示、绑定手机号掩码显示、通知偏好分组样式与图标。

> **查"什么已完成、什么待办"请看 [`docs/project-status.md`](./docs/project-status.md)**（里程碑状态表 + PRD 与代码的差异对齐清单）与 `docs/m0~m6-acceptance.md`（逐条验收真值）。PRD 的分期规划不等于交付状态。

## 快速开始（开发环境）

前置要求：Node ≥20、pnpm、Docker。

```bash
pnpm install
cp docker/.env.example docker/.env
pnpm compose:up          # MySQL 5.6 / Redis / MinIO / MailHog
pnpm db:migrate          # 建表（gmind 库）
pnpm dev                 # server :3000 + web :5174
```

打开 http://localhost:5174 ，用邮箱验证码注册、邮箱+密码登录。开发环境万能验证码 `123456` 始终可用；想在开发机也收到**真实验证码邮件**，从 `scripts/dev-local.env.example` 复制出 `scripts/dev-local.env`（git 已忽略）并填入 SMTP 参数，再跑 `scripts/dev-restart.sh`（Windows：`powershell -ExecutionPolicy Bypass -File scripts/dev.ps1 restart`）生效。需要演示数据时空库跑一次 `pnpm --filter @gmind/server exec tsx scripts/seed-demo.ts`（server 运行中；演示超管 demo@gmind.dev / demo123456）。

> **生产部署必读**：必须显式设置 `NODE_ENV=production`，并配置 `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS`（缺一服务拒绝启动）；漏设 `NODE_ENV` 会以开发语义运行（可使用万能验证码 `123456`，未配置 SMTP 时不发信，可被用来重置任意账号密码），属严重配置错误。

> 说明：MinIO / MailHog 的容器定义已就绪，但镜像来自 Docker Hub；若所在网络拉取受限，二者可暂缺 —— M0 代码路径不依赖它们（文件上传与邮件链路属后续里程碑）。

### 一键启停（端口约定固化：API :3001 + web :5174，与 e2e 门禁一致）

| 平台 | 启动 | 停止 | 重启 | 状态 | 日志 |
| --- | --- | --- | --- | --- | --- |
| macOS / Linux | `scripts/dev-start.sh` | `scripts/dev-stop.sh` | `scripts/dev-restart.sh` | `scripts/dev-status.sh` | `scripts/dev-logs.sh` |
| Windows PowerShell | `scripts\dev.ps1 start` | `scripts\dev.ps1 stop` | `scripts\dev.ps1 restart` | `scripts\dev.ps1 status` | `scripts\dev.ps1 logs` |

- 进程脱离终端运行（关窗不影响），日志统一落 `.data/dev-server.log`，pid 记录于 `.data/dev-server.pids`。
- 环境变量可覆盖：`PORT` / `WEB_PORT` / `REDIS_URL`（默认 `redis://127.0.0.1:16379/0`）。Redis 使用低位固定端口 16379，避开 Windows Hyper-V 高位动态保留区，也降低与本机默认 Redis（6379）的冲突。
- 从旧的 63790 环境升级后，执行一次 `pnpm compose:up` 重建 Redis 端口映射。旧 `REDIS_HOST_PORT` 配置不再读取；确需改宿主端口时使用 `GMIND_REDIS_HOST_PORT` 并同步设置 `REDIS_URL`。

### 本机端口占用时的替代命令

如果本机 3000 已被无关应用占用（开发机实测如此），按下面这组命令跑，行为完全等价；环境变量名分别为 `PORT`、`API_ORIGIN`、`WEB_PORT`，不设置时默认值仍为 3000 / 5174 / 3000。web 默认使用 5174，避开另一项目常用的 5173；如仍需换 web 端口，可覆盖 `WEB_PORT`：

```bash
pnpm compose:up                                                # 基础设施（同上）
PORT=3001 pnpm --filter @gmind/server dev                      # 后端改跑 :3001
WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web dev   # 前端 :5174，代理到 3001
```

E2E 验收同样带这两个变量（Playwright 会自动拉起 vite，后端需已在 3001 运行）：

```bash
PORT=3001 pnpm --filter @gmind/server dev                      # 终端 1，等 "listening on :3001"
WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e   # 终端 2
```

首次跑 e2e 需安装浏览器：`pnpm --filter @gmind/web exec playwright install chromium`。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm test` | 全部单元测试 |
| `pnpm --filter @gmind/server test:e2e` | 服务端集成测试（gmind_test 库） |
| `pnpm --filter @gmind/web e2e` | Playwright 端到端（需 compose 与 server 运行中） |
| `pnpm compose:down` | 停基础设施 |

## 文档

- **项目逻辑与进度（先读这个）**：[`docs/project-status.md`](./docs/project-status.md)——真相源分级、里程碑状态表、PRD≠交付的差异清单
- **代理规则**：[`AGENTS.md`](./AGENTS.md)——工程纪律、文档更新义务、需求不明确时先提问
- 产品需求：`Gmind_在线协作脑图软件_产品需求文档.md`
- 技术设计：`docs/superpowers/specs/2026-09-18-gmind-phase1-design.md`
- 实施计划（历史）：`docs/superpowers/plans/`
- 验收真值（逐里程碑，M0~M6）：`docs/m0-acceptance.md` … `docs/m6-acceptance.md`
- **功能逻辑说明（每核心功能一页，写给人看）**：`docs/features/`——排序/权限过滤/时效等规则逐条+代码出处
- 跨里程碑挂账台账：`docs/m2-entry-checklist.md`
- 性能基线：`docs/perf-m1.md` / `perf-m2.md` / `perf-m5.md`
