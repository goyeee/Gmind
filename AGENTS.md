# AGENTS.md — 代理规则（agent 必读）

> 本文件只放 **agent 必须遵守的规则**。项目的业务逻辑、里程碑进度、PRD 与交付的差异对齐在 [`docs/project-status.md`](./docs/project-status.md)——查"哪些已完成、哪些待办"一律以它为准，不要按 PRD 的分期/P0 标记推断。

## 一、需求不明确时，先提问再动手

- 需求描述含糊、存在多种合理实现、或可能与既有裁定/验收口径冲突时，**不要自行拍板**：先向需求方提问澄清，得到明确答复后再动代码。
- 提问前先自查 `docs/project-status.md` 的状态表与"待需求方裁定/裁定不做"清单——若答案已在案，按裁定执行；若冲突或无裁定，必须问。
- 尤其要确认清楚：验收口径（以哪个文档为准）、是否触碰"裁定不做"清单、是否影响既有 testid 契约与布局金样。
- 宁可多问一句，也不要猜错方向返工；同理，发现文档与代码不一致时先提出来对齐，而不是默默按某一方改。

## 二、工程纪律（改代码前必读，违者评审打回）

1. **唯一写入口**：对 Yjs 文档的一切写必须经 `@gmind/core` 操作 API（addChild/setText/moveNode/setSummary…），禁止直操 Y.Map（装载通道 docFromState/Y.applyUpdate 除外）。
2. **校验先于事务**：Yjs 事务内抛错**不回滚**——全部校验/diff 计算放 `withTransaction` 之外，事务内只执行已验证的写。
3. **MySQL 5.6**：实体列显式 snake_case `name`；索引键 ≤191；无 JSON/CTE/窗口函数；payload 用 text+LIKE。
4. **tsx 无 DI 元数据**：Nest 类注入显式 `@Inject(Token)`；实体/迁移显式注册（目录守卫测试兜底）。
5. **engine 只增不改**：改动不得变更既有节点/边行为；布局金样变更仅限新增字段，用 `UPDATE_GOLDENS=1` 重生成并在 diff 里核对范围。
6. **testid 契约**：UI 元素用 `data-testid`（e2e 大量按名断言）；错误文案两段式=原因+下一步（NFR-USE-005）。
7. **协同语义**：远端更新走 `attachRemoteNormalization` 收敛；新文档级数据（如 summaries）必须在 repair/restore 路径同裁定（见 restore.ts 头注先例）。
8. **门禁五件套**（提交前全绿）：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`。
9. **SDD 流程**：里程碑级工作走 docs/superpowers/plans 计划→任务简报→实现→独立评审→修复环→全分支终审→验收文档；台账在 `.superpowers/sdd/<plan>/progress.md`（收口后删，git 为准）。

## 三、文档更新义务（防状态错位，必要时必须更新）

- **交付任何里程碑/任务**：当日更新对应 `docs/mX-acceptance.md`（真实用例名+行号当日 grep，禁止转抄报告；无自动化背书不写"通过"）；若影响整体进度，同步 [`docs/project-status.md`](./docs/project-status.md)（状态表/差异清单）与 `README.md`（进度行）。
- **里程碑收口**：更新 `docs/project-status.md` §二 状态表与 §三 差异清单；`README.md` 的进度行同步。
- **需求方裁定变更**（新增排除项/提前项/待裁定结论）：同步 `docs/project-status.md` §三 对应小节，必要时在验收文档补记。
- **挂账**：评审 minors/顺延项登记 `docs/m2-entry-checklist.md` §7 或验收文档"诚实登记"，禁止静默丢弃。
