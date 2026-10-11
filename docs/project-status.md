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
| — | 格式/任务右列不因画布点击关闭 + 中/右键拖拽平移（需求方 2026-10-09 三问裁定：光标仅拖动中抓手；右键「拖了就不弹菜单」（4px 阈值，原地松开照常弹）；格式/任务面板点空白转空态不关闭，其余弹层维持外点即关）：① EditorPage 统一外点 effect 摘出 formatOpen/taskPanelOpen（点画布仅清选区，面板自身按钮/toggle/只读强制收不变）；② engine Viewport 新增右键阈值平移（增量自起点起算）+ `gm-panning` 类挂摘（editor.css 抓手光标）+ `justPanned` 标记，页面 onSvgContextMenu 据此防抖；中键/空格+左键路径零变化（engine 只增不改）；e2e 更新 format-panel/format-painter 断言 + 新增右键/中键平移用例。**注：「面板点空白不关闭」半项已被 2026-10-10 需求方改判（恢复外点即关，见下行）** | ✅ 完成 | engine viewport.test 5 新用例（37/37）+ web e2e editor:772/801 平移用例 + format-panel:53/102 新语义；附带环境修复：本机 Node 20.19.4→22.22.2（jsdom 30 需 ≥22.22，engine 单测在 20 上无法收集） |
| — | **人员进度列（assignee，第 5 种自定义列类型；第一步：数据+规则+表格/面板，节点画布渲染=第二步待办）**：需求方 2026-10-11 三决策（新类型区别于 person 纯名单；总进度=标准负责人+各列每人拉平平均、done 门禁=全 100% 拦截（空列不拖后腿）；先做第一步）：core `CUSTOM_COLUMN_TYPES` 加 assignee（值=Record<userId, 0-100>，校验先于事务）；shared derive `effectiveProgress` 新口径（无参与项回落原值，零回归）；core `setNodeTask` done 门禁（TASK_DONE_GATE_BLOCKED 两段式，判定用写入前值防联动注入绕过）；read `assigneeEntriesOf` 拉平；web 公共 `AssigneeField`（选人默认 0%/逐人进度/移除，整值 LWW）+ 表格单元格弹层 + TaskPanel CustomFieldInput 分支 + 表格进度列叶子显示合成值；e2e 全链路（分配→30%→合成显示→拦截→100% 放行） | ✅ 完成（第一步；第二步节点渲染待需求方启动） | core operations.test:1611/1652 + shared derive.test:270 + web TaskFields.test 映射用例 + web e2e custom-columns:258；门禁 lint/typecheck 0、单测全绿（core 289/290 仅 bench 存量）、server e2e 192/192 |
| — | **人员进度节点头像（第二步完成，2026-10-11）**：任务行内横向圆形文字头像（首字符代替——头像图片功能后续迭代，**待办**）——负责人昵称头像化（gm-task-owner-avatar）+ 人员进度头像外缘弧形进度环（0 仅底环/30 画弧/100 满圆；`data-assignee-user/col` 锚点）；**点击头像弹 9 档选盘快速更新该成员进度**（对齐 A 进度徽章标杆，写回 setCustomField 整值替换；再点同头像 toggle 收盘）；engine：NodeSnapshotLike.custom/DocMetaLike.customColumns 只增、taskvisual `flattenAssigneeEntries`/`assigneeColumnIdsOf` 拉平（engine 不 import core）、`hasTaskInfo` 门槛计入 assignees、buildDeriveNodes 补 customAssignees（修复节点 Σ 与表格口径不一致）；「未分配」文字与头像互斥（避免 render 文字宽度耦合）；compact 随任务行隐藏；**金样零变更**（UPDATE_GOLDENS=1 diff 为空，数据门槛锁定） | ✅ 完成（头像图片功能=后续迭代待办） | engine render.test:772/789 + layout.test:877（405/405）+ web e2e custom-columns:307（节点展示→点选盘→写回 100 全链路） |
| — | **用户头像功能（2026-10-11 需求方裁定三问：设置页入口/预置默认分配+可重选/全量位置）**：`users.avatar_url` 列（init 迁移既有，零迁移）+ `POST/PATCH /api/users/me/avatar`（上传复用 storage `users/{id}/` 命名空间经公开 /api/images 直出；预置白名单 `/avatars/preset-1..5.svg` 或本人键，防目录穿越/他人键）；5 个预置 SVG（public/avatars/）；**未自定义按 userId 字符码稳定哈希分配预置**（Avatar 组件级——存量用户零数据迁移）；**选盘视觉对齐原版进度选盘**（MARKER_CATALOG 饼图 MarkerChip，高亮 progressStageOf 落档）；全量位置：任务行 owner/assignee 圆形 `<image>`（共享 clipPath `gm-avatar-clip`，translate 就位）+ 成员面板行 + 协同光标标签（`gm-cursor-clip` 二选一显隐）+ 评论作者（author.avatar）+ 成员多选/表格 chips + 设置页（当前头像/预置库/上传，testid `avatar-*`） | ✅ 完成 | server e2e users-me 5 用例（白名单/上传回环/collaborators avatar）+ server e2e 195/195；engine render.test 图片头像用例 + cursors.test 光标头像用例（407/407）；web e2e settings 头像区用例 + custom-columns:307 图片头像断言 |
| — | 拖拽换侧修复（需求方 2026-10-09 报告「左侧没有分支主题时，右侧的分支主题无法拖拽至左侧」）：根级左列门控从纯几何口径（盒集已有左列主题才开放）升级为**结构门控**——engine drag 三处（classifyDropAt/resolveDropSlot/resolveBlankTarget）新增可选 `rootLeftAllowed`，EditorPage 按 structureType 供给（**mindmap 恒开放**：拖到左半即建首个左列主题，onDrop 内按 target.side setNodeSide 持久化；logic 向右结构恒右、行为不变；org down 分支不经此门控）；缺省回退几何口径，纯函数旧口径与布局金样零变化 | ✅ 完成 | engine drag.test 4 新用例（57/57：根左半命中/空白左半/纯函数 classify/纯函数 resolveDropSlot）；真实指针拖拽无 e2e（沿 m1 登记口径），手感待手动核验 |
| — | 插入菜单删除 + 再点开属性面板 + 节点任务视觉对齐 mindgrid（需求方 2026-10-10 六问裁定，spec `docs/superpowers/specs/2026-10-10-node-props-and-task-visual-design.md`）：① 工具栏「插入」菜单连 5 条目全删（链接/图片走格式面板既有入口；**评论经裁定 6 桌面补装 comment-toggle 按钮**——实现中发现该钮原仅移动端装配；MarkerPanel 改 fixed 视口锚定+下缘钳制，入口=TaskPanel「在标记面板中编辑」）；② **再点已选中节点开 TaskPanel**（mindgrid 同款：只开不 toggle、多选先收敛单选不当场开、点其他节点不收跟随选中），右键「任务设置」/TaskQuickCard/`,` 快捷键全删；③ **格式/任务面板改判外点即关**（10-09「点空白不关闭」半项作废）；④ 节点任务视觉对齐 mindgrid（仅非简洁模式、仅任务节点显示 footer——裁定 5）：footer 行左=负责人文字名（ownerNames 渲染期派生，useTaskMembers 成员目录映射，多人 +N；无负责人且 depth≥2 橙字「未分配」）、右=百分比（逾期红），预期日期移盒右上角外侧悬浮 chip（不占盒宽高）；负责人色点/行内日期徽标退役；简洁模式不动、无任务节点布局金样 diff 为空。**当日预览反馈追加：TaskPanel 标题改可编辑输入框（键入即写 setText）、描述改键入即写（原失焦提交退役），两者实时同步画布节点（撤销栈 500ms 合并打字突发）** | ✅ 完成 | engine 401/401（render.test 负责人文字/未分配/日期 chip 重写 + measure/layout 槽位断言同步）；web e2e 165+1 skipped：node-props-panel 3 用例（再点开面板/实时同步画布/多选收敛）+ 13 spec 重写（marker-panel/emoji/rich-content/task-table/format-painter/comments/activity/error-copy/toolbar/mobile-readonly/custom-columns/format-panel/telemetry）；server e2e 190/190 |
| — | 成员面板邀请改造（需求方 2026-10-11 预览反馈裁定：① 勾选站内用户一键拉取=直接成为 editor 协作者，无需对方接受；② 粘贴框保留为折叠次要入口「邀请站外联系人」）：server 新增 GET /files/:id/invitable-users（owner-only 404 口径；排除 owner/既有协作者；q 模糊搜索昵称/手机号/邮箱；分页 size≤50）+ POST /files/:id/collaborators（幂等，重拉/无效 id 计 skipped；uk_fc_file_user 并发归并）；MemberPanel 邀请区重做为 picker（搜索 300ms 防抖/分页/跨页勾选/已选计数/一键拉取，拉取后目录自动重取）；**账号清理需求方裁定不做**（2026-10-11：账号太多问题不清理） | ✅ 完成 | server e2e files 2 新用例（目录排除/搜索/分页/非 owner 404；拉取幂等/角色 editor/404/400）→ 192/192；web e2e member-invite 新用例 4（搜索→勾选→拉取→目录排除）+ 用例 1/3 与 error-copy ⑨ 适配折叠入口 → 全量 167+1 skipped |
| — | 预览反馈两条（2026-10-11）：① **远端协作者名字被节点盖住修复**——z 序根因（renderScene 后建节点 g 追加在 gm-cursors 层之后压住标签）：cursors.setCursors 每次调用把层 re-append 到 nodesLayer 末位；标签同时加用户色胶囊衬底（白字，密集堆叠与上方兄弟交叠也可读，宽=免测量估算）；② **简洁模式不展示百分比**（需求方裁定）：gm-task-progress-inline 内联进度整体退役（render 元素 + measure 盒宽槽位预留同删），紧凑盒 = 纯标题 + 标记。**当日追加修复（预览复验）**：名字胶囊改锚定选中节点**右上角**（右缘贴盒右缘、悬顶上方 18px），并根治「偏离特别远」——旧 LABEL_MIN_Y 钳制假设场景 y≥0，负 y 节点（根上半树）标签被错钳到 18，场景坐标本可负，钳制整体删除。**二次调整（同日复验「再靠近一些+左列贴左」）：间距 18→6px（避开右上角日期 chip 碰撞区），左列节点镜像贴左上角（各内收 6px）** | ✅ 完成 | engine cursors.test +1 z 序 +1 左列镜像用例（14/14：胶囊几何/角锚定/无钳制断言重写）+ render.test compact 2 用例改写 + measure.test 紧凑盒宽断言更新 → 402/402；web e2e compact-mode 断言改写 + collab 双上下文用例回归 → 全量 167+1 skipped；Orca 浏览器实测：label transform 与选中节点右上角逐像素对齐 |

| — | 任务面板「优先级 / 标记」区块内嵌化 + 进度徽章↔百分比全量联动（需求方 2026-10-10 预览反馈三问裁定：内嵌任务面板/MarkerPanel 整体退役/全量联动）：① 区块重做——优先级 9 枚+进度 9 枚平铺常显可直接点，其余六组（心情/数字/箭头/旗帜/其他/表情）折叠行（点组名开合、已选计数回显），「在标记面板中编辑」按钮与 MarkerPanel 弹层组件/CSS/e2e 整体删除（MarkerChip 提取独立模块，画布迷你选盘不动）；② 进度全量联动（core 单点双向）——`PROGRESS_STAGE_PCT`（1/8 档 round(k×12.5)，与 progressStageOf 互逆）单源换算，`setNodeTask` 凡写 progress（含状态联动 done→100/回退→0）同事务回写 `icons.progress` 档位徽章，`setIcon` 对 progress 组反向同步 `task.progress`（null=清除进度：徽章+进度键一并移除）；同值守卫看两边（徽章+百分比均同才零事务）；repair 装载通道：旧 M6 环收敛随徽章创建 task.progress（已有任务进度时以任务为准收敛徽章）；③ TaskPanel 进度行 radio（点档位经 setIcon 反向同步；当前档再点幂等；新节点点「未开始」显式落徽章），父节点进度行禁用（Σ 只读，与 ProgressField 一致） | ✅ 完成 | core 单测 281（联动 6 新用例+repair 1）+ engine 401 + web e2e 166+1 skipped：task-panel-markers 新套件 7 用例（结构/折叠组写入/进度联动三方同步/父级禁用/回显独立/空态）+ emoji/rich-content/format-painter/task-table helper 内嵌化改写；server e2e 190/190 |

| — | 顶栏右缘重组——成员入口 + 本人头像个人中心（需求方 2026-10-11 预览反馈：成员面板改从头像左侧新入口接入）：① 顶栏最右改为 [成员钮 members-btn][本人头像 avatar-me]——成员钮=成员面板**唯一入口**（MembersIcon+在线数角标，testid/data-popover-toggle 自协作组迁移，既有用例零改动），本人头像（昵称首字符+colorForUser 个人色）点开**个人中心下拉**（昵称+手机号 GET /users/me、返回工作台、退出登录——复用工作台 POST /auth/logout+clearToken 范式；Esc/外点关，接入统一外点 effect）；② 协作者头像栏（M6 Task 9，≤5 chips+溢出位+离线灰+会话缓存 avatarSeen）**整体退役**（在线名单以成员面板为准；membersFocus 定位管线保留暂无触发入口）；③ 工具栏协作组旧 members-btn 删除（**M6「在线成员头像栏增强」被本裁定取代**）；avatars.e2e 重写为 member-center.e2e（角标在线数/个人中心/双上下文/多人）；toolbar 组序断言同步（版本历史组不再含成员钮） | ✅ 完成 | web e2e 168+1 skipped：member-center 新套件 4 用例 + toolbar 组序/清单 + mobile-readonly 增补 avatar-me；server e2e 192/192（复跑：首跑 MySQL teardown 瞬断 flake，与本改动无关） |

> **M7 合并轨与并行企微对标轨的关系**：`docs/superpowers/specs/2026-09-28-wecom-interaction-parity-design.md`（待评审）与本轨在标记分组/暗色上已被 2026-09-28 裁定更新，其余项（框选/拖动排序/⊕/格式抽屉/外框）不冲突、待并轨排期，见合并轨 spec §二。

**当前门禁基线**（2026-10-11 成员面板拉取站内用户交付后，**本机 Node 已切 22.22.2+**——jsdom 30 需 ≥22.22，Node 20 下 engine 单测无法收集，xmind-io undici unhandled error 随切换消失）：lint/typecheck 0；engine 401/401、web/shared/server/xmind-io 单测全过（core bench 本轮通过）；server e2e 192/192；web e2e 167 passed + 1 skipped（PERF 门）。唯一存量：core bench「1 万次混合操作」3s 阈值超时（机器负载敏感，stash 基线验证非代码回归）。
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
