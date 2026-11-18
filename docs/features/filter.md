# 筛选（双层化 + 负责人多选）

> 最后核对：2026-11-16（负责人收敛追加 + 轮 2 筛选双层化）

## ① 这是什么

文件顶部筛选栏（`map-filter-bar`）的筛选状态，从「只存在你浏览器里」升级为两层：

- **公共筛选**：写入文件本身（`meta.sharedFilter`），所有打开这份文件的人默认使用。适合团队对齐「现在只看未分配任务」这类场景。
- **个人筛选**：只存在你当前浏览器标签页里，改动默认不打扰别人。关掉标签页就回到公共筛选。

**负责人筛选**：多人勾选（点「人员」按钮弹 checkbox 列表），与分组/部门是 AND 收窄关系——命中负责人的归属还要在所选分组/部门里。

## ② 规则

1. **改动默认仅你可见**：调整任何筛选条件（负责人/状态/仅逾期/仅未分配/字段条件/分组/部门）后，筛选按钮尾巴出现灰色小字「· 仅你可见」（`map-filter-personal-badge`）。队友不受影响。
2. **「对所有人生效」**：点筛选弹窗里的蓝色按钮，把当前筛选（**不含搜索关键词**）写入文件。筛选按钮上的「· 仅你可见」消失，弹窗头变成绿色「✓ 已同步给所有人」（`map-filter-synced-badge`）。
3. **「恢复为公共筛选」**：点弹窗里的灰色按钮，放弃你的个人调整，回到团队公共筛选。如果公共筛选为空（没人发布过），等于清空筛选。
4. **队友发布时自动跟随**：如果队友点「对所有人生效」时你没有做任何个人调整，你的筛选会自动变成新公共筛选，同时屏幕下方弹出小提示「xx 更改了筛选条件」（停留几秒自动消失）。
5. **冲突保护**：如果你正在调整自己的筛选（还没发布），队友发布时**你的筛选不动**，小提示照样弹，「· 仅你可见」保留。你可以之后手动「恢复为公共筛选」跟随。
6. **搜索关键词（keyword）永远仅你可见**：顶部搜索框输入的文字不会被「对所有人生效」带走，也不参与「是否已同步」的判定。
7. **「我的待办」预设**：视图下拉里的「我的待办」= 负责人筛选为你自己。与旧版「范围=我」效果相同（旧 scope 概念已删除）。
8. **旧视图自动迁移**：浏览器里保存的筛选视图如果带旧「范围=我」标记，打开时自动转成「负责人=我」，不会报错也不会丢数据。
9. **版本恢复不回滚筛选**：文件版本恢复（restore）不会把公共筛选滚回旧版本——公共筛选是协作偏好，不是文档内容。
10. **负责人多选**：筛选弹窗「更多条件·人员」点按钮弹出 checkbox 列表（我/成员A/成员B…），勾多人=负责人「任一命中」筛选。只有这一个负责人入口——字段条件行里没有「负责人」字段（2026-11-16 需求方拍板收敛，此前两处独立状态会导致两组标签且求值 AND 筛不出东西）。
11. **负责人 + 分组/部门 = AND 收窄**：选了负责人多人 + 又选了分组/部门时，命中负责人的归属还要在所选分组/部门里。例如：负责人=[我, 张三] + 分组=前端组 → 只显示「我或张三负责 且 归属前端组」的任务。
12. **弹窗外点关闭**：筛选弹窗打开后，点击弹窗外任意位置（含画布空白）立即收起（`MapFilterBar.tsx` document pointerdown 监听，2026-11-18 由 mousedown 改 pointerdown——画布会抑制 mousedown，旧实现在画布上收不起）。

## ③ 特殊情况

| 场景 | 表现 |
|------|------|
| 公共筛选从未发布过 | 所有人打开都是空筛选（无筛选生效） |
| 自己刚点完「对所有人生效」 | 弹窗头立即变「✓ 已同步给所有人」，不会弹 toast 打扰自己 |
| 队友连续发布两次相同筛选 | 第二次不会触发任何提示（同值守卫短路，零协同噪音） |
| 只输了搜索关键词没动其他条件 | 视为「无个人调整」——队友发布时你的结构化条件会跟随，关键词保留 |
| 文档数据里公共筛选字段损坏（非对象形状） | 读取时归一为「无公共筛选」，不抛错不崩溃 |
| 公共筛选里混入 keyword 键（异常数据） | 读取时剔除该键，不影响其他字段 |

## ④ 待需求方确认

- 无（三轮 AskUserQuestion 已拍定全部口径）。

## ⑤ 最后核对

2026-11-18，代码核对（外点关闭修复）：
- `apps/web/src/editor/MapFilterBar.tsx` — 弹窗外点监听 mousedown → pointerdown（画布空白点击可收起）
- `apps/web/e2e/filter-two-tier.e2e.spec.ts:54` — 「筛选弹窗：点击画布空白自动收起」红→绿

2026-11-16，代码核对（负责人收敛追加）：
- `apps/web/src/editor/taskFilter.ts:82-88` — `BUILTIN_COND_FIELDS` 删 `owner`（字段条件行不再有负责人）
- `apps/web/src/editor/MapFilterBar.tsx` — 「更多条件·人员」弹层多选 checkbox（owners 集合唯一入口）；`dropLegacyOwnerConds` 读侧防御旧 conds
- 求值侧零改动（owners + grp/dept 已是 AND 收窄）

2026-11-15，代码核对：
- `packages/gmind-core/src/constants.ts` — `canonicalSharedFilter`（防御归一单源）
- `packages/gmind-core/src/operations.ts:994-1032` — `setSharedFilter` op（同值守卫、ORIGIN_SYSTEM、keyword 键抛错）
- `packages/gmind-core/src/read.ts:145` — `getMeta` 读 `sharedFilter`（防御归一）
- `packages/gmind-core/src/restore.ts:143-146` — `sharedFilter` 随 `meta.title` 先例排除
- `packages/gmind-core/src/repair.ts:494-500,1245-1257` — 规则⑧扩展：`sharedFilter` 非法形状收敛
- `apps/web/src/editor/MapFilterBar.tsx:40-89,102-138,196-206,324` — 双层 UI（badge、publish、restore、synced）
- `apps/web/src/editor/TaskTable.tsx:156-178,540,567` — `Filters` 删 `scope`；`EMPTY_FILTERS` 同步删
- `apps/web/src/pages/EditorPage.tsx:582-601,3910-3970` — `sharedFilter` state、`publishSharedFilter`/`restoreSharedFilter`、协同跟随 + toast
- `apps/web/e2e/filter-two-tier.e2e.spec.ts` — 四用例（基础双层/协同跟随/恢复/keyword 隔离）
