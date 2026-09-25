# Gmind M3a（文件管理与准入清偿）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付工作台完整文件管理域（四视图/文件夹/复制/星标/回收站/标题搜索）+ 清偿 M2 终审准入台账 7.1~7.4（存储属主校验、PUT/WS 写序守卫、收敛 web e2e 守卫、剪贴板 parity）。

**Architecture:** 复用 M0 建好的全部表（folders/file_stars/file_collaborators/events 等，本次首次消费）；回收站 = files.deleted_at 软删 + 每日定时任务（30 天彻底删除 + 前 3 天提醒，通知走 notifications 表 + MailHog）；四视图为 FilesService 查询层扩展；工作台 UI 从裸列表升级为 tabs + 操作菜单 + 文件夹 + 回收站页 + 搜索。last_modifier 经文档 meta（客户端 system origin 写入）→ 服务端持久化时回写 files 表。

**Tech Stack:** 既有栈无新增运行时依赖（node-cron 不引入——定时任务以「可测试的服务方法 + 启动时 setInterval 24h」实现，测试直接调方法）。

**Spec:** PRD FR-FIL-001~008/010、FR-EDT-003 复制语义；spec §5.3/§5.8；**准入台账 `docs/m2-entry-checklist.md` §7.1~7.4 逐项**。

## Global Constraints

- 准入 7.2（安全第一）：上传/copy 端点补属主校验——调用者须为 fileId 文件的 owner 或协作者（与 files 域 assertCanRead 同口径）；非授权 404（不泄露存在性）；copy 纳入配额（目标文件可编辑才可写入其命名空间）。验收：非协作者上传/copy 他人 key → 404 的 e2e。
- 准入 7.1：PUT/WS 陈旧写序守卫——PUT body 增 `baseUpdatedAt`（客户端装载/最后已知的服务端 updated_at）；服务端在「文件 updated_at 晚于 baseUpdatedAt 且协同模块持有该文档的内存活跃 doc」时拒绝 409「文档已在别处更新，请刷新后重试」；客户端 409 → 清 dirty、状态置该文案、提示刷新。验收：A（PUT 兜底）与 B（WS）并发编辑的自动化用例证明 B 的写不被 A 的陈旧快照覆盖。
- 准入 7.3：web e2e 守卫收敛接线——双页并发结构操作（移动 vs 删除）→ 双方画布与服务端 docState 收敛。
- 准入 7.4：engine/core 剪贴板镜像 parity 测试（同输入下 engine pasteText 与 core insertSpec 结构一致）。
- 回收站语义（FR-FIL-005~007/010）：删除=软删（deleted_at/deleted_by）；还原回原文件夹（已删则回根）；彻底删除连带 comments/versions/对象存储前缀；满 30 天自动彻底删；前 3 天通知（notifications 表 + MailHog 邮件）；个人回收站仅 owner 可见可操作。
- 复制（FR-FIL-003）：「原名-副本」、含节点数据与样式、不含评论与版本历史；复制需可编辑权限。
- 四视图（FR-FIL-001）：我的文件 / 与我协作（collaborator 行且非 owner）/ 星标（加星时间倒序）/ 最近打开（last_opened_at 倒序 50 条）；列表字段含 文件名/所有者/最近修改时间/修改人/所在文件夹。
- last_modifier：客户端每次用户写后在同一事务后以 system origin 写 doc meta `lastEditorUserId`；服务端持久化（WS onStoreDocument 与 PUT）读 meta 回写 `files.last_modifier_user_id`（PUT 路径亦校验与 token 用户一致时才写——离线兜底语义）。
- 文件夹（FR-FIL-002）：5 级嵌套校验、命名 1~64 字符禁 `/ \ : * ? " < > |`、非空删除提示入回收站（二次确认前端）。
- 定时任务：server 启动注册 24h interval（生产口径每日）；核心逻辑为 `TrashService.runCleanup(now)` 纯可测方法（e2e 直接调用+断言），禁止真实 sleep 等待。
- MinIO 换实现继续顺延（镜像在本环境不可得——M0 裁决，环境原因非决策；checklist 注记保留）。
- Conventional Commits 中文；TDD；gates = lint + typecheck + `pnpm test` + server e2e + web e2e。

---

### Task 1: 存储属主校验与 copy 配额（准入 7.2，安全优先）

**Files:**
- Modify: `apps/server/src/storage/storage.controller.ts`, `storage.service.ts`
- Test: `apps/server/test/storage.e2e-spec.ts` 增补

**Interfaces:**
- 上传 `POST /api/files/:id/images` 与 copy `POST /api/files/:id/images/copy`：注入 FilesService 的授权查询（owner 或 collaborator 行，deletedAt null）→ 非授权 404 `NotFoundException('文件不存在')`。
- copy 配额：目标文件 doc 节点数不变（图片非节点），配额语义为「目标可编辑」——即属主/协作者校验即配额（图片不占节点配额）；在响应中维持 `{key}`。

- [ ] **Step 1 失败测试**：非协作者上传到他人文件 → 404；非协作者 copy 他人 key 到自己命名空间 → 404；协作者上传 → 201；owner 不受影响（既有用例）。
- [ ] **Step 2-4** 失败→实现→gates → **Step 5: Commit** `fix(server): 图片上传/copy 端点补属主校验（准入 7.2）`

---

### Task 2: PUT/WS 陈旧写序守卫（准入 7.1）

**Files:**
- Modify: `apps/server/src/files/files.controller.ts`, `files.service.ts`（saveDocState 签名）, `apps/server/src/collab/collab.service.ts`（暴露「是否持有活跃内存 doc」查询）, `apps/web/src/editor/saveLoop.ts`（PUT body 带 baseUpdatedAt + 409 处理）, `apps/web/src/editor/useEditorDoc.ts`（记录 baseUpdatedAt）
- Test: `apps/server/test/file-content.e2e-spec.ts` 增补

**Interfaces:**
- PUT body: `{ docState: base64; baseUpdatedAt?: ISO }`（缺省视为 0=永远允许——兼容旧客户端/首次保存）。
- 拒绝条件：`file.updatedAt > baseUpdatedAt` **且** collab 模块持有该 fileId 的活跃内存 doc（说明有 WS 通道在写，PUT 是陈旧快照）。二者缺一则放行（纯 PUT 用户间无 WS 竞争面；无内存 doc 时最新落库者即 PUT 自己）。
- collab.service 增 `hasLiveDoc(fileId): boolean`。
- 客户端：useEditorDoc 记录 GET 响应的 updatedAt 为 base；saveLoop PUT 携带；409 → dirty=false、状态「文档已在别处更新，请刷新后重试」、停止重试（同 403 非重试模式）。
- baseUpdatedAt 刷新时机：收到 persisted ack 后以 ack 时刻的 updated_at？——**裁定：persisted ack payload 增 `updatedAt` 字段（服务端持久化成功后的行值），客户端收到后更新 base**；M1 的 `{type:'persisted', at}` 扩展为 `{type:'persisted', at, updatedAt}`（向后兼容：缺 updatedAt 不更新 base）。

- [ ] **Step 1 失败测试**：构造 file + collab 内存 doc（通过 T1 的 provider 测试客户端连接一次使其装载）；A 以旧 baseUpdatedAt PUT → 409 且 doc_state 未被覆盖（B 的内容保留）；无内存 doc 时旧 base PUT → 200（纯 PUT 场景不误伤）；新 baseUpdatedAt（≥ 当前）→ 200。
- [ ] **Step 2-5** 失败→实现→gates → Commit `fix(server/web): PUT 陈旧快照写序守卫（准入 7.1）`

---

### Task 3: 收敛 web e2e 守卫 + 剪贴板 parity（准入 7.3/7.4）

**Files:**
- Modify: `apps/web/e2e/collab.e2e.spec.ts`（增补）, `packages/engine/src/clipboard.test.ts`（增补）
- Test: 同上

**Interfaces:**
- 7.3 web e2e：A/B 两上下文同文档；A 拖拽移动节点 X 到 P1（或 API 级 moveNode 经 page.evaluate——用 __gmind.getDoc hook），B 同期删除 X；交换（等待 synced）→ 双方画布均无 X、无悬挂引用；**reload 后从服务端 docState 装载，结构完整**（无孤儿、无重复挂载）——断言双方 reload 后节点集合一致且 normalize 后无残留（通过 node-count 与画布快照）。
- 7.4 parity：同一组缩进大纲文本样本（含边界：空行/多空格/深回跳）→ engine pasteText（IDocHandle 桩）与 core insertSpec（真 doc）产出结构逐节点一致（text/children 形状）。

- [ ] **Step 1 失败测试** → **Step 2-4** 实现（若 parity 天然一致则以契约测试入库；收敛 e2e 若暴露真实缺陷按缺陷流程）→ gates → **Step 5: Commit** `test: 收敛 web e2e 守卫与剪贴板 parity（准入 7.3/7.4）`

---

### Task 4: 文件域查询扩展——四视图 + 删除 + last_modifier

**Files:**
- Modify: `apps/server/src/files/files.service.ts`, `files.controller.ts`, `packages/gmind-core/src/read.ts`+`operations.ts`（meta lastEditor 写入 helper）, `apps/web/src/pages/EditorPage.tsx`（afterUserWrite 写 meta）, `apps/server/src/collab/collab.service.ts`（持久化回写 last_modifier）
- Test: `apps/server/test/files-views.e2e-spec.ts`（新）

**Interfaces:**
- core：`markLastEditor(doc, userId, origin = ORIGIN_SYSTEM)`（写 meta.lastEditorUserId；不进撤销栈）。
- GET /api/files?view=mine|shared|starred|recent（默认 mine）：
  - mine：owner=me、alive、updatedAt DESC
  - shared：EXISTS(file_collaborators fc WHERE fc.user_id=me AND fc.file_id=files.id) AND owner != me、alive、updatedAt DESC
  - starred：JOIN file_stars（user_id=me）按 stars.created_at DESC
  - recent：mine ∪ shared，last_opened_at 非空倒序 LIMIT 50
  - 列表项增字段：`ownerUserId`/`ownerName`（JOIN users.nickname）/`lastModifierName`（JOIN users by last_modifier_user_id，可空）/`folderId`/`folderName`/`starred`（当前用户视角 boolean）/`lastOpenedAt`。
- DELETE /api/files/:id（owner only）→ 软删（deleted_at=now、deleted_by=me）→ 404 语义不泄露；删除后若 collab 持有内存 doc：断开连接并阻止重连（collab.service 增失效检查——onAuthenticate 已查 deletedAt，天然阻止重连；主动踢除：hocuspocus 断开该文档连接，**裁定：调用 hocuspocus 的 closeConnections? 按 v4 实际 API——若不便则依赖下次 persist 的 deletedAt 跳过 + 客户端下次 GET 404，踢除为增强项记录**）。
- last_modifier：EditorPage afterUserWrite → markLastEditor(doc, me.id)；collab onStoreDocument 读 meta.lastEditorUserId 回写 files.last_modifier_user_id；PUT 路径 body 增 `lastEditorUserId?`（客户端传，服务端校验 = token 用户才写入——离线兜底）。files 表 last_modifier_user_id 列——**检查迁移：M0 init 无此列 → 新增迁移 20260925000000（显式注册 createDataSource.migrations 数组 + 目录守卫测试自动覆盖）**。

- [ ] **Step 1 失败测试**（四视图各一例 + 删除后四视图均不可见 + shared 视图不含自己拥有的文件 + recent 50 上限 + last_modifier 链路：PUT 带 lastEditorUserId → 列表显示修改人昵称）→ **Step 2-5** → Commit `feat(server): 文件域四视图/删除/last_modifier 链路与迁移`

---

### Task 5: 文件夹域（CRUD/5 级/移动/删除入回收站）

**Files:**
- Create: `apps/server/src/folders/folder.entity.ts`（注册 DatabaseModule entities）, `folders.service.ts`, `folders.controller.ts`, `folders.module.ts`
- Modify: DatabaseModule entities 数组、AppModule
- Test: `apps/server/test/folders.e2e-spec.ts`

**Interfaces:**
- POST /api/folders {name, parentId?} → 5 级深度校验（parent 链 depth<5）、命名校验 → FolderItem {id,name,parentId,depth}
- GET /api/folders → 树（当前用户个人空间）
- PATCH /api/folders/:id {name} | {parentId}（移动：环检测——不能移入自己子树；深度重算）
- DELETE /api/folders/:id → 文件夹软删（folders.deleted_at）+ 其下所有文件（递归子文件夹）软删入回收站（复用 FilesService 软删，folder 整体入回收站策略）
- PATCH /api/files/:id {folderId}（移动到文件夹/null=根）——files.controller PATCH 扩展（title 之外可选 folderId）
- 还原规则挂钩 Task 7：文件夹删除后文件还原时原文件夹已删 → 回根目录。

- [ ] **Step 1 失败测试**（建/改名/5 级限制/第 6 级拒绝/移动环拒绝/删除含文件文件夹→文件进回收站且删除人记录/非法名字符 400）→ **Step 2-5** → Commit `feat(server): 文件夹域——CRUD/五级嵌套/移动环检测/整体入回收站（FR-FIL-002）`

---

### Task 6: 文件复制与星标（FR-FIL-003/004）

**Files:**
- Modify: `apps/server/src/files/files.service.ts`, `files.controller.ts`, `file-star.entity.ts`（新实体注册）
- Test: `apps/server/test/files-views.e2e-spec.ts` 增补

**Interfaces:**
- POST /api/files/:id/copy（可编辑权限：owner 或协作者）→ docFromState → 新文档（新 id、标题「原名-副本」）→ docToState 落库；不复制评论/版本（本来就不跟随）；docState 中图片 key 仍指向原文件命名空间（**裁定：一期同一用户内复制不迁移对象，key 共享合法——copy 端点属主校验已覆盖跨用户写**）。
- PUT /api/files/:id/star（加星）/ DELETE /api/files/:id/star（取消）→ file_stars 行；星标用户级。
- 列表 starred 字段联动（Task 4 查询已含）。

- [ ] **Step 1 失败测试**（复制→新 id/标题-副本/内容一致/源不变/无编辑权 404；加星→starred 视图含且按加星时间倒序；取消→移出；他人星标互不影响）→ **Step 2-5** → Commit `feat(server): 文件复制与星标（FR-FIL-003/004）`

---

### Task 7: 回收站（列表/还原/彻底删除/定时清理/到期提醒）

**Files:**
- Create: `apps/server/src/trash/trash.service.ts`, `trash.controller.ts`, `trash.module.ts`, `apps/server/src/jobs/cleanup.service.ts`
- Test: `apps/server/test/trash.e2e-spec.ts`

**Interfaces:**
- GET /api/trash → 我的回收站（deleted_by 任意但 owner=me；列表含 删除时间/删除人昵称/所在原文件夹名）
- POST /api/trash/:fileId/restore → 原文件夹在→回原处；不在→根（folder deleted_at 检查）
- DELETE /api/trash/:fileId → 彻底删除：files 行删除 + comments/versions 同删 + 对象存储前缀清理（StorageService.deletePrefix——LocalDisk 递归删目录）+ file_collaborators/invites/share_links/stars 清理
- TrashService.purgeFile(fileId)（供定时与手动复用）
- CleanupService.runCleanup(now)：满 30 天 → purge；剩 3 天 → notifications 行（type system + payload）+ 邮件（MailHog SMTP——**检查 env 是否有 SMTP 配置；M0 MailHog 容器未起（镜像不可得）→ 裁定：邮件发送接口化 MailService（SMTP 可配），无 SMTP 时仅落 notifications 并 log；MailHog 就绪后零改动接通**）
- 启动注册：main.ts setInterval(runCleanup, 24h)（dev 无害；测试直接调 runCleanup）
- server e2e：删除→列表含删除人/时间；还原回根（原文件夹已删）；彻底删后 comments/versions 消失、图片 404；runCleanup(now+30d) → 自动清除；runCleanup(now+27d) → notification 生成且不重复（同一条目只提醒一次）

- [ ] **Step 1 失败测试** → **Step 2-5** → Commit `feat(server): 回收站——还原/彻底删除/30 天清理/3 天提醒（FR-FIL-005~007/010）`

---

### Task 8: 全局搜索（FR-FIL-008，标题）

**Files:**
- Modify: `apps/server/src/files/files.service.ts`, `files.controller.ts`
- Test: `apps/server/test/files-views.e2e-spec.ts` 增补

**Interfaces:**
- GET /api/search?q= → 我的文件 + 与我协作的 alive 文件标题 LIKE（MySQL 5.6 utf8mb4 LIKE 大小写不敏感取决于 collation——utf8mb4_unicode_ci 已 CI）按相关度简单排序（前缀命中优先）LIMIT 20；返回复用列表项形状。
- 快捷键与 UI 在 Task 9。

- [ ] **Step 1 失败测试**（命中自己+协作文件；不含他人私有；前缀命中排序在前；空 q → 400）→ **Step 2-5** → Commit `feat(server): 标题全局搜索（FR-FIL-008）`

---

### Task 9: 工作台 UI——四视图/文件夹/操作/回收站/搜索

**Files:**
- Modify: `apps/web/src/pages/WorkspacePage.tsx`（重写为完整工作台）
- Create: `apps/web/src/workspace/*`（ViewTabs/ItemList/FolderTree/ContextMenu/TrashPage/SearchBox）
- Modify: `apps/web/src/App.tsx`（/trash 路由）、`apps/web/src/api/client.ts`
- Test: `apps/web/e2e/workspace.e2e.spec.ts`（新）

**Interfaces:**
- 布局：顶部（logo + 搜索框 + 新建按钮 + 用户菜单占位）+ 左侧文件夹树（可选「全部文件」根）+ 主区视图 tabs（我的文件/与我协作/星标/最近打开）+ 列表（文件名/所有者/修改时间/修改人/位置 + 星标点击 + 行点击进编辑器）
- 行操作菜单：重命名（prompt 弹层）/移动到文件夹/复制/加星/删除（→回收站）
- 回收站页：列表（删除时间/人）+ 还原/彻底删除（二次确认文案「不可恢复」）+ 提示条「30 天后自动清除」
- 搜索：输入回车 → 结果列表（复用列表行）
- E2E（workspace.e2e.spec.ts）：新建/重命名/移动到新建文件夹/复制出现副本/星标切换视图/删除→回收站可见→还原/彻底删除二次确认/搜索命中/四视图切换正确
- 既有 e2e 不得回归（M0 三例用 file-list li 结构——保持列表 DOM 兼容或同步更新 M0 用例选择器并说明）

- [ ] **Step 1 失败 E2E** → **Step 2-5** → Commit `feat(web): 工作台——四视图/文件夹树/操作菜单/回收站/搜索（FR-FIL-001）`

---

### Task 10: M3a 验收 + 终审配合

**Files:**
- Create: `docs/m3a-acceptance.md`

- [ ] FR-FIL-001~008（010 属回收站任务一并覆盖）逐条映射用例 + 准入 7.1~7.4 收口证明 + 全量回归真实数字 + 手动项清单（诚实纪律同前）。
- [ ] Commit `docs: M3a 验收清单与实测结果`

## 里程碑边界（本计划不做）

分享链接/邀请/评论/@提及/通知 SSE/邮件摘要（M3b）、内容级搜索与范围过滤（FR-FIL-009 P2）、团队空间与权限体系（二期另立）、XMind 导入导出与版本快照（M4）、图片对象跨文件迁移（key 共享裁定已记录）、MinIO 换实现（环境受限顺延）。
