# 导出主题按结构选型 + 导入分侧 v3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 导出 .xmind 的主题线条类按画布结构选型（思维导图=curve 曲线，修「直愣愣」）；导入分侧规则 v3（均匀小文件不再全跑左边）。

**Architecture:** theme 按结构从真实金样二选一——mindmap 用邢安家2025.08.01.xmind 的 10 键 curve 主题（27/35 份真实思维导图文件主流形态，逐字借用）、logic 沿用现 15 键 roundedElbow 金样、org 无真实样本沿用 logic 变体+诚实登记；分侧 v3=现有「最大分支锚左」规则保留（问题汇总已验证），**锚点落在第一个分支（右侧将为空）时回退为从右起交替**（XMind 对均匀小文件交替排）。

**Tech Stack:** 现有栈；theme 值逐字取金样零自造。

**Spec:** 需求方 2026-11-15 反馈：①「刚把结构从逻辑图（向右）改成了思维导图，导出的农千问待办10.27 (2).xmind 的线又变成了直愣愣的了」（画布 1）②「思维导图.xmind 导进来后节点的方向都跑到左边去了」。已实证：导出件画布 1=map.unbalanced（切换生效）、解析器读回 [mindmap, logic] 零降级（Gmind 导入无错判——「命中逻辑图」系原始文件本身即逻辑图，忠实还原，非缺陷，交付汇报说明）；用户新建思维导图=5 分支权重 [4,1,2,1,1]、max 在首位；Gmind问题汇总 权重 [4,2,2,4,3,3,2,4,16,1]、max=16 在第 9 位（现行规则已验证吻合）。

## Global Constraints

- 不 commit；不派子代理（实现者）；engine/core/xmind-io 既有函数只增不改。
- theme 值逐字取真实金样零自造；分侧规则变更必须保持问题汇总已验证用例（前 8 右、文件+分支主题 6 左）不回归。
- 门禁五件套收官（T3）。

---

### Task 1: build 层 theme 按结构选型

**Files:**
- Modify: `packages/xmind-io/src/build.ts`（THEME_MINDMAP 常量+按 structureType 选型）
- Modify: `packages/xmind-io/src/build.test.ts`、`packages/xmind-io/src/roundtrip.test.ts`

**Interfaces:** 不变（buildXmind 签名不动；产物 sheet.theme 按 s.structureType 二选一）。

- [ ] **Step 1: 提取金样**：`python3 -c` 从 `/Users/guoyue/Downloads/邢安家2025.08.01.xmind` 读 content.json 的 theme（10 键：boundary/calloutTopic/centralTopic/floatingTopic/mainTopic/map/relationship/subTopic/summary/summaryTopic；central/main/sub line-class 全 `org.xmind.branchConnection.curve`；mainTopic svg:fill #DCE6F2、border-line-width 2pt；无 skeletonThemeId/colorThemeId）逐字转 THEME_MINDMAP 常量。
- [ ] **Step 2: 失败测试**：structureType 'mindmap' 的 sheet 产物 theme.mainTopic line-class === curve 且 **无 skeletonThemeId 键**；'logic' 产物维持现 roundedElbow 金样（不回归）；'org' 产物=logic 变体（无真实样本，登记）。先红。
- [ ] **Step 3: 实现**：`const themeOf = (t?: XmindStructureType) => t === 'mindmap' ? THEME_MINDMAP : THEME_LOGIC;`（THEME_LOGIC=现 DEFAULT_THEME 改名），sheet 产 `theme: themeOf(s.structureType)`；头注 v2.4（依据=2026-11-15 需求方「思维导图页线直愣愣」反馈+35 份真实文件主流形态统计）。
- [ ] **Step 4: 验证**：xmind-io test 全绿+tsc。

### Task 2: 导入分侧 v3（锚左+空右回退交替）

**Files:**
- Modify: `apps/web/src/editor/xmind-import.ts`（balancedSides）
- Modify: `apps/web/src/editor/xmind-import.test.ts`

**Interfaces:** 不变（balancedSides(children)→side 数组）。

- [ ] **Step 1: 失败测试**：①新用例「均匀小文件（max 在首位）：从右起交替」——5 分支权重 [4,1,2,1,1]（复刻用户文件形态）断言 `['right','left','right','left','right']`（现行规则产出全 left，先红）②问题汇总回归用例（[4,2,2,4,3,3,2,4,16,1]→前 8 右）不变绿。
- [ ] **Step 2: 实现**：balancedSides 现锚定逻辑后加回退——`const sides = children.map((_, i) => (i >= maxIdx ? 'left' : 'right'));` 若 `!sides.includes('right')`（锚点=第一支）则改 `children.map((_, i) => (i % 2 === 0 ? 'right' : 'left'))`；头注 v3（均匀小文件 XMind 交替排、XMind 8 不存位置故为近似——诚实边界延续）。
- [ ] **Step 3: 验证**：web test 全绿（问题汇总用例+新用例+既有全量）。

### Task 3: 文档 + 门禁收官

**Files:**
- Modify: `docs/features/import-export.md`、`docs/m4-acceptance.md`、`docs/project-status.md`
- （无 e2e 新增：theme 断言已在 share-export 用例 2——需同步断言值！）

- [ ] **Step 1: e2e 断言同步**：share-export 用例 2 的 theme line-class 断言（种子文档结构=mindmap → 现断言 roundedElbow 会红）改为 curve；跑 share-export+import-export 全绿。
- [ ] **Step 2: 文档**：features 规则 15（theme 二选一+org 无样本登记）、规则 4（分侧 v3 两模式+诚实边界续）、m4 §十四补记、project-status §三指针行（只追加）。
- [ ] **Step 3: 收官门禁五件套全绿**（数字带回；flaky 判定照旧）。

## Self-Review

- 反馈覆盖：①主题按结构=T1（画布 1 直线）②全跑左边=T2（均匀文件交替）③「命中逻辑图」=忠实还原非缺陷（交付汇报说明，无代码）✓
- 回归红线：问题汇总分侧用例（T2 显式不回归）+logic 主题金样（T1 显式不回归）✓
- 接缝：T1 产物变化→share-export 用例 2 断言在 T3 同步（否则 e2e 红）——已入 T3 Step 1 ✓
