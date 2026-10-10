# 节点属性快捷面板 + 节点任务视觉对齐 mindgrid + 工具栏「插入」菜单删除 — 设计 spec

> 日期：2026-10-10。需求方四问裁定已落地（见 §一），本文为实现的唯一口径。
> 参照项目：`../mindgrid`（NodeEditor 面板 / 节点任务信息布局 / 再点开面板交互）。

## 一、需求与裁定记录（2026-10-10，四问确认）

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 工具栏「插入」菜单（图标/表情/链接/评论/图片 5 条目）删除范围 | **整个菜单连条目全删**。链接/图片仍走格式面板既有入口；评论走工具栏 comment-toggle 按钮（实现中发现该按钮仅移动端存在 → 裁定 6 桌面补装）；MarkerPanel 保留并改锚定 |
| 2 | 「再点已选中主题 → 右侧属性框」承载方式 | **复用现有 TaskPanel**（字段最全、testid 契约成熟）；右键「任务设置」/TaskQuickCard/`,` 快捷键一并删除；工具栏「任务」按钮保留 |
| 3 | 非简洁模式节点任务信息布局对齐程度 | **全量对齐 mindgrid**：footer 行=左负责人文字名(+N)/右百分比；预期日期=节点盒右上角外侧悬浮标签；状态色条保留；简洁模式不动 |
| 4 | 面板关闭行为（与 2026-10-09「格式/任务面板点空白转空态不关闭」裁定冲突） | **改判：点空白关闭**（格式/任务面板恢复外点即关，与 mindgrid 一致）。project-status 对应行补改判注记 |
| 5 | footer 行是否每个节点都显示（spec 评审中发现的第五问：mindgrid 详细模式每节点恒有 footer/未分配/0%） | **仅任务节点显示 footer**（hasTaskInfo 门槛不变）：零任务信息节点保持纯脑图卡；有任务信息的节点内，无负责人且 depth≥2 才显示橙字「未分配」；百分比口径不变（叶>0 才显示、父恒显示） |
| 6 | 桌面端评论入口（实现中发现：comment-toggle 按钮只存在于移动端工具栏，「插入→评论」是桌面唯一入口——裁定 1 的「评论走 comment-toggle」前提不成立） | **桌面工具栏补「评论」按钮**（testid 复用 comment-toggle，标题组尾随 save-status，与移动端同 testid 同动作）；桌面评论功能保持可用 |

参照事实（mindgrid 探查结论）：

- 再点开面板：`MindMap.tsx` mousedown 首次选中记 `justSelectedRef`，click 时 `e.detail>1` 跳过（双击归就地编辑）、`justSelected===id` 跳过，否则已选中 → 开面板；**再点只开不 toggle**。
- 节点布局（详细模式）：行1 标记+标题；行2 描述；footer 行 左=首负责人**文字名**（多人 +N；depth≥2 无负责人显示橙色「未分配」）、右=`{eff}%`（逾期红）；dueDate 悬浮标签在卡片**右上角外侧**（MM-DD，逾期红）；startDate/doneDate 不上节点；左缘 2px 状态色条。
- 简洁模式：标记+标题+内联 `{eff}%`（与 Gmind 现状同构，本次不动）。

## 二、工作流 A：工具栏「插入」菜单整体删除

**代码（`apps/web/src/pages/EditorPage.tsx`）**：

1. 删除插入组 JSX（`insert-menu` 按钮、`.insert-dropdown`、5 条目 `insert-icons/emoji/link/comment/image`）、`insertOpen` state、`closeInsertLayer` 中的 `setInsertOpen`。
2. **MarkerPanel 改锚定**：现状 `openMarkerPanel(tab)` 取 `insertWrapRef` 按钮 rect 作 anchor（EditorPage L532-540），JSX 挂 `.insert-wrap` 下（L3205-3215）。改造：
   - `openMarkerPanel(tab, anchor?: {left,top})`——调用点供给 anchor：
     - 节点标记点击入口（L3832 附近）：用点击事件 clientX/clientY；
     - TaskPanel「标记编辑」入口（L3696）：用 TaskPanel 内按钮 rect（TaskPanel 经 onOpenMarkers 上传事件坐标）；
   - MarkerPanel JSX 移出 `.insert-wrap`，挂编辑器根（fixed 定位语义不变）；`.insert-wrap`/ref 删除。
3. 评论入口：`insert-comment` 删除；桌面工具栏标题组补 comment-toggle 按钮
   （裁定 6——实现中发现 comment-toggle 原仅移动端分支装配，桌面补同款）。
4. 链接/图片：条目删除；格式面板内既有入口保留不动。

**testid 退役**：`insert-menu`、`insert-icons`、`insert-emoji`、`insert-link`、`insert-comment`、`insert-image`。

**e2e 重写**（改用替代入口）：

| spec | 现状用法 | 改法 |
|---|---|---|
| marker-panel.e2e.spec.ts | insert-menu 开 MarkerPanel（L61-75/109/196-197） | 改节点标记点击入口开面板；`insert-link` 用例改格式面板链接输入 |
| emoji.e2e.spec.ts | insert-emoji（L46-47） | 同改标记点击入口（emoji 页签） |
| comments/activity/error-copy | insert-comment | 改走工具栏 `comment-toggle` 按钮（EditorPage L3013，评论面板的另一既有入口——插入菜单条目本就是冗余入口） |
| toolbar.e2e.spec.ts | testid 清单含 insert-menu（L53/168/194） | 清单删除 insert-menu；布局断言同步 |
| mobile-readonly.e2e.spec.ts | 装配口径（L51-61） | 删除 insert 相关断言 |
| format-painter/rich-content/task-table | 间接引用 | 逐文件改为格式面板/标记点击入口 |

## 三、工作流 B：再点已选中主题 → 开 TaskPanel；TaskQuickCard 全删

**交互（`EditorPage.tsx`）**：

1. 新增 `justSelectedIdRef`：节点 pointerdown 完成「未选中 → 选中」时记下 id（含多选收敛为单选的情形）。
2. `onSvgClick`：节点 id === 当前唯一选中 且 `justSelectedIdRef !== id`（即本次点击前已处于选中态）且非双击（浏览器 click 序列天然区分，双击编辑走 dblclick 链不触发本分支）且非 `justDragged` 合成 → `setTaskPanelOpen(true)`（与 formatOpen 互斥沿用现状）。
3. 再点只开不 toggle（同 mindgrid）；多选（>1）中点击先收敛为单选，不当场开面板。
4. 双击已选中节点：浏览器序列 click(1) → click(2) → dblclick，第一次 click 会先触发开面板、随后 dblclick 进就地编辑——面板与行内编辑器并存（mindgrid 同款行为，接受，不做延迟抑制）。

**删除清单**：

- 右键菜单 `menu-task-quick` 条目（EditorPage L3748）；右键菜单项数由 9 → 8，telemetry spec 注释同步。
- `apps/web/src/editor/TaskQuickCard.tsx` 组件文件、`openQuickCard`（L593-608）、渲染处（L3820-3836）。
- `,` 逗号快捷键（L728-751）及快捷键帮助面板对应条目。
- TaskQuickCard 专属 Esc/外点监听（L612-626）；testid `task-quickcard` 退役。

**点空白关闭面板（改判 2026-10-09）**：

- EditorPage 统一外点 effect 恢复 `formatOpen`/`taskPanelOpen`：pointerdown 命中画布空白（非节点、非面板自身）→ 两面板关闭（不再「转空态保留」）；面板自身按钮/toggle/只读强制收不变。
- `format-panel.e2e.spec.ts` / `format-painter.e2e.spec.ts` 中 10-09 新语义断言回改「外点即关」。
- `docs/project-status.md` 10-09 交付行补改判注记（需求方 2026-10-10 改判）。

**e2e 新增**：

- 「选中节点 → 再点 → TaskPanel 打开」「已开时再点保持开（不 toggle）」「点空白 → TaskPanel/格式面板关闭」。
- `custom-columns.e2e.spec.ts` L183-214：`,` 开 `task-quickcard` 的用例改走工具栏 `task-toggle` 开 TaskPanel（自定义属性小节在 TaskPanel 内）。

## 四、工作流 C：节点任务视觉全量对齐 mindgrid（仅非简洁模式）

**engine 改动范围**：`packages/engine/src/taskvisual.ts`（几何/语义常量单源）、`render.ts`（绘制）、`measure.ts`（盒宽/高下限）。布局 `layout.ts` 不动。

| 元素 | 现状（render.ts L621-735） | 改后 |
|---|---|---|
| 状态色条 | 左缘 3px `gm-task-bar` 四色 | 保留不变 |
| footer 行 | `gm-task-row` 自右向左：日期徽标 → 百分比 → 负责人色点+n | 两栏：左=负责人文字、右=百分比；行高 `TASK_ROW_H=20` 不变 |
| 负责人 | `gm-task-owner` 色点 + `gm-task-owner-plus`「+n」 | `gm-task-owner-text`：首人显示名（多人 ` 名 +N`）；**depth≥2 且无负责人 → 橙色「未分配」**（`gm-task-owner-unassigned`，mindgrid 口径）；色点/+n 类退役 |
| 百分比 | `gm-task-progress`（叶 progress>0 才显示；父=Σ 子级均值恒显示） | 位置改 footer 行右缘；**显示口径不变**（effectiveProgress，逾期红） |
| 预期日期 | 行内徽标 `gm-task-due-bg`+`gm-task-due`（MM-DD，逾期红底白字） | **节点盒右上角外侧悬浮标签** `gm-task-due-float`：MM-DD，逾期红字红框、常态灰字浅框、底色=画布色（mindgrid chip 同款——实现时按 mindgrid 源码订正，非红底白字）；不占布局宽/高（绘制在盒外上方空隙，与 mindgrid `-top-2 right-1.5` 同位）；startDate/doneDate 不上节点 |
| 描述行/标记行 | 现状 | 不变 |
| 简洁模式 | 色条/任务行/描述行隐藏 + `gm-task-progress-inline` 内联 % | **不动**（已是 mindgrid 口径） |

**负责人显示名数据流**：engine 不查用户目录——EditorPage 调 `useTaskMembers(fileId, presence, docOwnerIds)`（`TaskFields.tsx` L87，TaskPanel/TaskQuickCard 同款）得 memberIndex，构造 `nodeData`（EditorPage L2680-2708）时把 `owners` ID 映射为显示名随 `task` 透传（字段如 `ownerNames: string[]`）；无成员信息时回退 ID 截断（前 8 位）。engine `NodeBox`/nodeData 的 task 类型扩字段（新增字段，不动既有字段——金样纪律「仅限新增字段」对快照类型同样适用）。

**宽度测量（measure.ts）**：盒宽下限改按「负责人文字宽（ownerNames[0] + 可选 +N）+ 间距 + 百分比宽」+ 标题/标记行取 max；浮动日期标签不参与测量。文字宽度沿用既有 measure 适配器（非估算）。

**金样纪律**：`UPDATE_GOLDENS=1` 重生成布局/渲染金样，diff 逐一核对——预期变化仅限：任务行内部结构、盒宽下限（负责人文字名普遍宽于色点）、浮动标签新增元素；节点盒位置/边几何不应变化（行高不变、盒高不变）。若 diff 出现盒位/边变化，停下来对齐。

**单测重写**：

- `render.test.ts` L737-1070 任务视觉断言：按新 DOM 结构重写（owner-text 文案/+N/未分配、due-float 位置与逾期色、footer 两栏 x 坐标）。
- `taskvisual.ts` 槽位函数（`taskRowSlotsOf` L98-108）改两栏布局算法 + 单测。
- `measure.ts` 盒宽下限用例更新。

**e2e**：`compact-mode.e2e.spec.ts` L59-123 任务视觉断言按新结构重写（简洁模式断言不动）；详细模式截图级断言更新。

## 五、影响面与风险

- **testid 契约**：退役 `insert-*`、`menu-task-quick`、`task-quickcard`；TaskPanel 全部 testid 不变。渲染类名退役 `gm-task-owner`/`gm-task-owner-plus`/`gm-task-due-bg`/`gm-task-due`（行内），新增 `gm-task-owner-text`/`gm-task-owner-unassigned`/`gm-task-due-float`。
- **协同**：本包为纯 UI/渲染层改动，文档模型（NodeTask）不动，无 repair/restore 影响；ownerNames 为渲染期派生数据，不入 Yjs 文档。
- **风险**：①金样 diff 范围失控（纪律：逐 diff 核对，见上）；②e2e 重写量大（约 10 spec），逐文件当日 grep 真实用例名登记；③评论入口消失后若有用户路径依赖，属裁定 1 已接受范围。
- **不做**：TaskPanel 本身字段/布局不改；表格视图（TaskTable）不动；XMind 导入导出不涉及任务视觉。

## 六、验证与文档义务

- 门禁五件套全绿：`pnpm lint && pnpm typecheck && pnpm test && pnpm --filter @gmind/server test:e2e && WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`。
- 当日更新 `docs/project-status.md`：新增交付行（本包三工作流）+ 10-09「面板不关闭」裁定改判注记（§二 对应行）；README 进度行如涉整体进度再同步。
- 验收口径：以本文 §一 裁定表 + 各工作流 e2e/单测用例名为准。
