# 任务（节点任务体系：单负责人 / 独立总进度 / 逐人子进度）

> 本文是「画布多人任务规则」（2026-11-20 需求方裁定第一轮 + 2026-11-21 交互重构，spec `docs/superpowers/specs/2026-11-20-canvas-task-model-design.md`）交付的功能逻辑说明。第二轮（任务索引扩展/我的待办改版/统计拆分/任务动态/参与人筛选）见 `todos.md`（我的待办与任务动态）与 `filter.md`（参与人筛选）。

## ① 这是什么

脑图节点可标记为任务：**一名总负责人** + **任务总进度** + 可选的**逐人执行子进度**（自定义人员列）。入口：

- 任务面板：选中节点 → 工具栏「任务」按钮（或再点节点），`apps/web/src/editor/TaskPanel.tsx`
- 表格视图：状态/进度/负责人/人员列，`apps/web/src/editor/TaskTable.tsx`
- 画布任务行：节点底部条带（头像+右侧百分比），`packages/engine/src/render.ts` 任务行段
- 我的待办：`/todos`，经 server 任务索引（`apps/server/src/todos/task-index.service.ts`）

## ② 规则（逐条，标代码出处）

1. **总负责人唯一**：负责人列只能指派一人；面板/表格点成员=设为负责人、再点=取消（写 `setTaskOwner`，`packages/gmind-core/src/operations.ts:835`）。旧多负责人入参被拒（`setNodeTask` 抛 TASK_INVALID_OWNERS 引导改用 setTaskOwner，`operations.ts:719`）。
2. **任务总进度独立**：`task.progress` 只表示任务总进度，不属于任何人；人员子进度不参与总进度合成（旧 weight 仅兼容读取，不影响任何业务规则）。唯一派生口径 `taskProgressOf`（`packages/shared/src/derive.ts:178`）：手动=自身 progress；自动父=直属**真正任务**子级的均值（`taskActive !== false`，普通说明节点不参与）；空任务子级回退自身。
3. **总负责人可选子进度**：`ownerProgress`（`setOwnerProgress`，`operations.ts:856`）；「负责人子进度」独立填写行已退役（2026-11-21 需求方裁定「头像/名字分开，点头像调起进度图标选择进度」）——改由**点负责人头像**调起 9 档进度选盘写入：面板在负责人 chip 内点头像（`TaskPanel.tsx:516`）、画布点任务行负责人头像（`EditorPage.tsx:2429`）两个入口同口径。**没有其他执行人（人员列空）时，点头像写的是任务总进度**（选盘头部标注「任务总进度」，选 100=完成）；有其他执行人时写负责人子进度（画布 owner 头像弧环=ownerProgress，`packages/engine/src/render.ts` owner 段）。自动汇总父任务点头像改总进度会被拦截（两段式提示），子进度不受限。
4. **逐人子进度**：人员列（assignee 自定义列）值是「逐用户逐条目」嵌套结构；写入经 `addAssignee`（`operations.ts:1358`）/ `removeAssignee`（`:1381`）/ `setAssigneeProgress`（`:1402`，只写目标用户 progress 字段——画布选盘 2026-11-21 起也切逐人 diff，两个客户端更新不同人员互不覆盖）。**面板不单独列行**（2026-11-21 需求方二次裁定「跟负责人一样」）：人员列区块与负责人区块同构——一排成员 chips（已指派=高亮选中态），已指派成员**点头像**调起 9 档进度选盘写其子进度（`TaskPanel.tsx:541`）、点 chip 本体取消指派，未指派成员点 chip 整体指派；单独行/×移除钮/进度填写框全部退役。表格单元格弹层保留行+输入框编辑（`AssigneeField` 双形态，`apps/web/src/editor/TaskFields.tsx`）。
5. **状态/进度联动**（`applyStatusRules`，`derive.ts:293`）：0%=todo、1～99%=doing、100%=done 三态合一；blocked 保留当前进度（阻塞中到 100 仍完成）；恢复来源的全字段快照（显式 doneDate 含 null）完全按原值不走联动。
6. **完成=同一动作**：总进度设 100% 或状态选「已完成」等价；普通完成入口默认**保留**所有子进度（`setNodeTask` 不碰 ownerProgress/人员条目）。有未完成子进度时弹出三选确认：完成并全部改为 100%（`completeNodeTask` complete-subprogress，原子命令，`operations.ts:1432`）/ 仅完成保留子进度（preserve-subprogress）/ 取消。预检 `unfinishedTaskProgressOf`（`read.ts:320`）只返回界面实际展示的未完成项——无人员列条目时隐藏的 ownerProgress 不参与检查。自动汇总父任务不能被手动完成（`setNodeTask`/`completeNodeTask`/`setIcon` 进度徽章三入口同拦截，`operations.ts` autoProgress 守卫）；确认时宿主重新执行预检再调原子命令。画布入口（进度徽章/无执行人时负责人头像选 100）按 preserve 语义直接完成不弹窗——与画布「写弹层不驻留」口径一致。
7. **重开/开始**（2026-11-21 需求方裁定「百分百切非百分百不让用户再确定百分比」）：**进度值类入口直接用所选值静默重开**——表格进度格输入、面板进度数字/档位图标、画布进度徽章、负责人头像选盘（无执行人）在完成态选 0～99 立即生效（裸进度补丁走 `applyStatusRules` 清完成日期并派生状态，徽章同事务同步，`operations.ts:676` setNodeTask；重开门禁只拦「带状态不带进度」的补丁），不再二次弹确认框。**纯状态切换仍弹进度选择**（0～99/1～99，`TaskCompletionDialog` reopen 模式，输入只接受完整整数）：已完成任务点状态按钮/状态列改回非 done、或 0% 直接选「进行中」——该动作未携带进度值，弹窗即选值步骤，不自动写 0/1/99（`operations.ts` 重开门禁含区间校验：重开传 100、doing 传 0 直接拒绝）。清除完成日期不自动清零。
8. **父任务默认手动**：可逐节点开「自动计算」（`autoProgress`，面板勾选）；自动父的 Σ 只读，只平均直属真正任务；普通说明节点（无任务信息、无人员条目）不参与。开启开关只缓存当前 Σ，不触发完成联动、不写完成日期（`operations.ts` autoProgress 分支）。自动父总状态随总进度派生（`taskStatusOf`，`derive.ts:193`），完成日期=最晚直属子任务有效完成日期（`taskDoneDateOf`，`derive.ts:204`），不伪造当天；脑图状态色也用派生状态（engine `taskStatusMap`）。
9. **权限**：所有文件编辑者可改总进度/状态/任何人的子进度；viewer/commenter 只读（面板/表格只读态）。手机端保持现有简化只读画布。
10. **旧数据自动迁移**：装载（docFromState）时旧多负责人/人员列旧形状自动迁移（`migrateTaskModel`，`packages/gmind-core/src/doc.ts:202`；管线接入 `doc.ts:450`）：第一人留任总负责人、其余进「原负责人」列（确定 ID `legacy-assignees`）每人子进度=旧共享进度；总进度=迁移前旧显示值（旧人员加权口径复刻，仅 `weighted=true` 列使用遗留 weight）；无 owners 键但有旧人员列的节点同样迁移；迁移后总进度 100 的任务状态统一为 done；迁移前服务端自动建 `pre_task_model` 版本（`apps/server/src/collab/collab.service.ts` loadDocument / todos patchTask 离线路径），按原始字节判重+数据库命名锁串行化，迁移回写带乐观并发（doc_state 仍是原字节才覆盖，冲突时以后落库者为准），回写后立即重建待办索引。预留列 ID 被非人员列占用时中止迁移（TASK_MIGRATION_COLUMN_CONFLICT），列满中止（TASK_MIGRATION_COLUMN_LIMIT），两者均原文档零变更。

## ③ 特殊情况

- **done + 子进度未完成**：合法状态，repair 不强补（`packages/gmind-core/src/repair.ts` 人员列逐条目剔坏，不碰进度语义）；恢复/迁移同口径。
- **迁移列上限**：「原负责人」列无处可建（schema 已满）→ 抛 TASK_MIGRATION_COLUMN_LIMIT 两段式错误，原文档零变更（不丢人）；删除部分列后重新打开即迁移。
- **折叠**：只影响可见性，不改变汇总结果（layout 把折叠节点按叶子输出）。
- **版本恢复**：恢复覆盖 ownerId/ownerProgress/autoProgress/全部节点 custom（人员列逐人 diff）/doc 级列 schema（`packages/gmind-core/src/restore.ts` hasTaskDiff/applyFieldDiff）；恢复不弹确认、不自动补全子进度。
- **旧文档兼容读取**：`owners` 数组、weight、人员列旧 number 简形读侧归一；新写入不再产生这些形状。

## ④ 待需求方确认

- done 异常迁移时总负责人子进度取「拉满 100」（与总进度同源保完成事实）——spec §五字面是「子进度取旧原始 progress」，实现按完成事实一致性优先，如需改回字面口径请指示。
- 「原负责人」列固定名称「原负责人」、ID `legacy-assignees`——如需改名（改列名不影响数据）请指示。
- 比重控件退役后，旧 weight 数据仍在人员列条目里保留（只读）——是否需要一次性清除请指示。
- ~~无其他执行人时，画布负责人头像点选盘改为提示「请到任务面板修改任务总进度」~~ **已按 2026-11-21 需求方指示反转**：点头像直接弹选盘写任务总进度（含选 100=完成），不再 toast 引导。
- 自动汇总父任务在「我的待办」勾选完成会被拒绝（两段式提示进文件更新子任务）——若希望待办里也能对自动父手动完成请指示（会与脑图派生状态矛盾）。
- 画布入口（进度徽章/无执行人头像选盘选 100）完成时不弹三选确认、按「保留子进度」语义直接完成——三选确认仅在面板/表格入口。若希望画布也弹三选请指示。

## ⑤ 最后核对

- 2026-11-21，commit 待提交（工作区停「改完验证绿」状态）。当日读码核对：上列行号均当日 grep 实测（2026-11-21 进度交互重构后重核：规则 3/4/6/7 为本次更新，规则 1/2/8/9/10 沿用 2026-11-20 核对，涉及函数行号逐一复核未漂移）。
