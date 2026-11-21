# 任务系统第一轮验收（2026-11-20）

> 范围：画布多人任务规则第一轮（spec `docs/superpowers/specs/2026-11-20-canvas-task-model-design.md`，plan `docs/superpowers/plans/2026-11-20-canvas-task-model.md`）。实施：Task 1 由并行会话交付（本会话审读沿用），Task 2/3/4 由本会话接手完成。全部改动停「改完验证绿」工作区状态，未提交。

## 自动化背书（门禁五件套，四轮整改后当日实测）

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| lint / typecheck | 全清 | 全仓 0 错误 |
| 单测 | shared 54/54、core 426/426（bench 首跑 3094ms 超时、复跑 2522ms）、engine 432/432、web 203/203、xmind-io 88/88、server 84/84 | core bench「1 万次混合操作」3000ms 阈值为已登记机器负载敏感存量（全量并发下首跑超时，单跑复跑通过） |
| server e2e | 227/227 | 首跑 226/227（auth password-reset 发码 403 并发限流波动，单跑 14/14），完整复跑全绿；含迁移/备份/乐观回写/待办重开新用例 |
| web e2e | 249 passed + 3 flaky + 1 skipped（退出码 0） | 3 flaky=canvas-tabs:46 / collab:567 / toolbar:184，均重试通过；含任务/待办/导出按新口径迁移的用例与四轮整改新增用例 |

## 真实用例（当日 grep/实测，非转抄）

### core 迁移与恢复（单测）
- migrateTaskModel：单负责人转写/多负责人建列/人员加权复刻（(50+30×2+80)/4=48）/number 简形归一+空 owners 有效进度/done 异常保完成事实（含不伪造日期）/多画布单列/幂等零写/列上限抛错零变更/新模型零迁移/全管线装载——`doc.test.ts` 10 用例
- 恢复：ownerId/ownerProgress/autoProgress 覆盖、custom 逐人 diff+多余列删除、done+子进度未完不强补（normalize 后仍 50/100）、整树收敛含 custom——`restore.test.ts` 4 用例
- repair 逐条目剔坏（坏条目删、好条目与 weight 保留）——`repair.test.ts` 1 用例；undo 换负责人撤销还原——`undo.test.ts` 1 用例

### 真实浏览器走查（Playwright 直跑，截图 `gui-test-screenshots/wt-task-model/`，脚本 `apps/web/e2e/wt-task-model.mjs`）
1. S1a 0%→进行中弹进度选择并写入 30% ✓
2. S1b 任务行右侧显示总进度 30% ✓
3. S2a 完成三选弹窗列出未完成子进度（owner-a 执行进度 40%）✓
4. S2b「仅完成保留子进度」→ done + 人员 40% 保留 ✓
5. S2c 表格负责人列显示总负责人（ownerId 口径，本轮走查揪出旧口径「未分配」显示并修复）✓
6. S3 重开显式选 65% 生效 ✓
7. S3b 完成三选「完成并全部改为 100%」→ done + 人员 40%→100%（原子命令真实浏览器用例）✓
8. S4 三视图总进度一致（完成态脑图 100% = 表格 100%）✓
9. S5 旧模型迁移由 server e2e 钉死（versions.e2e）✓

### 诚实登记
- **独立评审（2026-11-20 需求方裁定「你来评审吧 不用k3了」，由主会话亲自挑刺复查）**：按 plan Review Focus 逐条核对（迁移不丢人/并发覆盖/完成旁路/恢复部分写入/跨视图口径），发现 2 项并修复：① **Important**——blocked 0% 节点点「进行中」不弹进度选择、直写撞 core 门禁抛错（UI 弹窗条件与 core 门禁不一致，TaskPanel/TaskTable 两处对齐修复）；② **Minor**——迁移对 crafted 非法 status 回退 todo 与 progress 显示不一致（改按 progress 派生）。两项均补自动化用例钉死（core 1 + e2e 1）；其余核对通过（completeNodeTask 幂等/重入/原子命令、恢复旁路、逐人 diff、自动父折叠、迁移幂等与列上限零变更、undo 通道）。Kimi K3 验收通道自此退役为主会话评审（需求方当日拍板）。
- **四轮 code-review 整改（同日，需求方指令「先评审 需要优化的进行修改」）**：① 首轮 10 项 Important——迁移无 owners 键人员保留/weighted=false 权重失效/旧单画布探针预建版本/换负责人同值恢复/状态·逾期·排序·筛选·导出·缩略图切派生口径/面板·表格·档位全入口完成确认/待办重开选进度，全部 RED→GREEN；② 二轮 10 项——离线待办迁移备份、表格负责人单选（setTaskOwner）、自动开关不伪造 doneDate、迁移后状态 100→done、迁移回写后重建索引、脑图派生状态色、重开严格整数、根任务派生、core 重开区间校验；③ 三轮 9 项——TaskPatch 类型排除、人员列逐人回调（远端并发不再覆盖）、迁移列类型冲突中止、备份按字节判重+命名锁、隐藏 owner 子进度不进预检、自动父禁手动完成（core/待办双入口）、autoProgress 进任务视觉、XMind 导出重算总进度徽章；④ 四轮 5 项——迁移回写乐观并发（doc_state 仍为原字节才覆盖）、锁提交后释放+GET_LOCK=1 校验、进度徽章也禁手动完成自动父、无其他执行人时 owner 隐藏子进度环+画布选盘提示、面板取消弹窗重挂输入框。四轮共 34 项全部修复并有自动化背书；nit 项（重开标题与所选进度一致）随第三轮一并修正。
- **todos 索引最小修复**：任务索引负责人判定切 ownerId（ownerId 优先/owners 回退）——属「第二轮不做但不得提前破坏」条款的最小接线，参与人收录/角色仍留第二轮。
- **重开弹窗焦点循环**已按 RenameFileDialog 同款补齐（捕获 Escape/Tab 循环/焦点归还/组合输入守卫），本条关闭。

---

# 任务系统第二轮验收（2026-11-21）

> 范围：画布任务第二轮（spec `docs/superpowers/specs/2026-11-21-task-round2-design.md`，plan `docs/superpowers/plans/2026-11-21-task-round2.md`）：索引扩展与待办 API、待办页/待办空间改版、任务动态链路、筛选参与人。改动停「改完验证绿」工作区状态，未提交。

## 自动化背书（门禁五件套，当日实测）

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| lint / typecheck | 全清 | 全仓 0 错误 |
| 单测 | shared 54/54、core 429/429、engine 432/432、web 205/205、server 84/84、xmind-io 88/88 | core 含 participants 归一 2 例（read/repair/operations/restore 既有断言随新字段同步）；server 单测补 collab.service 事件桩 |
| server e2e | **240/240** | 全量套件含新增 13 例（todos 第二轮 9 + collab 任务动态 4——含评审修复环追加的 activity 范围/limit/坏 payload 用例与伪完成丢弃/after 现值覆盖断言）；首跑曾出现 1 例「完成勾选」404 偶发（同用例单跑两次 + 全量复跑均绿，登记为环境级 flake 待观察）；两次「Connection is not established」为 app 关停后 fire-and-forget 重建的清理竞态，仅留痕不影响用例 |
| web e2e | **257 passed + 1 flaky（重试通过）+ 1 skipped**（3.7 分钟，退出码 0） | 修复环重跑；flaky=canvas-tabs:46（既有偶发，retry 通过）；含新增 todos 第二轮 2 例、activity 任务动态 1 例、filter 参与人筛选 1 例 |

## 真实用例（当日 grep/实测，非转抄）

### server e2e（`apps/server/test/todos.e2e-spec.ts` 第二轮 describe 8 例 + `test/collab.e2e-spec.ts` 任务动态 describe 4 例）
1. 全画布覆盖+参与人圈范围：member 见 3 行（含第二画布/纯参与节点），canvas 字段齐、myRole/participants 断言 ✓（todos.e2e:275 起）
2. 派生口径：自动父索引进度=直属真正任务均值（40+80→60），status doing；admin 参与人视角 mySubProgress=30 ✓
3. task_participant 落表：同节点多列同人各一行（col-a/col-b），负责人 owner_progress NULL ✓
4. PATCH mySubProgress 全来源一起改：两列条目 + ownerProgress 同值 88，page 行回显 88 ✓
5. PATCH mySubProgress：参与人单独写自己条目；无权限者 404、与任务无关协作者 400 两段式、与总进度混传 400 ✓
6. report 拆计数：admin total 5 = responsible 3（自动父+两子）+ participating 2（任务A/纯参与）；member total 3 = 2+1 ✓
7. 旧口径行兜底：canvas_id 置 NULL 后 rebuildIfStaleInBackground 重建补齐画布名/owner_progress ✓
8. setOwnerProgress 独立写入后 mySubProgress 跟随（负责人无人员条目场景）✓
9. 盖章：连接身份覆盖伪造 actor、taskText/related 服务端文档现值、声明不转发给其他连接 ✓（collab.e2e 任务动态 describe）
10. viewer 连接声明丢弃；形状非法/伪造 nodeId/未知 kind 丢弃；POST /api/events task_* 前缀 400 ✓
11. todos PATCH 直记：progress→task_progress、done→task_complete（actor=登录身份，after.progress=100）✓
12. 自动父派生变化补记：子任务 40→80 后重建 diff 记 task_progress（derived:true，40→80，操作者=PUT 发起者）✓

### web e2e（新增 4 例）
13. 我的待办第二轮：画布两级分组（画布 1/画布二）+ 角色徽章（执行人/总负责人）+ 我的子进度选盘写入（50→75）+ chip 计数 + 动态页签内容（选盘写入直记的 task_progress 75% 可见）+ 行点击跳编辑器 ✓（todos.e2e:112）
14. 待办空间第二轮：负责/参与拆计数（1/1）+ 明细参与人列（有参与非「—」）✓（todos.e2e:175）
15. 任务动态：面板指派负责人 → stateless 声明 → 盖章落库 → 文档动态抽屉出现「指派了负责人」条目（taskText=节点文本、操作人=登录用户）✓（activity.e2e:98）
16. 参与人筛选：多选块渲染（我+文档内成员）+ 勾选后表格仅显示命中行（任务B 1 行、任务A 0 行）+ 发布后文档 meta SharedFilter.participants 落盘且 owners 空 ✓（filter-two-tier.e2e:254）

### 过程锚点（非转抄，当日实测）
- 迁移 TaskParticipant20261121100000 在 dev 库 migration:run 实跑成功（建表+加列）；e2e gmind_test 由 db-init 重放覆盖（表清单断言含 task_participant）
- 探针实测两处：自动父派生值计算（单子任务 40→80 → 父 40→80，修正测试断言算术错误）；「画布节点点击后首次工具栏点击双触发 onClick」为 HEAD 既有怪相（HEAD 检出对照复现，非本轮回归，登记于 §挂账）

## 独立评审与修复环（2026-11-21 当日闭环）

独立评审（只读子代理，全文件逐行 + typecheck 实测）结论：**无 P0**；P1×3 / P2×5 / P3×8。修复环处置：

| 编号 | 处置 | 说明 |
| --- | --- | --- |
| P1-1 chip 残留清空已完成页签 | **已修** | 过滤加 `tab !== 'done'` 门（TodosPage；chip 隐藏的页签不参与过滤） |
| P1-2 activity 零测试 | **已修+揪出真 bug** | 新增 server e2e：相关人可见/文件可见无关者不可见/无权限空/limit 收拢/坏 payload 防御——**测试写出来即暴露 LIKE 模式 `%`/`"` 顺序写反**（`CONCAT('"%',…)` 缺前导 %，「与我相关」此前对 related 事件恒查不到，只有自己操作的事件可见），已修正为 `CONCAT('%"', …)` |
| P1-3 GROUP_CONCAT 截断 | **已修** | page/report 的参与人改二次查询应用层聚合（`participantsByTask`，按 file IN 拉回 JS 分组），无 1024 字节截断面 |
| P2-1 after 数值面 | **已修** | 盖章时 after 以内存文档现值覆盖（status/progress）；`task_complete` 且现值<100 丢弃；before 保留声明值（无从校验，登记已知限制）；collab e2e 增伪完成丢弃 + 现值覆盖两断言 |
| P2-2 滑条刷屏 | **登记** | todos.md ③ 增「滑条一次拖动≈20 条事件+重建」量级行；服务端短窗合并挂账 |
| P2-3 重建并发回退 | **已修** | TaskIndexService 按 fileId promise 链串行（enqueueRebuild）；todos 离线直改路径走同链 |
| P2-4 台账义务 | **已完成**（评审时点误报） | 验收文档/状态表/README 在评审启动后已写入（评审员读的是启动时快照） |
| P2-5 命中即拦截不一致 | **已修** | 解析出 task-event 后一切失败路径统一拦截 |
| P3-1 同值事件 | **已修** | recordPatchEvents 加 progress/status 同值守卫 |
| P3-2 断线表述 | **已修** | provider.send 断线入队、重连补发——taskEvents.ts/todos.md 措辞修正 |
| P3-4 命名风格 | **已修** | TaskEventPayloadOf → parseTaskEventPayload |
| P3-5 commitOwner 弹层 | **已修** | 恢复「保存成功才关弹层」语义 |
| P3-3 console.error | **不改** | collab.service 落库失败与 storeDocument 同款 console.error 风格，保持一致 |
| P3-7 双连接真并发落行 | **挂账** | 逐人 diff 写有 core 单测背书，顺序双账号 e2e 已覆盖主路径 |
| P3-8 降渐参与人 e2e | **挂账** | 表格/计数两处已由 filter-two-tier 钉住，降渐同一段判定逻辑 |

## 已知限制（如实登记，与 spec §5.5/§5.4 一致）
- 断线期间本地编辑不产生动态事件；撤销/重做不经声明入口不留事件；事件不做同人短时合并。
- 旧索引行（canvas_id IS NULL）显示「未知画布」，文件打开一次修复；不做部署期全量离线重建。
- 旧客户端归一会丢弃 SharedFilter.participants（全员同版本部署无影响）。
- 动态 related 由客户端声明 + 服务端文档现值收敛；伪造 related 只影响声明者自己的可见范围（不影响他人数据）。
- server e2e 全量偶发 1 例 404 flake（同用例复跑绿），待后续观察是否复现。

## 挂账（评审 minors/顺延项）
- 「画布节点点击后首次工具栏点击双触发 onClick」（HEAD 既有）：面板/抽屉类首次点开闪开即关、需点两次；本轮 e2e 以重试容忍，根因（事件双派发）未查——顺延为独立修复任务。
- ActivityPanel 任务事件摘要渲染依赖 task_ 前缀在开放上报端点 400 保留；若未来放开该保留需同步收紧渲染白名单。
- 待办页「动态」行点击跳文件不定位节点（裁定 5 现口径）；如需深链定位另立任务。

---

# 任务系统第二轮追加批验收（2026-11-21 需求方两条新需求）

> 范围：① 待办页分组 chips 只显示能筛出内容的分组；② 每用户参与范围配置（我的待办+统计面板参与的文件/画布，默认全关联、可排除，两页同入口、动态跟随、服务端入库——四项口径当日 AskUserQuestion 确认）。

## 自动化背书（门禁五件套，追加批当日实测）

| 门禁 | 结果 | 说明 |
| --- | --- | --- |
| lint / typecheck | 全清 | 全仓 0 错误 |
| 单测 | shared 54、core 429、engine 432、web 205、server 84、xmind-io 88 全绿 | 与修复环终态一致（本批未动包内逻辑，新增面在 server todos 域 + web 页面） |
| server e2e | **241/241** | 新增 1 例：参与范围配置（GET 清单含画布、画布级/文件级排除幂等、page/report/activity 三处同口径生效、恢复、无权限文件 404） |
| web e2e | **258 passed + 1 flaky（collab:660 重试通过）+ 1 skipped** | 新增 1 例：配置弹窗开关即时生效（列表/统计卡同步归零与恢复）+ 分组 chips 无关分组不渲染 |

## 真实用例（当日实测）

### server e2e（todos.e2e-spec 第二轮 describe 末尾追加）
1. GET /api/todos/scope：可见文件在列、画布清单含「画布 1/画布二」（来自 task_index 去重）、默认 excluded=false ✓
2. 画布级排除「画布二」：重复 PUT 幂等；member page stats.all 3→2、画布二任务消失、任务A 仍在；scope 读侧排除态回显 ✓
3. 恢复画布参与：stats 回 3 ✓
4. 文件级排除：member page 归零、report total 归零、activity 不含该文件事件；**admin 不受影响**（各自配置）✓
5. 恢复文件参与：page 回 3 ✓
6. 无权限文件 PUT → 404 ✓

### web e2e（todos.e2e-spec 追加 1 例）
7. 分组 chips：任务相关人无组织分组 → chips 行仅「我的子进度未完成」，无「全部分组」与分组 chip（旧实现列出目录里全部分组）✓
8. 配置弹窗：todo-scope-toggle 打开 → 文件开关 aria-checked=true → 关掉后列表即时消失 + 统计卡 todo-count-all 同步归 0（服务端同口径）→ 打开恢复 → 关闭弹窗 ✓

### 真实走查（wt-task-round2.mjs，12/12 全过，截图 gui-test-screenshots/wt-task-round2/）
9. S11 分组 chips 只显示有内容分组（走查账号无分组 → chips=1）✓
10. S12 配置弹窗关/开文件即时生效（关后待办 0 行、开后 2 行）✓，截图 07/08

## 需求方走查缺陷修正（2026-11-21 追加批当日，真实账号 goyeee@163.com 实测发现）

需求方在 /todo-space 用真实账号（goyeee@163.com=张国跃）走查发现两个缺陷，当日定位修复：

1. **成员名字显示错误**（冯武鑫显示成「成员 J18V」）：根因=页面名字解析只认组织目录（directory 只收录有部门/分组挂靠的账号），纯任务协作用户查不到掉「成员+id尾段」兜底——而服务端 report.byOwner.name 本来就是 users 表昵称（namesFor 回填），页面覆盖时把它丢了。张国跃显示正常纯属「登录者本人走 /users/me」的巧合。**修复**：名字解析三段兜底（本人 → 目录 → 服务端 byOwner.name → 成员+id尾段），TodoSpacePage nameById 映射（useMemo）。
2. **选成员行下钻明细为空**：根因=明细池与统计池不一致——统计聚合=可见文件**全部任务**，明细=page(me,…)=只有「我」是负责人/参与人的任务，他人任务永远不在明细池，选他人行下钻必空（冯武鑫 2 任务在池外）。**修复**：report items 改为独立 spaceItems 查询（scopeSql(false)+全状态+LIMIT 200，与统计同池）；顺带修活「已完成」状态 chip（此前 items 仅 open，chip 恒空）。数据库取证：冯武鑫（01M7TEMES5QW4ECJ5DF07HJ18V，users 表昵称确为冯武鑫）2 任务 doing 38/13 在张国跃可见文件内。
3. **头像显示错误**（需求方同场景补充反馈）：统计页「按人员」行头像恒为名字首字文本块（且首字取自错误兜底名「成」），从未渲染真实头像图片——两账号均有上传头像（users/<id>/… 键）。**修复**：report.byOwner 增 avatarUrl 存储键（profilesFor 查 users.avatar_url），页面有头像渲染 `<img class="space-avatar-img">`（avatarSrcOf 直出 /api/images/…，实测 200），无头像回退首字色块。

回归背书：server e2e 增 2 断言（byOwner.avatarUrl 回传、下钻/昵称修正的 web 断言），web e2e 增 3 断言（真昵称行、img.space-avatar-img 可见、他人行下钻命中与互斥）；全量门禁重跑见下。

4. **明细负责人列在「今日」范围下仍显示「成员 J18V」**（需求方修复验证时再发现）：根因=页面名字映射误用按时间范围过滤的 byOwner 建立明细池人员的解析源——明细池不分范围，范围外人员查不到又掉兜底。**修复**：report 新增 `people` 名单（聚合键 ∪ 明细池全部相关人，profilesFor 回填昵称+头像，与范围解耦），页面 nameById 改从 people 构建；e2e 增「切今日后明细负责人仍解析真名」断言。

## 账号管理分组缺陷修正 + dev 库测试数据清理（2026-11-21 需求方第二批反馈）

**缺陷**：账号管理页分组弹层「设置不上也关闭不了」（需求方在成员二号上实测）。定位（浏览器实测复现）：弹层勾选走「PATCH 全量替换 → 整表回刷」，而整表回刷（1294 账号分页+挂靠聚合）秒级耗时——回刷窗口内再次点击拿的是**旧 props 的全量列表**，快速连选互相覆盖（连点 3 组实测只剩 1 组）、取消同样失效。**修复**：弹层打开期间的勾选落**本地草稿**（groupDrafts Map），toggleGroup 以草稿为基准累积并发 PATCH、checkbox 选中态读草稿，慢回刷不再覆盖连点；关闭弹层清草稿（AdminUsersPage closeGroupsEditor）。浏览器实测：连点 3 组+取消 1 组全部生效（API groupIds 复核一致）、mask 关闭正常。回归 e2e：admin-users 新增「快速三连选全保留、逐个取消全生效（含接口复核）」用例。

**dev 库测试数据清理**（需求方指令「名称包含测试内容的账号及关联文件、测试分组/部门删除」，范围当日确认全删）：
- 账号 1294 → **7**（删 1287：e2e 自测号 1281 @e2e.gmind.dev + smoke9 冒烟号 5 + 成员二号 1；保留 演示管理员/陈默/周舟/许然/孙宁/张国跃/冯武鑫）
- 文件：删 4012（含回收站）+ 协作/星标/评论/版本/分享/邀请/事件/任务索引/参与人/范围配置等关联行按 file 与 user 双向清除；存量 61 个文件归属 7 个保留账号
- 分组 14 → **4**（删 10 个编号残留：前端组-53068 等四个 + 连选甲乙丙六个 e2e 残留）；部门 9 → **4**（删研发部-52312/52955/5714/87870/96794，保留账号的 department_id 已解挂为「未设置」）
- 对象存储孤儿目录清理：files/ 1701 → 13（1688 个已删文件目录）、users/ 头像目录与保留账号一一对应
- 备份：mysqldump 全库 `gui-test-screenshots/db-backup/gmind-before-cleanup-20261121-131219.sql`（15.4MB，可整体回滚）
- 已知边界：notifications 表无 file_id 列，保留账号的站内通知 payload 里可能残留对已删文件的引用（点击 404，不影响功能）；上一轮清理挂账的 smoke9 账号与研发部-52312 部门随本批清偿

## 账号管理布局病二次修正 + dev 库二次清理（2026-11-21 第三批，需求方反馈「点击编辑没反应 / 列表无法向下滚动」）

**根因（第一性）**：`.ws-content` 是 flex 纵向容器，`.admin-user-table` 带着为圆角设的 `overflow: hidden` 且未禁 flex 收缩——
①行多时表格被压进视口且不产生滚动条（滚动容器误以为内容不超高，13:42 e2e 重跑把库刷回 297 账号后行数足够才发作）；
②行内分组弹层（absolute 于 .groups-cell）被表格底边裁掉：弹层实际开着但不可见，需求方后续所有点击落在透明 mask 上——
即上一批「设置不上也关闭不了」的真实病根，上一批只修了连点覆盖、验证点位又恰好在表格上半区，故漏网。
**修复**：`styles.css` 表格改 `overflow: visible; flex: none`（滚动交还 ws-content），圆角挪到表头/末行；`.org-manage` 同病同修补 `flex: none`。
**实测**（IAB 真机）：真实滚轮滚动 scrollTop 0→709；张国跃/冯武鑫行（原先弹层全被裁的行）「+ 分组」弹层完整可见、复选框真实可点、mask 点击关闭正常；验证用勾选已撤销还原。

**e2e**：admin-users.e2e.spec 追加「组织管理小视口：列表可滚动，底部行分组弹层不被表格裁剪」（420 高视口锁死 overflow/flex 计算样式 + 底部行弹层真实可点，勾两次净零不留数据）；连选用例补 POST 201 状态断言（首次尝试曾遇 dev server 重启窗口静默失败）；顺手修连选用例一处既有 TS 隐式 any。当批 spec 7/7 绿（1 例重试绿）、tsc/eslint 全绿。

**dev 库二次清理**（判据同上一批，需求方当日已裁定全删；成因 = 13:42 web e2e 重跑再污染，非清理失效）：
- 账号 297 → **7**（删 290 个 13:12 后再生的 e2e 号）；文件 960 → **61**（删 899）；分组 9 → **4**、部门 6 → **4**（删编号残留 5+2，保留账号挂靠已解绑）
- 关联行按 file/user 双向清除；对象存储孤儿目录再清 22（35 → 13，与存活文件一一对应）
- 备份：`gui-test-screenshots/db-backup/gmind-before-reclean-20261121-134707.sql`（6.1MB）
- **挂账**：web e2e 套件跑一次即污染 dev 库（注册 e2e 号/建文件/建编号分组，且无删号 API），「测试结束删数据」当前靠手工脚本兑现——套件级自清理（测试专用清理端点或直连库方案）待需求方裁定后再做

## e2e 测试数据自动清理落地 + 完整套件实测（2026-11-21 第四批，需求方拍板「给测试套件做自动清理」）

**机制**（清偿上一批挂账「套件级自清理」）：
- `apps/server/scripts/cleanup-e2e-data.ts`（`pnpm --filter @gmind/server cleanup:e2e`，dry-run 默认 / `--apply` 实删）：判据化全量清理——`@e2e.gmind.dev`/`@test.dev`/`memberNNNN@`/`smoke9-` 账号、名下文件（含注册自动播种的 3 个示例文件）及评论/事件/版本/节点索引/分享/邀请/协作/星标/任务索引/参与人/范围配置/通知/目录等关联行（file 与 user 双向）、`e2e-` 前缀或 `XX-数字` 编号命名的分组/部门（保留账号挂靠解绑）、对象存储目录；幂等可重跑。
- web e2e `globalTeardown`（`apps/web/e2e/global-teardown.ts`）：整套结束（**失败也会执行**）自动带 `--apply`，清理失败显眼抛错。
- spec 建组/部门判据化改名：admin-users 用例的分组/部门统一 `e2e-` 前缀（研发部-/前端组-/连选甲乙丙- → e2e-研发部-…）。

**探针实测**（先造真实探针数据再验证脚本）：注册探针号+建文件+新旧两种命名分组+部门+demo 挂靠 → dry-run 判据命中 1/4/2/1 → apply 后 7/4/4/61 全恢复、demo 部门/分组挂靠解绑 ✓。探针暴露并修复一处脚本 bug（files 表主键是 id 无 file_id，通用删除语句不适用）。

**完整 web e2e 实测**（WEB_PORT=5174 API_ORIGIN=http://localhost:3001，当日）：**260 passed + 1 skipped（1 例重试绿）**，跑完 globalTeardown 自动清理「288 账号 / 893 文件 / 4 分组 / 1 部门 / 22 存储目录」；跑后 dry-run 复核 **0 命中（零残留）**，库内终态 7 账号/4 分组/4 部门/61 文件/13 存储目录，与手工清理基线一致。

## 已知限制（如实登记）
- 画布级清单只含**有任务**的画布（无任务画布排除无意义）；旧索引行「未知画布」（canvas_id NULL）不入画布清单、画布级排除对其无效——文件级开关可覆盖，打开一次文件即修复。
- 被排除的文件在页面上无「已排除 N 个」角标（待需求方确认是否需要）。
- 排除配置只影响「我的待办 + 统计面板 + 待办页动态」三个消费面，不影响任务本身、他人视图与文件内的一切功能。
