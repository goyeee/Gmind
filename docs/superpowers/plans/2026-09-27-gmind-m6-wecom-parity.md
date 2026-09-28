# M6 企微对标包 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按需求方 2026-09-27 裁定的企微对标范围补齐：概要、格式刷、查找替换、emoji 面板、主题扩容、工具栏图标化分组、格式面板随选中联动、文档动态、顶栏协作者头像栏；前置完成连线涡流交叉修复（已单独提交 a602824）。

**Architecture:** 全部为既有域增量——engine（概要 bracket 布局渲染）、core（概要 ops + 格式刷复制源）、web（工具栏改版/查找替换/emoji/主题面板/动态/头像栏）、server 仅文档动态一个只读端点。无新依赖、无新表（events 已有）。

**Tech Stack:** 既有栈。

**Spec:** PRD FR-EDT-016（格式刷）/023（概要）/FR-FIL 检索域/FR-COL-007（动态）；需求方排除项：大纲模式、添加节点三按钮、关联线、外框、结构扩展、提醒查阅、节点上限显示、暗色模式——**不做**。

## Global Constraints（全任务绑定）

- 唯一写入口/校验先于事务/MySQL5.6/显式 @Inject——既有纪律照旧。
- testid 命名沿用 `data-testid`；UI 文案中文；错误文案=原因+下一步（NFR-USE-005）。
- 「只增不改」引擎纪律：概要为新增渲染层，不改既有节点/边行为；金样变更仅限新增 bracket 输出。
- 测试输出 pristine；TDD；逐任务 commit。
- 概要数据口径（裁定）：存 doc 级 `summaries` Y.Map（id → {nodeIds: string[], label: string}），nodeIds 为同父连续兄弟片段；节点删除致片段断裂时 repair 收敛（片段内全部消失→删概要；部分→保留存活子段）。

---

### Task 1: 工具栏图标化分组改版

**Files:** Modify `apps/web/src/pages/EditorPage.tsx`（工具栏区）、Create `apps/web/src/editor/toolbar.css` 或并入既有 css；Test `apps/web/e2e/toolbar.e2e.spec.ts`（新建）
**Interfaces:**
- Produces: 工具栏单行分组 `[返回] | [撤销][重做] | [结构▾][主题▾][格式] | [导出▾] | [成员][版本历史][快捷键][查找]`，竖线分隔组；全部按钮带内联 SVG 图标（`apps/web/src/editor/icons.tsx` 新建：UndoIcon/RedoIcon/StructureIcon/ThemeIcon/FormatIcon/ExportIcon/MembersIcon/HistoryIcon/KeyboardIcon/SearchIcon，stroke=currentColor，16×16）+ `title` 悬停提示 + 现有 testid 全保留（undo-btn/redo-btn/structure-select/theme-select/export-menu/members-toggle/versions-toggle/help-toggle）；新增 `find-toggle`（查找入口，T3 接线前禁用态）。
- 标题输入与保存状态位置不变（最左返回之后）；样式作用：图标按钮 28×28、hover 背景、组分隔线 1px。
**Steps:** ① 失败 e2e（分组结构断言：分隔符数量、每按钮有 svg 子元素与 title、既有 testid 不丢）→ ② icons.tsx + 工具栏重排 → ③ 全量 web e2e（既有断言 zero regression）→ 提交 `feat(web): 工具栏图标化分组改版（企微对标 T1）`。

### Task 2: 格式面板随选中联动

**Files:** Modify `apps/web/src/editor/RichPanel.tsx`、`apps/web/src/pages/EditorPage.tsx`（传 selectedSnapshot）；Test `apps/web/e2e/format-panel.e2e.spec.ts`（新建）
**Interfaces:**
- Consumes: `EditorPage` 已有 selection→snapshot 流（getNode）。
- Produces: RichPanel props 增 `selected: NodeSnapshot | null`；样式区填充/文字色按钮按 `selected.style.fill/ color` 回显 `aria-pressed`；字号/作用域 select 回显当前值；无选中时样式区置灰（fieldset disabled + 提示「选中节点后设置样式」）；切换选中节点即时刷新。
**Steps:** ① 失败 e2e（选 A 设红→面板红钮 pressed；选 B 未设→无 pressed；清空选择→disabled）→ ② 实现 → ③ 全量回归 → 提交 `feat(web): 格式面板随选中节点联动回显（企微对标 T2）`。

### Task 3: 查找替换

**Files:** Create `apps/web/src/editor/FindReplace.tsx`；Modify `apps/web/src/pages/EditorPage.tsx`（装配 + Ctrl/Cmd+F 绑定 + find-toggle 接线）；Test `apps/web/e2e/find-replace.e2e.spec.ts`（新建）
**Interfaces:**
- Produces: testid `find-bar`/`find-input`/`find-next`/`find-prev`/`find-replace-input`/`find-replace-btn`/`find-replace-all`/`find-close`/`find-count`（`3/7` 式）；匹配集=全部存活节点 text 大小写不敏感包含；`find-count` 展示当前第 n/共 m；next/prev 循环定位（locateNode 展开祖先+选中）；替换单条=当前定位节点 setText（ORIGIN_USER）；全部替换=逐节点事务；Esc/关闭清空定位。Ctrl/Cmd+F 在编辑器页 preventDefault 打开（isEditableTarget 内不劫持输入框自带查找）。
**Steps:** ① 失败 e2e（建 3 节点含「节点」→ 查「节点」count 3/3 → next 定位断言 .gm-selected 文本 → 替换当前 → 替换全部后 count 0/0 且画布文本更新 → Esc 关闭）→ ② 实现 → ③ 回归 → 提交 `feat(web): 查找替换——全文匹配/循环定位/单条与全部替换（企微对标 T3）`。

### Task 4: 主题扩容 3→12

**Files:** Modify `packages/engine/src/themes.ts`（THEMES 增 9 套）、`apps/web/src/pages/EditorPage.tsx`（主题选择改缩略图面板）；Test `packages/engine/src/themes.test.ts`（追加）、`apps/web/e2e/theme-panel.e2e.spec.ts`（新建）
**Interfaces:**
- Produces: THEMES 12 套（现 gmind-light/warm-orange/a11y + 新 9：深蓝商务/森绿/樱粉/石墨深灰(浅色文字非暗色模式)/紫罗兰/琥珀/青瓷/水墨/蜜桃——每套含 root/level/leaf 三级色、edge、字体、对比度≥4.5:1（a11y 用例守卫全主题跑 contrastRatio））；选择面板=缩略图网格抽屉（复用 MemberPanel 抽屉样式；缩略图=3 节点迷你 SVG 内联渲染），testid `theme-panel`/`theme-item-{id}`；套用即 setDocMeta themeId（既有链路，可撤销）。
**Steps:** ① themes.test 追加（12 套齐、全主题对比度达标、resolveNodeStyle 不回归）→ ② 数据实现 → ③ 失败 e2e（打开面板 12 缩略图、点新主题画布变色、撤销恢复）→ ④ 回归 → 提交 `feat: 主题扩容至 12 套 + 缩略图选择面板（企微对标 T4）`。

### Task 5: emoji 表情面板

**Files:** Modify `packages/gmind-core/src/operations.ts`（icon 增 'emoji' 组）、`packages/engine/src/render.ts`（ICON_GLYPHS 增 emoji 组渲染）、Create `apps/web/src/editor/EmojiPicker.tsx`、Modify `RichPanel.tsx`（入口）；Test core/render 追加 + `apps/web/e2e/emoji.e2e.spec.ts`
**Interfaces:**
- Produces: `IconGroup` 联合增 `'emoji'`（值=单个 emoji 字符）；EmojiPicker 分类 tab（表情/手势/符号，每类 ≥24 个，静态表）；选中= setIcon(doc, id, 'emoji', char)——与现有图标组并存互斥语义（emoji 组独立，不清除 priority/flag）；节点渲染 emoji 组进 `.gm-icons`（文本渲染，emoji 字体自然支持）；再点同 emoji=取消；testid `emoji-picker`/`emoji-item-{char}`。
**Steps:** ① core/render 失败单测（emoji 组往返、渲染槽位）→ ② 实现 → ③ 失败 e2e（选节点→面板选 😊→节点 icons 含 😊→刷新仍在→再点取消）→ ④ 回归 → 提交 `feat: emoji 表情面板——图标体系扩展 emoji 组（企微对标 T5）`。

### Task 6: 概要（summary bracket）

**Files:** Create `packages/gmind-core/src/summary.ts` + 测试；Modify core index 导出、`packages/engine/src/layout.ts`+`render.ts`（bracket 输出）、`packages/gmind-core/src/repair.ts`（断裂收敛）、`apps/web`（右键菜单「概要」项 + 面板标签编辑）；Test 各层 + e2e
**Interfaces:**
- core: `setSummary(doc, nodeIds: string[], label: string, origin?): string`（校验：≥1 存活、同父、按父 children 序连续→否则 SUMMARY_INVALID）、`removeSummary(doc, id)`、`listSummaries(doc)`；存储 `doc.getMap('summaries')`；repair 规则按 Global Constraints 口径。
- engine: `LayoutResult` 增 `summaries: Array<{id, x, y, w, label}>`（bracket 框=片段盒下方 12px 外扩线下括弧 `{` 形 path + label 居中）；render `<g data-summary-id>`。
- web: 多选连续兄弟（框选或 Shift 加选校验同父连续，不满足 toast 原因+下一步）→ 右键「添加概要」→ label 行内编辑（Enter 提交 setSummary）；点 label 可改/右键删除。
**Steps:** ① core 失败单测（合法/非法片段/repair 断裂三态）→ ② engine 失败单测（三节点片段 bracket 几何：y=片段底+12、w=片段宽+16、金样重生成）→ ③ web e2e（选周一~周三→右键概要→括弧+标签出现→改 label→删除节点其一→bracket 收敛到存活段）→ ④ 全量回归 → 提交 `feat: 概要——连续兄弟片段括弧归纳（FR-EDT-023 提前，企微对标 T6）`。

### Task 7: 格式刷

**Files:** Modify `apps/web/src/pages/EditorPage.tsx`（state + 工具栏按钮 + 应用逻辑）、`packages/gmind-core/src/operations.ts`（`copyNodeStyle`/`applyNodeFormat` 若需）；Test `apps/web/e2e/format-painter.e2e.spec.ts`
**Interfaces:**
- Produces: 工具栏 `format-painter` 按钮（T1 图标组补 PainterIcon）；单击=复制当前选中节点 style+icons（快照存 state，光标变 copy 样式 class）→ 点目标节点=应用（setStyle 逐键 + setIcon 逐组，ORIGIN_USER 单事务）并退出；双击=粘滞模式（连续应用，Esc/再点按钮退出）；无选中点按钮 toast「先选中要复制样式的节点」；自刷（源=目标）no-op。
**Steps:** ① 失败 e2e（A 设红+旗帜→点刷→点 B→B 变红带旗；粘滞模式连刷 C/D；Esc 退出；撤销一步回滚单次应用）→ ② 实现 → ③ 回归 → 提交 `feat(web): 格式刷——单击/双击粘滞复制节点样式（FR-EDT-016 提前，企微对标 T7）`。

### Task 8: 文档动态面板

**Files:** Create `apps/server/src/events/events-query.controller.ts`（或并入 controller：GET /api/files/:fileId/events）、`apps/web/src/editor/ActivityPanel.tsx`；Modify EditorPage（版本历史旁入口）；Test server e2e + web e2e
**Interfaces:**
- server: `GET /api/files/:fileId/events?limit=50` → `{items:[{id,type,payload,createdAt,userName}]}`（canAccess 口径 404；join users 映射 userName；type 中文化由 web 侧做）。
- web: ActivityPanel 时间倒序列表（评论/导出/版本恢复/文档创建等既有事件类型；TYPE_LABEL map：comment_create=评论、export_done=导出、version_restore=恢复版本、doc_create=创建）；条目带相对时间；testid `activity-panel`/`activity-item-{id}`；工具栏「动态」入口（T1 图标组补 ActivityIcon，或并入版本历史面板 tab——实现取后者则记裁定）。
**Steps:** ① server 失败 e2e（造事件→列表倒序+userName+无权 404）→ ② 实现 → ③ web e2e（评论/导出后动态面板出现对应条目）→ ④ 回归 → 提交 `feat: 文档动态面板——events 只读端点+编辑器动态流（FR-COL-007 提前，企微对标 T8）`。

### Task 9: 顶栏协作者头像栏

**Files:** Modify `apps/web/src/pages/EditorPage.tsx`（顶栏头像条）；Test `apps/web/e2e/avatars.e2e.spec.ts`
**Interfaces:**
- Consumes: MemberPanel 数据源（collab presence/成员列表既有获取路径——照 MemberPanel 的 props/获取方式复用）。
- Produces: 工具栏右侧 ≤5 个 24px 圆头像（首字符回退），在线=全彩+描边、离线=灰；溢出 `+N`；点击头像=打开成员面板并定位该成员；无协作者（仅自己）显示自身 1 枚；testid `avatar-bar`/`avatar-{userId}`。
**Steps:** ① 失败 e2e（双上下文 B 加入→A 顶栏出现 B 头像在线态；B 关页→灰）→ ② 实现 → ③ 回归 → 提交 `feat(web): 顶栏协作者头像栏——在线态/溢出/点击进成员面板（企微对标 T9）`。

### Task 10: M6 验收 + 全分支终审

**Files:** Create `docs/m6-acceptance.md`；复跑全门禁（lint/typecheck/test/server e2e/web e2e）；浏览器实测截图存证（连线二次修复对照、九项新能力各一张）；诚实登记（排除项清单=需求方裁定原文；概要 repair 语义；格式刷不跨文档；动态不含系统级事件等）；提交 `docs: M6 验收清单与实测结果（企微对标包）`。终审按 SDD 流程派发全分支 review。

---

## Self-Review
1. 覆盖：需求方未排除项 9 项 ↔ T1~T9；排除项 8 项在 Global Constraints 声明不做；连线修复已前置入库（a602824，含防回归断言）。
2. 无占位：各任务 Interfaces 给出精确 testid/签名/校验语义；T8 面板归属留两案但裁定规则明确（实现者择一并记录）。
3. 类型一致：`setSummary/listSummaries`、`summaries` 布局输出、`IconGroup+'emoji'`、find/theme/emoji/activity/avatar testid 套各任务内自洽；T1 图标件名与 T7/T8 补充图标名一致（PainterIcon/ActivityIcon）。
