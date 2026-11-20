# 画布多人任务规则与体验优化（第一轮）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付单总负责人、独立任务总进度、多人员子进度、完成联动与旧数据迁移，并统一脑图、表格和任务面板。

**Architecture:** 在现有 Yjs 节点任务与自定义人员列上演进。core 提供唯一逐人写入口与原子完成命令；shared 提供唯一任务总进度/总状态派生；UI 只消费普通快照，不接触 Yjs 类型。

**Tech Stack:** TypeScript、Yjs、React、NestJS、Vitest、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-20-canvas-task-model-design.md`

## Global Constraints

- 所有 Yjs 写入经 `@gmind/core`；校验与 diff 在事务外，事务内不抛错。
- engine 只增不改既有节点/边行为；无任务信息节点与既有布局金样不变。
- 保留现有 testid；语义变化同步迁移测试，不静默删除入口。
- viewer/commenter 只读；手机保持现有简化只读任务画布。
- 未经明确指令不提交、不推送；无关 `apps/server/scripts/probe-mail.ts` 不动。

## Review Focus

- 旧多负责人或列上限数据：不得静默丢人员；Task 2 用迁移与异常测试钉住。
- 不同人员并发更新：两项都必须保留；Task 1 用双文档合并测试钉住。
- 完成后子进度降低：允许且不得被 repair 自动补全；Task 1/2 用合法状态测试钉住。
- 自动父折叠或含说明节点：总进度不变化；Task 3 用脑图/表格一致性用例钉住。
- 恢复与导入：不得触发交互确认或部分恢复；Task 2 用快照精确断言钉住。

---

### Task 1：任务总进度、单负责人与逐人协同写

**Files:**
- Modify: `packages/shared/src/derive.ts`
- Modify: `packages/gmind-core/src/constants.ts`
- Modify: `packages/gmind-core/src/read.ts`
- Modify: `packages/gmind-core/src/operations.ts`
- Modify: `packages/gmind-core/src/index.ts`（按现有出口方式导出）
- Test: `packages/shared/src/derive.test.ts`
- Test: `packages/gmind-core/src/operations.test.ts`
- Test: `packages/gmind-core/src/remote-sync.test.ts`

**Interfaces:**
- `NodeTask` 增加 `ownerId: string | null`、`ownerProgress: number | null`；兼容读取 `owners` 最多一项，但新写入只写 `ownerId`。
- `DeriveNode` 增加可选 `taskActive?: boolean`，由 core 读取时根据显式任务信息或人员条目填充；普通说明节点为 false。
- 新增 `taskProgressOf(nodes: DeriveNode[], id: string): number`：手动返回 `progress`；自动父只平均 `taskActive !== false` 的直属子任务，空集回退自身 `progress`。
- 新增 `taskStatusOf(nodes: DeriveNode[], id: string): TaskStatus` 与 `taskDoneDateOf(nodes: DeriveNode[], id: string): string | null`，供自动父派生总状态和完成日期。
- 新增 `setTaskOwner(doc, id, ownerId: string | null, origin?, canvasId?): void`：更换负责人清除旧 `ownerProgress`，不改 `progress`。
- 新增 `setOwnerProgress(doc, id, progress: number, origin?, canvasId?): void`。
- 新增 `setAssigneeProgress(doc, id, colId: string, userId: string, progress: number, origin?, canvasId?): void`，只写对应用户条目的 `progress`。
- 新增 `addAssignee(doc, id, colId, userId, origin?, canvasId?)` 与 `removeAssignee(...)`；新增人员默认 0%。
- 新增 `unfinishedTaskProgressOf(doc, id, canvasId?): UnfinishedTaskProgress`，返回生效的总负责人项及所有未达 100% 的人员条目。
- 新增 `completeNodeTask(doc, id, mode: 'preserve-subprogress' | 'complete-subprogress', origin?, canvasId?): void`，原子写总进度 100、done、完成日期及可选子进度。
- `setNodeTask` 继续受理日期、自动开关和非完成进度；状态/进度遵循 spec 联动。恢复来源允许快照原值，但不能绕过事务外校验。
- assignee 的快照对外仍为普通对象，旧 `weight` 可读出但不再派生总进度；新 UI 不写 weight。

- [ ] **Step 1：写 shared 失败测试。** 固定手动总进度、自动父只含真正任务、空任务子级回退、0/1～99/100 状态、阻塞保留值、最晚子级完成日期；人员条目不得改变 `taskProgressOf`。
- [ ] **Step 2：运行 shared 测试并确认旧 `effectiveProgress` 语义导致失败。** `pnpm --filter @gmind/shared test`。
- [ ] **Step 3：实现 shared 单一派生。** 保留旧函数仅作迁移期内部兼容，不让新消费点继续使用人员加权语义。
- [ ] **Step 4：写 core 失败测试。** 覆盖 ownerId/ownerProgress 读写、负责人更换与撤销、人员默认 0、逐人进度、非法输入、完成预检与两种完成模式。
- [ ] **Step 5：写双文档并发失败测试。** 两端基于同一人员列分别更新不同用户，双向同步后两项都保留；同用户同字段结果一致。
- [ ] **Step 6：实现嵌套人员读取与 core 操作。** 普通对象兼容值先在外层归一，再逐用户 diff；禁止 UI 路径整列覆盖。
- [ ] **Step 7：运行受影响测试。** `pnpm --filter @gmind/shared test && pnpm --filter @gmind/core test`，要求新增用例全绿，存量失败按新裁定迁移而非删除断言。

### Task 2：确定性迁移、repair、undo 与完整恢复

**Files:**
- Modify: `packages/gmind-core/src/doc.ts`
- Modify: `packages/gmind-core/src/repair.ts`
- Modify: `packages/gmind-core/src/restore.ts`
- Modify: `apps/server/src/versions/versions.service.ts`
- Test: `packages/gmind-core/src/doc.test.ts`
- Test: `packages/gmind-core/src/repair.test.ts`
- Test: `packages/gmind-core/src/restore.test.ts`
- Test: `packages/gmind-core/src/undo.test.ts`
- Test: `apps/server/test/versions.e2e-spec.ts`

**Interfaces:**
- 新增内部 `migrateTaskModel(doc): boolean`，在旧文档转多画布后、全量 repair 前执行；只返回是否迁移，不返回部分成功。
- “原负责人”迁移列使用确定 ID 与名称；每个人员初始子进度取旧共享进度。新总进度按 spec 保留旧显示值。
- 迁移列上限或非法旧数据无法完整保留时抛出带原因与下一步的 core 错误；调用方保留原文档。
- restore 支持 ownerId/ownerProgress/autoProgress 和全部 custom 字段；人员嵌套结构按逐人 diff 恢复，ORIGIN_RESTORE 不弹交互。
- 服务端在接收旧模型到新模型的首次迁移结果前创建 `pre_task_model` 版本；重复同步不重复建版本。

- [ ] **Step 1：写迁移失败测试。** 旧单/多负责人、有/无人员列、done 异常、多画布、旧 number/对象人员值；断言第一人保留、其余人入列、旧显示总进度保持、无历史日期伪造。
- [ ] **Step 2：写幂等与上限失败测试。** 连续迁移两次快照一致且第二次零写；无法完整迁移时原文档不变且人员不丢。
- [ ] **Step 3：实现装载迁移与预迁移版本。** 顺序固定为旧多画布迁移 → 任务模型迁移 → 人员嵌套归一 → repair。
- [ ] **Step 4：写恢复失败测试。** 覆盖 ownerId/ownerProgress/autoProgress/custom、多画布、done+未完成子进度；恢复前后快照精确一致。
- [ ] **Step 5：实现恢复与 repair。** repair 只剔除坏人员条目，不把合法的总任务完成+子进度未完成改成全 100。
- [ ] **Step 6：运行 core 与版本测试。** `pnpm --filter @gmind/core test && pnpm --filter @gmind/server test:e2e -- versions.e2e-spec.ts`。

### Task 3：脑图、表格和任务面板统一交互

**Files:**
- Modify: `packages/engine/src/taskvisual.ts`
- Modify: `packages/engine/src/render.ts`（只增必要输入与角色标识）
- Modify: `apps/web/src/editor/TaskFields.tsx`
- Modify: `apps/web/src/editor/TaskPanel.tsx`
- Modify: `apps/web/src/editor/TaskTable.tsx`
- Modify: `apps/web/src/pages/EditorPage.tsx`
- Create: `apps/web/src/editor/TaskCompletionDialog.tsx`
- Create: `apps/web/src/editor/task-completion.css`
- Test: `packages/engine/src/render.test.ts`
- Test: `apps/web/src/editor/TaskFields.test.ts`
- Test: `apps/web/e2e/custom-columns.e2e.spec.ts`
- Test: `apps/web/e2e/task-panel-markers.e2e.spec.ts`
- Test: `apps/web/e2e/task-table.e2e.spec.ts`
- Test: `apps/web/e2e/mobile-readonly.e2e.spec.ts`

**Interfaces:**
- 三视图只消费 Task 1 的 `taskProgressOf/taskStatusOf/taskDoneDateOf`；不得各自加权人员进度。
- `TaskCompletionDialog` 接收未完成项并提供 `onComplete(mode)`、取消；确认时重新执行 core 预检，再调用 `completeNodeTask`。
- 重新打开和 0%→进行中复用一个 0～99%/1～99% 进度选择流程，不自动写 0/1/99。
- 负责人选择改单选；人员编辑调用逐人 core 操作；所有权重开关、输入与相关提示删除。
- engine 接收完整画布任务拓扑的可选输入用于总进度，折叠后的可见布局只负责绘制。

- [ ] **Step 1：写 engine/web 失败测试。** 单总负责人、头像与子进度对应、右侧仅总进度、无执行汇总、无权重控件、手动父无 Σ、自动父有 Σ。
- [ ] **Step 2：写完成交互失败用例。** 取消零写；保留子进度后 done/100+原子进度；全部同步后所有生效子进度 100；两种完成入口只弹一次。
- [ ] **Step 3：写重新打开与状态失败用例。** done 后选 todo/doing/blocked 必须选择新进度；0% 选 doing 同理；阻塞保留进度。
- [ ] **Step 4：实现共享总进度映射与 UI。** 修复表格手动父误显示 Σ、脑图折叠汇总变化、根任务映射和人员头像语义；不扩大节点为任务大卡。
- [ ] **Step 5：实现共享完成/重开弹窗。** 支持 Escape、焦点循环、关闭后焦点归还、中文组合输入不误提交。
- [ ] **Step 6：验证权限与简化端。** viewer/commenter 可查看不可写；手机保持只读；所有文件编辑者均可改任一进度。
- [ ] **Step 7：运行受影响测试。** 先运行上述 engine/web 单测与 Playwright spec，再补 `toolbar`、`import-export`、`canvas-scope`、`versions` 回归。

### Task 4：真实验收、独立评审与文档

**Files:**
- Create: `docs/features/task.md`
- Modify: `docs/features/filter.md`
- Modify: `docs/features/import-export.md`
- Modify: `docs/project-status.md`
- Create: `docs/task-system-acceptance.md`
- Modify: `docs/superpowers/specs/2026-11-20-canvas-task-model-design.md`（仅登记实施偏差）

- [ ] **Step 1：真实浏览器走查。** 验收单负责人、多人头像与子进度、独立总进度、完成三选、重新打开、父任务、折叠、说明节点和只读角色；保存关键截图。
- [ ] **Step 2：旧数据与周边链路走查。** 验证迁移前版本、迁移后人员不丢、恢复往返；CSV/Excel/XMind、缩略图和版本预览只使用任务总进度。
- [ ] **Step 3：独立评审。** 检查迁移丢失、并发覆盖、完成旁路、恢复部分写入、跨视图口径；Important 全部修复并复测，Minor 如实挂账。
- [ ] **Step 4：完整门禁。** `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`；记录首次失败、重试和 flaky。
- [ ] **Step 5：文档收口。** `task.md` 使用五栏目并当日读码标行号；项目状态登记旧规则替代与第二轮边界；验收文档只写真实用例和结果。
- [ ] **Step 6：停在工作区。** 汇报可见变化、验证证据、代理拍板项和第二轮边界；不提交、不推送。

## 第二轮不做但不得提前破坏

任务索引扩展、我的待办参与人收录与角色、多画布待办、统计范围统一、参与人筛选、可信任务动态与待办汇总，均按 spec 留到第二轮。本轮 core 快照和迁移不得把人员列信息丢弃，以免第二轮无法补齐。
