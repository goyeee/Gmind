# Gmind 项目逻辑与进度（交付真相源）

> **PRD 写的是"需求"（含分期规划），不是"交付状态"。** 实际交付与 PRD 分期有多处偏差（提前/顺延/需求方裁定不做）。**判断"哪些已完成、哪些待办"一律以下文的状态表与差异清单为准，不要按 PRD 的分期/P0 标记推断。** 每个里程碑收口后必须同步本文（维护规则见 [`AGENTS.md`](../AGENTS.md) 的"文档更新义务"）。agent 行为规则同样见 [`AGENTS.md`](../AGENTS.md)。

## 一、真相源分级（读文档的顺序）

| 文档 | 角色 | 何时读 |
| --- | --- | --- |
| `Gmind_在线协作脑图软件_产品需求文档.md` | **需求源**（FR/NFR 编号、验收标准原文）。分期规划已被实际交付改变，**不可当状态用** | 查需求语义/验收口径时 |
| `docs/superpowers/specs/2026-09-18-gmind-phase1-design.md` | 一期技术设计 spec（架构裁定：CRDT 模型/唯一写入口/版本快照/导入导出位置等） | 改架构相关代码前 |
| 本文 + `docs/m0~m6-acceptance.md` | **交付真值**：逐 FR 通过/部分达成/待手动/缺口诚实登记（无自动化背书不写通过） | 查"某功能到底交付没有、缺什么" |
| `docs/m2-entry-checklist.md` | 跨里程碑挂账台账（§7 顺延项、裁定记录、收口注记） | 查历史裁定/遗留项 |
| `docs/perf-m1/m2/m5.md` | 性能基线实测（500 节点 60fps、50 机器人 P95 等） | 动性能相关代码前 |
| `docs/superpowers/plans/*.md` | 历史实施计划（任务分解的原始出处；结论以验收文档+代码为准） | 追某改动的来龙去脉 |

## 二、里程碑状态表（截至 2026-09-28，M0~M6 全部收口）

| 里程碑 | 范围 | 状态 | 验收文档 |
| --- | --- | --- | --- |
| M0 | 工程地基（monorepo/契约/DB/CI 门禁） | ✅ 完成 | docs/m0-acceptance.md |
| M1a+M1b | core 内核 + engine 编辑器 + 文件 CRUD/自动保存 | ✅ 完成（m1 有 13 项待人工签注，见 §7.5） | docs/m1-acceptance.md |
| M2 | 实时协同（Hocuspocus/光标/离线 IndexedDB/混沌） | ✅ 完成 | docs/m2-acceptance.md |
| M3a/M3b | 文件管理/回收站/分享链接/邀请/评论/通知/摘要 | ✅ 完成（部分 FR 有登记缺口，见下） | docs/m3a/m3b-acceptance.md |
| M4 | XMind 导入导出、PNG/JPG 导出、版本快照与恢复 | ✅ 完成 | docs/m4-acceptance.md |
| M5 | 打磨验收（设置页/快捷键面板/引导/埋点/移动端只读/NFR-P0） | ✅ 完成（一期收官） | docs/m5-acceptance.md |
| M6 | 企微对标包（工具栏图标化/格式联动/查找替换/12 主题/emoji/概要/格式刷/动态/头像栏） | ✅ 完成（3 项待需求方裁定） | docs/m6-acceptance.md |
| — | 连线两次修复（锚点偏移 c61df7e + 控制点恒 dx/2 a602824）+ 新建节点先落位 | ✅ 完成 | 金样/防回归断言在 packages/engine |
| — | 节点标记面板企微化（6bc0d4b→2483652 二次改版为右侧抽屉+图标/表情页签）：标记体系迁出 RichPanel → 工具栏「插入」菜单；**形态待需求方确认后补测试**（内容将被 M7a 三组制切换重排） | ✅ 交付 / 测试挂账 | — |
| M7a | mindgrid 合并轨第一弹（任务常驻/冲突以 mindgrid 为准）：任务字段、派生规则、标记三组制、表格视图（19fad2c）；kimi 流程验收+修复+回归闭环（eb19547/67c717b）。**表格形态需求方 2026-09-29 走查后提出 M7b 反馈包（11 条），面板/工具栏类项转入 M7b** | ✅ 交付（e2e 挂账随 M7b 收口） | docs/superpowers/specs/2026-09-28-mindgrid-merge-m7.md |
| M7b | 标记企微对标二批+交互补课（需求方 2026-09-29 反馈 11 条）：企微全量图标/表情目录+组语义（替换/多选）+多值模型、标记面板企微式竖层重做（顶部按钮开合）、节点标记点击换组内、空白左拖框选+批量标记、工具栏去重/文件名宽度/保存中初始态/插入左移/格式刷剔除标记、回退待开始进度清零 | 🚧 进行中 | docs/superpowers/specs/2026-09-29-m7b-marker-wecom-parity.md |
| — | 分支主题顺时针落位（需求方 2026-10-09 裁定，四问确认：双带居中/左列镜像/中心 Shift+Enter 逆时针/接受旧文档左列重排）：root 一级子树左右两带独立垂直居中于中心主题，右列=文档序自上而下、**左列=文档序自下而上（视觉反序，往左上角生长）**；中心主题 Enter/Tab 顺时针（右列配额 3 满后 append 落左列顶部）、Shift+Enter 逆时针镜像（左列优先、插该列文档序最前）；二级主题 Enter=文档序后插/Shift+Enter=前插（左列视觉反序下涌现向上）；拖拽槽位几何与落点映射同口径视觉序（drag sideInsertDocIndex/resolveDropSlot）；纯右文档布局零变化（金样未动） | ✅ 完成 | engine layout/drag 单测 + web e2e 方向矩阵/顺时针/逆时针用例 |
| — | 新增节点默认命名与中心主题定名（需求方 2026-10-09 五问裁定：格式=「分支主题 N」/「子主题 N」（同级局部序号，第三级及更深也叫子主题）；删除跳号不重排（max+1，墓碑不计数，保留前缀的改名仍占号）；中心节点=「中心主题」**仅新建空白文档**（存量/XMind 导入/种子不动），文件标题与中心节点文本解耦；表格「+ 添加子任务」与画布统一）：规则单源 `apps/web/src/editor/defaultNodeText.ts`（画布 openNewNodeEditor 与表格 addChildTo 共用，序号计算在事务外）；core `TemplateSpec.rootText` 可选覆盖；服务端三处空态模板同口径（files.service 创建即落 docState=主路径、collab.service 装载兜底、comments.service 空态兜底）；core `operations.ts` 默认空串语义不动（粘贴/恢复/导入零波及）；e2e 断言 8 文件同步（editor 数组精确断言按序号重写；share/member-invite/avatars 画布 root 断言随解耦改「中心主题」） | ✅ 完成 | web 单测 defaultNodeText 10 用例 + core doc.test 2 用例 + server e2e files:80 + web e2e 全量；m1-acceptance FR-EDT-001 行已更新（占位提示缺口随裁定关闭） |
| — | 格式/任务右列不因画布点击关闭 + 中/右键拖拽平移（需求方 2026-10-09 三问裁定：光标仅拖动中抓手；右键「拖了就不弹菜单」（4px 阈值，原地松开照常弹）；格式/任务面板点空白转空态不关闭，其余弹层维持外点即关）：① EditorPage 统一外点 effect 摘出 formatOpen/taskPanelOpen（点画布仅清选区，面板自身按钮/toggle/只读强制收不变）；② engine Viewport 新增右键阈值平移（增量自起点起算）+ `gm-panning` 类挂摘（editor.css 抓手光标）+ `justPanned` 标记，页面 onSvgContextMenu 据此防抖；中键/空格+左键路径零变化（engine 只增不改）；e2e 更新 format-panel/format-painter 断言 + 新增右键/中键平移用例 | ✅ 完成 | engine viewport.test 5 新用例（37/37）+ web e2e editor:772/801 平移用例 + format-panel:53/102 新语义；附带环境修复：本机 Node 20.19.4→22.22.2（jsdom 30 需 ≥22.22，engine 单测在 20 上无法收集） |

> **M7 合并轨与并行企微对标轨的关系**：`docs/superpowers/specs/2026-09-28-wecom-interaction-parity-design.md`（待评审）与本轨在标记分组/暗色上已被 2026-09-28 裁定更新，其余项（框选/拖动排序/⊕/格式抽屉/外框）不冲突、待并轨排期，见合并轨 spec §二。

**当前门禁基线**（2026-10-09 平移/面板裁定交付后，**本机 Node 已切 22.22.2**——jsdom 30 需 ≥22.22，Node 20 下 engine 单测无法收集，xmind-io undici unhandled error 随切换消失）：lint/typecheck 0；engine 396/396、web/shared/server/xmind-io 单测全过；server e2e 190/190；web e2e 161 passed + 1 skipped（PERF 门）。唯一存量：core bench「1 万次混合操作」3s 阈值超时（机器负载敏感，stash 基线验证非代码回归）。

## 三、PRD 分期 ≠ 实际交付（对齐差异清单）

### 已提前交付（PRD 排二/三期、实际已做）
- **概要 bracket**（FR-EDT-023 二期→M6 提前；跨侧视觉待裁定）
- **格式刷**（FR-EDT-016 二期→M6 提前）
- **文档动态面板**（FR-COL-007 二期→M6 提前；不含系统级事件、开面板拉取不实时订阅）
- **邀请对话框 UI**（M3b 缺口→M4 T2 补齐）、邀请回填覆盖已注册用户（准入 §7.10）
- **XMind 导入导出**（V1.1 修订本就提前至一期，M4 交付）
- **查找替换/emoji 面板/12 套主题/工具栏图标化/格式面板联动/头像栏**（PRD 未单列或排后期，M6 按需求方对标企微的要求交付）

### 需求方明确裁定不做（2026-09-27 原文，M6 排除清单）
大纲模式（FR-EDT-031/032）、工具栏添加上级/子级/同级三按钮、关联线（FR-EDT-022）、外框（FR-EDT-024）、结构扩展（双向逻辑图等）、提醒查阅、节点上限显示、暗色模式。**这些是"裁定不做"，不是"没做完"——验收不据此判缺。**

### 维持 PRD 后期排期（未做、待排期）
PDF/SVG 导出、FreeMind/Markdown/OPML/TXT 导入（二期）；版本对比/手动版本（FR-VER-003/002）、评论解决/汇总面板（FR-CMT-008/004）、跟随视角、在线成员头像栏增强、团队空间与四级权限（二期）；Word 导出、大纲、公式等（三期）。

### 部分达成的 FR（主链路已过、缺口登记在案）
- **FR-CMT-001**：缺右键菜单「评论」项与 Shift+F2 入口、评论换行输入（现为常驻面板+单行）
- **FR-CMT-002**：缺"视口居中+闪烁高亮"（现为选区+展开祖先定位）
- **FR-CMT-005**：缺评论输入 @ 唤起成员选择器 UI（mention 端点已就绪）
- **FR-CMT-006**：「加入协作」的 permission 通知已补（M4 T10）；权限**级别变更**通知随二期四级权限体系（一期角色集只有 owner/editor）
- **FR-SHR-001**：分享链接"关闭"无工作台 UI 入口（API 已就绪）
- **FR-IO-003**：JPG 像素视觉待手动（冒烟自动化已过）
- 其余逐条见各验收文档"诚实登记"节

### 待需求方裁定（不代签，见 m6-acceptance §三）
1. 跨侧概要 bracket 视觉（限制仅同侧 vs 维持横跨）
2. 旧主题（经典蓝/暖橙）root 文字对比度债（4.28/2.39，被 M1b 主色钉定测试锁死）
3. 概要×版本恢复口径（恢复不回滚概要、repair 自愈收敛 vs 纳入恢复 diff；现状语义在 `packages/gmind-core/src/restore.ts` 头注）

### 待人工/待环境（非代码项）
- m1-acceptance 13 项人工签注（§7.5，验收文档原样转需求方）
- 双机协作/恢复广播/分享体验（m2~m5 手动清单）
- 真实 XMind 8/2020+ 文件导入验证、导出图片视觉（m4）
- MailHog/MinIO 镜像不可得：邮件真实送达、对象存储 Provider 换型（本地磁盘 Provider 已就绪）
- TLS/落盘加密（NFR-SEC-001/002）、PERF-004 生产构建首屏：生产部署期核验
- 移动端真机 Safari（iOS 捏合缩放缺失，底栏缩放钮兜底）
