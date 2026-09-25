# Gmind M3b（分享与协作闭环）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付协作闭环的最后一环：分享链接与落地页、批量邀请与注册回填、节点级评论（楼中楼/角标/双向定位）、@提及与站内通知、邮件摘要；首批任务清偿准入台账 §7.8/7.9。验收「FR-SHR-001/004、FR-CMT-001~003/005/006 全过」。

**Architecture:** 分享/邀请/评论/通知为关系型业务数据（MySQL，不进 Y.Doc——spec §4.4）；评论实时性复用协同 WS 的 broadcastStateless（单连接多路复用，M2 架构红利）；**站内通知实时推送走 per-user SSE（/api/notify，UserGuard + text/event-stream，单实例内存注册表）**——spec §5.6 原设计 SSE，维持（通知需全局触达：被 @ 用户可能不在该文档页；WS stateless 只达文档内用户，裁定偏离理由记录）。邮件经 MailService 接口（M3a 已建，无 SMTP 时 log-only）。

**Tech Stack:** 无新增运行时依赖（SSE 用原生 express Response；nodemailer 引入 MailService 传输层——**裁定：引入 nodemailer@^6 作为 MailService 的 SMTP 传输实现**，无 SMTP_HOST 时零行为变化）。

**Spec:** PRD FR-SHR-001/004、FR-CMT-001~003/005/006、§5.7；spec §4.4/§5.6/§5.7；**准入台账 `docs/m2-entry-checklist.md` §7.8/7.9 首批必须**；M3a 终审 M3b Entry Checklist 全部条目。

## Global Constraints

- 准入 7.8：复制图片对象迁移——copyForUser 解析副本 docState 中全部 image.key，逐 key 经 StorageService.copyImage 迁移至新文件命名空间，setImage 回写新 key 后再落库；迁移失败的 key 保留原 key 并记录（不阻塞复制）。验收：复制含图文件 → 删原件 → runCleanup(+30d) → 副本图片仍 200 的 e2e。
- 准入 7.9：提醒去重 marker 加 deletedAt 分量（hasReminded 匹配该 fileId 且 deletedAt 等值）；还原时删除该 fileId 的既有提醒通知行（防死链堆积）。验收：提醒 → 还原 → 再删 → runCleanup(+27d) 产生第二条提醒的 e2e。
- 清偿小包：star 竞态捕获 duplicate-key → no-op 200；shared 视图行菜单收敛（删除/移动 owner-only 隐藏，重命名/复制保留——PRD 2.2.1 可编辑者可重命名）；编辑器工具栏加星入口（FR-FIL-004）；搜索命中高亮 <mark> + Ctrl/Cmd+Shift+F 聚焦搜索框（FR-FIL-008 收口两项；空间列随空间概念二期登记）。
- 分享（FR-SHR-001）：POST /api/files/:id/share（owner only）→ 128bit token（hex 32）→ {shareToken}；DELETE → status=closed 即失效；GET /api/share/:token → {fileId,title,ownerName,status}（closed → status 字段，前端失效页）；POST /api/share/:token/join（登录）→ active 才写 collaborator 行（role editor）→ {fileId}；closed → 410 语义「链接已失效」。/s/:token 落地页：校验 → 未登录跳 /login?redirect= → 登录后回跳 → join → /edit/:fileId。
- 邀请（FR-SHR-004）：POST /api/files/:id/invites {contacts: string[]}（1~50 个，邮箱或手机号格式分类）→ invites 行（pending，uk_invite 去重幂等）+ 各发邀请邮件；注册回填：auth.service 新用户创建后按其 email/phone 匹配 pending invites → 批量 accepted + 写 collaborator 行。
- 评论（FR-CMT-001~003）：GET /api/files/:id/comments → {threads（含 nodeDeleted 标记）, counts}；POST comments {nodeId, content(1~500), mentions?}——节点必须存在于当前 docState（服务端校验），nodeTextSnapshot 落创建时文本；POST replies（parent 楼中楼，时间正序）；评论与节点生命周期解耦（节点删除评论保留，nodeDeleted 标记）。可评论权限 = owner 或 collaborator（一期可编辑即含评论权）。
- 评论实时：评论/回复创建成功 → collab broadcastStateless {type:'comment-updated'} → 在线客户端刷新该文档评论数据；renderScene 增评论角标（增量扩展：NodeVisual 加 commentCount，节点标题右侧 N 小标——只增不改既有 DOM 契约）。
- 双向定位（FR-CMT-002）：点击节点评论角标 → 打开面板该节点线程；点击面板条目 → selectOnly(nodeId)（祖先链若折叠自动展开——core 已有 children 结构可查 pathToRoot）。
- @提及（FR-CMT-005）：输入 @ 唤起成员选择（GET /api/files/:id/collaborators → owner+collaborators 列表，新增端点）；提交时 mentions userId 数组服务端校验均为该文档协作者。
- 通知（FR-CMT-005/006）：notifications 表 type=mention/reply；被 @/被回复 → 行 + SSE 实时推（事件 {id,type,payload,createdAt}）；15 分钟未读邮件摘要：jobs 每分钟扫描（read_at IS NULL AND emailed_at IS NULL AND created_at ≤ now-15min）按 user+file 合并单封 → MailService → emailed_at 回写；用户偏好（关邮件）二期——**裁定：一期不做偏好开关，站内必推、邮件必发（有邮箱的），登记差异**。
- Conventional Commits 中文；TDD；gates = lint + typecheck + `pnpm test` + server e2e + web e2e。

---

### Task 1: 准入 7.8——复制图片对象迁移

**Files:**
- Modify: `apps/server/src/files/files.service.ts`（copyForUser）, `apps/server/src/storage/storage.service.ts`（如需 copyImage 暴露调整）
- Test: `apps/server/test/files-views.e2e-spec.ts` 增补

**Interfaces:** per Global Constraint 7.8——copy 时解析 image keys → copyImage → docState 内回写新 key → 落库；失败 key 保留原 key + log（不阻塞）。e2e：A 复制含图文件 → DELETE 原件 → TrashService.purgeFile（或 runCleanup(+30d)）→ 副本图片 GET /api/images/{新key} 200（旧 key 404）。

- [ ] **Step 1 失败测试** → **Step 2-4** 实现→gates → **Step 5: Commit** `fix(server): 复制迁移图片对象至副本命名空间（准入 7.8）`

---

### Task 2: 准入 7.9——提醒去重与还原清理

**Files:**
- Modify: `apps/server/src/jobs/cleanup.service.ts`, `apps/server/src/trash/trash.service.ts`（restore 清旧提醒）
- Test: `apps/server/test/trash.e2e-spec.ts` 增补

**Interfaces:** per Global Constraint 7.9——hasReminded 匹配 fileId+deletedAt；restore 删除该 fileId 的 system/restore 提醒行。e2e：提醒 → 还原（通知行被清）→ 再删 → runCleanup(+27d) → 第二条提醒产生。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `fix(server): 提醒去重含删除时间分量与还原清旧提醒（准入 7.9）`

---

### Task 3: 清偿小包（star 竞态/视图菜单收敛/编辑器加星/搜索高亮+快捷键）

**Files:**
- Modify: `apps/server/src/files/files.service.ts`, `apps/web/src/pages/WorkspacePage.tsx`, `apps/web/src/pages/EditorPage.tsx`, `apps/web/src/pages/editor.css`
- Test: 相关 e2e 增补

**Interfaces:** per Global Constraint 清偿小包四项。e2e：并发加星（两端同时 PUT star → 均两行一或 no-op 200 无 500）；shared 视图 row-menu 无删除/移动项；编辑器工具栏星标切换（data-testid="star-toggle"）与工作台同步；搜索高亮 <mark>（data-testid="search-hit"）与 Ctrl/Cmd+Shift+F 聚焦。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `feat: 清偿包——star 竞态/视图菜单收敛/编辑器加星/搜索高亮快捷键`

---

### Task 4: 分享链接与落地页（FR-SHR-001）

**Files:**
- Modify: `apps/server/src/files/files.controller.ts`（或新建 share 模块）, `apps/web/src/App.tsx`（/s/:token 路由）, WorkspacePage（分享入口按钮）
- Create: `apps/server/src/share/share.module.ts`, `share.service.ts`, `share.controller.ts`; `apps/web/src/pages/ShareLandingPage.tsx`
- Test: `apps/server/test/share.e2e-spec.ts`, `apps/web/e2e/share.e2e.spec.ts`

**Interfaces:** per Global Constraint 分享。服务端 e2e：创建（owner）→ token 32 hex；非 owner 创建 404；关闭后 GET status=closed、join 拒绝；join 写 collaborator（第二次 join 幂等 no-op）；closed join → 410。web e2e：A 创建分享复制链接 → B（新账号）开链接 → 未登录跳登录 → 登录后回跳 → 加入 → 进编辑器可编辑；关闭链接后 B 再开 → 失效页。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `feat: 分享链接——创建/关闭/落地页与加入流（FR-SHR-001）`

---

### Task 5: 批量邀请与注册回填（FR-SHR-004）

**Files:**
- Modify: `apps/server/src/share/*`, `apps/server/src/auth/auth.service.ts`（注册回填）, `apps/server/src/mail/mail.service.ts`（nodemailer 传输）
- Test: `apps/server/test/share.e2e-spec.ts` 增补

**Interfaces:** per Global Constraint 邀请。e2e：批量邀请 3 联系人（2 邮箱 1 手机号）→ invites 行 + invites 表状态；未注册邮箱注册后 → 自动 accepted + collaborator 行 + 可见 shared 视图；重复邀请幂等；>50 拒 400；非法格式拒 400；auth 回填对手机号注册同样生效。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `feat(server): 批量邀请、注册回填与邮件传输层（FR-SHR-004）`

---

### Task 6: 评论域 API + WS 广播（FR-CMT-001/003）

**Files:**
- Create: `apps/server/src/comments/comment.entity.ts`（注册）, `comments.service.ts`, `comments.controller.ts`, `comments.module.ts`
- Modify: `apps/server/src/collab/collab.service.ts`（暴露 broadcastStateless 给 comments 模块）, DatabaseModule, AppModule
- Test: `apps/server/test/comments.e2e-spec.ts`

**Interfaces:** per Global Constraint 评论。e2e：创建（节点存在于 docState、快照落对、>500 拒 400、无权 404、节点不存在 400）→ counts 正确；回复楼中楼时间正序；节点删除（软删文件不适用——是 doc 内删节点）后 threads nodeDeleted=true 且保留全文；comment-updated 广播到达在线 provider 客户端（复用 collab.e2e 客户端模式断言 stateless 收到）。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `feat(server): 评论域——CRUD/楼中楼/节点解耦与 WS 广播（FR-CMT-001/003）`

---

### Task 7: 评论 UI 与双向定位（FR-CMT-002）

**Files:**
- Modify: `packages/engine/src/render.ts`（评论角标——NodeVisual.commentCount）, `packages/engine/src/types.ts`, `apps/web/src/pages/EditorPage.tsx`, editor.css
- Create: `apps/web/src/editor/CommentPanel.tsx`
- Test: `packages/engine/src/render.test.ts` 增补, `apps/web/e2e/comments.e2e.spec.ts`

**Interfaces:** 引擎增量（commentCount 角标渲染 + 幂等更新——镜像 note badge 模式）；EditorPage：进入文档拉评论（GET）→ nodeData 携带 counts；comment-updated stateless → 重新拉取；右面板评论 tab（列表按时间倒序 + 节点筛选 + 输入框 + @提及占位 T8 接）；角标点击 → 面板定位该节点线程；面板条目点击 → selectOnly 定位（pathToRoot 展开折叠祖先）。web e2e：A/B 双端评论可见性（A 评论 → B 角标出现）；回复；角标点击开线程；面板定位（选区断言）；节点删除后评论面板 nodeDeleted 标记。

- [ ] **Step 1 失败测试**（engine 角标 jsdom + web e2e）→ **Step 2-4** → gates → **Step 5: Commit** `feat(web/engine): 评论面板、节点角标与双向定位（FR-CMT-002）`

---

### Task 8: @提及与站内通知（FR-CMT-005）

**Files:**
- Create: `apps/server/src/notify/notify.module.ts`, `notify.service.ts`（通知写入 + SSE 注册表）, `notify.controller.ts`（GET /api/notify SSE + GET /api/notifications 列表 + POST /:id/read）
- Modify: `apps/server/src/comments/comments.service.ts`（mentions 校验 + 通知触发）, `apps/web/src/pages/WorkspacePage.tsx`（铃铛 + 未读数 + 通知下拉）, `apps/web/src/api/client.ts`（SSE 订阅 helper）
- Test: `apps/server/test/notify.e2e-spec.ts`, web e2e 增补

**Interfaces:** per Global Constraint 通知。e2e：A 评论 @B（B 为协作者）→ B notifications 行 + SSE 事件到达（supertest SSE 断言或 EventSource polyfill）；回复 B 的评论 → reply 通知；mentions 含非协作者 → 400 或过滤（**裁定：过滤并返回实际提及者，不 400**——避免枚举）；已读接口；铃铛未读数（web e2e：A @B → B 铃铛 +1、下拉显示、点击已读清零）。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `feat: @提及与站内通知——SSE 实时推送与铃铛（FR-CMT-005）`

---

### Task 9: 邮件摘要（FR-CMT-006）

**Files:**
- Modify: `apps/server/src/jobs/cleanup.service.ts`（或新建 digest job）, `apps/server/src/mail/mail.service.ts`
- Test: `apps/server/test/notify.e2e-spec.ts` 增补

**Interfaces:** 每分钟扫描任务 DigestService.runDigest(now)（可测方法 + 1min interval unref）：notifications (read_at IS NULL AND emailed_at IS NULL AND created_at ≤ now-15min) → 按 user+file 分组 → 单封摘要（MailService.sendMail；无 SMTP log-only）→ emailed_at 批量回写。e2e：伪造 3 条 15 分钟前未读通知（直接插行）→ runDigest → MailService 收到 1 封（spy/log 捕获）含 3 条内容、emailed_at 回写；已读/已发不重复。

- [ ] **Step 1 失败测试** → **Step 2-4** → gates → **Step 5: Commit** `feat(server): 15 分钟未读邮件摘要合并（FR-CMT-006）`

---

### Task 10: M3b 验收 + 终审配合

**Files:**
- Create: `docs/m3b-acceptance.md`

- [ ] FR-SHR-001/004、FR-CMT-001~003/005/006 逐条映射 + 准入 7.8/7.9 收口证明 + 清偿小包 + 全量回归真实数字 + 手动项（真实双机分享流、通知铃铛体验、邮件摘要经 MailHog——环境受限标待环境）。
- [ ] Commit `docs: M3b 验收清单与实测结果`

## 里程碑边界（本计划不做）

评论解决 Resolve/汇总面板（三期/二期）、跟随视角/头像栏（二期）、权限四级与团队空间（二期另立）、FR-FIL-008 空间列（随空间概念）、用户通知偏好开关（登记差异）、MailHog 环境接通（环境受限）。
