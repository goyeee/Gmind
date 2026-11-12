# Gmind 第二期功能设计：组织管理 / 跨文件待办 / 待办空间 / 表格文件类型

- 日期：2026-10-24
- 状态：需求方已裁定四问（见 §一），按批次 A→B→C→D 实施，每批独立门禁+提交
- 原型参照：`~/Downloads/Gmind脑图表格产品`（样式沿用第一期令牌；逻辑以本 spec 为准）
- 上期：`2026-10-24-figma-prototype-ui-port-design.md`（一期样式移植）

## 一、需求方裁定（2026-10-24，四问）

1. **范围**：A+B+C+D 四批全做；**协作空间实体化继续不做**（维持 10-20/10-24 两次裁定）。
2. **任务数据源**：**服务端任务索引表**——persisted/PUT 落库后从 docState 抽取任务写 `task_index`，跨文件查询走索引（不做前端拉全量解析）。
3. **表格文件形态**：**同构 docState 包装**——`files.kind = 'map' | 'table'`，表格文件数据模型与脑图完全同构，仅默认打开表格视图+新建入口/徽标/筛选差异；脑图⇄表格可随时互切。
4. **生成报告类产物**：生成日报/完成报告 = **Markdown 摘要复制到剪贴板**；提醒 TA = **站内通知**（notify 既有能力）。零新基建。

## 二、批次 A：组织管理（部门/分组）

### 数据模型（单迁移 `OrgDepartmentsGroups20261024`）
- `org_departments`：id char26 PK / name varchar(64) UNIQUE / created_at
- `org_groups`：id char26 PK / name varchar(64) UNIQUE / color varchar(16) NULL / created_at
- `org_user_groups`：user_id char26 + group_id char26，PK(user_id, group_id)
- `users` 加列 `department_id char26 NULL`
- 实体显式 snake_case；注册进 data-source（目录守卫测试兜底）。

### 端点（`/api/org`；写=AdminGuard，读=UserGuard 登录即可——待办筛选的数据源）
- `GET/POST /api/org/departments`、`DELETE /api/org/departments/:id`（仍有账号挂靠 → 409「部门下还有账号，请先转移」）
- `GET/POST /api/org/groups`、`DELETE /api/org/groups/:id`（同上 409）
- `GET /api/org/directory` → `{ departments, groups, memberships: [{userId, departmentId, groupIds}] }`
- 账号挂靠：`PATCH /api/admin/users/:id` 扩展可选字段 `departmentId?: string | null`、`groupIds?: string[]`（全量替换该用户分组）

### web（AdminUsersPage 三页签）
- 页头页签：账号管理 / 部门管理 / 分组管理（`org-tab-*`）；部门/分组=列表+行内新增+删除（409 两段式文案）
- 账号表加「所属部门」列（行内下拉即改）与「分组」标签列（下拉多选，选中即存）
- e2e：server `org.e2e-spec.ts`（CRUD/目录/409/权限门/挂靠）；web admin-users 三页签用例

## 三、批次 B：任务索引 + 我的待办

### 索引表（迁移 `TaskIndex20261024`）
`task_index`：id PK / file_id char26 / node_id char26 / text varchar(255) / **owners_csv text（逗号分隔 userId，MySQL 5.6 无 JSON→text+FIND_IN_SET，纪律 3）** / status varchar(16) / progress int / start_date varchar(10) NULL / due_date varchar(10) NULL / done_date varchar(10) NULL / updated_at；UNIQUE(file_id, node_id)、KEY(file_id)

- **抽取口径**：节点 task 与 DEFAULT 不同才算任务（owners 非空 ∥ startDate ∥ dueDate ∥ status≠todo ∥ progress>0）；`done` = status==='done'
- **重建策略**：`TaskIndexService.rebuildForFile(fileId, doc)` 全量重建（事务内 DELETE 该文件 + 批量插入；数百节点级，异步 fire-and-forget 不阻塞保存，失败 console.error 同 auto 快照模式）
- **挂载点**（两处落库成功后）：① collab `storeDocument`（内存 doc 在手）② files PUT saveContent（docFromState(buffer)）；导入/复制/种子路径低频同样挂载

### 端点（`/api/todos`，UserGuard）
- `GET /api/todos?view=all|today|overdue|week&tab=open|done`
  → `{ stats: {all, today, overdue, week, done}, items: [{fileId, fileTitle, nodeId, text, status, progress, startDate, dueDate}] }`
  - 范围：`FIND_IN_SET(me, owners_csv)` 且 file 存活（owner/协作者天然涵盖；join 防脏数据）
  - 口径：today=dueDate=今天；overdue=dueDate<今天且未完成；week=dueDate∈[今天,+7]；done=status='done'；统计卡为全量口径（不随 view 收缩）
- `PATCH /api/todos/:fileId/:nodeId` body `{ progress?: number, done?: boolean }`
  - **写回 docState**（core `setNodeTask` 合规写，status↔progress 联动复用既有规则）→ 存 docState + 重建该文件索引
  - **在线冲突闸**：该文件在 collab 网关存在活跃会话 → 409「文件正被编辑，请打开文件后修改」（防内存文档下次防抖覆盖服务端直写）
- **提醒 TA**：`POST /api/todos/remind` `{ fileId, nodeId, ownerUserId }` → `notifyService.notify(owner, 'mention', {title, nodeId, fileId, reminder: 提醒人昵称})`

### web（侧栏新项「我的待办」nav-todo，路由 /todos，WorkspaceShell 外壳页）
- 统计四卡（全部待办/今日到期/已逾期/7 天内到期，点卡=切换 view 筛选）+ tabs 待办 N / 已完成 M
- 任务行：完成勾选（PATCH done）/ 标题 / 进度档位 select（PATCH progress）/ 截止日期 / 所属文件（点击跳编辑器）
- 「生成日报」= 汇总当日口径 Markdown → `navigator.clipboard.writeText` + toast
- e2e：server `todos.e2e-spec.ts`（抽取/统计口径/PATCH 联动/在线冲突 409/越权）；web todos 页用例（造任务→出现→勾完成→tab 切换→生成日报剪贴板）

## 四、批次 C：待办空间

- `GET /api/todos/report?range=today|week|month|all`：可见范围（我 owner 或协作者的存活文件）任务聚合
  → `{ stats: {total, done, doing, todo, overdue, rate}, byOwner: [{userId, nickname, total, done, doing, todo, overdue}], byDepartment/byGroup: 同构（join users.department_id / org_user_groups）, byDay: [{date, done}]（近 7 天，done_date 口径）, items: 明细 }`
- web（侧栏「待办空间」nav-space，路由 /todo-space）：统计五卡 + 按人员/部门/分组三视图（表格：总数/已完成/进行中/未开始/逾期/完成率进度条）+ 纯 CSS 柱状趋势图（不引图表库）+ 任务明细表（跳文件）+ 生成完成报告（MD 剪贴板）+ 明细行「提醒」按钮（站内通知）
- e2e：server report 聚合口径（含部门/分组归并）+ remind 通知落库；web 待办空间用例

## 五、批次 D：表格文件类型

- 迁移：`files.kind varchar(16) NOT NULL DEFAULT 'map'`（FileEntity 显式列）
- shared `FileListItem(+Detailed)` 增 `kind: 'map' | 'table'`；`POST /files` body 增 `kind?: 'table'`（title 缺省按 kind：未命名脑图/未命名表格）；复制/种子恒 'map'
- 编辑器：`kind === 'table'` → view 初始 'table'（现有 脑图/表格 view-tabs 保持互切=天然互转）；GET content 契约带 kind
- 工作台：快速创建第 4 卡「新建表格」（原型四卡齐）；文件卡徽标按 kind（表格绿点/脑图蓝点）；我的文件+最近筛选加类型 chips（全部/脑图/表格，客户端过滤）
- e2e：server kind 契约；web 新建表格→默认表格视图→卡片徽标/类型筛选

## 六、全局约束

- 全部 testid 契约保留；每批交付跑门禁五件套（web 侧 --workers=1）+ Orca 截图验收
- MySQL 5.6：显式 snake_case、索引键 ≤191、无 JSON/CTE/窗口函数、payload text+LIKE/FIND_IN_SET
- Yjs 写一律经 @gmind/core 操作 API（含 server 端 PATCH 回写），校验先于事务
- engine 零变更（本二期不碰布局/渲染）
- tsx 无 DI 元数据：server 注入显式 @Inject；新实体/迁移注册（目录守卫兜底）

## 七、里程碑顺序与验收

A → B → C → D，每批：实现 → 门禁五件套 → Orca 截图 → project-status 登记 → 需求方指令后提交。全四批收口后整体验收文档（docs/phase2-acceptance.md 或并入 project-status）。
