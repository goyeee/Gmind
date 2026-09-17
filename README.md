# Gmind 在线协作脑图

浏览器端、协作为先的在线脑图工具。当前进度：M0（工程地基）。

## 快速开始（开发环境）

前置要求：Node ≥20、pnpm、Docker。

```bash
pnpm install
cp docker/.env.example docker/.env
pnpm compose:up          # MySQL 5.6 / Redis / MinIO / MailHog
pnpm db:migrate          # 建表（gmind 库）
pnpm dev                 # server :3000 + web :5173
```

打开 http://localhost:5173 ，手机号 + 验证码 `123456` 登录（开发环境 mock）。

> 说明：MinIO / MailHog 的容器定义已就绪，但镜像来自 Docker Hub；若所在网络拉取受限，二者可暂缺 —— M0 代码路径不依赖它们（文件上传与邮件链路属后续里程碑）。

### 本机端口占用时的替代命令

如果本机 3000 / 5173 已被无关应用占用（开发机实测如此），按下面这组命令跑，行为完全等价；环境变量名分别为 `PORT`、`API_ORIGIN`、`WEB_PORT`，不设置时默认值仍为 3000 / 5173 / 3000：

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

- 产品需求：`Gmind_在线协作脑图软件_产品需求文档.md`
- 技术设计：`docs/superpowers/specs/2026-09-18-gmind-phase1-design.md`
- 实施计划：`docs/superpowers/plans/`
- M0 验收清单：`docs/m0-acceptance.md`
