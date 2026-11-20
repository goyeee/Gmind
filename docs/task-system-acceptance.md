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
