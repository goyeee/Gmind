# M0 验收清单（spec §9）

核验日期：2026-09-18。下表「结果」列全部为当日实测输出摘要（本会话逐条执行，非转抄历史报告）。

| # | 验收项 | 命令/操作 | 结果 |
| --- | --- | --- | --- |
| 1 | compose 四服务 healthy | `docker compose -f docker/docker-compose.yml ps` | **部分达成** —— mysql（`repo.guanyingyun.com:1443/other/mysql5.6:1`，:33061）Up 2 hours (healthy)；redis（`redis:7.2`，:63790）Up 2 hours (healthy)；**minio / mailhog 容器不存在**：镜像在本环境不可得（Docker Hub 受限，401 insufficient_scope），compose 定义已就绪，M0 代码路径不消费二者，镜像可得后 `pnpm compose:up` 即起 |
| 2 | 迁移建出 11 张 utf8mb4 表 | `pnpm --filter @gmind/server test:e2e`（db-init 用例） | **通过** —— db-init.e2e-spec.ts 2 tests passed；另对实库直查 information_schema 复核：gmind 库 11 张业务表（users / files / folders / file_collaborators / file_stars / invites / share_links / comments / versions / notifications / events）+ 1 张 `migrations` 记账表，collation 非 utf8mb4 的表为 0 |
| 3 | 会话五端互踢 | `pnpm --filter @gmind/server test`（session 用例） | **通过** —— session.service.test.ts 5 tests passed（Test Files 1 passed, Tests 5 passed） |
| 4 | 三方式登录注册（mock） | `pnpm --filter @gmind/server test:e2e`（auth 用例） | **通过** —— auth.e2e-spec.ts 8 tests passed（含手机验证码 / 邮箱验证码 / 邮箱密码 / 微信 mock 路径） |
| 5 | 注册种 3 个示例文件 | 同上 + files 用例 | **通过** —— files.e2e-spec.ts 4 tests passed（含终审新增：种子文件 structure='org' 落库断言、空标题 400 用例）；web e2e 用例 1「注册登录后看到 3 个示例文件」（断言恰好 3 个列表项，其一为 `欢迎使用 Gmind`）亦通过 |
| 6 | 浏览器全链路：注册→看到示例文件→新建 | `pnpm --filter @gmind/web e2e` | **通过** —— 实跑命令（本机 3000/5173 被占，用替代端口）：`PORT=3001 pnpm --filter @gmind/server dev` 起后端，然后 `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`，输出 `3 passed (2.1s)`：注册登录见 3 示例文件 ✓ / 新建脑图列表首位 ✓ / 未登录跳登录页 ✓（真实后端，零 mock） |
| 7 | 无 token 访问受保护接口 401 | users-me 用例 | **通过** —— users-me.e2e-spec.ts 2 tests passed（无 token 401 / 无效 token 401） |

## 支撑输出（2026-09-18 实测；终审修复波后已复核刷新）

- `pnpm --filter @gmind/server test:e2e`：Test Files 4 passed (4)，Tests **16 passed (16)**（auth 8 / files 4 / db-init 2 / users-me 2），修复波复跑全绿。
- `pnpm --filter @gmind/server test`：Test Files 2 passed (2)，Tests 6 passed (6)（session 5 + data-source 迁移注册守卫 1）。
- `pnpm test`（全仓）：@gmind/core 3 passed、@gmind/shared 5 passed、@gmind/server 6 passed，apps/web 为占位（单测自 M1 起）。
- `pnpm lint`：exit 0，无输出。
- `pnpm typecheck`：server / web / gmind-core / shared 四包全部 Done，exit 0。
- `pnpm --filter @gmind/web e2e`：3 passed (2.1s)（见上表第 6 项命令）。

## 备注（如实记录）

- **redis 镜像替换**：`docker/.env.example` 写的是 `redis:7-alpine`，本环境不可拉取，实际使用本地已有 `redis:7.2`（`docker/.env` 已置 `REDIS_IMAGE=redis:7.2`，实施台账记录在案）；compose ps 实际显示即 7.2。
- **minio / mailhog**：镜像拉取受限于本环境网络（Docker Hub 代理 401），容器未启动；compose 中定义与健康检查补齐留待镜像可得后处理。此项即第 1 项「部分达成」的唯一原因。
- **验证码**：开发环境手机/邮箱验证码固定 `123456`（mock Provider），仅 dev。
- **git 状态**：按用户要求全程未做任何 commit/add，仓库无历史提交，当前所有 M0 成果均在工作区未入库；任务边界无快照可回滚，需人工检查后手动 `git add` / `git commit` 入库。
- **终审修复波**（全分支终审后一轮修复，diff 复审 4/4 ADDRESSED）：①注册种子按文档 meta 回填 `files.structure/theme_id`（原 'org' 模板被写成 'mindmap'）；②`POST /api/files` 改返回 FileListItem 形状 DTO，docState 不再出现在响应；③新增迁移注册守卫单测（目录文件数 vs 注册数组）；④files e2e 补空标题 400 用例。修复后计数已刷新如上（16/6/3）。
- M0 验收结论：**7 项中 6 项通过，第 1 项部分达成（2/4 服务 healthy）**；除 minio/mailhog 镜像来源这一环境问题外，无未决验收项。

## 登录页原型布局补记（2026-11-17）

- **改了什么**：左侧标志、脑图、介绍按原型纵向排列，修复插画覆盖文案；按设计稿补齐左右比例、蓝紫光晕、连线标志、四个特点图标、文案与间距；脑图按原型分层淡入，同时保留常见桌面窗口一屏完整显示。右侧三视图交互、testid、登录逻辑均未改。
- **自动化实测**：`WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web exec playwright test e2e/login-page.e2e.spec.ts` → **11 passed (10.7s)**。其中左侧无重叠与一屏完整显示用例在 `apps/web/e2e/login-page.e2e.spec.ts:31`，右侧垂直位置在同文件 `:58`，分层淡入与减少动态效果在 `:75`，Figma `16:708` 真实尺寸与位置在 `:89`；其余注册、登录失败、记住我、忘记密码、分享回跳等 7 项同轮通过。新凭证读取节点成功，未写入项目或文档。
- **浏览器实测**：`1512×845` 下录制并查看动画开始、中间、结束截图，126 个分层动画均正常结束；最终图标、光晕、比例与设计稿一致。`1440×900`、`1280×800`、`1280×720` 均无纵向溢出；`390×844` 只显示表单；浏览器脚本错误为 0。
- **全仓检查**：`pnpm typecheck` 全绿；`pnpm test` 共 1213 项通过（shared 43 / xmind-io 88 / core 386 / engine 428 / server 77 / web 191）。core 性能检查曾在前一轮以 3543.81ms/3602.18ms 超时，本轮完整复跑为 2888ms，小于 3000ms 阈值。登录页文件 eslint 通过，全仓 `pnpm lint` 同日复跑也已通过。
- 本次仅完成登录页原型同步，不刷新上方 2026-09-18 的历史验收结论。
