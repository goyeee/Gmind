# Gmind M2（实时协同）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付实时协同脊柱：Hocuspocus 网关（鉴权/持久化/配额）、Awareness 彩色光标与选区、在线成员面板、y-indexeddb 断网恢复与三态指示补全、远端更新收敛接线、并发混沌套件、50 机器人延迟压测——验收「FR-COL-001~005 全过；P95 <100ms；混沌套件全绿」。

**Architecture:** `@hocuspocus/server` 挂载现有 NestJS HTTP 服务（`/collab` 路径）：onAuthenticate 校验会话与文件权限（PermissionService 单点，404 语义）、onLoadDocument 从 MySQL `doc_state` 重建、onStoreDocument 防抖持久化（接替 PUT 为主通道，PUT 保留为 WS 不可用时的降级）+ `broadcastStateless` 广播持久化 ack。客户端 `@hocuspocus/provider`（Bearer 经 query）+ `y-indexeddb` 本地副本（断网编辑/重连合并/刷新兜底）。Awareness 携带用户身份（uid/昵称/颜色/进入时间/编辑中标记），引擎以**增量扩展**（只增不改）新增远端光标层。远端 update 在服务端与对端落地的收敛接线：`deriveNormalizeDirty` 挂 `doc.on('afterTransaction')`（准入清单 §1）。

**Tech Stack:** @hocuspocus/server + @hocuspocus/provider / y-indexeddb / y-protocols（Awareness 已内置于 provider）/ Vitest / Playwright 多上下文 / Node ws 机器人。

**Spec:** `docs/superpowers/specs/2026-09-18-gmind-phase1-design.md` §4.4/§5.4、PRD FR-COL-001~005、NFR-PERF-005；**准入清单 `docs/m2-entry-checklist.md` 全部条目**。

## Global Constraints

- engine 只增不改（远端光标层为新增模块；既有 DOM 契约 `data-node-id`/`data-for-id`/`.gm-*` 类名不得变动；renderScene 等既有签名不变）。
- 光标颜色：高对比度色板按 userId 哈希分配、会话内固定（FR-COL-002）；对红绿色盲可区分（色板避开纯红绿对）。
- 成员面板（FR-COL-005）：正在编辑/正在查看两组、创建者标识、成员退出 5 秒内移除——数据源 Awareness（本地渲染，无轮询）。
- 三态指示补全（FR-EDT-034/FR-COL-004）：「已保存 HH:MM / 保存中… / 离线编辑中，恢复联网后自动同步」+ WS 403 配额的非重试态（M1 已有）。
- 断网（FR-EDT-035/FR-COL-004）：断网期间可继续编辑（IndexedDB 兜底）；恢复后自动重连合并、无重复节点；本地副本保留 7 天。
- 配额（准入清单 §1）：服务端持久化路径用 `countAliveReachable`；协同写入的配额执行裁定——**onStoreDocument 持久化不拒绝（防数据丢失），超限时 broadcastStateless 配额告警 → 客户端置只读新增拦截标志 + toast**（PUT 路径维持 403 语义）；`QUOTA_STATUS` 文案与 `MAX_DOC_NODES` 常量统一（M1 遗留）。
- 撤销：远端应用不进本地撤销栈（已有 USER-origin 机制）——M2 加断言钉死；本地撤销只回退本人操作在多端下保持成立。
- 收敛：远端 update 落地路径必须经 `deriveNormalizeDirty` 收敛（准入清单 §1）——服务端 onLoadDocument 的 doc 与每个客户端 doc 都挂接；混沌套件全绿是发布门槛。
- 延迟（FR-COL-001/NFR-PERF-005）：≥50 并发机器人，任一操作端到端 P95 <100ms；`docs/perf-m2.md` 记录（发布验收在基准机重跑）。
- 测试债（准入清单 §5）：T8 navigate 真金样集成测试、链接/图片/图标刷新持久化 e2e、框选 getAttribute→poll、镜像 parity 测试——本计划 T9 顺带清偿可清偿项。
- 本地环境：server 3001（tsx watch）、web 5174、compose 基础设施；WS 经 vite 代理（`ws: true`）。
- Conventional Commits 中文；每任务 TDD；gates = lint + typecheck + `pnpm test` + server e2e + web e2e。

---

### Task 1: 服务端 Hocuspocus 网关（鉴权/加载/持久化/卸载）

**Files:**
- Modify: `apps/server/src/app.module.ts`（或新建 collab 模块）, `apps/server/src/main.ts`（attach 到 HTTP server）, `apps/server/src/config/env.ts`
- Create: `apps/server/src/collab/collab.module.ts`, `collab.service.ts`（Hocuspocus 实例与钩子）, `collab.controller.ts`（如需健康检查）
- Test: `apps/server/test/collab.e2e-spec.ts`（Node 端 raw WebSocket + Y 编解码直连 /collab）

**Interfaces:**
- Hocuspocus 挂载：`main.ts` 中 `const hocuspocus = new Hocuspocus({ ... }); hocuspocus.handle(info, request, response)`？——**绑定实现：使用 `@hocuspocus/server` 的 `Server` 型 API 或 `Hocuspocus` 类 + `webSocketServer` 接线到 `app.getHttpServer()` 的 'upgrade' 事件（path === '/collab'）**。以当前 @hocuspocus 版本的实际 API 为准（pnpm add @hocuspocus/server 后读其 d.ts），报告记录所选接线方式。
- 钩子：
  - `onAuthenticate({ token, documentName })`：SessionService.validate(token) → userId；PermissionService 语义（owner 或 collaborator 行，复用 FilesService.assertCanRead 的查询）→ 失败抛错拒绝连接（客户端收到 403 语义）；context 携带 `{ userId }`
  - `onLoadDocument({ documentName })`: 读 files.doc_state → `docFromState` → Y.Doc（无状态 → `createTemplateDoc` 空文档？——**裁定：无 doc_state 返回仅含 root 的空文档**）
  - `onChange({ documentName, doc })`: 节点数超限检测（countAliveReachable）→ 超限时 `broadcastStateless(documentName, JSON.stringify({type:'quota-exceeded'}))`（客户端置拦截标志）；**持久化本身交给 onStoreDocument（Hocuspocus 自带 debounce≈2s 可配）** → 写回 doc_state（Buffer.from(encodeStateAsUpdate)）+ `node_count`（countAliveReachable）+ ack：`broadcastStateless({type:'persisted', at: ISO})`
  - `onDisconnect`/`unload`：文档无人时从内存卸载（Hocuspocus 内置 unload 阈值，配置确认即可）
- 配额执行裁定（准入清单）：**持久化不拒绝**（防丢数据），超限广播告警；PUT 路径 403 语义不变。

- [ ] **Step 1 失败测试**（collab.e2e-spec.ts，用 `ws` + yjs 在 Node 直连 `ws://127.0.0.1:PORT/collab?token=…&file=…`——Hocuspocus 线协议用 lib0/y-protocols sync steps；**为降低测试复杂度：测试内直接用 @hocuspocus/provider 的 Node 可用形态或 y-websocket 风格握手**，以实际依赖为准）：
  1. 无 token → 连接被拒；伪造 token → 拒
  2. 非协作者连他人文件 → 拒（404 语义不泄露）
  3. owner 连接 → sync 成功且收到 doc_state 内容（root 文本可解码）
  4. 两客户端互同步：A 改文本 → B 收到
  5. B（owner）改 → A 收到；断开重连 → 内容仍在（持久化回写验证：直查 MySQL doc_state 已更新）
- [ ] **Step 2-4** 失败→实现→gates（`pnpm --filter @gmind/server test:e2e` 全绿 + 既有不回归）
- [ ] **Step 5: Commit** `feat(server): Hocuspocus 协同网关——鉴权/加载/持久化/配额告警`

---

### Task 2: 服务端配额常量统一与 markOpened 定点更新（M1 遗留清偿）

**Files:**
- Modify: `apps/server/src/files/files.service.ts`, `apps/server/src/config/env.ts`, `packages/shared/src/…`（如需共享常量）, `apps/web/src/editor/saveLoop.ts`
- Test: 既有 e2e 调整

**Interfaces:**
- `MAX_DOC_NODES = 500` 落入 `@gmind/shared`（或 server env），core 的 `MAX_DOC_NODES`? ——**裁定：常量放 `@gmind/shared` 导出，server/saveLoop 的 500 字面量全部改引**（M1 遗留：QUOTA_STATUS 文案硬编码）。
- `markOpened` 改定点更新：`repo.update(id, { lastOpenedAt })` 不推进 `updated_at`（M1 遗留：污染列表排序）。
- saveLoop 403 文案改引共享常量。

- [ ] **Step 1 失败测试**：markOpened 连续两次 open → `updated_at` 不变（e2e 断言 updated_at 无第二次变化）；grep 断言 500 字面量清零（一个 vitest 源码扫描测试或人工 grep 记录）。
- [ ] **Step 2-4** 失败→实现→gates
- [ ] **Step 5: Commit** `refactor(server): 配额常量统一与打开时间定点更新（M1 遗留清偿）`

---

### Task 3: 客户端协同接入与三态/离线（FR-EDT-034/035、FR-COL-004 基础）

**Files:**
- Modify: `apps/web/src/editor/useEditorDoc.ts`（provider 接管 doc 装配）, `saveLoop.ts`（真值表化）, `apps/web/vite.config.ts`（ws 代理）, `packages/shared/src/api/*`（如需）
- Create: `apps/web/src/editor/collab.ts`（provider + indexeddb 装配封装）
- Test: `apps/web/e2e/collab.e2e.spec.ts`

**Interfaces:**
- `startCollab(fileId, doc, callbacks): { destroy(): void; isSynced(): boolean }`：
  - IndexeddbPersistence(fileId, doc)（本地副本；FR-EDT-035 刷新兜底）
  - HocuspocusProvider({ url: `ws(s)://${location.host}/collab`, name: fileId, token: getToken(), document, awareness })
  - 状态回调：status → EditorPage 三态（connected/saving 由 persisted ack 驱动；disconnected → 「离线编辑中，恢复联网后自动同步」）
- **持久化真值表（binding）**：WS 已连接 → 服务端持久化（PUT 通道停用）；WS 断开 → saveLoop PUT 重启尝试（REST 可用时兜底）；网络全断（both 失败）→ 仅 IndexedDB，状态离线态。PUT 403 配额非重试态保留（M1）。
- vite 代理 `'/collab': { target: API_ORIGIN, ws: true }`。
- 离线 E2E：`context.setOffline(true)` → 编辑 → 状态「离线编辑中」→ reload（仍离线，内容来自 IndexedDB）→ setOffline(false) → 自动重连 → 对端（第二 context）看到内容合并且无重复。

- [ ] **Step 1 失败 E2E**（4 用例：三态显示/断网编辑恢复合并无重复/离线刷新 IndexedDB 兜底/PUT 降级——server WS 关闭模拟：测试内直接断网即可覆盖，PUT 降级用例 = 断网状态下 IndexedDB 兜底已覆盖 REST 不可达；**PUT 降级真值表用单测覆盖 saveLoop 决策函数**——抽出纯函数 `shouldPut(status)`）
- [ ] **Step 2-5** 失败→实现→gates→ Commit `feat(web): 协同接入——provider/IndexedDB 离线恢复与三态指示（FR-EDT-034/035）`

---

### Task 4: engine 远端光标层（增量扩展）

**Files:**
- Create: `packages/engine/src/cursors.ts`, `src/cursors.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- `createCursorLayer(scene: SceneRoot): CursorLayer`
- `CursorLayer.setCursors(cursors: RemoteCursor[]): void`——`RemoteCursor = { userId; name; color; nodeIds: string[] }`；渲染：每个远端用户在其（第一个）选中节点 `<g>` 内叠加 `rect.gm-remote-selection`（用户色描边）+ 节点上方 `g.gm-remote-cursor`（色点 + 昵称标签）；用户多节点选中 → 多框但单标签。节点删除时其上光标元素随更新清除或重挂（id 幂等：`data-cursor-user`）。
- `CursorLayer.clear()`；destroy 不需要（跟随 scene 生命周期，主题切换重建场景时页面层重建）。
- 纯渲染无事件；坐标从 NodeBox/场景 transform 继承（放 nodes 层内受视口 transform 管辖——**裁定：光标元素插入 scene.nodesLayer 末尾，随场景缩放平移**）。

- [ ] **Step 1 jsdom 测试**：setCursors 两个用户 → 两组元素、颜色/昵称正确；同用户更新节点 → 元素迁移不重复；clear 清空；用户色板确定性（userId 哈希 → 色，导出 `colorForUser(userId): string`）。
- [ ] **Step 2-5** 失败→实现→gates→ Commit `feat(engine): 远端光标层——彩色选区与昵称标签（FR-COL-002）`

---

### Task 5: Awareness 身份广播与编辑器接线

**Files:**
- Modify: `apps/web/src/editor/collab.ts`（awareness local state）, `apps/web/src/pages/EditorPage.tsx`（光标层接线）, `apps/web/src/api/client.ts`（me 信息暴露）
- Test: `apps/web/e2e/collab.e2e.spec.ts` 增补

**Interfaces:**
- Awareness local state：`{ user: { userId, nickname, color }, joinedAt, editing: boolean, selection: string[] }`；editing = 最近 3s 内有本地用户写（afterTransaction 时间戳）；selection 随 SelectionModel.onChange 广播。
- EditorPage：awareness states 变化 → `CursorLayer.setCursors(...)`（过滤自己）；选区类应用。
- 用户信息：注册/登录后 `GET /api/users/me` 已有——collab 装配时取一次（cache 到 module 级）。

- [ ] **Step 1 失败 E2E**（双上下文）：A/B 同时打开同一文件 → B 的画布出现 A 色选框与昵称标签（反之亦然）；A 关闭页面 → B 的 A 光标 5 秒内消失（Awareness 超时；测试用 waitForTimeout 上限断言消失）。
- [ ] **Step 2-5** 失败→实现→gates→ Commit `feat(web): Awareness 身份/选区广播与远端光标接线（FR-COL-002）`

---

### Task 6: 在线成员面板（FR-COL-005）

**Files:**
- Create: `apps/web/src/editor/MemberPanel.tsx`
- Modify: `apps/web/src/pages/EditorPage.tsx`（右上角成员按钮 + 面板）
- Test: `apps/web/e2e/collab.e2e.spec.ts` 增补

**Interfaces:**
- 右上角「成员」按钮（含在线数角标）→ 面板：两组「正在编辑 / 正在查看」（editing flag 分组）+ 每人头像占位（首字符色块，用户色）/ 昵称 / 进入时间；创建者（owner_user_id == userId，前端从文件 meta 或 awareness owner 字段——**裁定：GET /api/files/:id 已返回结构，扩展加 `ownerUserId` 字段**，server 一行）带「创建者」标识。
- 数据源 Awareness（本地计算分组，无轮询）；退出 5 秒内消失（Awareness timeout 保证）。

- [ ] **Step 1 失败 E2E**：A/B/C 三上下文（C 只看不编辑——C 的 awareness editing=false）→ A 面板显示 B 在编辑组、C 在查看组、A 带创建者标识；C 关闭 → 5 秒内从 A 面板消失。
- [ ] **Step 2-5** 失败→实现→gates→ Commit `feat(web): 在线成员面板——编辑/查看分组与创建者标识（FR-COL-005）`

---

### Task 7: 远端收敛接线与多端撤销断言（准入清单 §1）

**Files:**
- Modify: `apps/web/src/editor/collab.ts`（provider update → 已有 doc update 监听覆盖？——**验证：HocuspocusProvider 写入的是同一个 Y.Doc 实例，doc 'update'/'afterTransaction' 都会触发；deriveNormalizeDirty 挂在 afterTransaction（M1a 遗留：操作层的 one-shot listener 在 operations.ts）——远端事务没有走 withTransaction，因此**需要显式接线：`doc.on('afterTransaction', tr => { const dirty = deriveNormalizeDirty(doc, tr); if (dirty !== null) normalizeTreeFor(doc, ORIGIN_SYSTEM, dirty); else normalizeTree(doc, ORIGIN_SYSTEM); })`——放在 collab.ts，仅挂一次，标注「远端事务收敛」**）
- Test: `packages/gmind-core/src/remote-sync.test.ts`（core 级：模拟远端事务 applyUpdate 后断言收敛）+ 断言远端事务不进本地撤销栈（undo.test 增补：applyUpdate 后 um.undoStack 不变、undo 仍只回退本人）

- [ ] **Step 1 失败测试**：core 远端事务（applyUpdate 含 move/delete 残留）→ 无接线时不收敛（残留存在）→ 接线后收敛；远端 update 后本地 undo 行为不变。
- [ ] **Step 2-5** 失败→实现（collab.ts 显式挂接 + 文档注释）→gates→ Commit `feat(core/web): 远端事务收敛接线与多端撤销断言（准入清单 §1/§7）`

---

### Task 8: 并发混沌测试套件（PRD 风险表第一项缓解）

**Files:**
- Create: `packages/gmind-core/src/chaos.test.ts`

**Interfaces:**
- 双客户端模型（docA/docB/docC 经 update 交换）+ 随机化（**种子化 LCG，固定 20 个种子**）脚本生成器：每轮 N=100 操作随机抽样（addChild/setText/moveNode/deleteNodes/setIcon/applyStyle/toggleCollapse），三客户端各自本地执行后两两交换 update，全部收敛后断言：三端 `getNode` 全量快照 deep-equal + `normalizeTree` 各端 0 残留 + 服务端口径（countAliveReachable）三端一致。
- 场景偏置种子（确定性复现 PRD FR-COL-003 验收语义）：同文本 LWW、移动 vs 删除、换父 vs 换父、墓碑上编辑。
- 崩溃即 fail 并打印种子（可复现）。

- [ ] **Step 1 实现套件并运行**——若发现真实收敛缺陷：BLOCKED 报种子与最小复现（不许放宽断言）；预期 M1a repair 已覆盖大部分，混沌的价值在组合面。
- [ ] **Step 2: Commit** `test(core): 并发混沌测试套件——三端随机交错收敛（FR-COL-003/NFR-REL-005）`

---

### Task 9: 50 机器人延迟压测（FR-COL-001/NFR-PERF-005）+ 测试债清偿

**Files:**
- Create: `tools/latency-bots.mjs`（Node 脚本：ws + yjs 机器人）, `docs/perf-m2.md`
- Modify: `apps/web/e2e/*`（测试债顺带项）

**Interfaces:**
- 机器人：50 个 ws 连接（经 @hocuspocus/provider 的 Node 形态或裸 y-protocols sync——以 T1 实际验证过的连接方式为准），同一文档：每 bot 周期发文本编辑（user 写），全局统计任一 op 从发起到在**其他**连接上可见的延迟（op 内嵌 Lamport 时间戳/本地 clock，接收端比对 RTT 表），输出 P50/P95/P99。
- 运行：`node tools/latency-bots.mjs --url ws://127.0.0.1:3001/collab --token … --file … --bots 50 --duration 60`；断言 P95 <100ms（脚本退出码）；`docs/perf-m2.md` 记录环境与数字（基准机重跑声明）。
- 测试债顺带（准入清单 §5 可清偿项）：T8 navigate 真金样集成测试（engine）；链接/图片/图标刷新持久化 e2e（web，复用 rich-content 模式加 reload）；框选 getAttribute→poll。

- [ ] **Step 1** 实现并运行——P95 不达标：BLOCKED 报数据（不调阈值）；优化方向提示：Hocuspocus 广播即转发，瓶颈预期在持久化 debounce 阻塞（确认 onChange 不做同步重活）。
- [ ] **Step 2** 测试债三件 → 全量 gates
- [ ] **Step 3: Commit** `test: 50 机器人延迟压测与测试债清偿（FR-COL-001/NFR-PERF-005）`

---

### Task 10: M2 验收清单 + 全量回归 + 终审配合

**Files:**
- Create: `docs/m2-acceptance.md`

- [ ] **Step 1**: FR-COL-001~005 逐条验收（e2e 用例映射 + 压测数据引用）+ 手动项清单（真实双机体验：光标/面板/离线）+ 全量回归数字（lint/typecheck/unit/server e2e/web e2e/PERF=1 perf/latency bots）——诚实纪律同 M1。
- [ ] **Step 2: Commit** `docs: M2 验收清单与实测结果`

## 里程碑边界（本计划不做）

跟随视角/成员头像栏增强（FR-COL-008，二期后段）、协作动态流（FR-COL-007）、权限四级启用与逐成员调整（PRD 二期权限体系，另立里程碑）、评论汇总面板、断线补偿提示增强（FR-COL-004 完整态）、3 分钟版本快照（M4）、移动端。
