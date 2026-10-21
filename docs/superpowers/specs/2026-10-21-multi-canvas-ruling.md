# 多画布（一文件多张脑图）裁定记录与技术评估

> 日期：2026-10-21 ｜ 状态：**已裁定，待排期开发** ｜ 性质：翻案——推翻 2026-09-28 企微对标 spec「多画布本期不做，登记备选」（见 `2026-09-28-wecom-interaction-parity-design.md` §二.5）
>
> 本文只记录裁定与评估，**不是实施计划**。开工前另走 SDD 流程出计划（`docs/superpowers/plans/`）。

## 一、需求方裁定细则（8 条，2026-10-21 逐条确认）

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 节点数配额 | **按画布算**：每张画布各自计上限（现 500 节点口径逐画布独立），不按全文档合计 |
| 2 | 撤销/重做 | **不跨画布**：⌘Z/⌘⇧Z 只影响当前画布 |
| 3 | 工作台缩略图 | **取第一个画布** |
| 4 | 远端光标 | 对方在别的画布时**隐藏光标**（不做跳转提示，不加"对方正在画布 N"标识） |
| 5 | 结构 / 主题归属 | **各画布独立**：structureType 与 themeId 为画布级数据（画布 1 脑图＋蓝、画布 2 树状＋绿互不干扰） |
| 6 | 概要 × 版本恢复 | **恢复时不恢复概要**（维持现状语义：恢复 diff 范围不含 summaries，恢复后由 repair 按存活片段自愈收敛）。**此条一并了结 M6 验收「待裁定项 3」（m6-acceptance §三 = 选项 B）** |
| 7 | 移动端 | **显示画布页签，只读可切换**（手机用户能看到并翻看所有画布，不可编辑） |
| 8 | 导出范围 | **XMind 导出全部画布（多 Sheet）；PNG/JPG 只出当前画布** |

### 默认假设（需求方过目未异议，随本记录生效；有异议随时翻）

1. 画布命名：默认「画布 1 / 2 / 3…」，可重命名；文件名与画布名解耦（沿用 files.title 与画布名分开的既有先例）
2. 表格视图：只显示当前画布的内容
3. 自定义列（customColumns）：全文件共享一套 schema，不做画布级
4. 评论：不绑画布（节点 id 全局唯一不变）；点评论定位时自动切到目标画布再定位
5. 画布管理入口：底部页签条（对齐企微形态）＋「＋」新建；画布不可删到最后一张

## 二、技术方案方向：A 切换制（推荐），B 多根同屏（排除）

| | A. 切换制（一次只渲染一棵，页签切画布） | B. 多根同屏（森林） |
|---|---|---|
| core（repair/restore/配额/undo） | 中——多根收敛规则逐条重述＋混沌套件同步 | 同左 |
| engine | 小——`'root'` 字面量参数化（layout.ts:211、selection.ts:176），createScene/renderScene/DragController 已是单树参数化 | **大——布局森林化、拖拽空白解析唯一根假设、边 id 命名空间全改、金样全重生成** |
| web UI | 中——页签条＋约 10 处 ROOT_NODE_ID 兜底接「当前画布 vs 全文档」口径 | 大 |
| e2e/testid/金样 | 中 | 大 |
| 粗估（含门禁五件套＋验收文档） | **4~6 人周** | 8~10+ 人周 |

**裁定方案 = A（切换制）**，理由：覆盖最实际的用户价值（XMind 多 Sheet 导入不再拍平丢弃、一文件组织多张图），引擎主体不动；B 的同屏多图收益不抵布局/拖拽颠覆成本。

## 三、现状单画布假设盘点（评估依据，2026-10-21 排查）

**全局结构**：一个 Y.Doc = 一棵树 = 固定根 id `'root'`（`packages/gmind-core/src/doc.ts:11`，spec §4.1 钉死「不可删除、不可换父」）。nodes 为文档级扁平 Y.Map，树由 parentId＋children 拼出。

**改造热点（按风险排序）**：

1. **repair 收敛规则**（`packages/gmind-core/src/repair.ts`）：规则⓪环破坏挂回 root、⑤孤儿挂回、⑥root 缺失重建均需重述多根语义；`deriveNormalizeDirty` 的等价性论证与混沌测试套件同步重做——**本工程最大风险点**
2. **root 引用面**：core（read.countAliveReachable 配额口径、operations deleteNodes/moveNode 特判、restore 可达集/父映射、export.cloneExpanded）、engine（layout/selection/drag 三处字面量）、web（EditorPage 约 10 处：全选/定位中心/查找全树/导出/缩略图/表格视图/版本预览/粘贴目标）
3. **meta 归属拆分**：structureType/themeId 改画布级（裁定 5）；title 保持文件级；customColumns/tableView 按默认假设 2/3 执行
4. **xmind-io 多 Sheet**：解析侧 `parse-json.ts:107-132` / `parse-xml.ts:93-112` 现取 sheets[0] 并把其余计「结构降级」——这条降级路径就是迁移线索；导出侧 `build.ts:24` 恒单 Sheet 改多 Sheet
5. **undo 作用域**（裁定 2）：`undo.ts` 的 UndoManager 现跟踪整个 doc，需按画布裁剪 scope

**零改动面**（评估确认）：

- 服务端 DB schema：doc_state/versions.state 为 opaque blob，Y.Doc 新增 root type 不动存储与传输；旧文档经 `docFromState` 唯一装载通道无损升级（有 side 回填 `planSideBackfill` 先例）
- Hocuspocus 网关（documentName=fileId 粒度不变）
- 节点 id 体系：ULID 全局唯一，共享 nodes map 方案下评论/任务/标记/awareness 选区的**数据层不动**（裁定 4 只需 UI 层按画布过滤）

## 四、启动条件

- [x] 需求方裁定细则（本文 §一）
- [ ] SDD 实施计划（`docs/superpowers/plans/`，分层：core → engine → web → xmind-io → e2e）
- [ ] 排期（依赖 M7b 收口情况，由需求方定）
