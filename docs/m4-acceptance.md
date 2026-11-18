# M4 验收清单（PRD 导入导出与版本 FR-IO-001/002/003/004(XMind)/005、FR-VER-001/004 ＋ M2 准入台账 §7.10/7.11 ＋ M3b 缺口清偿小包）

核验日期：2026-09-26。对照《Gmind_在线协作脑图软件_产品需求文档.md》第 4 章需求编号逐条列示；「结果」列为当日实测输出与本仓源码核对后如实填写（本会话逐条执行/核对——全部 e2e 用例名与行号、实现位置行号均当日 grep 源码核实，非转抄历史报告）。

验收环境：本机 dev（NestJS tsx `PORT=3001` ＋ vite `WEB_PORT=5174`，API_ORIGIN=http://localhost:3001）。开发环境验证码固定 `123456`。全量回归（单测＋服务端 E2E＋浏览器 E2E）全程共用该 dev 服务器（进程未重启）。

结果标记约定（同 M1/M2/M3a/M3b）：**通过**＝有当日通过的自动化用例（E2E/单测，注明出处）；**通过（单测/e2e）＋待手动核验**＝自动化已覆盖同链路、体验/视觉/跨机网络层/真实墙钟须人工确认；**部分达成**＝已实现子项有通过用例、明确列出未实现缺口；不虚构任何「通过」。

里程碑边界（M4 计划 Global Constraints「本计划不做」，防验收口径漂移）：PDF/SVG 导出（二期）、FreeMind/Markdown/OPML/TXT 导入（二期）、FR-VER-002 手动版本（三期）、FR-VER-003 版本对比（二期）、导入图片对象提取（.xmind 内嵌图按降级计数，FR-IO-002 口径）。FR-IO-004 的 Markdown/FreeMind 导出（三期）、Word 导出 FR-IO-006（三期）同样不在 M4 范围。

## 一、M2 准入台账 §7.10/7.11 收口证明（docs/m2-entry-checklist.md 条目 10/11，M4 前置必须）

| 项 | 台账要求（原文语义） | 实现位置 | 守卫测试（当日通过） | 状态 |
| --- | --- | --- | --- | --- |
| 7.10 已注册用户被邀请是死路 | 回填仅在新用户创建路径触发（`if (!user)` 门控）→ 对已注册邮箱/手机号邀请永久悬挂。裁定＝扩展现有回填：已移出 `if (!user)` 门控，新旧用户每次登录尽力触发（幂等＝pending 过滤 + uk_invite，失败隔离同邮件旁路）。验收＝已注册受邀者完成授权的 e2e | `apps/server/src/auth/auth.service.ts:31-37`（裁定注释 :31-32；:35 `await this.invites.acceptPendingForNewUser(user)` 位于 :23 `if (!user)` 门控**之外**、每次登录执行；:36-37 catch 隔离不炸登录）；`apps/server/src/share/invite.service.ts:104` acceptPendingForNewUser（:111 事务原子；:127 isDuplicateKeyError 并发败者幂等 no-op） | `apps/server/test/share.e2e-spec.ts:512`「准入 7.10：已注册用户被邀请，登录后自动获得授权（不再永久悬挂）」——对已注册邮箱发邀请 → 首次登录仍 pending → 二次登录（:498 注释「回填对已注册用户同样生效，每次登录尽力触发」）→ accepted ＋ collaborator 行；配套 ：457「回填中途失败与登录隔离：登录仍 200、事务回滚（行保持 pending、无协作者行）；**二次登录按 7.10 天然重试成功**」（故障注入 pinning） | **已收口**（台账条目 10 已由 M4 T1 回写「已收口（M4 T1，commit d187f39）」注记，本日复核原文与实现一致） |
| 7.11 回收站提醒双重邮件 | cleanup remind() 即时发邮件且所写通知行不带 emailed_at → 15 分钟后 DigestService 再发一封（MailHog 接通后每次提醒=两封）。裁定＝remind() 落行即置 emailed_at（DigestService 扫描跳过本行；不取「digest 跳过 type='system'」——不排除将来 system 行入摘要）。验收＝即时邮件不触发 15 分钟摘要重发的 e2e | `apps/server/src/jobs/cleanup.service.ts:110-112`（注释「准入 7.11：即时邮件已发（或无邮箱天然不可达），行级 emailed_at 置位使 DigestService 扫描跳过本行」＋ :112 `notification.emailedAt = new Date()`，早于 :113 save） | `apps/server/test/trash.e2e-spec.ts:344`「准入 7.11：回收站提醒的即时邮件不触发 15 分钟摘要重发（emailed_at 落行）」——runCleanup(+27d) 触发提醒后，该通知行 emailed_at 非 NULL；再跑 runDigest 不产生第二封摘要邮件 | **已收口**（台账条目 11 已由 M4 T1 回写注记，本日复核原文与实现一致） |

## 二、FR-IO-001 文件导入（XMind，P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-001 | 「用户可以在文件列表页或编辑器内通过"导入"入口上传格式文件，一期支持 XMind（.xmind）格式；……单文件大小上限 20MB。导入成功后新建脑图文件；解析失败时系统应提示具体原因（格式不受支持/文件损坏/超出大小上限）」。验收：「当用户上传 25MB 的 .xmind 文件时，系统应拒绝并提示大小超限；上传合法 .xmind 后应生成层级结构一致的脑图」 | 浏览器（`apps/web/e2e/import-export.e2e.spec.ts`）：:43「工作台导入 .xmind：新文件出现且层级/备注正确渲染」（程序化 zip 夹具 buildXmind 构造：root＋两级子树＋分支A备注 → 列表新行 → 编辑器 root/分支A/孙1 渲染 ＋ gm-note-badge 恰 1）；:63「导入 25MB 超限：提示大小上限；损坏文件：提示已损坏」（21MB buffer → toast「文件大小超过 20MB 上限」；1KB 乱字节 → 「文件已损坏，无法解析」且列表仍 3 行）。web 单测（`apps/web/src/editor/xmind-import.test.ts`）：:16「正常导入：先序组装 doc（层级/备注），title=根主题，state 可回读，degraded 透传」；:45「超 20MB：拒绝且不解析」；:51「合法 zip 但无 content.*：UNSUPPORTED_FORMAT 归因『无法识别的文件格式（仅支持 .xmind）』」；:58「乱字节：归因『文件已损坏』」；:40「根主题缺标题：title 回落文件名去 .xmind 后缀」。服务端（`apps/server/test/file-content.e2e-spec.ts` POST /api/files 携带 docState 组，:466 起）：:501「导入：携带 docState 建文件——nodeCount 服务端重算、层级/备注落库」（夹带 nodeCount=999 被无视、docFromState 回读层级/备注一致）；:540「导入：损坏 docState → 400『文件已损坏』」。实现：`apps/web/src/editor/xmind-import.ts:51`（MAX_IMPORT_BYTES=20MB :14，解析前预检 :51，错误归因 :53-60）；`apps/web/src/pages/WorkspacePage.tsx:435`（import-button）/ :443（import-input）/ :251-258（importXmindFile → 新行回刷＋失败/降级 toast）；`apps/server/src/files/files.service.ts:111-119`（docFromState 抛错 → 400「文件已损坏」:113；nodeCount 一律 countAliveReachable 重算 :119，不信任客户端） | 「提示具体原因」的三类文案中「格式不受支持」仅单测覆盖（:51），浏览器 e2e 只造了大小超限与损坏两类——如有需要可用手造伪 zip 补一次目视。**PRD「25MB」字面用 21MB buffer 等价**：上限 20MB（>20MB 即拒绝域），21MB 与 25MB 同处拒绝域、走同一 `file.size > MAX_IMPORT_BYTES` 分支，字面 25MB 专属值未单独造件——等价边界如实注明 | **通过（web e2e 2 例 ：43/:63 ＋ web 单测 5 例 ＋ server e2e 2 例 ：501/:540）**。备注如实：①PRD「文件列表页**或**编辑器内」——一期为工作台（文件列表页）单入口，编辑器内无导入入口（「或」字面由单入口满足，双入口属后续增强，口径登记非隐藏项）；②e2e 夹具为程序化 zip（buildXmind 产物），**真实 XMind 客户端导出的 .xmind 文件导入属人工项**（见手动清单 5） |

## 三、FR-IO-002 导入降级与提示（P1）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-002 | 「当源文件包含 Gmind 不支持的元素（如特定主题样式、附件类型）时，系统应按对照表规则降级处理，导入完成后以通知形式告知降级项数量与类型」。验收：「当导入含自定义样式的 XMind 文件后，系统应弹出『已降级处理 2 项样式』类提示，且节点文本与层级完整」 | 解析层计数（`packages/xmind-io/src/parse.test.ts` 18 例中降级专项 7 例）：:60「降级计数：markers/labels/realHTML 备注/漂浮主题」；:89「降级计数：图片/附件/备注内图片 → media，概要/额外 sheet → structure」；:121「style 属性与 sheet theme 计入 style 降级」；:176/:189/:206（XMind 8 xml 路径：detached/markers·labels·图片·概要/额外 sheet 对应计数）；:148「rootTopic 无 title……无 markers 等则零降级」。文案构造（`apps/web/src/editor/xmind-import.test.ts`）：:65「全 kind：已降级处理 N 项（样式 x/媒体 y/结构 z）」；:75「部分 kind：零计数 kind 不出现在括号内，前缀保持『已降级处理 N 项』」；:85「空降级：仅前缀」。toast 接线：`apps/web/src/pages/WorkspacePage.tsx:258`（`degraded.length > 0 → showToast(degradedSummary(degraded))`）；`apps/web/src/editor/xmind-import.ts:25` degradedSummary | **降级 toast 的浏览器层端到端呈现无自动化用例**（import-export.e2e 夹具为纯净树 degraded=[]，:134 断言空数组）——计数（parse.test）与文案（degradedSummary 单测）均当日通过、接线代码在位，但「含降级项的文件导入 → toast 弹出」的组装链路与视觉待人工：可用含 markers/图片的 .xmind 导入目视（可与手动清单 5 真实文件项合并执行） | **通过（单测：解析计数 7 例 ＋ 文案 3 例）＋待手动核验（toast 组装与视觉）**。备注如实：①「节点文本与层级完整」由 FR-IO-001 的 ：43/:501 层级断言覆盖；②T3 deferred 登记：**detached（漂浮）子树整体丢弃，其内部样式/媒体不计数**（降级计数以「存留树上的降级」为口径，代码注释声明）；③导入图片不入库——.xmind 内嵌图按 media 降级计数，不提取入库（FR-IO-002 口径，计划 Global Constraints 明确） |

## 四、FR-IO-003 图片导出（P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-003 | 「用户可以导出 PNG/JPG，可选 1x/2x/3x 分辨率，PNG 支持透明背景开关。导出范围默认为全部节点，系统应自动展开当前折叠的节点后再渲染导出」。验收：「当脑图存在折叠节点时，导出的 PNG 应包含全部子节点；选择 3x 与透明背景时，输出图片应为透明底且分辨率符合 3 倍渲染」 | 浏览器（`apps/web/e2e/import-export.e2e.spec.ts`）：:159「导出 PNG 3x：下载产物 IHDR 尺寸可被 3 整除；无折叠不弹确认」（下载名『本周计划.png』；PNG 魔数＋IHDR 宽高 %3==0——3x 输出=1x 布局三倍的直接证据；**export-transparent 默认勾选断言** :167；无折叠 dialogCount=0）；:185「折叠提示：检测到 1 处折叠 → 确认后导出（画布折叠态不变）」（Ctrl+/ 折叠 → confirm 文案含「1 处折叠」→ 导出 → 徽标仍在/孙节点仍隐藏——**折叠场景导出产物含全部子节点**由 cloneExpanded 快照克隆保证）。引擎单测（`packages/engine/src/export.test.ts`）：:34「exportSceneSvg：序列化含根文本、xmlns、正尺寸；不污染既有场景容器」；:53「org 结构与未知 themeId 兜底同样可序列化」。实现：`packages/engine/src/export.ts:41` exportSceneSvg（detached 容器离屏渲染＋XMLSerializer 序列化＋viewBox 平移取整）；`apps/web/src/editor/image-export.ts:35` exportImage（:45 cloneExpanded 折叠在克隆上展开、画布不动；:51-53 JPG 恒白底/PNG 透明开关；:55-57 toBlob mime png/jpeg）；`apps/web/src/pages/EditorPage.tsx:343` runImageExport（:346-347 countCollapsedWithChildren>0 → confirm「检测到 N 处折叠，将自动展开后导出」）；导出菜单 ：1373 export-menu，:1398 export-transparent（勾选框），:1406~:1422 PNG/JPG×1x/2x/3x 六项（runImageExport 接线 :1409/:1419） | **JPG 导出零自动化用例**（mime、下载成功、白底均无 e2e/单测——e2e 种子无图节点，inlineImages/rasterize/JPG 白底链路无自动化覆盖，T9 deferred 如实登记）；透明底像素级（背景 alpha=0）与白底目视、1x/2x/3x 倍率清晰度目视见手动清单 1 | **部分达成**：PNG 主链路（3x 分辨率断言、折叠提示与全子节点导出、透明开关存在与默认态、文件名）全通过（web e2e 2 例＋engine 单测 2 例）；**JPG 仅有实现与 UI 项、无自动化**（菜单项 export-jpg-1x~3x 在位，行为同函数 exportImage format='jpg' 分支）——JPG 白底/透明底视觉、倍率清晰度全部待手动。备注如实：①T9 裁定——透明勾选静态常显标「透明背景（PNG）」＋JPG 项标「白底」（菜单无预选态，「仅 PNG 显示」不可字面实现，行为等价 opaque=format==='jpg'\|\|!transparent）；②画布像素区域无上限（3x 极端长宽比受 Safari canvas 限制，计划内已知限制） |

## 五、FR-IO-004 文档与数据格式导出（XMind 一期，P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-004（XMind 部分） | 「XMind 导出一期支持；PDF/SVG 导出二期支持；Markdown/FreeMind 导出三期支持。层级类导出（Markdown/mm/xmind）同样先自动展开折叠节点」。验收：「当导出含折叠节点的脑图为 XMind 时，导出内容应包含全部子节点且层级完整」 | 浏览器（`apps/web/e2e/import-export.e2e.spec.ts`）：:115「导出 XMind 并往返导入：层级/文本/备注一致」（export-menu → export-xmind 下载 → 下载名『本周计划.xmind』:124 → **parseXmind 直接解析下载产物**断言 root/周一/周三/周五层级与周一备注『评审要点』/子树『周会对齐』/degraded=[] :129-134 → 产物回灌工作台导入 → 新文件出现且渲染一致 :139-152——导出↔导入双向闭环）。包单测（`packages/xmind-io`）：roundtrip.test.ts:9「多级/备注/空子级/无备注节点深度相等」/ :24「构建产物可被 unzipSync 读回 content.json」；build.test.ts:8/:33（zip 结构与无冗余字段）。实现：`apps/web/src/editor/xmind-export.ts:37` exportXmind（:14-36 docToXmindTree 先序遍历 childIds 存活树，墓碑/悬空不入树）；`packages/xmind-io/src/build.ts:6` buildXmind（2020+ content.json zip）；`apps/web/src/pages/EditorPage.tsx:1379` export-xmind 菜单项（onClick 内 try/catch 失败 toast） | 折叠节点的 XMind 导出**无独立 e2e 步骤**（:115 用例未先折叠）——「自动展开折叠」为数据层天然满足：折叠仅视图态标记，childIds 存活可达树不含折叠概念（`apps/web/src/editor/xmind-export.ts:4-5` 注释原文：「折叠只是视图态（collapsed 标记不影响数据层子树完整性）——FR-IO-004 的『层级类导出先自动展开折叠』在本架构下自动满足，无需展开步骤，导出恒为完整层级」）；同一原理在图片导出路径有自动化钉住（:185 cloneExpanded）。如需双重保险可手动折叠后导出 XMind 解包目视 | **通过（web e2e 往返 1 例 ＋ xmind-io 单测 4 例）**。备注如实：①「自动展开折叠」非显式实现步骤而是数据层天然性质，无 XMind 侧折叠导出的专属自动化断言——注释引用如上，登记为口径说明；②PDF/SVG（二期）、Markdown/FreeMind（三期）按里程碑边界不做，菜单无死按钮 |

## 六、FR-IO-005 导出文件命名与限制（P1）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-IO-005 | 「导出文件名默认为『脑图文件名.扩展名』；单次导出的节点数上限为 500（与一期统一节点上限一致），超出时提示『文件过大，请拆分后导出』」。验收：「当脑图含 501 个节点发起 PNG 导出时，系统应拒绝并给出拆分提示」 | 文件名：`apps/web/e2e/import-export.e2e.spec.ts` :124（`本周计划.xmind`）/ :173（`本周计划.png`）/ :201（折叠场景 `本周计划.png`）——文件名=编辑器标题（getMeta(doc).title 同源）＋扩展名，XMind/PNG 双格式断言。>500 防御：`apps/web/src/editor/image-export.ts:43-46`（`countAliveReachable(doc) > MAX_DOC_NODES → throw new Error('文件过大，请拆分后导出')`，注释「FR-IO-005 防御：服务端配额与协同 WS 双闸已保证 ≤500，此处为最后一道客户端闸门」）；文案由 EditorPage showToast 呈现。导入侧同限有 e2e：`apps/server/test/file-content.e2e-spec.ts:526`「导入：可达活跃节点 501（+root）→ 400，文案含『节点数』」 | 导出侧 501 拒绝分支**无独立自动化用例**（见备注）——如需目视可用 dev-only 手段造超限文档后点 PNG 导出看 toast | **通过（文件名 e2e 3 例 ＋ 导入侧 501 e2e 1 例）**；导出侧 >500 拒绝为**防御分支，无独立 e2e——如实注明**：一期配额闸（创建/导入/saveDocState/countAliveReachable 重算多处）保证常态文档 ≤500，该分支仅在配额被绕过（手工 doc-state/未来新入口）时触发，属计划明示的防御性闸门而非常态路径 |

## 七、FR-VER-001 自动历史快照（P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-VER-001 | 「系统应在文件内容发生变更后每 3 分钟自动生成一个历史快照；若 3 分钟内无变更则不生成。快照保留最近 90 天，版本时间轴展示快照时间与触发编辑的用户」。验收：「当连续编辑 10 分钟后打开版本面板，应至少存在 3 个自动快照且时间间隔约为 3 分钟；无变更时段不产生新快照」 | 服务端（`apps/server/test/versions.e2e-spec.ts`，注入时钟直调 public 快照入口）：:139「快照：编辑落库后过 3 分钟窗口落 auto 版本行（注入时钟直调）」（落库≠快照：窗口内 0 行；`snapshotIfDue(+4min)` → auto 行 1 条，nodeCount=可达活跃口径、createdBy=编辑人、restoredFrom=null、state 非空）；:160「快照：无变更不落行；间隔内不重复落」（dirty=false 时钟 +10min 不落；+2min 间隔门拦截——「无变更时段不产生新快照」与「约 3 分钟间隔」的直接证据）；:175「快照：卸载时脏文档落行（snapshotIfDirty）」（最后连接断开 → beforeUnloadDocument 落行恰 1 条；卸载后两入口均不再落——无泄漏无重复）；:199「清理：90 天前版本行删除、保留期内保留」（-91d 删/-89d 留，runCleanup 返回 versionsPurged=1）。实现：`apps/server/src/collab/collab.service.ts:68`（SNAPSHOT_INTERVAL_MS=3×60×1000）/ :72（snapMeta per-doc lastAutoAt+dirty）/ :264（编辑置脏）/ :284-313（storeDocument 落库后 snapshotIfDue）/ :89-95（beforeUnloadDocument → snapshotIfDirty 卸载兜底）/ :330 snapshotIfDue（:333 脏∧过窗双门）；`apps/server/src/jobs/cleanup.service.ts:16`（VERSION_RETENTION_DAYS=90）/ :68-73（90 天硬删）。时间轴展示（时间＋触发编辑用户）由 web e2e `apps/web/e2e/versions.e2e.spec.ts:70`（「自动」徽标）与 VersionPanel.tsx:278-288（时间/徽标/createdByName/节点数）覆盖 | 「连续编辑 10 分钟 ≥3 快照」的**真实 3 分钟墙钟节奏以注入时钟等价验证**（真实时长待手动）：e2e 不等待真实 3 分钟，而是直调 `snapshotIfDue(fileId, now+Δ)` 验证「脏∧过窗才落、窗口内不落、无变更不落」的门控语义——节奏正确性由语义组合保证，真实墙钟下的节奏体感（编辑 10 分钟 → 面板 ≥3 条且间隔 ≈3 分钟）见手动清单 6 补一条挂机观察 | **通过（注入时钟 e2e 4 例 ：139/:160/:175/:199）＋待手动核验（真实墙钟节奏）**。备注如实：①T6 deferred 登记——脏标志 TOCTOU：快照 await 期间到达的编辑其 dirty 在完成时被清（粒度损失非数据损失，该编辑并入下一窗口）；②T6 裁定——快照写失败在 storeDocument/beforeUnloadDocument 内吞错仅 log（v4 对 store 抛错整链重放、unload 抛错弃卸载滞留内存，吞错范围仅限快照、persist 失败仍上抛） |

## 八、FR-VER-004 一键恢复（P0）

| 编号 | 验收项（PRD 原文） | E2E 用例 / 自动化验证 | 手动核验步骤（自动化未覆盖部分） | 结果 |
| --- | --- | --- | --- | --- |
| FR-VER-004 | 「文件所有者与编辑者可以将文件恢复至任一历史版本。恢复不覆盖当前内容，而是将当前状态自动保存为一个新版本后再回滚，保证恢复操作本身可撤销」。验收：「当用户恢复至 2 小时前的版本后，画布内容应与该版本一致，且版本时间轴顶部新增一条『恢复自某版本』的记录」 | 服务端（`apps/server/test/versions.e2e-spec.ts` 恢复组，:234 起）：:360「恢复：live 文档——REST 恢复后 WS 在线端收到回滚内容（恢复广播）」（恢复 200 返回 preRestoreVersionId → 在线端 doc 轮询回滚至『早期文本』；**pre_restore 行先于恢复落行**：type='pre_restore'、restoredFrom=来源版本 id、createdBy=恢复人、state=恢复前『漂移文本』；files.docState 随防抖落库为恢复后内容；version_restore 事件落 events 表）；:395「恢复：无人在线——走落库路径，GET docState 与快照一致」（**快照中被删节点以新 ULID 重建，故按文本而非旧 id 断言**）；:423「恢复权限：非 owner/editor 404；未登录 401；版本 id 属其他文件 404」（editor 可恢复、viewer/路人 404 不泄露、跨文件版本 404）；:462「列表/取态：canAccess 可读，含 createdByName」；:509「dev 快照路由（Task 8）：live 脏文档 POST 即落 auto 行」（NODE_ENV!=='production' 才生效）；:538「events 端点：POST /api/events 登录 204 且落库；未登录 401」。浏览器（`apps/web/e2e/versions.e2e.spec.ts:50`「版本面板：时间轴/只读预览/一键恢复」）：改周一→计划B → dev 快照 v1 → 改计划C → v2 → 面板两条时间轴（「自动」徽标）→ 只读预览第二条（本周计划＋计划B 在、计划C 不在）→ 恢复（confirm 文案含『当前内容将自动存档为「恢复前版本」』＋条目同款时间）→ toast「已恢复」→ **画布经 y-sync 恢复广播回滚（计划B 回归、计划C 消失、页面不 reload**——`__gmindNoReload` 存活断言）→ 列表刷新顶部出现「恢复前存档」条目。实现：`packages/gmind-core/src/restore.ts:67` restoreFromSnapshot（:22 ORIGIN_RESTORE；:134 withTransaction 单事务；:149 缺失节点 addChild 新 ULID 重建）；`apps/server/src/versions/versions.service.ts:92` restore（:104 先写 pre_restore 再恢复；:107/:127 withLiveDocument live 广播/离线落库双路径；:141 version_restore 埋点尽力而为）；versions.controller.ts:20/:25/:34/:52（REST 层级隶属文件资源）；`apps/server/src/database/migrations/20260926000000-versions-restored-from.ts:12`（restored_from char(26) NULL）；VersionPanel.tsx:234 restore / :256 面板 / :281-283 **restoredFrom 非空时徽标 title=「恢复自某版本」**（PRD 字面文案由 title 属性承载） | 「恢复至 2 小时前」的字面时长未造件（快照即时造数，恢复语义与时长无关）；**双机恢复广播体验**（A 恢复、B 在第二台设备实时看到画布回滚）待人工——web e2e :50 已在单机覆盖 y-sync 广播回滚链路，跨机网络层见手动清单 2 | **通过（server 6 例 ：360~:538 ＋ web 1 例）＋待手动核验（双机广播体验）**。备注如实：①PRD「时间轴顶部新增一条『恢复自某版本』的记录」以 **pre_restore 类型条目（徽标「恢复前存档」＋title「恢复自某版本」＋restored_from 溯源列）** 承载——语义等价（恢复前内容自动存档、恢复可撤销），徽标字面为「恢复前存档」，口径登记非隐藏项；②T7 裁定——恢复双跑幂等=内容恒收敛非 id 稳定（被删节点以新 ULID 重建）；③**恢复×评论产品裁定登记**：恢复重建的节点为新 ULID、不回链旧评论——旧节点上的评论线程按 M3b 既有语义呈「原节点已删除」并保留全文（CommentPanel nodeDeleted 徽标），恢复不复活评论锚点，产品已知晓该行为；④T7 deferred——events payload 无尺寸上界（TEXT 64KB 界限内可 500，建议几 KB cap）；零 diff 恢复仍写 pre_restore 行（计划字面时序） |

## 九、M3b 缺口清偿小包四项落地证明（f084707）

| 项 | 要求 | 实现位置 | 守卫测试（当日通过） | 状态 |
| --- | --- | --- | --- | --- |
| 摘要邮件含跳转链接 | FR-CMT-006 验收「应收到一封含跳转链接的邮件」——M3b 登记正文仅条目列表无链接 | `apps/server/src/jobs/digest.service.ts:90`（条目行附 `${WEB_ORIGIN}/edit/:fileId` 深链）/ :101（正文尾部统一「打开 Gmind」入口行）；`apps/server/src/config/env.ts:26` WEB_ORIGIN 缺省跟随本机 web dev 端口 | `notify.e2e-spec.ts:435`「清偿：摘要邮件条目含跳转链接与『打开 Gmind』行」——body 断言 `- [提及] 阿乙：这条要能点回文档 — http://localhost:5174/edit/{fileId}` ＋ `打开 Gmind：http://localhost:5174` | **已落地**（真实送达仍待 MailHog 环境，同 M3b 口径） |
| 加入通知（join/回填 → owner） | FR-CMT-006「权限变更」事件通知——M3b 登记无通知生产者 | `apps/server/src/share/invite.service.ts:145` notifyOwnersJoined（真实新增协作者行才通知——重复 join/并发败者不重发，T10 裁定收敛为单条件） | `notify.e2e-spec.ts:296`「清偿：join 后 owner 收 permission 通知（SSE + unread）」——路人凭 token join → owner SSE 实时推送＋unread +1；`share.e2e-spec.ts:419`「M4 清偿：邀请回填成功 → owner 收 permission 通知（payload.memberName/action=joined）」 | **已落地**（web 下拉 permission 类型显示通用「通知」标签——TYPE_LABELS 未专用化，T10 裁定范围内合规，登记见诚实登记节） |
| 通知深链 ?node= | 通知点击跳文档后无法定位到被提及/被回复的节点 | `apps/web/src/pages/WorkspacePage.tsx:143/:158`（通知 payload 携带 nodeId → `/edit/:fileId?node=:nodeId`）；`apps/web/src/pages/EditorPage.tsx:1300`（装载完成后读 ?node=<ulid>，有效则 locateNode 定位——同评论面板「选中＋展开折叠祖先」口径） | `apps/web/e2e/notify.e2e.spec.ts:110`「M4 清偿：通知点击深链 ?node= → 装载后定位对应节点并清参」（定位选中生效、URL 参数清除） | **已落地**（deferred：深链 e2e 硬依赖种子文案） |
| isDuplicateKeyError 收敛 | M3b 各域各自手写 duplicate-key 判定，口径漂移风险 | `apps/server/src/utils/duplicate-key.ts:6` isDuplicateKeyError（统一 ER_DUP_ENTRY/errno 1062 判定）；三消费方：`files.service.ts:561`（star 竞态）/ `invite.service.ts:127`（回填并发败者）/ `share.service.ts:107`（join 并发败者） | 既有守卫不回归（当日全量绿）：`files-views.e2e-spec.ts` star 竞态用例、`share.e2e-spec.ts` join/回填幂等用例、准入 7.10 故障注入 :457——三路径并发败者 no-op 语义不变 | **已落地** |

## 诚实登记——缺口与延期项台账（全部为「未实现/待环境/待手动」，如实列出防口径漂移）

以下各条来自 M4 各任务评审台账（progress.md）与上文逐 FR 表，汇总于此便于终审复核：

1. **导入图片不入库**：.xmind 内嵌图按 media 降级计数、不提取入库（FR-IO-002 口径，计划 Global Constraints 明确「导入图片对象提取」不做）。
2. **摘要邮件待 MailHog 环境核验**：摘要跳转链接（:435）为 MailService 层断言，端到端送达接通 MailHog 后人工核验（M3b 既有口径延续）。
3. **FR-IO-003 JPG 白底/透明底视觉、倍率清晰度待手动**：JPG 导出零自动化用例（mime/成功/白底均无 e2e 或单测，T9 deferred「inlineImages/rasterize/JPG 白底无自动化覆盖」如实保留）。
4. **FR-VER-001 真实 3 分钟墙钟节奏以注入时钟等价验证**（真实时长待手动）：见第七节手动核验步骤。
5. **恢复×评论「原节点已删除」产品裁定**：恢复重建节点为新 ULID、不回链旧评论，旧节点评论按 M3b nodeDeleted 语义保留全文（产品知晓，见第八节备注③）。
6. **web 通知下拉 permission 类型显示通用「通知」标签**：TYPE_LABELS 服务端未动、未专用化（T10 裁定：范围内合规，登记差异）。
7. **e2e 偶发抖动（历史台账，本日未复现）**：T4 期间 server files-views 2/14、share 域 >50 用例偶发 404、web collab 离线用例各偶发一次——6 次插桩全量未复现，另行排查；**本日全量首跑全绿无重跑**。
8. **dev DB 长驻＋手动迁移漂移模式**：T8 实测发生一次（dev 库缺 T6 restored_from 迁移致 web e2e 失败），已 `migration:run` 修复；该模式会重演——dev 长驻环境跑验收前先 `pnpm --filter @gmind/server migration:run` 确认齐平（已列入手动清单 6）。
9. **events payload 无尺寸上界**（T7 deferred）：TEXT 64KB 界限内可 500，建议几 KB cap（非阻塞）。
10. 其余 minors 延期项随任务台账留档（T1 trash spec 清理假设/回填 catch 丢上下文；T3 detached 子树降级不计数；T4 walk 在 try/catch 外；T6 脏标志 TOCTOU；T8 面板关闭预览未清/恢复成功＋刷新失败误报 toast；T9 画布像素无上限/checkbox 语义；T10 回填通知未滤软删文件等）——均非验收项阻塞，终审裁量。

## 支撑输出（2026-09-26 本会话全量实测；dev 服务器 :3001/:5174 全程共用未重启）

- `pnpm lint`：exit 0，无输出。
- `pnpm typecheck`：server / web / engine / gmind-core / shared / **xmind-io** 六包全部 Done，exit 0。
- `pnpm test`（全仓单测）：**444 passed**，Test Files 34 passed，exit 0——@gmind/shared 5（1 文件）、@gmind/xmind-io **22**（3 文件：parse 18＋build 2＋roundtrip 2）、@gmind/gmind-core 160（11 文件）、@gmind/server 18（5 文件）、@gmind/engine **212**（11 文件，含 export.test 2 例 :34/:53）、@gmind/web 27（3 文件，含 **xmind-import 8 例** :16~:85）。
- `pnpm --filter @gmind/server test:e2e`：Test Files **14 passed (14)**，Tests **156 passed (156)**，15.88s，exit 0——auth 8 / files 4 / db-init 2 / users-me 2 / **file-content 19**（含 XMind 导入 3 例 :501/:526/:540）/ storage 12 / collab 6 / files-views 24 / folders 13 / **trash 10**（含准入 7.11 守卫 :344）/ **share 23**（含准入 7.10 守卫 :512＋清偿 ：419/:457）/ comments 8 / **notify 15**（含清偿 ：296/:435）/ **versions 10**（快照 4＋恢复权限列表 dev 路由 events 6）。首跑全绿。**终审修复轮后为 157/157**（versions 增列表上限用例，连续 4 次全绿，见终审修复轮节）。观察到的 stderr 噪音（不判失败）：套件收尾阶段一条 `[collab] 卸载快照失败（…）Connection is not established`——测试 app 关闭与 beforeUnloadDocument 卸载兜底的拆链竞态，属用例收尾时序噪音，断言零失败。
- `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e`：**66 passed, 1 skipped (21.5s)**，0 failed，exit 0——workspace 14 / collab 7（含准入 7.3 接线守卫）/ editor 12 / rich-content 8 / **import-export 5**（导入 2＋往返 1＋PNG 2，:43/:63/:115/:159/:185）/ m1-gaps 6 / m0-acceptance 3 / share 3 / comments 3 / **member-invite 2**（:46/:64）/ **notify 2**（:53＋清偿深链 ：110）/ **versions 1**（:50）/ perf-editor 1 skipped（须 PERF=1，同 M1~M3b 口径）。首跑全绿。**终审修复轮后为 68 passed, 1 skipped**（import-export 6 增 JPG 冒烟、versions 2 增面板重开预览回归，见终审修复轮节）。

## 终审修复轮（2026-09-26，全分支终审 With fixes → 单修复波 → 复审全 ADDRESSED）

- 全分支终审（base 266f6d0..56d5ff7，13 commits）：**0 Critical / 2 Important**，判定 With fixes——①versions 列表逐行拉取 LONGBLOB state 且无分页（生产唯一实际痛点）；②版本面板关闭后预览态残留（重开空白预览对话框）。跨任务接缝（快照×恢复脏标志、导入配额咽喉点、降级计数贯通、dev 路由生产泄漏、导出菜单行为）逐项核查通过。
- 修复波（1244ef6，单提交）：①list() 只取元数据列 + take(200) 上限（PRD 口径「最近 90 天」，分页/加载更多随 M5 面板打磨做产品裁定；单版本取态端点不变；e2e 201 行断言恰取最新 200 且响应无 state 键）；②面板 open→false 重置预览态（销毁 previewDoc，docstring 改为如实描述；e2e 开预览→关面板→重开→再预览断言内容渲染）；③JPG 导出冒烟 e2e（FF D8 FF 魔数＋尺寸＋.jpg 文件名）。修复后 server e2e 157/157 连续 4 次全绿、web e2e 68 passed/1 skipped。
- 范围化复审：三项发现 **全部 ADDRESSED**，修复 diff 无新破损。挂账至 M5（复审产出）：预览遮罩（z-1300）盖住面板关闭钮——预览开着时指针无法关面板（交互是否调整留产品决策）；versions take(200) 无加载更多（超限历史仅可按 id 取态）；e2e 套件在机器高负载下有整体超时敏感（一次 17 例超时、时长 14s→494s 摆动，隔离环境项）。
- 终审裁量其余 7 项缓期 minor 为 PARKED（快照脏标志 TOCTOU、events payload 上界、零 diff 恢复仍写 pre_restore、导入 copy 路径收紧、导出树无环防护、回填通知软删过滤、邀请计数含 skipped 等），随 M5 触及对应文件时顺带清偿。

## M4 验收结论与手动核验清单（如实记录）

- 逐项结论：**FR-IO-001、FR-IO-004、FR-IO-005 三项通过**（FR-IO-001 带 25MB→21MB 等价边界与单入口口径注明；FR-IO-004 的折叠展开为数据层天然满足＋注释引用；FR-IO-005 导出侧为防御分支无独立 e2e——均如实注明）；**FR-IO-002 通过（单测）＋待手动核验**（降级 toast 组装与视觉）；**FR-VER-001 通过＋待手动核验**（真实墙钟节奏）；**FR-VER-004 通过＋待手动核验**（双机广播体验）；**FR-IO-003 部分达成**（PNG 主链路自动化全过；JPG 冒烟自动化已随终审修复轮补齐——魔数/尺寸/文件名，像素视觉仍待手动）。准入台账 **§7.10/7.11 全部已收口**（台账注记本日复核一致）；M3b 缺口清偿小包**四项全部落地**。FR-VER-002（三期）/FR-VER-003（二期）/PDF·SVG·FreeMind·Markdown·OPML·TXT 格式（二期/三期）/导入图片提取按里程碑边界明确不做。无一虚构「通过」，全部缺口逐条登记（见诚实登记节）。
- 全量回归当日真实执行（数字见上节）：lint/typecheck exit 0、单测 444 passed、server e2e 156/156（修复轮后 157/157）、web e2e 66 passed ＋ 1 skipped（修复轮后 68＋1），0 failed——**五个门禁全部首次连跑全绿，无重跑挑数**。
- **待手动核验清单（真实操作，累计 ≈15 分钟）**：
  1. **导出图片视觉**：编辑器导出菜单分别导出透明底 PNG（勾选默认开）、白底 JPG、1x/2x/3x 各一份——目视透明底棋盘格背景、JPG 白底、倍率清晰度递增；文件名 `<标题>.png/jpg`。web e2e（import-export.e2e.spec.ts:159/:185）已覆盖 PNG 尺寸/折叠链路，像素视觉与 JPG 全量待人工。
  2. **双机恢复广播体验**（两台设备/跨网络）：A、B 同开一文档 → B 观察画布 → A 打开版本面板对历史条目点恢复 → B 端画布**不刷新**实时回滚至快照内容；A 端面板顶部出现「恢复前存档」。web e2e（versions.e2e.spec.ts:50）已在单机覆盖同链路（y-sync 广播＋无 reload 断言），跨机网络层待人工。
  3. **版本面板预览视觉**：时间轴徽标（自动/恢复前存档）、只读预览画布渲染、恢复 confirm 文案目视。
  4. **邮件送达（MailHog 待环境）**：接通后核验三封——邀请邮件（含注册链接）、15 分钟未读摘要（**含条目深链与「打开 Gmind」行**，M4 清偿后口径）、回收站到期提醒（**单封**，7.11 已去重）。
  5. **真实 .xmind 文件导入**：用 XMind 客户端（**XMind 8 与 2020+ 各导一份**）导出含样式/图片/备注的真实文件，经工作台导入——验证双路径解析、降级 toast 弹出（可与 FR-IO-002 手动项合并）、节点文本层级完整。e2e 夹具为程序化 zip，真实文件兼容性属人工项。
  6. **dev 环境迁移齐平（流程项）**：dev 库长驻环境验收前 `pnpm --filter @gmind/server migration:run` 确认 restored_from 迁移已应用（T8 曾实测漂移一次，模式会重演）。
- 口径边界（同 M1~M3b 纪律）：以上自动化断言均为本机 dev 实测（单次全量连跑全绿，无重跑挑数）；「待手动核验」各项背后均有当日通过的自动化覆盖同链路（JPG 像素视觉除外——冒烟自动化在位，视觉待手动，已按「部分达成」如实分级），人工步骤为跨机网络/视觉/体感/环境/真实文件补充。已登记缺口（FR-IO-002 toast 组装、FR-IO-003 JPG 视觉、导入图片不入库、permission 通用标签、恢复×评论新 ULID 裁定等）均为「未实现/待环境/待手动、如实列出」，后续排期由需求方裁定。

## 十、2026-11-14 导入保真度升级补记（进度/表情/图标/图片/概要/超链接/样式全接入＋导出对称写回）

核验日期：2026-11-14。需求方立项起因：真实文件 `吾盛待办10.27.xmind` 导入后图片/表情/图标/进度全没进；探查证明进度九档与 XMind 八档设计上同构、纯映射缺失。设计与裁定记录：`docs/superpowers/specs/2026-11-14-xmind-import-fidelity-design.md`（当日拍板 4 条：①范围=导入修全＋样式映射＋导出对称；②对不上的图标丢弃＋如实计数；③降级提示改逐项点名、toast 恒弹；④**推翻两条旧裁定**——指针见下文「裁定推翻」）。功能逻辑文档（AGENTS.md §四 五栏目）：`docs/features/import-export.md`（同日新建）。里程碑边界段（本文头部）「导入图片对象提取不做」与第二/三节 FR-IO-002 行备注③、诚实登记节第 1 条的「图片不提取」口径**自本日起作废**，以本补记为准（原文保留不覆写）。

### 自动化用例背书（用例名+行号为 2026-11-14 当日 grep，非转抄）

- **@gmind/xmind-io 单测 69/69 全绿**（4 文件）：
  - `src/markers.test.ts` 17 例（13 个 it 块，其一是 spec §3.1 逐行循环生成 5 例）：导入表逐行（`:57` describe「markersToIcons v2」循环——进度九档/smiley 族/people 六色/symbol 族+c_symbol_like/arrow 四向）、`:66` 既有族不回归、`:78` 未映射丢弃（arrow-refresh/symbol-minus/week-*/month-*/c_number_*）、`:85` 单选组 first-wins、`:98` other 组 multi 并存与同值重复、导出方向 `:112` progress 八档→task-*（none 不写）、`:124` mood 仅 smile、`:129` other 六值+person+important、`:141` arrow 四向、`:149` emoji/number 零虚增、`:155` 既有导出不回归、往返 `:167` smiley-laugh/c_symbol_like 形近恒稳、`:172` 原生族往返值级恒等；
  - `src/parse.test.ts` 38 例：JSON 侧 v2 专项 `:192` 概要两段式、`:228` 图片（剥 xap:/魔数白名单/float 取整/align 白名单）、`:260` 超链接、`:282` 样式四键、`:317` 结构三映射+theme+legend 忽略、`:369` 标注/外框/任务信息/标签/附件/备注图片逐类计数、`:421` 多画布计数；XML 侧 `:545` **根元素 xmap-content 同样解析（T7 冒烟暴露新增）**、`:560` **概要标签桶 topics type="summary"（T7 冒烟暴露新增）**、`:598` markers 双形状、`:619` 概要+detached 豁免、`:655` 图片属性真值、`:674` href、`:689` styles.xml 间接表、`:724` 结构+theme 属性；resources 表与错误契约组 `:500`/`:804`；
  - `src/build.test.ts` 8 例：v2 导出写回 `:88` href 产键、`:107` style 四键产 style.properties（fontSize 产 "<n>px"）、`:143` extra 第二参夹具开口、`:164` 不传 extra 产物与 v2 前逐字节一致（字节金样）；
  - `src/roundtrip.test.ts` 6 例：`:77` v2 原生族导入→导出→再导入 Gmind icons 值级集合稳定（含样式/href，形近三档钉死）、`:143` emoji/number 零虚增。
- **web 单测 161/161 全绿**：`apps/web/src/editor/xmind-import.test.ts` 23 例（`:150` describe v2——`:238` 无图快路径不调 deps、`:251` 两段式时序 createFile→uploadImage→setImage→putDocState、`:303` 上传拒绝计图片继续、`:331` **putDocState 拒绝：整体 reject、文件已建、该图不进降级计数（终审 Important#2 新增）**、`:357` 单图 10MB 预检、`:390` 同图多节点逐节点上传、`:424` 混合态部分成功、`:470` 落盘 v2（description/href/style 四键/folded/setIcon 进度联动）、`:501` 概要 setSummary、`:533` SUMMARY_INVALID 计概要零残缺、`:556` structureType 首 setDocMeta 次 addCanvas、`:586` origin=system 修正；`:664` describe degradedSummary v2——全零「已完整导入」/单项/目录序/未知 key 容错）；`apps/web/src/editor/xmind-export.test.ts` 9 例（`:97` describe 导出对称 v2——`:98` http(s) href 产键、`:109` 非 http(s) 不产键、`:124` style 四键非空才产、`:141` icons 全组透传树层不过滤）。
- **web e2e 全绿（import-export 9/9、error-copy 11/11）**：`apps/web/e2e/import-export.e2e.spec.ts`——`:271` 全保真合成夹具（标记四族/图片两段式/概要/超链接/样式/结构类）导入 toast 逐项点名「未导入：图标 1」精确全文＋画布落位逐项断言、`:321` 纯净水树恒弹「已完整导入」、`:330` 导出往返 marker 集合值级稳定＋href/style 写回断言；既有导入/超限/损坏/往返/PNG/JPG 用例 `:36`/`:57`/`:131`/`:184`/`:210`/`:235` 不回归。`apps/web/e2e/error-copy.e2e.spec.ts` `:108` 导入归因两段式文案、`:163` 图片 10MB 上限文案不回归。

### 门禁五件套（2026-11-14 当日全量连跑，含一次发现→判定→裁定→修复闭环）

最终口径：`pnpm lint` 0 / `pnpm typecheck` 0 / `pnpm test` 全绿（server 77＋web **161**＋xmind-io 69＋shared 43＋engine/core 等；web 第 161 例＝终审修复波新增「putDocState 拒绝」用例，随修复波独立复跑全绿）/ `pnpm --filter @gmind/server test:e2e` **217/217** / web e2e **215 passed + 1 skipped, 0 failed**——**全绿**。

过程如实登记：前两轮全量 web e2e 为 **213 passed + 1 skipped + 2 failed**（`m0-acceptance` :19「注册后见 3 示例文件」/:28「新建脑图在列表首位」，隔离重跑必现非偶发）。判定与本计划改动无关：①错误快照败因「验证码错误或已过期」——`uiRegister` 点发码后不等发码请求返回就提交注册（先在竞态），而需求方当日 13:05 起在本机 `scripts/dev-local.env` 配置了真实 SMTP（服务端 454 限流拒信使每次发码请求耗时秒级，`.data/dev-server.log` 多条「454 too frequently sending」），注册请求先于存量码落库到达 → 万能码校验失败；②同链路 `login-page.e2e.spec.ts:31`（提交前先等发码钮进入倒计时）两轮均过，证明链路健康、差异只在等待；③本计划 T1-T7 未触碰 auth/login/email-code/server 任何文件（且 T6 报告 :59 已预告「T7 门禁全量 web e2e 会再次撞上」）。**2026-11-14 需求方裁定修测试侧**：与 error-copy ⑩ 修正后同款——发码 click 前注册 `waitForResponse`（谓词 url 结尾 `/api/auth/email-code`＋POST＋**204**：204 恒在 issue() 写码键之后返回，谓词真 ⟺ 码已落；非加重 timeout）await 后再提交（`apps/web/e2e/m0-acceptance.e2e.spec.ts:14-20`）。修复后 m0 spec 3/3 绿，全量 web e2e **215 passed + 1 skipped（0 failed，2.1m）**，lint/typecheck 复跑 0。

### 真实文件人工冒烟（需求方本机文件，只读使用，未入库未复制进仓库；临时 Playwright spec 跑完即删）

文件：`吾盛待办10.27.xmind`（XMind 8 XML；2 画布）。导入方式：工作台首页「导入文件」卡→选文件（公共 helper `helpers/auth.ts` API 造号+注 token，注册即登录）。

- **toast 实际全文：「未导入：图标 2、画布主题 2、结构覆盖 1」**（目录序=DEGRADED_LABELS 序；与简报预期三项一致、无多余项；计数正当性核对：图标 2=arrow-refresh 1+symbol-minus 1 丢弃、画布主题 2=两 sheet theme 属性、结构覆盖 1=「商城端」子树非根 structure-class）。
- **页面上下文内 parseXmind 交叉核对**（同一解析器跑真实字节）：sheets 2；degraded 恰 {icon:2, theme:2, structureOverride:1}；概要 38；图片 1；标记映射 progress.done 36/p75 5/p12 4/p87 1、other.like 28/plus 1/question 2/cancel 1/done 2、mood.smile 1、other.person 1、other.important 1、arrow.up 1；双画布 structures [logic, logic]。
- **画布落位断言全过**：画布页签 2 张，树节点 **161**（画布1=101、画布2「PDA 优化」=60），另有概要标签 topic 38＋图例 legend 2（XML topic 元素合计 201；简报「201 节点」口径按此更正）；结构面板双画布均「逻辑图（向右）」高亮；图片恰 1 张渲染、`data-image-placement="bottom"`（挂节点下方）、渲染尺寸 108×200（源 188×348 → 200px 钳制）；概要 25+13=38 条全落位（标签文本可见）；画布徽章 38 枚=非进度标记全量（like 28/smile 1/up 1/person 1/important 1/plus 1/question 2/cancel 1/done 2；进度组画布不渲染系 2026-10-12 裁定）；徽章 title 抽点「点赞」「心情 微笑」「箭头 向上」；任务行进度 100%×36/75%×5/13%×4/88%×1=46 与解析一致；任务面板 marker-progress-done aria-pressed=true、aria-label「进度 完成」。冒烟后导入件已从工作台删除（网格回到 3 种子文件），无残留。
- **截图与计数记录**（git 忽略目录）：`.superpowers/sdd/2026-11-14-xmind-import-fidelity/smoke/`——`toast.txt`、`parse-cross-check.json`、`smoke-summary.json`、`smoke-1-canvas1.png`、`smoke-2-structure-canvas1.png`、`smoke-3-canvas2.png`、`smoke-4-task-panel-done.png`、`smoke-5-image-bottom.png`。

### T7 冒烟暴露并同日修复的两个解析缺陷（修复经需求方裁定接受不回退、具名风险进全分支终审；归因如实分列）

1. **真实 XMind 8 文件曾被整份误判「已损坏」**【归因：HEAD 存量缺陷——修复前 parse-xml.ts 第 99 行根检查只认 `<map>`（M4 合成夹具自造形状），content.xml 根元素实际是 `<xmap-content>`（urn:xmind:xmap:xmlns:content:2.0）→ 真实文件全部 CORRUPTED】。修复：双根形状都接受（`packages/xmind-io/src/parse-xml.ts:283-289`），用例 `parse.test.ts:545`。这也意味着 M4 手动清单第 5 项「真实 XMind 8 文件导入」当日首次真正走通。
2. **概要标签曾全部落空串**【归因：T2/spec 缺陷被冒烟暴露——设计 spec §二把标签桶形状写成 detached topic，T2 实现照 spec 落地、单测夹具同形致盲区；真实 XMind 8 的概要标签 topic 在 `<topics type="summary">` 桶（与 attached 平级），旧实现只查 detached → 真实文件 38 条概要可见但标签全空】。修复：标签桶=detached+summary 双桶查找（`packages/xmind-io/src/parse-xml.ts:158-181`，detached 在前兼容既有用例），用例 `parse.test.ts:560`。

### 残余损失清单（如实登记，候选后续任务）

emoji(28)/数字(10) 组往返仍丢（无 XMind 原生源）；颜色/形状信息有损（旗帜恒红、人员恒蓝、箭头恒蓝、星标恒橙）；心情仅 smile 可导出（smiley-laugh 形近）；进度「未开始」不导出（task-start 未实测）；**图片/概要/折叠态导出不写回**（XMind 里打开无图无概要括号）；每节点 1 图、多图取首张；图片 200px 钳制缩放；字体/线宽/行高/对齐不映射（计样式属性）；非 http(s) 链接丢弃；legend 忽略；同一图片多节点引用逐节点重复上传（去重候选后续任务）；setDescription 超 200 字整单拒绝、概要标签超 200 字计概要降级；**putDocState 失败：文件停留无图初态、丢失图片不进计数（行为待需求方裁定是否回收，终审 Important#2 补钉：`apps/web/src/editor/xmind-import.test.ts`「putDocState 拒绝」用例）**。

### 裁定推翻（2026-11-14，指针）

1. **M4「内嵌图片不提取只计数」→ 推翻，图片提取上传入库**：原文出处=本文档头部里程碑边界段「导入图片对象提取不做」、第二节 FR-IO-002 行备注③、诚实登记节第 1 条；新裁定与落地形态见上文与 `docs/project-status.md` §三「已裁定并交付」2026-11-14 条目。
2. **M7b「emoji 组不从 XMind 导入」→ 推翻，smiley 族映射 mood 组入内**：原文出处=packages/xmind-io/src/markers.ts v2 之前头注（git 历史）；emoji unicode 组（28 字符）仍无 XMind 原生源，导入恒不产出、导出不写回（落地形态）。

### 同日跟进（2026-11-14 下午，需求方复测 Gmind问题汇总.xmind 反馈三项，已修）

1. **文件名改按原文件**：导入文件名=原文件名去 .xmind 后缀（原为中心主题文字，如「Gmind问题汇总.xmind」会被命名为中心主题「Gmind」）；画布中心主题文本保持 XMind 根主题原文不变。自动化背书：`apps/web/src/editor/xmind-import.test.ts:152`（title=原文件名优先）、`:203`（文件名仅剩后缀回落根主题）、`:615-643`（setDocMeta 文件名覆写断言）。
2. **思维导图根分支左右均衡定侧**：原 addChild 固定「右侧最多 3 个」配额导致 10 分支文件右侧仅 3 个；现 mindmap 画布导入按分支子树规模贪心均衡（并列取右、同侧保序），logic/org 不受影响。自动化背书：`xmind-import.test.ts:211`（均衡定侧断言）、`:239`（logic 画布不均衡）。
3. **画布主题不再计入「未导入」提示**（需求方拍板：主题由 Gmind 自有主题替换呈现，属有意替换非内容丢失）：降级目录 14 类（原 15 类含「画布主题」）。自动化背书：`packages/xmind-io/src/parse.test.ts:317`、`:342`、`:724`（JSON/XML 两路径 theme 均不计数）。**此文件若今日重导，预期提示为「已完整导入」**；吾盛待办10.27.xmind 新预期提示为「未导入：图标 2、结构覆盖 1」（原冒烟记录「未导入：图标 2、画布主题 2、结构覆盖 1」为修复前口径，原文保留）。

跟进批验证：lint/typecheck 0、全包单测绿（shared 43/xmind-io 69/core 375/engine 428/server 77/web 163）、import-export+canvas-scope e2e 10/10。

### 校准更正（2026-11-15，需求方复测 Gmind问题汇总.xmind 打回上一批「左右均衡」）

上一批的「按子树规模轻侧贪心」是自拟规则、与 XMind 思维导图真实平衡不符（10 支文件导入后右侧 5 支且读序变化 vs 源文件右侧 8 支）。按源文件截图逐支校准为新规则：**子树权重最大的分支锚定左侧，其前分支居右（文档序）、其后分支随左**——源文件（右=场景/首页/harness/Ai/筛选/任务看板/协作/设置，左=文件/分支主题 6）逐支吻合。自动化背书：`apps/web/src/editor/xmind-import.test.ts:211`「左右均衡定侧」（权重模式 [4,2,2,4,3,3,2,4,16,1] 合成树，断言右=前 8、左=9/10）、`:239`（logic 画布不均衡）；web 单测 163/163、import-export e2e 9/9、全量 web e2e 215+1skip+0 failed。XMind 平衡算法无文档，该规则按此文件校准，诚实边界登记 features 文档④10。

## 十一、2026-11-15 轮 1 分享导出改版补记（分享弹框导出五项＋PNG 退役＋Excel 新增）

核验日期：2026-11-15。起因与依据：需求方 2026-11-15 口径「我要白底的 jpg」——**PNG 透明档退役**，图片导出统一 JPG 白底；分享弹框「导出」页签收敛为五项（XMind/JPG/Markdown/CSV/Excel），新增 Excel 任务表导出。计划与任务台账：`docs/superpowers/plans/2026-11-15-share-export-revamp.md`（轮 1 任务 1-3 落码、任务 4=e2e 新建＋文档三件套收官）；功能文档同步 `docs/features/import-export.md`（标题/①/规则 17/20 改口径、④11/④12 新增）。任务 1-3 落码内容（行号 2026-11-15 当日 grep）：

### 改动清单

1. **分享弹框导出页签五项**（`apps/web/src/editor/ShareDialog.tsx:126-132`）：XMind/JPG 转发既有导出通道（`onExport('xmind'|'jpg', scale?)` `:35`；EditorPage 接线 `apps/web/src/pages/EditorPage.tsx:5147-5158`），MD/CSV/XLSX 弹框内真实下载（`apps/web/src/editor/docExport.ts:54/:69/:131`）；单项点击 1800ms「已导出 ✓」回落（`ShareDialog.tsx:134-143`、`:242`）；说明行「导出…包含已折叠的节点」（`:230`）。
2. **PNG 退役**（依据=需求方 2026-11-15 口径「我要白底的 jpg」）：工具栏导出菜单=XMind＋JPG 1x/2x/3x 三档（`EditorPage.tsx:4396`、`:4413-4422`），分享弹框图片项固定 JPG 白底 2×（`ShareDialog.tsx:128`）；`apps/web/src/editor/image-export.ts` 收敛为仅 'jpg' 一档（`:29` 类型、`:92` 下载 `.jpg`），PNG 双格式实现留 git 历史。
3. **Excel 任务表导出**（`apps/web/src/editor/docExport.ts:131` exportXlsx、`:115` buildXlsxBytes）：**零依赖手写最小 OOXML**——五标准部件 zip 经 xmind-io zipEntries=fflate（`:92`），选型理由=任务表只有文本/数字两种单元格，引专门 xlsx 库（数百 KB 依赖）不划算；列口径=CSV 7 列（2026-11-15 需求方拍板），序号/进度为数字单元格 `t="n"`、其余 inlineStr 文本（`:108-111`）；**公式/样式/多 Sheet 不支持**（诚实登记，候选引库重做）。

### 自动化背书（用例名+行号为 2026-11-15 当日 grep，非转抄）

- **新建 `apps/web/e2e/share-export.e2e.spec.ts` 6/6**（种子文档「本周计划」口径，与工具栏导出用例同源；下载断言沿用 import-export 既有模式）：`:39` 五项齐全+「包含已折叠的节点」说明行、`:52` XMind 下载产物 parseXmind 单 Sheet/root 本周计划/三分支、`:69` JPG 下载 FFD8FF 魔数（弹框固定 2×）、`:83` Markdown `# 本周计划` 开头+「- 周一」、`:98` CSV BOM+7 列表头、`:114` Excel PK 魔数+按钮变「已导出 ✓」（反馈断言在含下载的 Promise.all 之后，不做 1800ms 回落时序断言）。
- **unit：`apps/web/src/editor/docExport.test.ts` 4 例**（zip 五部件/表头 7 列与 CSV 同序/XML 实体转义/数字单元格 t="n"）。
- **不回归**：import-export e2e 9/9（含工具栏 JPG 三例与 XMind 往返）。

### 门禁五件套（2026-11-15 当日全量连跑，收官）

`pnpm lint` 0 / `pnpm typecheck` 0 / `pnpm test` **1160 passed, 0 failed**（shared 43＋xmind-io 70＋gmind-core 375＋engine 428＋server 77＋web 167）/ `pnpm --filter @gmind/server test:e2e` **217/217**（19 文件）/ web e2e **220 passed＋1 flaky＋1 skipped，0 failed（2.2m，222 用例 4 workers）**。全量跑读完整输出核对：flaky=`collab.e2e.spec.ts:566`「双页并发结构操作收敛：move vs delete」（首轮 node-count 断言 10s 窗内得「6 节点」非「4 节点」，重试即过；**隔离重跑 2/2 绿**）——双页协同负载抖动，与本轮改动无关（本轮任务 1-4 未触碰协同/结构操作链路）；skipped=`perf-editor.spec.ts:126`（perf 合法跳过，存量口径）。新 spec 六例隔离跑与全量跑各 6/6 绿。

### 诚实登记（挂账三条）

1. **xlsx 的 escXml 未过滤 XML 1.0 非法控制字符**（`docExport.ts:107` 只转义 &/</>）：节点文本若含 U+0000–U+0008 等非法控制字符（外部来源粘贴场景理论上可达），产出的 xlsx 会被 Excel 判「损坏」拒开；触发概率趋近零，候选后续补字符过滤。
2. **转发通道「已导出 ✓」语义=点击已受理而非导出成功**：xmind/jpg 导出失败或折叠确认取消时按钮仍亮成功态 1.8s（`ShareDialog.tsx:134-143` runExport 同步 setExported；`onExport` void 契约固有不感知结果）——改动需把 onExport 契约 Promise 化，波及既有调用点，属后续裁定；features 文档④12 同口径登记。
3. **`apps/web/src/pages/editor.css:970/:981` `.export-option` 死 CSS**：PNG 勾选行退役后遗留的无引用样式（当日 grep 全仓 src/e2e 零引用），收口清理待做。

## 十二、2026-11-15 导出返工批补记（验收反馈三条：XMind 8 打不开／图片折叠态／Excel 列宽）

核验日期：2026-11-15。起因与依据：轮 1 交付后需求方验收实开反馈三条——①图片导出不要折叠按钮、要展示展开按钮和数量、按现有折叠状态导出不自动展开；②CSV/Excel 列宽适应内容（原文注「不好做可不做」）；③导出 .xmind 在 XMind 8 报 `SheetDeserializer.parseTopic null argument` 打不开。计划与任务台账：`docs/superpowers/plans/2026-11-15-export-rework.md`（任务 1-3 落码、任务 4=e2e 用例 5 重写＋文档三件套＋收官门禁，本节即任务 4 产物）；功能文档 `docs/features/import-export.md`（①/规则 15/17/20/④12-16 当日改写并当日 grep）。

### 三条反馈与修复（行号 2026-11-15 当日 grep）

1. **XMind 导出补四样必需键**（`packages/xmind-io/src/build.ts`，头注 v2.1 段 `:12-17`）：每个 sheet 与每层 topic 逐个产非空 `id`（缺省 `crypto.randomUUID()`，第三参 idFactory 供测试注入确定性工厂，`:70-88`）；根 topic 产 `structureClass` 三值反向映射（mindmap→`org.xmind.ui.map.unbalanced`、logic→`org.xmind.ui.logic.right`、org→`org.xmind.ui.org-chart.balanced`，仅根携带、子 topic 恒不产，`:30-38` 映射表＋`:93` 落键）；zip 补 `manifest.json`（file-entries 登记 content.json/metadata.json，`:100`）；metadata creator 改对象形式 `{"name":"Gmind","version":"1.0"}`（`:101`）。自动化背书：`build.test.ts` v2.1 三组新用例（id 全树非空唯一＋缺省 UUID 形状／三映射＋缺省不产键＋仅根携带／manifest＋metadata 容器）＋`roundtrip.test.ts` 四画布 build→parseXmind 往返（structureType 经 structureClass 还原、零降级）；xmind-io 单测 74/74。
2. **图片按当前折叠态导出**（`apps/web/src/editor/image-export.ts`＋`apps/web/src/pages/EditorPage.tsx`）：快照克隆改走 docToState→docFromState 装载通道，collapsed 原样保留（`image-export.ts:84`）；新增命名导出 `stripCollapseToggles`（`:136-143`）——删所有 `g.gm-collapse-toggle` 交互折叠钮整组、「+N」徽标 `g.gm-collapse-badge` 保留（N=被隐藏存活后代数，engine `layout.ts:158-161` 计数、`render.ts:973-1002` 画徽标）；EditorPage 删「检测到 N 处折叠，将自动展开后导出」确认框分支（`EditorPage.tsx:1290` runImageExport 只剩下载链路）。自动化背书：`image-export.test.ts` 新增 stripCollapseToggles 2 例（toggle 整组剥离且 badge 与其余节点原样／多组全剥＋幂等）。
3. **Excel 列宽自适应**（`apps/web/src/editor/docExport.ts`）：sheet1.xml 在 `<sheetData>` 前注入 `<cols>`（`:137`、`:143`），列宽=列内最大显示宽+2、钳制 [8,60]（`:134-136`），显示宽 CJK/全角记 2、数字按字符串化长度（`displayWidth` `:116`）。自动化背书：`docExport.test.ts` 新增 5 例（中文长标题列宽 10／全短列 7×宽 8／超长钳 60／cols 在 sheetData 前且 7 col 逐列 min=max=i+1／数字按字符串化长度）。**CSV 不做**：纯文本格式无列宽概念，如实说明非遗漏。

### 根因诊断过程（反馈③ XMind 8 打不开）

需求方提供报错栈：Zen 解析器 `SheetDeserializer.parseTopic:231 null argument`——解析器对 topic id 断言非空，而旧产物 sheet/topic 全无 `id`。诊断方法=与本机真实 XMind Zen 导出金样逐项对照：**张智建总结计划 2025-08-01.xmind**（creator Vana 24.01，115 个 topic 全部带 id、structureClass 只出现在根 topic、zip 带 manifest.json、metadata 的 creator 是对象形式）——旧产物四项全缺：topic/sheet id（直接死因）、manifest.json、creator 对象形状、根结构串；按金样四项全补（即修复清单第 1 条）。**旁证顺带登记**：需求方另一真实文件（王春龙 20261023）content.json 存在 CRC 损坏，但因同包还带 content.xml，XMind 仍能打开——说明 XMind 的打开链路对包内条目有多路兜底，也反向印证自产 zip 各部件齐整、形状贴近真实导出件的必要性。修复止于产物形状（engine/core 未动）；**XMind 8 实开冒烟待需求方执行**（已登 project-status 待人工清单）。

### 用例 5 重写（任务 4，口径经评审钉死）

`apps/web/e2e/import-export.e2e.spec.ts:222`「折叠态导出：不弹确认框直接导出（画布折叠态不变）」：折叠 root（Ctrl+/，徽标 +1）→ export-jpg-1x → `dialogCount === 0`（确认框已删，替换原「检测到 1 处折叠」断言——该断言随确认框一并移除）→ 下载名「本周计划.jpg」＋JPEG 魔数 FFD8FF → 画布徽标仍在（count 1）＋孙节点「周会对齐」仍隐藏（count 0）。用例 4（无折叠 JPG 3x）不变。图内「+N 在图／无交互钮」的图像内容语义由 image-export 单测＋engine render 单测钉住（JPEG 像素层 e2e 无法检视，不假装能）。

### 门禁五件套（返工批收官 2026-11-15 当日全量连跑）

`pnpm lint` 0（exit 0 无输出）/ `pnpm typecheck` 0（六包 Done）/ `pnpm test` **1171 passed, 0 failed**（shared 43＋xmind-io 74＋gmind-core 375＋engine 428＋server 77＋web 174）/ `pnpm --filter @gmind/server test:e2e` **217 passed (19 文件)，0 failed（29.8s）** / web e2e 全量 **220 passed＋1 flaky＋1 skipped，0 failed（2.2m，exit 0）**。全量输出读完整核对：flaky=`collab.e2e.spec.ts:566`「双页并发结构操作收敛：move vs delete」（首轮 node-count 断言 10s 窗内得「6 节点」非「4 节点」，套件内重试即过；**隔离重跑 2/2 绿**（9.2s/8.9s）——双页协同负载抖动，与本批无关：本批改动面=xmind-io build/web 导出胶水/导出 e2e/文档，未触碰协同与结构操作链路；与轮 1 为同一条已知观察项）；skipped=perf-editor（PERF=1 门，存量合法跳过）。受影响 e2e 三 spec 先行 **18/18 passed（18.0s）**（import-export 9＋share-export 6＋canvas-scope 3），全量中同批用例无回归。

### 诚实登记（返工批挂账四条，features 文档 ④13-16 同口径登记）

1. **engine/core 两处头注已与本批行为相反**：`packages/engine/src/export.ts:9-10`（「传入的 reader 应是已展开克隆……导出恒为完整层级」）与 `packages/gmind-core/src/read.ts:443`（「cloneExpanded 只展开可达集」）描述返工批前旧行为——engine/core 只增不改，注释不动，**读码以代码为准绳，勿信旧注**。
2. **core `cloneExpanded`（export.ts:27）与 `countCollapsedWithChildren`（read.ts:445）成无生产调用方的导出 API**：web 侧分别改走 docToState→docFromState 克隆与删除确认框计数；两者去留待需求方裁定（core 只增不改，本轮未动）。
3. **xlsx 半角片假名（U+FF61–FF9F）按全角记 2**：显示宽区间 U+FF00–U+FFEF 整段记宽，半角片假名实为窄字符，日文名列会偏宽——只宽不窄、不截断，细分待需求方点头。
4. **XMind manifest 不登记 buildXmind 第三参 extra 注入条目**：extra 仅 e2e 夹具开口、生产导出恒不传（生产不可达），manifest 恒登记 content.json/metadata.json 两个核心条目；XMind 8 实开验证时天然覆盖。

另注：轮 1 补记「诚实登记（挂账三条）」第 2 条所述「折叠确认取消时按钮仍亮成功态」场景随本批确认框删除不复存在，该条收窄为「导出失败时按钮仍亮成功态 1.8s」（features 文档 ④12 已同步改口径）。

## 十三、2026-11-15 导出保真第三波补记（验收反馈两条：图片没导出来／连接线直愣愣）

核验日期：2026-11-15。起因与依据：返工批交付后需求方验收实开反馈两条——①「新导出的 Gmind问题汇总 (2).xmind 可以打开（XMind 8 修复验证通过），但图片没导出来」；②「样式有点丑……分支的连接线都是直愣愣的，和 xmind 软件创建的不一样」。计划与任务台账：`docs/superpowers/plans/2026-11-15-export-polish.md`（任务 1=build 层、任务 2=web 导出链、任务 3=本节 e2e＋文档＋收官门禁；台账 `.superpowers/sdd/2026-11-15-export-polish/progress.md`）；功能文档 `docs/features/import-export.md`（①/规则 15/16/20/④5/④12/④16 当日改写并当日 grep）。

### 两条反馈与修复（行号 2026-11-15 当日 grep）

1. **图片没导出来＝M4 挂账「导出图片不写回」清偿**（`packages/xmind-io/src/build.ts`＋`apps/web/src/editor/xmind-export.ts`）：build 层 topic 级产 `image {src:'xap:<path>',width,height,align}`（`build.ts:286-297`；w/h/align 缺省不产键、path 空串视同无图）；web 链路四步=walk 读节点图片快照收任务（`xmind-export.ts:104-116`）→ 按唯一存储键并行 fetch `/api/images/{键}`（公开读取端点，同 JPG 导出内联图片先例；同图多节点只抓一次）→ 字节以 `resources/{键尾段}` 入 zip（`resourceNameOf` `:139-143`）并回填节点 → build 组包（`buildXmindBytes` `:152-190`）。**缺图不阻断**：单张抓取失败（网络错/非 200）只跳过那张，失败的不同图片张数经 toast 点名「N 张图片未能包含在导出中，可重试导出」（`EditorPage.tsx:1307-1316` runXmindExport，工具栏/分享弹框两入口同一闭包）。顺带清偿轮 1 ④16「manifest 不登记 extra」：`file-entries` 逐键登记注入条目（`build.ts:319-328`）。
2. **连接线直愣愣＝导出件缺 theme 的根因**（`packages/xmind-io/src/build.ts` DEFAULT_THEME）：每个 sheet 末位产 `theme` 键（`build.ts:312-313`），值**逐字借自本机真实 XMind（Zen/Vana 24.01）导出金样「张智建总结计划 2025-08-01.xmind」的软件默认主题 15 键全文**（十二层＋expiredTopic/skeletonThemeId/colorThemeId；含 map 层 multi-line-colors 六色与字体栈原文）——零自造样式值，需求方诉求即「和 xmind 软件创建的一样」。**根因诊断**：XMind 对缺 theme 的文件按默认直线渲染分支连线；金样 mainTopic/subTopic 的 `line-class: org.xmind.branchConnection.roundedElbow`（圆角肘形连接线）即软件曲线质感的来源。theme 是主题定义非内容，解析侧不计降级（2026-11-14 拍板口径一致）。

### e2e 与自动化背书（任务 3）

- `apps/web/e2e/share-export.e2e.spec.ts` 两处：**用例 2 扩**（`:105-114`）——下载产物 unzipEntries 解包，断言 content.json sheet theme 的 mainTopic/subTopic `line-class` 均为 `org.xmind.branchConnection.roundedElbow`、manifest.json file-entries 恰登记 content.json/metadata.json 两核心条目（无图文档不传 extra）；**用例 2b 新增**（`:123-163`）——种子文档无图，带图载荷走既有导入夹具（helpers/xmind-fixture 自带 4×4 PNG，经真实两段式上传落库，零新增图片数据）：导入（toast 逐字「未导入：图标 1」证明图片零降级）→ 分享弹框导出 → 解包断言 zip 恰一条 `resources/` PNG 魔数条目＋manifest 登记该键＋content.json 待办一 `topic.image` 四键写回（src=`xap:`+动态键、width/height=真实字节 4×4、align=夹具 bottom）。抓取失败的计数 toast 路径无 e2e（成本不匹配，单测已钉），如实登记。
- 单测背书（任务 1/2 产出、本波收官复跑零回归）：`packages/xmind-io/src/build.test.ts` v2.3 三组＋金样（theme 字节逐字=金样独立捕获串）、`roundtrip.test.ts` 图片往返、`apps/web/src/editor/xmind-export.test.ts` 抓取五例（打包/同键去重/reject 计数/404/无图零 fetch）。

### 门禁五件套（第三波收官 2026-11-15 当日全量连跑）

`pnpm lint` 0（exit 0 无输出）/ `pnpm typecheck` 0（六包 Done）/ `pnpm test` **1181 passed, 0 failed**（shared 43＋xmind-io 78＋gmind-core 375＋engine 428＋server 77＋web 180；较返工批基线 1171 净增 10＝xmind-io +4（build v2.3 三例＋roundtrip 图片往返一例）＋web +6（终审修复生产链结构串用例一例＋图片抓取五例））/ `pnpm --filter @gmind/server test:e2e` **217 passed (19 文件)，0 failed（30.3s）** / web e2e 全量 **222 passed＋1 skipped，0 failed（2.2m，exit 0）**（skipped=perf-editor PERF 门合法跳过；已知观察项 canvas-tabs:46、collab:566 本轮均未复现，全轮零 flaky 零重试）。受影响 e2e 两 spec 先行 **16/16 passed（18.0s）**（import-export 9＋share-export 7），全量中同批用例无回归；夹具行为顺带核对（计划 Self-Review 接缝项）：夹具 zip 形状变化（buildXmind 产物多 theme、buildCleanXmind 走新 manifest）后导入侧用例 7/8/9 全绿，导入不读 manifest、theme 不计降级，与预判一致。

### 诚实登记（第三波挂账，features ④ 同口径）

1. **缺图 toast 路径无 e2e**：失败计数 toast 由单测钉（fetch reject/404 两例），浏览器端 toast 呈现无自动化——与 Task 2 评审登记一致，成本不匹配接受。
2. **多图 zip 条目序=fetch 完成序每次抖动**（Task 2 评审 deferred 项沿用）：无功能影响；本波 e2e 只用单图夹具不涉序，带图金样若钉会 flake（修法挂账：Promise.all 后按 byKey 重组）。
3. **0 字节/非白名单图片字节照常入包**（Task 2 登记沿用）：导出侧信任服务端直出原图（上传时已校验），未做客户端魔数嗅探。
4. **theme 借用口径**：主题值=单一金样文件的软件默认主题逐字快照（含其字体栈/multi-line-colors），若需求方 XMind 版本/默认主题不同（如 XMind 8 经典主题），观感可能有差——待 XMind 8 实开核验（见 project-status 待人工清单）。

## 十四、2026-11-15 导出主题按结构选型＋导入分侧 v3 补记（验收反馈两条：思维导图页线条又直了／思维导图导入节点全跑左边）

核验日期：2026-11-15。起因与依据：第三波交付后需求方验收实开反馈两条——①「刚把结构从逻辑图（向右）改成了思维导图，导出的农千问待办10.27 (2).xmind 的线又变成了直愣愣的了」（画布 1）；②「思维导图.xmind 导进来后节点的方向都跑到左边去了」。计划与任务台账：`docs/superpowers/plans/2026-11-15-export-theme-sides.md`（任务 1=build 层 theme 按结构选型、任务 2=导入分侧 v3、任务 3=本节 e2e 断言同步＋文档三件套＋收官门禁；台账 `.superpowers/sdd/2026-11-15-export-theme-sides/progress.md`）；功能文档 `docs/features/import-export.md`（标题/①/规则 3/4/7/8/15/19/20 与③/④10 当日改写并当日 grep）。

### 两条反馈与修复（行号 2026-11-15 当日 grep）

1. **导出 theme 按画布结构二选一——反馈①根因=轮 3 的逻辑图金样错配思维导图页**（`packages/xmind-io/src/build.ts`，头注 v2.4 段 `:19-32`）：轮 3 起每 sheet 恒带 theme，但值=逻辑图金样（roundedElbow 圆角折线）——需求方把画布 1 切成思维导图后，思维导图页也被错配上逻辑图主题，XMind 打开线「又直愣愣」。修复=`themeOf(s.structureType)` 二选一（`build.ts:385`、落键 `:457`）：**mindmap→THEME_MINDMAP**（`build.ts:260`，逐字借本机真实思维导图金样「邢安家2025.08.01.xmind」map.unbalanced 画布 sheet.theme **十键全文**，centralTopic/mainTopic/subTopic/summaryTopic `line-class` 全 `org.xmind.branchConnection.curve` 曲线，无 skeletonThemeId/colorThemeId——金样本无，实现不自造）；**logic/org/缺省→THEME_LOGIC**（即轮 3 十五键 roundedElbow 金样，v2.4 仅改名 DEFAULT_THEME→THEME_LOGIC、零值变化，logic 画布观感不回归）。选型统计依据=「27/35 份 curve 主流」，**语料口径**（2026-11-15 当日核实，登记于 features 文档规则 15①——任务简报原要求补进 build.ts 头注，因本批收官任务不动代码文件，改记此处）：需求方本机 Downloads＋工作目录全部 .xmind 的 Zen JSON 共 **74 份**，其中 **35 份**显式 `map.unbalanced`（思维导图），这 35 份中 **27 份** theme 为 curve。**「农千问命中逻辑图」非缺陷**：实证该原始文件画布 1 本身即逻辑图结构，Gmind 导入零错判（解析器读导出件还原 [mindmap, logic] 零降级）、导出忠实还原原始数据——无代码改动，交付汇报向需求方说明。
2. **导入分侧 v3——反馈②根因=锚点在第一支时右侧为空、整树全挤左边**（`apps/web/src/editor/xmind-import.ts` balancedSides，规则头注 v3 段 `:230-238`、回退腿 `:247-248`）：现行「子树权重最大的分支锚定左侧、其前分支居右、其后分支随左」规则**原样保留**（Gmind问题汇总 已验证形态零回归）；需求方的均匀 5 支文件权重 [4,1,2,1,1]、最大分支恰在文档第一位——锚点=第一支 ⟹ 其前无分支 ⟹ 右侧为空 ⟹ v2 规则把整树挤在左边。修复=**回退腿：右侧为空时改「从右起交替」**（偶下标右、奇下标左）。触发条件按锚点表述（**锚点=第一支（右侧空）→回退从右起交替**），作用面比「均匀小文件」宽（两支等权 [2,2] 因严格大于取首遇最大、同样落入回退腿）。**单分支行为随 v3 顺带变化：v2 居左→v3 居右**（唯一分支=锚点=第一支），随 v3 一并登记（features 规则 4）。诚实边界延续：XMind 8 文件不存分支位置、XMind 平衡算法亦无文档，v3 为按复测文件校准的近似规则，不表述为「与 XMind 算法一致」（features ④10 续登。**勘误注，同日终审 Minor#1**：前半句已被实证推翻——本机三份 XMind 8 格式文件均存 right-number（思维导图 rn=3／前端周报0712 rn=2／Gmind问题汇总 rn=7，当日逐份解包核实），v3 自轮 5 起降级为「仅文件未存 right-number 时的兜底」，本段保留作轮 4 当时口径的历史记录）。

### 金样来源（零自造，本机真实文件只读使用、未入库）

- **THEME_MINDMAP**：`/Users/guoyue/Downloads/邢安家2025.08.01.xmind` content.json 首个 `map.unbalanced` 画布的 `sheet.theme`，`python3 -I`（zipfile+json）逐字提取——键数 10、各层形状 `{type,properties}` 与键序均金样原文，`JSON.stringify` 与金样 compact JSON 逐字节一致（测试以独立捕获串钉死）。
- **THEME_LOGIC（不回归基线）**：轮 3 借自「张智建总结计划 2025-08-01.xmind」（creator Vana 24.01）十五键原封，本批零漂移。

### e2e 与自动化背书（行号 2026-11-15 当日 grep）

- **`packages/xmind-io/src/build.test.ts` v2.4 用例（`:353`）**：mindmap sheet → mainTopic/centralTopic/subTopic line-class 全 `curve`＋`'skeletonThemeId' in theme === false`＋十键逐字节金样断言；logic/org/缺省三 sheet → roundedElbow 不回归。红→绿：实现前仅加测试 `1 failed | 78 passed`（received 为旧 THEME_LOGIC 全文）；实现后 `79 passed`。
- **`apps/web/src/editor/xmind-import.test.ts` 两新用例**：均匀 5 支 [4,1,2,1,1]（max 在首位）断言 `['right','left','right','left','right']`；两支等权 [2,2] 断言 `['right','left']`。红→绿：实现前 `2 failed | 25 passed`（received 全 left）；实现后 `27 passed`。**问题汇总回归用例（[4,2,2,4,3,3,2,4,16,1]→前 8 右、九/十居左）断言一字未动、零回归**（锚点在第 9 支、右侧非空，不触发回退腿）。
- **`apps/web/e2e/share-export.e2e.spec.ts` 用例 2（`:84`，断言块 `:98-120`）**：种子文档结构=mindmap → theme 断言 roundedElbow→**curve 两键**＋顺带加「无 skeletonThemeId」断言（任务 1 接缝：不随批同步必红）；manifest 恰两核心条目断言不变。受影响两 spec 先行 **16/16 passed（18.2s）**（share-export 7＋import-export 9）。

### 门禁五件套（本批收官 2026-11-15 当日全量连跑）

`pnpm lint` 0（exit 0 无输出）/ `pnpm typecheck` 0（六包 Done）/ `pnpm test` **1184 passed, 0 failed**（shared 43＋xmind-io 79＋gmind-core 375＋engine 428＋server 77＋web 182；较第三波基线 1181 净增 3＝xmind-io +1（build v2.4 theme 选型一例）＋web +2（分侧 v3 回退两例））/ `pnpm --filter @gmind/server test:e2e` **217 passed (19 文件)，0 failed（30.4s）** / web e2e 全量 **221 passed＋1 flaky＋1 skipped，0 failed（2.2m，exit 0）**——flaky=`editor.e2e.spec.ts:78`「Tab 新建节点提交后画布出现且自动保存」（首轮失败，套件内 retry#1 即过；**隔离重跑 2/2 绿（4.6s）**——本批改动面=xmind-io build 层单测/web 导入胶水单测/share-export e2e 断言/文档，未触碰编辑器新建节点与自动保存链路，判负载抖动，非已知观察项（canvas-tabs:46、collab:566 本轮均未复现））；skipped=perf-editor（PERF=1 门，存量合法跳过）。受影响 e2e 两 spec 先行 **16/16 passed（18.2s）**（import-export 9＋share-export 7，用例 2 theme 断言 roundedElbow→curve 随批同步），全量中同批用例无回归。

### 诚实登记（本批挂账，features 文档同口径）

1. **org 结构主题沿用 logic 变体**：无真实组织架构图导出样本可提取主题，org 画布导出 roundedElbow 主题与轮 3 相同——拿到真实组织架构图导出样本后再校准（features 规则 15① 登记）。
2. **「27/35 curve」语料口径只在 features 文档登记**：任务简报原要求在 build.ts 头注补一句，但收官任务纪律不动代码文件——改记 features 文档规则 15① 与本节，build.ts 头注 v2.4 段的「35 份真实思维导图文件」未注语料口径，读码以 features 文档为准。
3. **单分支行为顺带变化**（v2 居左→v3 居右）：非本轮点名诉求、系回退腿的必然结果（唯一分支=锚点=第一支），已随 v3 在 features 规则 4 登记——需求方若要单分支居左属新裁定、逐条可否决。
4. **分侧回退腿仍是近似规则**（features ④10 续）：只覆盖「锚点=第一支（右侧空）」一种退化（左侧为空不可能出现——锚点必居左）；「最大分支在文档中部之后、多个大分支」等形态仍按锚定腿近似，不保证与 XMind 逐字一致。

## 十五、2026-11-15 分侧忠实还原补记（需求方裁定「分支左右是用户内容不能猜」；当日立项当日交付）

核验日期：2026-11-15。起因与依据：需求方截图反馈「思维导图.xmind 导入后左右分布与 XMind 不符」＋明确裁定「不能靠数字分析节点该在哪边，分支可拖拽、是用户内容」。**铁证：思维导图.xmind 根扩展 right-number=3，与其 XMind 截图（右=分支 1/2/3）一致**——文件里存了左右分布，照抄即可，不猜。计划与任务台账：`docs/superpowers/plans/2026-11-15-side-faithful.md`；台账 `.superpowers/sdd/2026-11-15-side-faithful/progress.md`；功能文档 `docs/features/import-export.md`（头注轮 5/①/规则 4 v4/规则 15 分侧扩/④10 当日改写并当日 grep）。

### 四任务链与 T3 评审折算修正（行号 2026-11-15 当日 grep）

- **T1 解析**（`packages/xmind-io/src/parse-json.ts:140-171`、`parse-xml.ts:156-172`、`types.ts:63`）：两种内部格式的**根主题** extensions 读 right-number → `XmindSheet.rightCount`（provider=org.xmind.ui.map.unbalanced 才认；仅根有效，子主题扩展忽略；非法值不产键不计降级——与 theme 同口径）。
- **T2 build 写回**（`packages/xmind-io/src/build.ts:393-404` rightNumberExtensions、落键 `:468`/`:478`）：mindmap+rightCount!==undefined → 根 topic extensions 金样逐字形状；`roundtrip.test.ts:219` rightCount 经根扩展往返还原（3/0/缺省/logic 四态）。
- **T3 web 接线**（`apps/web/src/editor/xmind-import.ts:239-246` sidesFromRightCount＋定侧分支 `:301-311`；行号为同日终审修复批当日 grep——该批 Minor#1 兜底头注改写致 :259 之后 +1 顺移）：导入 mindmap 定侧 rightCount 优先（floor＋clamp [0,分支数]，0=全左合法、越界=全右），文件未存才回退 balancedSides（v3 原样降兜底一字未动）；`xmind-export.ts` docToXmindSheets 传 rightCount 给 build。
- **T4 折算修正（T3 评审裁定的正确性修正，本任务执行）**：T3 初版导出只统计持久 side==='right'，与 Gmind 实际渲染脱节——引擎对**无 side 的根子级按 index 0-2 视右**（`packages/engine/src/layout.ts:264` `persistedSide ?? (i < ROOT_SIDE_RIGHT_QUOTA ? 'right' : 'left')`；生产可达：EditorPage moveNode 到画布根 core 有意不写 side、模板直建同缺省），混合文档与全缺省模板文档的导出 right-number 因此与画布不一致、往返有损。修法=core `countRightSideRootChildren`（`packages/gmind-core/src/operations.ts:78-103`，持久侧计数＋index 0-2 折算右＋墓碑防御＋画布口径，头注齐备）**加 export 导出（只增，函数体一字未动）**，web docToXmindSheets 改用它取 rightCount、删除手写持久侧统计（`apps/web/src/editor/xmind-export.ts:148-161`；行号为终审修复批当日 grep——同批头注口径扩写致 :29 之后 +4 顺移）——两端语义=引擎渲染精确断言。随之的行为变化如实登记：mindmap 画布导出**恒产** right-number（含空画布产 '0'；T3 版「无侧别信息不产键」口径被折算修正取代——「文件未存回退算法」的语义只属于导入侧读不到扩展的文件，导出侧不再伪造「未声明」）。评审裁定原文要点：「导出 rightCount 必须反映 Gmind 实际渲染，否则往返有损且静默改写用户内容；属正确性修正非产品偏好」。

### e2e 与自动化背书（行号 2026-11-15 当日 grep）

- **单测折算两例（红→绿留痕，T4）**：`apps/web/src/editor/xmind-export.test.ts:231` 全缺省模板文档（buildSubtree 直建 5 支无 side）→ rightCount=3（修正前 undefined，先红）；`:247` 混合文档（第 1 支拖入无 side、其余 addChild 持久 [R,R,L,L]）→ 引擎渲染 [R,R,R,L,L]→rightCount=3（修正前 2，先红）。实现后该文件 **20/20 全绿**——T3 既有持久侧=2/全左=0/logic 负例三例零改动零回归；`pnpm --filter @gmind/core test` **375/375**（export 关键字零行为差异）。
- **`apps/web/e2e/helpers/xmind-fixture.ts:122` buildCleanXmind**：纯净水树夹具补 mindmap 结构串＋根扩展 right-number=1（走 buildXmind 通道传 sheet 参数，rightCount 需 structureType='mindmap' 才产键）。
- **`apps/web/e2e/import-export.e2e.spec.ts:339` 用例 8 扩**：导入「示例树.xmind」（toast 仍逐字「已完整导入」——扩展不计降级）→ 打开 → 导出菜单下载 → content.json 根 extensions 与夹具值逐字一致（`provider='org.xmind.ui.map.unbalanced'`＋`right-number='1'`）＝**right-number 往返无损背书**。
- **`apps/web/e2e/share-export.e2e.spec.ts:84` 用例 2 扩（断言 `:121-126`）**：种子文档「本周计划」（模板直建三分支、无持久 side）导出件根扩展 right-number='3'——引擎折算口径（index 0-2 视右）端到端实证，解析侧读回同值。注：用例 8 扩致 import-export.e2e 其后用例行号顺移（往返 :345→:367）——§十/§十二所引该文件行号为当日历史值，读码以现文件为准。
- 受影响 e2e 两 spec 先行 **16/16 passed（13.6s）**（import-export 9＋share-export 7，零重试）。

### 门禁五件套（本批收官 2026-11-15 当日全量连跑）

`pnpm lint` 0（exit 0 无输出）/ `pnpm typecheck` 0（六包 Done）/ `pnpm test` **1202 passed, 0 failed**（shared 43＋xmind-io 88＋gmind-core 375＋engine 428＋server 77＋web 191；较轮 4 基线 1184 净增 18＝xmind-io +9（T1 解析 describe 5 例 `parse.test.ts:820-925`＋T2 构建 3 例 `build.test.ts:434-497`＋roundtrip 1 例 `:219`）＋web +9（T3 导入 4 例＋导出 4 例＋T4 折算两例替换 T3 一例的净增 1））/ `pnpm --filter @gmind/server test:e2e` **217 passed (19 文件)，0 failed（30.2s）** / web e2e 全量 **222 passed＋1 skipped，0 failed（1.7m，exit 0）**（skipped=perf-editor PERF 门合法跳过；全轮零 flaky 零重试，已知观察项 canvas-tabs:46、collab:566、editor:78 本轮均未复现）。受影响 e2e 两 spec 先行 **16/16 passed（13.6s，零重试）**（import-export 9＋share-export 7），全量中同批用例无回归。TDD 留痕：折算两例实现前实跑红（全缺省 received undefined≠3、混合 received 2≠3），实现后绿；core 全量 375/375（export 关键字零行为差异）。

### 诚实登记（本批挂账，features ④10 同口径）

1. **Gmind问题汇总.xmind rn=7 与其 XMind 截图 8 右差一支**：疑 XMind 8 手动拖拽分支后不刷新根扩展计数（文件存储值确实为 7）——导入忠实按存储值处理，不算不猜；要与 XMind 显示一致，在 XMind 拖动该分支并重存（强刷计数）后重导（features ④10/规则 4 同口径专项说明）。定位信息（同日终审 Minor#2 补记，当日读文件核实）：①**点名移位分支=按文档序第 8 支「设置」**——根下文档序为 场景/首页/harness使用总结/Ai/筛选/任务看板/协作/设置/文件/分支主题 6 共 10 支，rn=7 时前 7 支居右、它从 XMind 截图的右侧落到 Gmind 左侧；②**同名双文件指认**——工作目录 `/Users/guoyue/工作/个人项目/Gmind/Gmind问题汇总.xmind` 才是存 rn=7 的原件（XMind 8 格式 content.xml），Downloads 下同名文件是旧 Gmind 导出件（无 right-number，导入走兜底）。
2. **right-number 缺失文件的兜底算法仍为近似规则**（features ④10 延续）：v3「锚左＋空右交替」按复测文件校准，不表述为「与 XMind 算法一致」。
3. **mindmap 画布导出恒产 right-number**（折算修正的必然结果）：空画布产 '0'、全缺省模板产折算值——语义=引擎渲染断言，不再是「文件未存」的模糊态；T3 版「无侧别不产键」口径就此作废（§十五 T4 段已记）。

## 十六、2026-11-15 轮 2 筛选双层化补记（需求方三轮 AskUserQuestion 拍板）

### 需求方裁定原话要点（AskUserQuestion 三轮，2026-11-15）

1. **公共筛选不含 keyword**（推荐项，原型口径）：「原型里『我保存的视图』和公共筛选都不含 keyword，keyword 只在『当前这次筛选』里生效。」
2. **旧视图自动迁移**（推荐项）：「localStorage 里已存的旧视图如果带 scope:'me'，打开时自动转成『负责人=我』，效果与旧版一致，用户无感。」
3. **提示用 toast，话术「xx 更改了筛选条件」**（指定项）。
4. **冲突保护 = 正在做个人调整的人不被覆盖**（推荐项）：「如果自己有自己的筛选还没保存，那么就不发生变化。」

### 实现要点

- **core**：`meta.sharedFilter` doc 级新字段（`setSharedFilter` op，setTableView 同款形状——同值守卫、ORIGIN_SYSTEM 不进撤销栈）；`canonicalSharedFilter` 防御归一单源（constants.ts）；restore 排除（随 meta.title 先例「视图偏好不随版本回滚」）；repair 规则⑧扩展（非对象删键/带 keyword 剔除）。
- **web**：`Filters` 删 `scope`（TaskTable/MapFilterBar/EditorPage 三处清除）；`MapFilterBar` 双层 UI（「· 仅你可见」badge、`对所有人生效` publish、`恢复为公共筛选` restore、`✓已同步给所有人` synced）；`isEqualToShared` 逐字段比较（keyword 不参与）；旧视图 `scope:'me'` 迁移为 `owners:[meId]`；「我的待办」预设改 `owners:[meId]`。
- **协同跟随**：EditorPage 订阅 `meta.observe`——远端发布时按「事件前公共筛选 vs 当前筛选」判定（无个人调整→跟随 + toast；有个人调整→仅 toast）；`justPublished` 短路（自己发布时不跟随不 toast）；toast 昵称从 awareness presence 取（回退「有成员」）。
- **keyword 会话级**：`toSharedFilter` 去 keyword；`setSharedFilter` op 对带 keyword 键的入参抛 `SHARED_FILTER_INVALID`；`isEqualToShared` keyword 不参与。

### 交付用例（当日 grep 行号）

| 用例 | 位置 | 结果 |
|------|------|------|
| setSharedFilter 写入读回 / null 删除 / keyword 抛错 / 同值守卫 / 非对象抛错 / 不进撤销栈 | `packages/gmind-core/src/operations.test.ts` 「setSharedFilter（公共筛选持久态整体写入，轮 2 筛选双层化）」describe 块 | 6/6 通过 |
| sharedFilter 防御读取（非对象→undefined/字段级防御/合法透传） | `packages/gmind-core/src/read.test.ts` 「sharedFilter 防御读取」describe 块 | 3/3 通过 |
| restore sharedFilter 不随版本回滚 | `packages/gmind-core/src/restore.test.ts` 「restore：sharedFilter 不随版本回滚」describe 块 | 1/1 通过 |
| sharedFilter repair 归一（非对象删键/keyword 剔除/合法零替换） | `packages/gmind-core/src/repair.test.ts` 「sharedFilter 归一」describe 块 | 1/1 通过 |
| 基础双层 + 协同跟随 + 冲突保护 + 恢复 + keyword 隔离 | `apps/web/e2e/filter-two-tier.e2e.spec.ts` 四用例 | 4/4 通过 |

### 门禁五件套（2026-11-15 收官）

- lint 0 / typecheck 0
- 单测 1213 = shared 43 + xmind-io 88 + core 386 + engine 428 + server 77 + web 191
- server e2e 217/217
- web e2e 226 过 + 1 skip、零 flaky

## 十七、2026-11-16 轮 3 顶栏在线绿点补记（原型 CollabStack 对齐）

### 需求

原型 `CollabStack`（`Gmind脑图表格产品/src/components/ui.tsx:55-92`）：在线优先排序、在线绿点、离线置灰、溢出 +N title 显示明细。

### 实现

- `MemberChipAvatar` 加 `online` 属性：在线时右下角绿点（`members-stack-online-dot`，`bg-ok ring-2 ring-white` 原型值），离线时置灰（背景 `#e5e6eb`、文字 `#a9aeb8`）。
- 顶栏头像堆排序：在线在前（按昵称字典序）、离线在后；溢出 +N title 逐行显示 `昵称 · 在线/离线`。
- 在线判定 = `presence`（`members` state）里有这个人；`onlineUserIds` = `new Set(members.map(m => m.userId))`。

### 涉及文件

- `apps/web/src/pages/EditorPage.tsx`——`MemberChipAvatar` 加 online 属性 + 绿点/置灰；头像堆排序 + 溢出 title；`onlineUserIds` 派生。
- `apps/web/src/pages/editor.css`——`.members-stack-avatar-wrap`、`.members-stack-online-dot`、`.members-stack-avatar-offline`。

### 交付用例

- `apps/web/e2e/collab.e2e.spec.ts`「顶栏头像堆：在线绿点 + 在线优先排序 + 离线置灰」——A/B/C 同开一文件 → 三绿点；C 关闭 → 2 绿点 + C 离线置灰；在线优先排序断言。

### 门禁五件套（2026-11-16 收官）

- lint 0 / typecheck 0
- 单测 1213（web 191）
- server e2e 217/217
- web e2e 224 过 + 3 flaky + 1 skip

## 十八、2026-11-16 轮 4 登录页＋设置页视觉对齐补记（纯视觉收尾，功能零改动）

### 范围

原型 11-14 版视觉规格对齐：登录页左侧 InfiniteMap 无限延伸动效 + 右侧表单样式规格；设置页卡片/输入框/按钮/开关样式规格。

### 红线

全部 testid 与既有文案逐字不动——login-page/settings/error-copy e2e 全绿零改动。

### 实现

- 登录页：左侧 hero 装饰区换成 `InfiniteMap` 组件（原型 168 行移植）；右侧表单输入框 40px 高/圆角 10px/聚焦品牌蓝 ring、按钮 42px 高/圆角 10px、验证码行按钮 40px×96px；卖点加「无限节点」。
- 设置页：卡片 padding 24px、输入框 40px 高/圆角 10px、按钮 36px 高/圆角 10px、通知偏好开关改原型 Switch 样式（24px×44px 圆角全圆、品牌蓝底/灰底、滑动圆钮）。
- 换绑区/昵称行内编辑按钮高度对齐 36px。

### 涉及文件

- `apps/web/src/pages/LoginPage.tsx`——InfiniteMap 替换旧 hero-art；卖点加「无限节点」。
- `apps/web/src/pages/InfiniteMap.tsx`（新建）——原型 InfiniteMap 移植（168 行，SVG 无限延伸脑图示意）。
- `apps/web/src/pages/SettingsPage.tsx`——通知偏好开关改 `.pref-switch`（`<button role="switch">` 替代 `<input type="checkbox">`）。
- `apps/web/src/styles.css`——表单输入框/按钮/验证码行/设置卡片/开关样式规格对齐。

### 交付用例

- login-page.e2e / settings.e2e / error-copy.e2e 全绿零改动（红线守住）。

### 门禁五件套（2026-11-16 收官）

- lint 0 / typecheck 0
- 单测 1213（web 191）
- server e2e 217/217
- web e2e 227 过 + 1 skip、零 flaky

## 十九、2026-11-16 头像刷新全链路＋弹框交互修复补记

### 范围（需求方当日反馈两批）

1. **头像刷新**：设置页换头像后左下角导航头像、编辑器成员堆不同步；首页/我的文件/最近文件的文件创建者头像显示首字符（如「张」）而非真实头像；进入页面应刷新出其他人最新头像。
2. **弹框交互**：通知下拉、导航栏用户设置菜单点击其他位置不消失；文件详情页右上角本人头像 avatar-me 及其个人中心弹框**整体删除**（需求方裁定，账号设置/退出登录由工作台侧栏用户卡承接）。

### 实现

- 头像 URL 统一经 `avatarSrcOf`：上传键 `users/{id}/...` 转 `/api/images/...`（`WorkspacePage.OwnerAvatar`、`EditorPage.MemberChipAvatar`）；`Avatar`/`MemberChipAvatar`/`OwnerAvatar` 加 onError 回退首字符 + avatar 变化重置失败态；文件创建者头像悬停 title 显示昵称。
- 换头像后：`SettingsPage` 清 `collab.ts` 模块级 me 缓存（新增 `clearMeCache`）+ dispatch `gmind:avatar-updated`；`WorkspaceShell`（重拉 /users/me）、`WorkspacePage`（重拉文件列表）、`useTaskMembers`（重拉 collaborators）各自监听刷新。**该事件仅当前浏览器窗口有效**；其他人最新头像由进入页面时重新拉取 collaborators/files 保证，不做跨用户实时广播。
- 通知下拉（`NotifyBell`）与侧栏用户菜单（`WorkspaceShell`）各加 document pointerdown 外点关闭（wrap 内含触发按钮，toggle 语义不被打断）。
- `EditorPage` 删除 avatar-me 按钮 + personal-menu 弹框 + personalOpen/logout 链路；`editor.css` 删 .avatar-me/.personal-* 样式块；`.toolbar-members-btn` 宽度改按内容自适应（原固定 28px 装不下头像堆+角标，avatar-me 删除后溢出顶出工具栏）；`.members-stack-avatar-wrap` 补 -6px 重叠偏移（轮 3 包 wrap 后重叠失效的顺带修复）。

### 涉及文件

- `apps/web/src/editor/TaskFields.tsx`、`apps/web/src/editor/collab.ts`、`apps/web/src/pages/{SettingsPage,WorkspaceShell,WorkspacePage,EditorPage}.tsx`、`apps/web/src/pages/editor.css`。
- 测试：`apps/web/e2e/notify.e2e.spec.ts`、`workspace.e2e.spec.ts`、`member-center.e2e.spec.ts`、`toolbar.e2e.spec.ts`、`mobile-readonly.e2e.spec.ts`。

### 交付用例（2026-11-16 当日 grep 行号）

- `notify.e2e.spec.ts:100`「通知下拉：点击外部立即收起，再点铃铛可重新打开」——新增，先红后绿。
- `workspace.e2e.spec.ts:292`「用户菜单：账号设置入口 + 退出登录清 token 回登录页」——扩外点关闭断言，先红后绿。
- `member-center.e2e.spec.ts:42`「顶栏右缘：成员钮角标与可访问名…本人头像入口已删除」——改写，钉 avatar-me/personal-menu 零渲染；原「个人中心」用例随功能删除。
- `toolbar.e2e.spec.ts:66/131`——EXISTING_TESTIDS 移除 avatar-me、组序断言改 members-btn 最右；单行不溢出断言在成员钮自适应修复后复绿。
- `mobile-readonly.e2e.spec.ts` EDITING_TESTIDS 移除 avatar-me。

### 外点关闭审计（需求方要求「列出来再决定」，仅记录未改）

- **文件卡片 ⋯ 菜单**（`WorkspacePage.tsx` card-menu/file-row-menu）：无外点监听无遮罩——点其他位置不收，只能再点 ⋯ 或选菜单项。
- **筛选弹窗**（`MapFilterBar.tsx:185-193`）：有外点关闭但用 mousedown——画布 onSvgPointerDown 的 preventDefault 会抑制兼容性 mousedown，点画布空白可能不收（编辑器其他弹层因此统一改 pointerdown 的先例见 EditorPage 导出菜单注释）。
- 其余已具备外点关闭：编辑器工具栏各面板（统一 pointerdown）、表格各弹层（tt-overlay 遮罩）、分享弹框（遮罩点击）、新建下拉（遮罩）、画布页签菜单/成员面板邀请候选（pointerdown）、组织管理分组弹层（遮罩）、图片预览右键菜单（点击预览层即收）。

### 门禁五件套（2026-11-16 收官）

- lint 0 / typecheck 0
- 单测：无新增单测（纯 UI 交互与样式，背书走上述 e2e）；存量全量随门禁复跑
- server e2e：未触碰服务端，随全量门禁复跑
- web e2e 全量 231 过 + 1 skip、零失败零 flaky（2026-11-16 收官实测）

## 二十、2026-11-18 卡片菜单＋筛选弹窗外点关闭补记

### 范围

§十九 审计列出、需求方当日拍板「两项都改」：
①文件卡片 ⋯ 菜单（`WorkspacePage.tsx` card-menu/file-row-menu）——新增 document pointerdown 外点关闭（豁免 `.card-ops`/`.file-row-ops` 操作区，⋯ 按钮 toggle 不受打断）；
②筛选弹窗（`MapFilterBar.tsx`）——外点监听 mousedown → pointerdown，修「画布空白点击收不起」（画布 onSvgPointerDown preventDefault 抑制兼容性 mousedown）。

### 交付用例（2026-11-18 当日 grep 行号，均先红后绿）

- `workspace.e2e.spec.ts:292`「卡片 ⋯ 菜单：点击外部自动收起，再点 ⋯ 可重新打开」——新增。
- `filter-two-tier.e2e.spec.ts:54`「筛选弹窗：点击画布空白自动收起（pointerdown 外点关闭）」——新增。

### 门禁

- lint 0 / typecheck 0；受影响套件 workspace 20/20＋filter-two-tier 全过；全量 web e2e 233 过 + 1 skip、零失败零 flaky（2026-11-18 收官实测）。
- 文档：`docs/features/filter.md` 规则 12 新增、project-status 跟进。

## 二十一、2026-11-18 设置页原型对齐补轮（结构级，需求方两项拍板）

### 范围

轮 4 仅对齐样式规格，本轮对齐原型 `Settings.tsx` 的结构性细节（需求方 2026-11-18「先做分析，确定疑问点后开始改」；两项疑问 AskUserQuestion 拍板：**手机号改掩码（跟原型）**、**账号资料卡补部门/分组只读行（跟原型）**）。

### 实现

- **头像卡**：预置头像选中态（蓝圈 + 右下角蓝色小勾，`aria-pressed` 钉契约）；上传按钮虚线框 + Upload 图标；新增底部说明「支持 JPG、PNG，2MB 以内；协作成员、评论与任务负责人处都会显示该头像」；预置图标 36→40px。
- **账号资料卡**：新增部门/分组两行只读（`profile-dept`/`profile-groups`，数据源 GET /org/directory 取本人 membership，未分配/接口失败显示「无」）+ 说明「部门与分组由管理员在"组织管理"中调整」。
- **换绑账号卡**：邮箱/手机号小标题加 Mail/Smartphone 图标；当前绑定手机号改掩码 `138 **** 1234`（`maskPhone`；「未验证」徽标保留——真项目既有口径，原型无此徽标）。
- **绑定微信卡**：按钮加 MessageCircle 图标。
- **通知偏好卡**：按事件类型区包灰底圆角容器（`notify-pref-group`）+ 每项图标（AtSign/Reply/ShieldCheck）；邮件摘要总开关关闭后说明文案切换为「邮件摘要已整体关闭，以下选项暂不生效。」（原说明文案保留在开启态，逐字未动）。
- `lucide-data.tsx` 补 6 枚原型图标（Mail/Smartphone/MessageCircle/AtSign/Reply/ShieldCheck，lucide 同源路径）。

### 红线

既有 testid 全部保留（新增 testid 仅 profile-dept/profile-groups/notify-pref-group）；既有文案逐字未动（新增说明文案除外）。

### 交付用例（2026-11-18 当日 grep 行号，均先红后绿）

- `settings.e2e.spec.ts:113` 换绑手机号——断言改掩码（`138 **** xxxx` 且不含完整号码）。
- `settings.e2e.spec.ts:131` 账号资料——新增部门/分组「无」与说明文案断言。
- `settings.e2e.spec.ts:49` 头像区——新增选中预置 `aria-pressed` 断言。
- `settings.e2e.spec.ts:172` 新增「邮件摘要总开关关闭：按事件类型区提示『暂不生效』且开关禁用」。

### 门禁

- lint 0 / typecheck 0；settings.e2e 9/9；全量 web e2e 233 过 + 1 flaky + 1 skip（flaky=filter-two-tier:165 恢复公共筛选，重试即过，与本轮无交互；2026-11-18 收官实测）。
- 文档：本节 + project-status 跟进 + README 进度行。

## 二十二、2026-11-18 设置页视觉规格逐项校准＋摘要细项开关语义反转补记

### 范围

需求方对照原型截图指出「按钮大小、提及/回复/权限的位置和样式、表单大小没还原」。逐项按原型 `Settings.tsx` 规格校准；细项开关语义经 AskUserQuestion 拍板**跟原型反转**。

### 实现（均为样式/展示层，服务端零改动）

- 表单输入框：max-width 320→**340px**、width 100%、hover 边色 #c9cdd4、聚焦 ring 3px→4px/10%；昵称编辑态输入框 36px 高 / 224px 宽；换绑验证码行 max-width 同步 340（按钮 96px 宽原有）。
- 主按钮：补 font-size 14px（36px 高 / 圆角 10 / 600 字重原有）。
- 通知偏好行：上下 padding 8→**14px**、虚线分隔改细分隔线 #eceef1、标题字重 500；`.pref-text` 补 `flex:1`——修「图标在左、文字被 space-between 挤到中间」的错位（截图实证后修复）。
- 灰底分组背景色按原型 token `--color-canvas: #f5f6f7`（含图标底盒）；卡片纵向间距 20→16px（`.ws-content.settings-page` 覆盖）。
- 手机号小标题括号说明改灰色正常字重（原型 font-normal text-ink-3）。
- **细项开关语义反转（需求方拍板）**：蓝=接收该类型邮件提醒（默认全蓝），点灭=关闭提醒；仅 `aria-checked` 显示反转（`!optOut.has`），`emailOptOut` 存储语义与点击链路不变。

### 交付用例

- `settings.e2e.spec.ts:157`「偏好开关切换 → 刷新仍保持」——改钉新语义（默认全蓝、点灭提及、刷新后提及灭/其余蓝），先红后绿；其余 8 用例零改动全绿。
- `settings.e2e.spec.ts:174` **装载竞态产品 bug 修复**（全量 flaky 追根）：初始 GET 旧偏好晚于用户 PATCH 到达时会「回冲」用户刚做的开关选择——`SettingsPage` 加 `prefsVersionRef`，用户每次点开关 +1，reload 响应落地时版本已变则跳过偏好三态覆盖（me 身份照常）。复现用例用 route.fetch 先取真实旧响应再延迟 fulfill，红→绿；摘要总开关用例同步保留 waitForResponse 硬等待。
- 视觉核对：Playwright 截图逐项比对（整页/头像卡/通知卡/换绑卡），通知行错位经截图复验修复。

### 门禁

- lint 0 / typecheck 0；settings 10/10（含新增装载竞态用例红→绿）；全量 web e2e **241 过 + 1 skip、零失败零 flaky**（2026-11-18 收官实测；总数较此前 +8 为另一批分享功能新增用例）。

## 二十三、2026-11-18 分享弹窗导出页原型对齐补记

- 导出页顺序按原型调整为 XMind、图片、Markdown、Excel、CSV；行卡片间距与固定底部下载位置说明对齐。
- 仅调整展示与顺序：五种导出仍走原真实通道，CSV/Excel 保持已验收 7 列，JPG 保持当前折叠态与白底 2×，XMind/Markdown 规则不变。
- `share-export.e2e.spec.ts` 既有五项可见性与五类真实下载用例全部通过；`share-dialog.e2e.spec.ts` 同时覆盖固定高度与普通协作者默认导出。最终门禁数字见 `docs/m3b-acceptance.md` 2026-11-18 补记。

## 二十四、2026-11-18 e2e 真发信打爆发件额度事故防线

### 根因

2026-11-14 开发环境改真发信后，web e2e 每造号一次即调 `/auth/email-code` 真发一封验证码邮件；全量数百测试账号（均为 `@e2e.gmind.dev` 测试域名）把真实 SMTP 发件额度打爆，需求方发件箱被服务商限发。

### 修复（单点收口）

`apps/server/src/mail/mail.service.ts` `sendMail`：**非生产环境**且收件人以 `@e2e.gmind.dev` 结尾 → 只 log 不真发、返回 false（EmailCodeService 的 dev 容错路径照常放行，测试用万能码 123456 不受影响）。验证码/通知/摘要/邀请全走此函数，一处拦截全覆盖；真实邮箱域名与生产环境不受影响。

### 背书

`mail.service.test.ts` 新增 3 用例（非生产 e2e 域名不真发 / 非生产真实域名照常发 / 生产不设闸），先红后绿；server 单测 81/81、typecheck/lint 0。

## 二十五、2026-11-18 左下角导航头像「换头像不生效」根因修复

### 根因（需求方追问「为什么没根本解决」）

前一轮头像修复只覆盖了「换头像后重新拉取数据」一层；左下角真正的断点是**字段名错配**：服务端 `fullUserView`（GET /users/me）返回 `avatarUrl`，`WorkspaceShell` 却读 `me.avatar`——恒 undefined，`Avatar` 回退到按 userId 自动分配的预置头像，用户永远看到「旧头像」。重拉数据无法治愈字段名错配。文件详情页正常是因为其数据走 collaborators 接口（字段恰好对齐）。

### 修复

`WorkspaceShell.tsx`：`ShellMe.avatar` → `avatarUrl`（与服务端视图单点同形），左下角用户卡取值同步改 `me.avatarUrl`。上传键本身每次上传均为新 ULID（`users/{id}/{ulid}.{ext}`），无 URL 缓存残留问题。

### 背书

`settings.e2e.spec.ts:49` 头像用例新增断言：选预置后 `.ws-user-card img` src 必须等于所选预置。修复前失败（偶发通过=默认预置恰好相同，1/5 概率掩盖），修复后 repeat 3/3；typecheck/lint 0。
