# 画布任务第二轮：索引扩展、我的待办、筛选统计与动态 —— 设计

> 2026-11-21 起草。第一轮（单总负责人任务模型）已于 2026-11-20 交付、2026-11-21 提交推送（`4f8f239` 等 6 个提交）。
> 本文档是第二轮的实施依据：扩展服务端任务索引、改版「我的待办」、区分负责人/参与人筛选与统计、新增任务动态。

## 一、这是什么、为什么

第一轮把任务模型收敛为「单总负责人 + 独立总进度 + 人员列逐人子进度」，但消费侧没跟上：服务端任务索引只扫第一个画布、只认负责人；「我的待办」不认人员列参与人；统计只算负责人；筛选没有参与人入口；任务发生的一切变化不进任何动态。第二轮让这些消费侧全部建立在新模型上，并补上动态，使系统真正成为「单任务多人、单人多任务」的管理系统。

## 二、已确认的产品规则（需求方裁定）

沿用第一轮计划裁定（2026-11-20）：待办收录总负责人与任意人员列参与人，同一任务只出现一次并标明我的角色；总任务完成后统一进已完成；筛选区分「总负责人」与「参与人」；统计按任务总数和总进度算，不按人员子进度算完成率；动态记录可信的指派/进度/状态/完成事件，不从防抖后的混合文档差异猜操作人。

2026-11-21 新增裁定：

1. **动态两处都要**：文件内「文档动态」抽屉显示任务事件；待办页新增跨文件动态流（只显示与我相关任务的变化）。
2. **待办页动态入口 = 新增「动态」页签**，与「今日待办 / 全部 / 已完成」并列。
3. **加「我的子进度未完成」筛选项**：我是执行人且我的子进度没拉满、任务还没完成时能单独筛出。
4. **按人统计把参与人计入**：某人名下任务数 = 我是总负责人的 + 我是执行人的（同一任务只算一次，标注角色）；完成率仍按任务总进度。
5. **待办页行交互维持现语义**（2026-11-21）：滑条/勾选对所有人仍是任务总进度/完成整个任务（第一轮「编辑者都能改全部」的自然延伸）；行上「我的子进度 %」可点击，弹 9 档选盘改自己的子进度。
6. **按部门/分组统计同样拆「负责/参与」两个计数**（2026-11-21）：任务按负责人部门、参与人部门各计一次，部门合计因此可能大于任务总数（需求方知情选定）。

## 三、非目标

- 不改任务模型本身（第一轮口径冻结；发现第一轮缺口走修复，不顺手改模型）。
- 不给手机端加任务编辑能力（维持只读画布口径）。
- 不做协同内的实时动态弹幕/toast（别人改任务时不弹提示，只在动态列表可见）。
- 不改「待办空间」页面结构，只扩统计口径。
- 不做动态的编辑回跳深链之外的新交互（动态行点击行为见 §五.5）。

## 四、现状地基（2026-11-21 读码核对）

- **索引**：`task_index` 表按 `(file_id, node_id)` 唯一（`apps/server/src/todos/task-index.entity.ts`，DDL `20261024100000-task-index.ts`）；只存 text/owners_csv/status/progress/三日期；`rebuildForFile` 从 `'root'` 走子树——**只覆盖第一画布**（`resolveCanvasId` 回退首画布，`packages/gmind-core/src/canvas.ts:57-69`）；参与人完全不读（`task-index.service.ts:20-22` 注释明确「留第二轮」）；全画布遍历先例 `allAliveNodeIds`（`canvas.ts:108-118`）。重建触发点：协同持久化后（`collab.service.ts:439`）、装载迁移后（`:323`）、PUT doc-state（`files.service.ts:730`）、PATCH 任务后（`todos.service.ts`）。
- **待办 API**：`GET /api/todos`（`todos.controller.ts:16-26`）按 `FIND_IN_SET(viewer, owners_csv)` 圈范围、`LIMIT 200`（`todos.service.ts:109`），行内返回 `owners` 兼容数组；`PATCH /api/todos/:fileId/:nodeId` 走 core 命令（完成 preserve 子进度、重开须显式进度）；`GET /api/todos/report`（`:200-284`）聚合 byOwner/byDepartment/byGroup + 7 天趋势 + 完成率（`:277`），全部只认 owners_csv。
- **待办页**：`TodosPage.tsx` 统计卡 + 三页签（今日/全部/已完成）+ 分组 chips（读 `t.owners`，`:111-112`）+ 按文件分组（`:116-124`）+ 行（`:255-292`，**行上无负责人/参与人展示**）+ 重开弹窗。另有「待办空间」`TodoSpacePage.tsx` 消费 report。
- **筛选**：条件模型 `taskFilter.ts`（内置 owner/progress/startDate/dueDate/finishDate + 人员列 assignee→person 条件）；聚合态 `Filters`（`TaskTable.tsx:165-187`）；UI `MapFilterBar.tsx`；公开筛选存 doc meta `SharedFilter`（`constants.ts:494-507`，`canonicalSharedFilter :517` 归一），经服务端 stateless 中继（`collab.service.ts:99-103`）+ awareness 通知（`collab.ts:89-94`）；画布侧按 `fadeOf`（`EditorPage.tsx:3665-3752`）降渐 + 表格行匹配。
- **动态**：events 域已有——`events` 表（type/file_id/user_id/payload text JSON/created_at）、`EventsService.record`、开放上报 `POST /api/events`、文件级读取 `GET /api/files/:fileId/events?limit=50`；已记录 comment_create/version_restore/doc_create/invite_send/collab_join；编辑器有「文档动态」抽屉 `ActivityPanel.tsx`（按类型标签渲染）。**任务事件无人发。**
- **可信操作人**：Hocuspocus 4.7，`authenticate` 把一次性票据换成 `context.userId`（`collab.service.ts:261`）+ `context.readOnly`（`:267-271`）；stateless 消息处理通道已有（筛选发布中继，`:99-103`）；服务端直写任务路径（todos PATCH）天然知道操作者。

## 五、技术方案

### 5.1 索引扩展（服务端地基）

**参与人改走独立表 `task_participant`**（我拍板，备选见 §五.1a）：列 `id / file_id / node_id / user_id / progress / col_id / updated_at`，索引 `(user_id, file_id)`、唯一 `(file_id, node_id, user_id, col_id)`。理由：我的待办要按人索引查询并取**我的子进度**（CSV 存不了逐人进度），按人统计要按人聚合；CSV+FIND_IN_SET 无索引可用。负责人仍沿用 `owners_csv`（现在至多一个 id，查询语义不变，第一轮服务端 e2e 的圈范围行为不被推翻）。

`task_index` 新列：`canvas_id char26`、`canvas_name varchar100`；`progress` 改存**有效任务总进度**、`status`/`done_date` 同源改存**派生口径**（自动父 = Σ 直属真正任务、子级全完则派生 done + 最晚子完成日期，与 `taskStatusOf`/`taskDoneDateOf` 同算法；普通节点 = 自身值）。blocked 不加列——status 字段已有 `blocked` 值；顺带修显示：`page()` 现把 blocked 归一成 todo（`todos.service.ts:117` TASK_TYPES 外归一），待办行文案增「阻塞」档，不再显示成「未开始」。`isExplicitTask` **放宽**：人列有任一条目的节点也算显式任务（第一轮裁定「待办收录任意人员列参与人」的必然结论——否则纯参与节点拼不出待办行；统计任务总数会因此比今天大，知情）；另排除 `taskActive === false` 的节点（说明节点不入索引）。

重建范围扩到**全部画布**：遍历每画布 root 子树（先例 `allAliveNodeIds`）；参与人读取人员列逐人条目（第一轮已落的嵌套结构读侧），同节点多列同人多行入 `task_participant`。

迁移：新增 SQL migration（建表 + 加列）。**存量文件索引**：行 `canvas_id IS NULL` 时视为旧口径，文件装载后触发一次后台重建（与现有装载触发点同通道）；未打开过的文件动态/待办里画布显示「未知画布」直到首次打开重建——不跑全量离线重建脚本（避免部署期长事务）。

**§五.1a 备选（否决）**：参与人也进 `task_index` CSV 列。否决原因：取不到逐人子进度，「我的子进度未完成」筛选和行上「我的子进度 %」都得在查询时打开文档现算，文件未装载时不可用；且按人统计退化为全表 FIND_IN_SET 扫描。

### 5.2 待办 API

`page()` 每行新增：`canvasId / canvasName / myRole ('owner'|'participant'|'both') / mySubProgress (int|null)`。`mySubProgress` 取「我的人员列条目最高值 ∪ 我的 ownerProgress（我是负责人且设了执行子进度时）」的最大者，都没有则 null；「我的子进度未完成」chip 条件随之含 ownerProgress 未满。圈范围扩为「负责人 ∪ 参与人」；**同一任务同一人天然一行，无重复**（行模型按节点唯一，裁定中的「去重」在 SQL 层即成立）。`owners` 兼容字段继续返回（前端分组 chips 过渡期仍可用）。行交互维持现语义（裁定 5）：滑条=总进度、勾选=完成，另加我的子进度 9 档选盘写入口（走既有逐人写 API）。`report()`：byOwner、byDepartment、byGroup 全部拆 `responsible`（任总负责人）与 `participating`（任执行人）两个计数，同人同任务只进一处；部门/分组口径下任务按负责人部门、参与人部门各计一次，**合计可大于任务总数**（裁定 6，知情）；完成率、趋势仍按任务级。

### 5.3 我的待办页改版

- 分组从「按文件」改「**文件 → 画布**」两级；行上显示我的角色徽章（「总负责人」/「执行人」，双身份显示「总负责人」），执行人另显我的子进度 %。
- 新增筛选 chip「我的子进度未完成」（只在未完成视图生效）：`mySubProgress !== null && mySubProgress < 100 && 任务未完成`（mySubProgress 定义见 §5.2，含 ownerProgress）。
- 新增「**动态**」页签（见 §5.5）。
- 已完成口径不变：总任务 done → 已完成页签。

### 5.4 筛选：参与人维度

`Filters` 与 `SharedFilter` 增加 `participants: string[]`（公开筛选 schema 同步扩，`canonicalSharedFilter` 归一）；`MapFilterBar` 在负责人多选旁新增「参与人」多选（候选 = 文档内人员列成员 ∪ 在线成员）；画布降渐与表格行匹配按「人员列任一条目命中」判定；「未分配」语义不变（仍指无总负责人）。旧客户端不识别新字段：发布端为新客户端、编辑端为旧客户端时该条件会被归一丢弃——登记为已知限制（全员同版本部署场景无影响）。

### 5.5 动态：客户端声明 + 服务端盖章

**事件产生（我拍板，备选见 §5.5a）**：编辑器内每次用户级任务写（面板/表格/画布选盘等 ORIGIN_USER 写入口成功后）经既有 stateless 通道发声明消息；服务端处理器**以连接身份盖章操作者**（`context.userId`，payload 里声明的操作者一律覆盖）、拒绝 readOnly 连接、校验 payload 形状后落 events 表；服务端直写路径（todos PATCH 完成/重开/进度）由服务端直接记事件。事件类型（粗集）：`task_assign`（指派/更换总负责人）、`task_assignee_add/remove`（人员列加/移人）、`task_progress`（总进度变更）、`task_status`（状态变更）、`task_complete`、`task_reopen`；payload 含 fileId/canvasId/nodeId/taskText/actor/before/after + **`related`（相关人员 id 清单：总负责人 + 全体人员列成员）**——「与我相关」的查询依据（JSON 引号精确串 LIKE 该数组）。**自动父派生变化**（子任务编辑把父的派生进度/状态抬起）无用户级父写入：服务端重建索引时对比自动父新旧派生值，变化即补记事件，操作者归属触发重建的最后修改者（近似口径，多人同瞬并发时归最后保存者，如实登记）。

文件内「文档动态」抽屉：`ActivityPanel` 增任务类型标签与摘要文案即可（渲染通道现成）。待办页「动态」页签：新 `GET /api/todos/activity?limit=50`——events 表 `type LIKE 'task\_%'` ∩ 我可见文件 ∩（payload 含我的 id（JSON 引号精确串 LIKE，ulid 无误命中问题）或操作者是我）倒序分页；动态行点击跳对应文件编辑器。

**§5.5a 备选（否决）**：服务端在 onChange 前后做任务快照 diff 猜事件。否决原因：正是第一轮计划点名要避免的「从防抖后的混合文档差异猜操作人」；diff 也还原不出动作语义（进度 80→100 是完成还是普通改值要猜）；且每条 ws 消息 O(节点数) 摘要，高频打字场景成本高。

**已知限制（如实登记，v1 不解决）**：断线期间的本地编辑不产生事件（Yjs 重连补同步，但声明消息已丢）；撤销/重做不经声明入口，不留事件；事件不做同人短时合并（连续改三次显示三条）。

## 六、我拍板的细节（可逐条否决）

1. 参与人走独立表而非 CSV（§5.1a 否决理由）。
2. `task_index.progress` 改存有效总进度（自动父在索引里也是汇总值）。
3. 未重建的旧索引行，画布显示「未知画布」，文件打开一次即修复。
4. 双身份（既是负责人又是执行人）徽章只显示「总负责人」。
5. 动态行点击 = 打开对应文件编辑器（不定位到节点）。
6. 动态事件粗分六类（§5.5），文案与徽章样式归 ActivityPanel/待办页动态两处实现。
7. 「动态」页签内容 = 与我相关（我是负责人/参与人）∪ 我操作的事件。
8. 「我的子进度未完成」chip 只在未完成页签出现；同一人多来源（多列条目、ownerProgress）取最高值展示。
9. `isExplicitTask` 放宽：人列有条目的节点即算显式任务入索引——纯参与节点不再隐形；统计任务总数会因此变大（§5.1）。
10. 索引 `status`/`done_date` 与 `progress` 一样同源存派生口径；待办行状态文案补「阻塞」档（修 blocked 显示成「未开始」的现存怪相）。
11. 自动父派生变化的动态事件由服务端重建索引时补记，操作者按触发重建的最后修改者归属（近似，登记）。
12. 动态「与我相关」的查询依据 = payload `related` 清单（负责人 + 全体参与人 id），JSON 引号精确串 LIKE。
13. `mySubProgress` 含 ownerProgress（负责人自己的执行子进度），与人员列条目一起取最高。

## 七、约束

MySQL 5.6（无 JSON/CTE/窗口函数，payload 用 text+LIKE，索引键 ≤191，实体列显式 snake_case）；Yjs 写只经 @gmind/core（服务端同样走操作 API）；tsx 无 DI 元数据（注入显式 `@Inject`）；testid 契约延续（新 UI 元素全部 `data-testid`）；门禁五件套提交前全绿；未经明确指令不提交不推送。

## 八、任务拆分（4 任务，测试先行）

1. **索引扩展与待办 API**：migration（建 `task_participant` + `task_index` 加列）、全画布重建、有效进度写入、参与人落表、`page()/report()` 扩口径（myRole/mySubProgress/canvas/参与人统计）、旧索引行装载触发重建。测试：server 单测+e2e（全画布覆盖、参与人行、自动父汇总进度、圈范围∪去重、双身份、report 参与人计数）。
2. **待办页与待办空间改版**：文件→画布分组、角色徽章与我的子进度展示、「我的子进度未完成」chip、「动态」页签壳、待办空间参与人计口径展示。测试：web e2e（分组、徽章、chip、动态页签用预置事件、空间页行）。
3. **动态事件链路**：stateless 声明通道 + 服务端盖章/拒 readOnly/形状校验 + todos PATCH 直记 + ActivityPanel 任务事件 + `GET /api/todos/activity`。测试：server e2e（盖章覆盖伪造 actor、readOnly 拒收、离线路径直记）、web e2e（抽屉任务事件、动态页签内容与范围）。
4. **筛选参与人 + 收口**：Filters/SharedFilter/MapFilterBar/降渐/表格匹配、旧客户端归一限制登记；功能文档更新（task/filter/我的待办）、验收记录、全量门禁。

顺序依据：1 是数据地基；2/3 各自独立消费 1；4 收尾。每任务完成即独立评审。

## 九、评审重点

1. 参与人重建是否真的逐人不丢、并发编辑两人各自落行。
2. 「同一用户同一任务」在待办/统计/动态三处口径是否一致，不出现重复计数。
3. 动态操作者是否全链路取自连接/服务端身份，无任何客户端声明可信路径。
4. 有效进度在索引、待办、统计三处同源（taskProgressOf 口径），不出现第二套算法。
5. 旧索引/旧客户端/断线编辑/撤销的已知限制是否如实登记且不静默错数据。
