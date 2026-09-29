# M7c：脑图任务化——描述字段+快速设置弹层+右侧任务面板（需求方 2026-09-29 裁定）

> 背景：需求方明确最终形态=「脑图 × 表格的项目管理工具」（mindgrid 合并轨原目标）。表格视图（M7a）已就绪，本轮把脑图侧的任务能力补齐到 mindgrid 对标。
> 验收：Kimi K3（high 思考档，可用 kimi-webbridge 操控真实浏览器）验收。

## R1 节点描述字段（description）
- core：NodeSnapshot 加 `description`（Yjs 键 'description'，缺省 ''）；op `setDescription(doc,id,text)`（≤200 字，校验先于事务，TASK 前缀沿用）；undo/repair（超长截断口径与 note 一致）/xmind-io（映射 note 旁的 `<desc>`? 以 mindgrid 导出兼容为主——导出 JSON 带 description，XMind 格式无对应则登记）。
- shared derive：ChangeLog 计算含 description（M7d 前先只在前端展示）。
- engine 节点卡片：text 下方第二行渲染 description（灰字 12px、单行省略，有 description 时节点高度自适应）；布局槽位随高度自然复用。
- 表格：任务列标题下方不展示（表格列已多），加「描述」列？——不加列，行内双击标题编辑器带描述输入（两行 textarea，Tab 切换），与 mindgrid QuickEditor 一致。

## R2 快速设置弹层（NodeQuickCard 对标 mindgrid）
- 画布节点右键菜单扩展（现右键菜单已有层级操作）：新「任务快速设置」卡——选中节点右键（或点击节点后浮出的快捷入口）弹出紧凑卡：状态四选（色点）、负责人（成员多选 chips）、优先级九宫格（现有迷你选盘复用）、图标/表情入口（现有面板）、三日期（SmartDateInput）、进度滑杆（叶子可调）。
- 全部写走 core ops + afterUserWrite；Esc/外点关；readOnly 不弹。

## R3 右侧任务属性面板（TaskPanel）
- 「格式」按钮旁新增「任务」按钮（图标+文字，企微式）；点开右列任务面板：标题/描述/负责人/状态/标记（跳标记面板）/三日期/进度/创建信息。结构与 RichPanel 同形态（右列条件渲染，关闭 ×）。
- 与格式面板互斥打开（同列）；评论面板可共存（纵排）。

## R4 节点卡片任务视觉（原 M7b 未做项，一并落地）
- 状态色左边条（todo 灱/doing 蓝/done 绿/blocked 橙）；负责人头像（第一人+n）；叶子有效进度 %；预期日期徽标（逾期红）。随 R1 description 行共同构成任务卡片。

## 裁定沿用
- 功能冲突以 mindgrid 为准（2026-09-28）；「回复开始时问」项：无需问——description 与现有 note 并存（note=企微备注角标语义不变，description=任务描述第二行）。
