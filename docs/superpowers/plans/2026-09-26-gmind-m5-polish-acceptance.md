# M5 打磨与验收 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收口一期 P0 全清单——账号设置（改绑/改密码/通知偏好）、快捷键帮助面板、三步新手引导、埋点 11 事件补全、移动端只读+评论、错误文案规范走查、M4 挂账清偿，并产出全量 NFR-P0 验收文档。

**Architecture:** 全部为既有域的增量：/settings 新页面 + users 域两新端点（notify_prefs 列 M0 已预留）；快捷键帮助面板以 keyboardMap.ts 提取的清单为单一数据源；埋点复用 M4 的 POST /api/events + EventsService（服务端 record 调用点 + 客户端 POST 两类生产者）；移动端为 EditorPage 只读装配分支（客户端能力降级，非安全边界）；验收任务复跑既有 perf 脚本并汇总既有 e2e 安全/断网面。

**Tech Stack:** 既有栈不变；无新依赖。

**Spec:** docs/superpowers/specs/2026-09-18-gmind-phase1-design.md（§里程碑表 M5 行、§8.6 埋点、line 198 移动端明细、line 213 /settings）；PRD 6.3（NFR-USE-001/002/005）、6.4（埋点清单）、6.5.1（一期验收标准）、FR-ACC-002、FR-EDT-007。

## Global Constraints（全任务绑定）

- **唯一写入口**（文档域）：本计划不新增文档写路径；埋点/设置不动 Yjs。
- **MySQL 5.6**：新列显式 name + snake_case；notify_prefs 为既有 text 列（JSON 字符串），不加新表；迁移仅在有新列时建。
- **校验先于事务**、tsx 显式 `@Inject`、实体/迁移显式注册——既有纪律照旧。
- **埋点公共参数**：payload 携带 `clientVersion`（apps/web package.json version）与 `sessionId`（sessionStorage 随机 ULID）；user_id/doc_id 由服务端 record 列承载（脱敏由列语义天然满足——不落原文）。
- **错误文案规范（NFR-USE-005，P1）**：所有操作失败提示 = 失败原因 + 用户可执行的下一步动作；禁止仅「操作失败」。
- **通知偏好口径（M5 裁定，收口 FR-CMT-006 差异登记）**：邮件开关仅覆盖 mention/reply/permission 三类事件（PRD FR-CMT-006 事件列表）；system（回收站到期提醒）不受开关控制——FR-FIL-010 邮件提醒独立要求，恒发；站内通知不可关闭（PRD 原文）。
- **移动端只读口径（OPEN-T-005 裁定）**：≤768px 视口为只读——隐藏全部编辑控件、禁用写交互，画布保留平移/缩放/折叠，评论可看可发；装载仍走同一 WS（实时旁观他人编辑）。**客户端能力降级而非安全边界**（服务端不拒绝移动端写请求——一期无四级权限模型，登记差异）。
- **测试输出 pristine；TDD；逐任务 commit。**
- **本计划不做**（登记防漂移）：NFR-USE-003 全键盘/004 色盲友好（P2 三期）；快捷键自定义（P2）；通知偏好「按事件类型关闭站内」（PRD 明示站内不可关闭）；微信扫码登录真实对接（M0 DevProvider 裁定维持）；WACD 等 AARRR 指标看板（上线运营期考核，非本期交付物）；NFR-SEC-001/002 的 TLS/落盘加密实测（本地 dev 为 HTTP 明文，属生产部署核验项，如实登记）。

---

### Task 1: 账号设置页 /settings（FR-ACC-002 收口 + 通知偏好收口）

**Files:**
- Modify: `apps/server/src/users/users.controller.ts`、`users.service.ts`（两新端点 + 偏好）
- Create: `apps/web/src/pages/SettingsPage.tsx` + 路由注册（App.tsx）+ 工作台头部入口（WorkspacePage）
- Test: `apps/server/test/users.e2e-spec.ts`（追加）、`apps/web/e2e/settings.e2e.spec.ts`（新建）

**Interfaces:**
- Produces:
  - `POST /api/users/me/password` body `{newPassword: string(8~64), currentPassword?: string, code?: string}`——有密码（password_hash 非空）须 currentPassword 验证；无密码（手机号注册）须 code（开发环境固定 123456 通道语义，同登录）核身；成功 204；密码强度 = 8~64 位任意可见字符（PRD 未定义强度规则，登记）。
  - `POST /api/users/me/rebind` body `{channel: 'phone'|'email', newIdentity: string, code: string}`——code 校验（123456）→ 新身份格式校验（同登录 zod）→ 占用检查（被占 409 文案「该手机号/邮箱已绑定其他账号」）→ 改绑落列；204。
  - `GET /api/users/me/notify-prefs` → `{emailOptOut: ('mention'|'reply'|'permission')[]}`；`PATCH` 同 body 全量替换；非法成员 400。存储 = users.notify_prefs text 列 JSON `{"emailOptOut":[...]}`（M0 预留列，无需迁移）。
  - digest 过滤：`digest.service.ts` 分组后按用户 opt-out 过滤对应 type 的行（过滤行同样回写 emailed_at 收敛，防永久滞留——语义同无邮箱用户 :410）；system 行不受影响。
- Consumes: 既有 auth guard、zod schema 模式、SessionService（改绑/改密后**不**吊销其他会话——PRD 未要求，注释登记）。

- [ ] **Step 1: 失败服务端测试**（users spec 追加：无密码用户验证码设密成功；有密码用户旧密码错 400；rebind 成功改列；rebind 被占 409；prefs PATCH→GET round-trip；非法成员 400；digest：opt-out mention 用户 16 分钟未读 mention 行不收信且行回写 emailed_at、reply 行照收）。
- [ ] **Step 2: 服务端实现**（两新端点 + prefs 读写 + digest 过滤；密码 bcryptjs hash 复用 auth 同款）。
- [ ] **Step 3: 失败 web e2e**（工作台头部「账号设置」入口 → /settings；密码区按身份形态渲染（无密码=验证码输入，有密码=旧密码输入）；改绑表单提交成功 toast；偏好开关切换→刷新仍保持）。视口断言 testid：`settings-page`/`password-section`/`rebind-section`/`notify-pref-mention`（等三类）/`settings-save`。
- [ ] **Step 4: web 实现**（SettingsPage：三区卡片；开关即 PATCH；成功 toast 文案含下一步动作「已完成」→ 规范核对：成功提示不属失败文案，不强制两段式）。
- [ ] **Step 5: 全量门禁**（server e2e / web e2e / typecheck / lint）→ 提交 `feat: 账号设置页——改绑/改密码/通知偏好（FR-ACC-002 收口）`。

---

### Task 2: 快捷键帮助面板（NFR-USE-002 / FR-EDT-007）

**Files:**
- Modify: `apps/web/src/editor/keyboardMap.ts`（提取清单数据源）
- Create: `apps/web/src/editor/HelpPanel.tsx`
- Modify: `apps/web/src/pages/EditorPage.tsx`（Ctrl/Cmd+? 绑定 + 工具栏「快捷键」按钮 + 装配）
- Test: `apps/web/src/editor/keyboardMap.test.ts`（追加）、`apps/web/e2e/help-panel.e2e.spec.ts`（新建）

**Interfaces:**
- Produces（keyboardMap.ts 新导出）:
  - `interface ShortcutItem { id: string; group: '节点编辑' | '视图' | '文件'; label: string; win: string; mac: string; }`
  - `const SHORTCUT_LIST: ShortcutItem[]`——清单与 attachKeyboardMap 行为绑定**同文件同源**（清单条目 id 与绑定 switch 的 case 一一对应）。
- 一致性守卫（单测，防漂移）：`SHORTCUT_LIST` 的 id 集合 === keyboardMap 内部实际处理的动作集合（把绑定函数改为按 id 分发即可结构化保证；若现结构不便重构为按 id 分发，则导出 `handledActionIds(): Set<string>` 供测试比对——实现者按侵入最小方案选，报告注明）。
- Consumes: PRD 3.1.2 快捷键表（键位/分组以现网 keyboardMap 实际绑定为准——面板是「完整列出全部」，不新增键位）。

- [ ] **Step 1: 失败单测**（清单存在、三分组齐、id 集合 === handled 集合）→ **Step 2: 提取清单实现**。
- [ ] **Step 3: 失败 e2e**（`Control+?` 打开面板 testid `help-panel`；搜索框 `help-search` 输「折叠」→ 过滤后仅剩折叠相关条目；`Escape` 关闭；工具栏按钮 `help-toggle` 打开；模拟 macOS UA → 键位显示 mac 列）。
- [ ] **Step 4: HelpPanel 实现**（分组标题渲染全清单；模糊搜索 = label+win/mac 包含匹配大小写不敏感；isMac = `navigator.platform`/UA 检测；面板样式沿用 MemberPanel 抽屉模式）。
- [ ] **Step 5: 全量门禁** → 提交 `feat(web): 快捷键帮助面板——清单同源/搜索/平台键位（NFR-USE-002）`。

---

### Task 3: 三步新手引导（NFR-USE-001）

**Files:**
- Create: `apps/web/src/editor/GuideOverlay.tsx`（放 editor/ 便于 e2e 复用 helper？不——页面级，放 `apps/web/src/pages/`）
- Modify: `apps/web/src/pages/WorkspacePage.tsx`（装配）
- Test: `apps/web/e2e/guide.e2e.spec.ts`（新建）

**Interfaces:**
- Produces: testid `guide-overlay`、`guide-step-1|2|3`、`guide-next`、`guide-skip`；localStorage 键 `gmind.guide.done = '1'`；埋点 `guide_finish` payload `{stepsDone: number, skipped: boolean, elapsedMs: number}`（T4 的 POST /api/events 通道——本任务直接 POST，若 T4 未先行则先落 fetch 调用、T4 统一公共参数）。
- 步骤语义（M5 裁定：引导全部落在工作台页内，不跨页编排）：①「新建文档」高亮新建按钮；②「添加节点」提示打开任意文档即可添加（高亮种子文件列表首项）；③「邀请协作」高亮行菜单分享/成员入口。每步「下一步」，任意步「跳过」；完成或跳过均写 localStorage 并发 guide_finish。
- 触发口径（登记）：`localStorage` 缺 `gmind.guide.done` 即触发（「首次进入产品」按浏览器本地口径，跨设备不重复引导——PRD 未定义跨端口径，登记差异）。

- [ ] **Step 1: 失败 e2e**（新注册用户进 workspace → 引导出现 → 走完 3 步 → localStorage 置位 + POST /api/events body 含 guide_finish；刷新不再出现；另一用例中途跳过 → skipped=true 埋点 + 不再显示）。
- [ ] **Step 2: 实现**（浮层卡片 + 目标高亮（目标元素 getBoundingClientRect 描边或简化为整页浮层+文案，高亮实现从简——PRD 未规定高亮形态，验收=步骤可走可跳+埋点））。
- [ ] **Step 3: 全量门禁** → 提交 `feat(web): 三步新手引导——可跳过/完成埋点（NFR-USE-001）`。

---

### Task 4: 埋点补全（PRD 6.4 十一事件全清单）

**Files:**
- Modify: `apps/server/src/files/files.service.ts`（doc_create——createForUser 成功后 record，payload `{entry: 'blank'|'import'|'seed'}`）、`apps/server/src/share/share.service.ts`（invite_send type=链接 + collab_join）、`apps/server/src/share/invite.service.ts`（invite_send type=成员 + collab_join 注册转化）、`apps/server/src/comments/comments.service.ts`（comment_create——`{hasMention: boolean}`）
- Modify: `apps/web/src/pages/EditorPage.tsx`（node_add/node_delete——操作方式参数 `{via: 'keyboard'|'context'|'drag'|'paste'}`、error_occur 保存失败/装载失败、perf_metric 装载完成一次 `{firstInteractionMs}`）、`apps/web/src/api/events.ts`（新建：`track(type, payload)` 封装 POST /api/events，静默失败）
- Modify: `apps/server/src/events/event.schema.ts`（payload 加尺寸上界 `refine` ≤10KB——**M4 挂账清偿**；超限 400）
- Test: 各域 server e2e 追加 + `apps/web/e2e/telemetry.e2e.spec.ts`（新建，page.route 拦截断言）

**Interfaces:**
- Consumes: M4 `EventsService.record(type, fileId, userId, payload)` + `POST /api/events`（M4 Task 7 已交付）。
- 事件→生产点对照（PRD 6.4 清单，缺失九项）：doc_create=files.service；node_add/node_delete=EditorPage（客户端）；invite_send=invite createBatch + share createForOwner（`{channel:'member'|'link'}`）；collab_join=joinByToken + acceptPendingForNewUser（`{viaRegistration: boolean}`——回填路径当次注册 true）；comment_create=comments.service（`{hasMention}`）；guide_finish=T3；export_done/version_restore=M4 已有（核对公共参数补齐）；perf_metric/error_occur=web。
- 公共参数（Global Constraints）：clientVersion + sessionId 进 payload；服务端不校验二者存在（客户端职责）。

- [ ] **Step 1: 失败服务端测试**（逐域：建文件→events 表 doc_create 行；批量邀请→invite_send 行 channel=member；创建分享链接→channel=link；join→collab_join 行 viaRegistration 正确；评论→comment_create 行 hasMention 正确；payload >10KB → 400）。
- [ ] **Step 2: 服务端实现**（record 旁路 try/catch 隔离——埋点失败不得影响主流程，同 dispatchNotifications 模式）。
- [ ] **Step 3: 失败 web e2e**（route 拦截：进入编辑器添加节点→POST events type=node_add 含 via/clientVersion/sessionId；删除→node_delete；制造保存失败→error_occur——用 `__gmindCollab.setReachable(false)` 后编辑等既有离线编排触发）。
- [ ] **Step 4: web 实现**（track 封装 + 各操作点接线；sessionId = sessionStorage `gmind.sid` 惰性生成）。
- [ ] **Step 5: 全量门禁** → 提交 `feat: 埋点补全——PRD 6.4 十一事件全清单＋payload 上界（M4 挂账清偿）`。

---

### Task 5: 移动端只读 + 评论（OPEN-T-005）

**Files:**
- Modify: `apps/web/src/pages/EditorPage.tsx`（只读装配分支）、`apps/web/src/editor/keyboardMap.ts`（只读不挂写键位）、`apps/web/src/editor.css`（断点样式）
- Test: `apps/web/e2e/mobile-readonly.e2e.spec.ts`（新建）

**Interfaces:**
- Produces: `useIsMobileViewport()`（matchMedia `(max-width: 768px)` 监听）；EditorPage readOnly 分支——**隐藏**：工具栏全部编辑项（撤销/重做/插入/结构/主题/样式/导出/成员/版本入口——保留返回工作台、保存状态指示、标题展示只读）、RichPanel、右键菜单、双击进入编辑、键盘写路径（keyboardMap 不装配或 isEditableTarget 外全拒——以不挂载实现）；**保留**：画布渲染、平移/缩放手势、折叠按钮点击、CommentPanel（查看+发表）、评论角标点击定位。
- engine 不改（交互装配在 EditorPage——只读 = 不绑定编辑类手势/回调，布局渲染照常）。
- 口径登记（验收文档）：客户端能力降级非安全边界；服务端不区分移动端写请求。

- [ ] **Step 1: 失败 e2e**（`page.setViewportSize({width: 375, height: 667})` → 打开种子文档：`.gm-text` 根文本可见（画布渲染）；工具栏编辑项不可见（undo-btn 等 toHaveCount(0) 或 hidden——按实现断言）；评论面板可开（testid 复用既有）且发表成功角标出现；折叠按钮可点（FR-EDT-030 折叠钮存在且点击后计数角标变化）；桌面视口回归：全部编辑控件仍在）。
- [ ] **Step 2: 实现**（readOnly 分支条件装配；CSS 断点兜底隐藏）。
- [ ] **Step 3: 全量门禁**（重点：桌面 e2e 68 例零回归）→ 提交 `feat(web): 移动端只读画布+评论（OPEN-T-005，客户端降级口径）`。

---

### Task 6: M4 挂账清偿包（PARKED 项集中清偿，55423a0 式）

**Files（逐项）:**
- `apps/server/src/collab/collab.service.ts`：快照脏标志 TOCTOU——`snapshotIfDue`/`snapshotIfDirty` 在 `await insertVersionSnapshot` **前**置 `dirty=false; lastAutoAt=now`，失败 catch 中恢复 `dirty=true`（handleChange 无条件重标记语义保持）；单测补一例（插入期间并发 onChange 后 dirty 仍 true）。
- `apps/web/src/editor/xmind-import.ts`：core 组装 walk 移入 try/catch——GmindCoreError 归因为「文件已损坏，无法解析」（T4 的文案不变），栈溢出同捕获。
- `apps/web/src/editor/xmind-export.ts`：walk 加 visited-set 环防护（防御性，现不可达）。
- `apps/server/src/share/invite.service.ts`：回填通知 `fileRepo.find` 加 `deletedAt: IsNull()` 过滤（软删文件不发「已加入」通知）。
- `apps/web/src/editor/MemberPanel.tsx`：toast 文案「已邀请 N 位，M 位已在邀请中」（skipped 分开计数）+ textarea `aria-label`。
- `apps/server/src/auth/auth.service.ts`：回填 catch 日志恢复 `user=${user.id}` 上下文。
- `apps/web/src/editor/VersionPanel.tsx`：预览遮罩层级——面板关闭按钮/头部 z-index 提至遮罩（z-1300）之上，预览打开时指针可关面板（M5 裁定：保留遮罩防误触画布，但面板自身控件可达）。
- **维持 PARKED 不清**（终审已裁量）：零 diff 恢复仍写 pre_restore（计划字面时序，产品知晓）；导入 copy 路径 >MAX 收紧（无实际影响，T4 files.service 触及时注释确认即可）。
- Test: 逐项单测/e2e 补守卫（TOCTOU 并发例、invite 软删过滤例、遮罩可达 e2e 断言可并入既有 versions spec）；全量门禁 → 提交 `fix: M4 挂账清偿包——TOCTOU/导入归因/环防护/软删过滤/遮罩层级等`。

---

### Task 7: NFR-USE-005 错误文案走查（逐分支自动化断言）

**Files:**
- Modify: 走查发现的文案缺口（预计散点小改：saveLoop.ts 离线提示、api/client.ts msgOf、WorkspacePage toast、EditorPage toast、ShareLandingPage 失效文案——以实际走查结果为准）
- Test: `apps/web/e2e/error-copy.e2e.spec.ts`（新建——集中走查套件）

**走查清单（PRD 高频异常分支，逐项断言「原因+下一步」）：**
1. 断网编辑→离线提示（FR-EDT-034 第三态，M2 交付）——文案含「恢复联网后自动同步」。
2. 配额拦截（quota-exceeded toast）——含「上限 500」+「删除节点后可继续」。
3. 文件不存在/无权（404 msgOf）——含「可能已被删除或无权限」+「返回工作台」。
4. 登录过期（401）——含「请重新登录」+ 跳转。
5. 分享链接失效页——含「链接已失效」+「联系分享者」。
6. 导入三归因文案——含下一步（换文件/检查格式）。
7. 导出过大——含「文件过大」+「拆分后导出」。
8. 评论 501 字/图片超限——含上限数值。
9. 邀请批量非法——逐条原因（T2 已有）+ 修正提示。
10. 改绑被占 409（T1）——含「已绑定其他账号」+「换用其他手机号/邮箱」。

- [ ] **Step 1: 建走查套件骨架**（逐条断言现有文案——先跑一轮记录哪些不达标）。**Step 2: 修补不达标文案**（每条补「下一步动作」，原因已有者不动）。**Step 3: 全量门禁** → 提交 `fix(web): 错误文案规范走查——原因+下一步逐分支达标（NFR-USE-005）`。

---

### Task 8: 全量 NFR-P0 验收 + m5-acceptance 文档

**Files:**
- Create: `docs/m5-acceptance.md`（结构同 m4-acceptance.md：核验日期/环境/标记约定、逐 NFR 表、埋点清单对照表、挂账清偿表、支撑输出、结论与手动清单）
- Modify: `docs/perf-m5.md`（新建或更新 perf-m1/m2 引用——复跑数字）、`docs/m2-entry-checklist.md`（§7.5/7.6/7.7 状态回写）
- Run: 复跑 `apps/server/tools/latency-bots.mjs`（50 机器人 P95<100ms——M4 后回归）、`apps/web` 的 500 节点帧率脚本（PERF=1 perf-editor——M1 交付，PERF=1 门禁启用复跑 40fps 线）

**验收覆盖面（PRD 6.5.1「全部 P0 级 NFR」逐项）：**
- NFR-PERF-001（500 节点 40fps）/005（50 人 P95<100ms）：复跑既有脚本，M4/M5 后回归数字入 perf 文档。
- NFR-PERF-003（操作 P95<0.1s）：M1 基线 perf-m1.md 已测（22ms）；引用 + 复跑口径注明。
- NFR-PERF-004（首屏 P75<3s）：本地 dev 一次性测量（vite dev 非生产构建——**如实登记口径**：生产构建基线留部署期，本测为开发环境参考值）。
- NFR-PERF-007（2s 自动保存）：M1/M2 e2e 已覆盖（保存指示/防抖断言）——汇总引用。
- NFR-SEC-003（越权逐请求校验）：汇总既有 e2e 越权面（files/share/comments/notify/storage/versions 的 404 同口径用例清单）。
- NFR-SEC-006（XSS）：既有输入过滤测试汇总（节点文本/评论/文件名）。
- NFR-SEC-001/002（TLS/落盘加密）：**环境项如实登记**——本地 HTTP dev 无法核验，留生产部署验收。
- NFR-REL-002（≤3s 丢失窗）/003（3 分钟快照 90 天——M4 e2e）/004（回收站 30 天——M3 e2e）/005（CRDT 不丢数据——M2 混沌套件）：汇总引用。
- NFR-USE-001/002：本里程碑 T2/T3 e2e。
- 埋点 11 事件对照表：事件名 × 生产点 × 测试（T4/T3）。
- **§7.5 m1 13 项人工签注**：清单原样列示转需求方（自动化同链路引用 + 人工步骤），M5 验收文档不代签。
- **§7.6/7.7**：记录性项——状态确认文字（维持 M2 裁定口径，无代码动作）。

- [ ] **Step 1: 复跑两个 perf 脚本 + PERF=1 帧率用例**，真实数字入档。**Step 2: 汇总各 NFR 既有 e2e 证据**（当日 grep 核实用例名/行号，非转抄）。**Step 3: 写 docs/m5-acceptance.md**（诚实纪律同 m3b/m4：无自动化背书不写通过）。**Step 4: 提交** `docs: M5 验收清单与实测结果——全量 NFR-P0 收口`。

---

## Self-Review

1. **Spec 覆盖**：spec M5 行五项 → 引导(T3)/快捷键面板(T2)/错误文案(T7)/埋点(T4)/移动端(T5)/全量 NFR-P0(T8)；spec line 213 /settings → T1；OPEN-T-005 明细裁定 → T5；M4 挂账 → T4(payload cap)+T6(其余)+T8(登记)；§7.5/7.6/7.7 → T8。PRD 6.5.1 P0 FR 面已由 M0~M4 交付，T8 汇总收口。
2. **占位扫描**：无 TBD；T7 走查「以实际走查结果为准」属审查型任务的固有形态——走查清单 10 分支已穷举给定，修补方向已定（补「下一步动作」）。
3. **类型一致性**：`SHORTCUT_LIST`/`ShortcutItem`（T2 定义 T2 消费）；`track(type, payload)`（T4 定义，T3 guide_finish 先行用 fetch 直调——T4 接线统一）；testid 套（settings-*/help-*/guide-*/notify-pref-*）各任务内自洽；事件名与 PRD 6.4 清单逐字一致。
