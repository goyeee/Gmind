# mindgrid 合并轨（M7）：任务脑图 × 表格双视图

> 日期：2026-09-28 ｜ 状态：M7a 已开工
> 上游评估：对 /Users/guoyue/code/mindgrid（前端 7,211 LOC / 后端 3,572 LOC / PRD 255 行）全量盘点后与需求方对齐。

## 一、合并方向（需求方已裁定，2026-09-28）

**在 Gmind 上长出 mindgrid**：保留 Gmind 全部底层（Yjs/Hocuspocus CRDT 协同、NestJS+TypeORM、monorepo 工程纪律、engine、e2e 体系），把 mindgrid 的任务管理功能与交互移植进来。mindgrid 自身的底座（REST+乐观锁 409+内存 WS 广播，约 1,500 LOC）整体丢弃。

裁定原文：
1. **深色一起要** —— mindgrid 深色 IDE 风随 M7 移植（推翻 2026-09-27「暗色先不做」）。
2. **任务常驻** —— 任务字段（status/progress/owners/日期）全局常驻所有文档，不做文档级开关；表格列可隐藏。
3. **功能冲突以 mindgrid 为准** —— 含标记体系：Gmind 五组图标制（priority/progress/flag/star/emoji）切换为 mindgrid 三组制（priority 1-7 / icon 10 个 / emoji 10 个），status 与 progress 成为任务字段而非标记。用户已点头的企微式右侧抽屉形态保留，仅内容切换。
4. 有问题随时问。

## 二、与并行轨的冲突登记（待需求方并轨裁定）

`docs/superpowers/specs/2026-09-28-wecom-interaction-parity-design.md`（另一会话产出的企微交互对标 spec，自称 M7、待评审）与本轨冲突点：

| 冲突面 | 企微对标轨 | 本轨（mindgrid 裁定） | 状态 |
| --- | --- | --- | --- |
| 标记分组 | P1-2 补心情/数字/箭头三组，数据模型零改动 | 三组制 priority/icon/emoji + 任务字段 | **本轨裁定更新，企微轨 P1-2 作废** |
| 暗色模式 | 明确不做 | 深色一起要 | **本轨裁定更新** |
| 空白左拖 | 框选（企微实测），平移改空格/中键 | mindgrid 为左拖平移、右拖平移 | **待裁定**（M7b 脑图交互开工前问） |
| 编号 | 自称 M7 | 本轨 M7a~M7e | 编号并轨待定，暂以内容区分 |

两轨不冲突的部分（框选落地细节、节点拖动排序、⊕ 快捷按钮、格式抽屉、外框等）保留在企微轨 spec 中，待需求方裁定后择机排期。

## 三、里程碑切分

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **M7a** | 任务字段进 core（schema/ops/校验/repair/undo）+ 标记三组制切换 + 派生规则入驻 shared + engine 新目录渲染 + **表格视图**（筛选/排序/右键菜单/行内编辑/负责人=用户ID/只读降级） | 🚧 开工 |
| M7b | 脑图任务化交互：Alt+Enter 连续录入、按下即选/二击开面板/双击就地编辑、任意字符开编、右键 NodeQuickCard、节点任务卡片视觉（状态条/负责人/进度/日期徽标/逾期红描边/状态色连线） | 待 |
| M7c | 深色主题：全站 CSS 变量化（--c-* 语义色板）+ 深浅切换 + 偏好持久化。默认主题深浅待问 | 待 |
| M7d | 今日动态 + 日报/周报：服务端 Hocuspocus 存储钩子前后快照 diff 生成变更日志（操作人取连接鉴权身份）+ Digest 视图移植 + Markdown 导出。开工前先 spike diff 方案 | 待 |
| M7e（可选） | 提醒（定时扫逾期生成站内提醒）、超管后台、JSON 整库导入导出 | 待 |

## 四、M7a 契约（任务书要点）

### T1 gmind-core：任务字段 + 标记目录切换

- 节点 map 新增 `task` Y.Map；读取侧快照恒定暴露归一化任务对象（缺省 todo/0/[]/null/null/null）。
- 新写入口 `setNodeTask(doc, id, patch)`：status('todo'|'doing'|'done'|'blocked') / progress(int 0-100) / owners(string[] 用户ID, 去重≤20) / startDate|dueDate|doneDate('YYYY-MM-DD'|null)。校验先于事务，拒绝零变更；错误码 TASK_INVALID_*。
- 状态联动（规则唯一实现放 @gmind/shared `applyStatusRules`，core op 与 web 共用）：status→done 自动 doneDate=今天 + progress=100；离开 done 清 doneDate；手改 doneDate 不反写 status。
- `ICON_GROUPS` → `['priority','icon','emoji']`，值目录从 core 常量导出（priority '1'..'7'；icon 10 个 slug：done/cancel/important/flag/question/alert/idea/like/link/clock；emoji 10 字符 😄🙂😐😟😢😠😴🤔👍👎，与 mindgrid `MARKER_GROUPS` 完全一致）。setIcon 增加**值校验**（现仅校验 group）。组内单选、组间并存语义不变。
- repair 旧值映射（幂等，随 repair 三态用例）：priority '8'/'9'→'7'；progress 组→删除（若旧值可解析为 0-100 数字则迁入 task.progress，口径登记验收文档）；flag→icon 'flag'；star→icon 'important'；emoji 原样。
- xmind-io 目录对齐：导入 priority 8/9→7、flag-*/star-* 映射 icon 组，未映射丢弃并登记；导出仅出三组。
- undo/redo 接入既有 capUndoStack 路径；单测覆盖校验拒绝/联动/undo/repair 映射。

### T2 @gmind/shared：派生规则移植（React 无关）

- 自 mindgrid `shared/derive.ts` 移植并适配 Gmind 快照结构（结构化类型输入，不依赖 engine）：`childrenOf`/`flattenVisible`（尊重折叠态）/`effectiveProgress`（父=子均值递归）/`applyStatusRules`（见 T1，唯一实现）/`isOverdue`（dueDate<今天 且 有效进度<100 且 status≠done）/`sortValue`（各列排序键）/ 日期工具。
- 单测含 mindgrid 语义用例：父进度均值、完成联动、逾期边界（今天当天不逾期）。

### T3 engine：新标记目录渲染（依赖 T1）

- 优先级 1-7 彩色数字方块（1 红→7 绿色阶，mindgrid 配色）；icon 组 10 符号（✓ ✗ ★ ⚑ ? ! 💡 ♥ 🔗 ⏰）；emoji 10 字符。图标行位置不变（节点框内文字左侧）。
- 旧 progress 环/旗帜/星标渲染路径移除；金样 `UPDATE_GOLDENS=1` 重生成并 diff 核对范围。

### T4 apps/web：表格视图 + 标记面板内容切换（依赖 T1/T2/T3）

- EditorPage 顶栏视图 Tab：脑图 | 表格（testid `view-tab-mind`/`view-tab-table`），切换保留各自状态；移动端只读降级两视图一致。
- TreeTable 移植（列：#/任务/负责人/状态/进度/开始/预期/完成/更新）：树缩进+折叠钮+状态点+标记+标题；**全部写走 gmind-core ops + afterUserWrite**（不引入 mindgrid store）；负责人=成员选择器（用户ID+姓名+成员色 chips 多选）；状态下拉；进度数字（叶子可编，父级只读 Σ 自动值）；SmartDateInput 移植（点空预填年月、未选日离开自动清除、无变更不写）。
- 筛选条（关键词/负责人/状态/仅逾期/仅未分配，命中保祖先、未命中 35% 淡化）；表头三态排序 + 右键行菜单（展开/折叠该行子级、展开/折叠全部、按当前列排序子级↑↓、添加子任务）；双击标题行内编辑、双击行折叠；Esc 关弹层；viewer 只读=全列文本化。
- MarkerPanel 内容切 mindgrid 三组（图标页=优先级+图标、表情页=emoji），抽屉形态与页签结构维持 2483652 版。
- **流程纪律（需求方 2026-09-28 要求）**：先快速实现+截图可视化给需求方确认形态，确认后再补全量 e2e 与旧标记用例迁移。

## 五、工程纪律（沿用，不变）

唯一写入口；校验先于事务；engine 只增不改+金样重生成核对；UI 一律 data-testid；错误文案两段式；门禁全绿收口；验收文档登记待裁定项。
