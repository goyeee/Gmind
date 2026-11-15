# 分侧忠实还原（right-number 读+写）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 思维导图分支左右不再「猜」：导入读 XMind 存储的 `right-number`（前 N 支居右的计数），导出把 Gmind 的分支左右写回同字段——分侧随文件往返无损；`right-number` 缺失时回退现行 v3 算法兜底。

**Architecture:** XMind 把思维导图左右分布存在根主题扩展上：XML=`<extensions><extension provider="org.xmind.ui.map.unbalanced"><content><right-number>N</right-number></content></extension></extensions>`、Zen JSON=`root.extensions:[{provider,content:[{name:'right-number',content:'N'}]}]`，语义=attached 文档序**前 N 支居右**（本机真实文件 11 份实证，含 rn=0 全左、双画布各自计数）。导入两格式解析出 rightCount→胶水按计数定侧；导出链统计画布根分支 side==='right' 计数→build 层落 extensions。

**Tech Stack:** 现有栈零新依赖。

**Spec:** 需求方 2026-11-15 截图反馈：思维导图.xmind 导入后左右分布与 XMind 不符（顺/逆时针读序对不上）+ 明确裁定「不能靠数字分析节点该在哪边，分支可拖拽、是用户内容」。铁证：思维导图.xmind 根扩展 `right-number=3`（右=分支1/2/3 与截图一致）；邢安家/赵冉/SOP/AI培训 等 Zen 样本语义一致；前端周报 rn=0（全左）与 rn=2（双画布）实证边界。已知异常：Gmind问题汇总.xmind rn=7 与其 XMind 截图（8 右）不一致——疑 XMind 8 手动拖拽不刷新计数，导入将忠实按 7 处理，交付汇报专项说明。

## Global Constraints

- 不 commit；不派子代理（实现者）；engine/core 只增不改。
- 分侧兜底（right-number 缺失时）保持现行 v3 算法（锚左+空右交替）不动——已有用例全绿。
- 未知 provider/无 right-number 的 extensions 一律忽略不计降级（与 theme 同口径）。
- 门禁五件套收官（T4）。

---

### Task 1: 解析层读 right-number（XML+JSON）

**Files:**
- Modify: `packages/xmind-io/src/parse-xml.ts`、`packages/xmind-io/src/parse-json.ts`、`packages/xmind-io/src/types.ts`
- Modify: `packages/xmind-io/src/parse.test.ts`

**Interfaces:**
- Produces: `XmindSheet.rightCount?: number`（根扩展 map.unbalanced provider 的 right-number；仅根主题上的扩展有效；非法值/越界行为=T1 实现口径钉死：非数字/负数→undefined，≥0 整数→ clamp 到 [0, attached 数] 在胶水层做，解析层原样透传数字）。

- [ ] **Step 1: 失败测试**（parse.test 追加）：①XML：根带 extensions provider=org.xmind.ui.map.unbalanced right-number=3 → sheets[0].rightCount===3；②XML：无 extensions → rightCount undefined；③JSON：root.extensions 数组同形 → rightCount；④JSON/XML：extensions 里 provider 不匹配（如 org.xmind.ui.map.balanced）或 content 里无 right-number → undefined；⑤多 sheet 各自计数（前端周报 rn=[0,2] 形状：sheet0=0、sheet1=2）。先红。
- [ ] **Step 2: 实现**：两格式在解析 sheet 时读根主题 extensions（XML: `<extensions><extension provider=…><content><right-number>N`；JSON: root.extensions 数组）；provider==='org.xmind.ui.map.unbalanced' 且 content 项 name==='right-number' → parseInt，合法非负整数产 rightCount，否则不产键；types.ts XmindSheet 加 `rightCount?: number`（只增）。
- [ ] **Step 3: 验证**：xmind-io test 全绿+tsc。

### Task 2: build 层写回 right-number

**Files:**
- Modify: `packages/xmind-io/src/build.ts`、`packages/xmind-io/src/types.ts`（XmindSheet.rightCount）
- Modify: `packages/xmind-io/src/build.test.ts`

**Interfaces:**
- Consumes: `XmindSheet.rightCount?: number`（T1 类型）。
- Produces: structureType==='mindmap' 且 rightCount!==undefined 时，根 topic 产 `extensions:[{provider:'org.xmind.ui.map.unbalanced',content:[{name:'right-number',content:String(n)}]}]`（金样逐字形状）；缺省不产键。

- [ ] **Step 1: 失败测试**：mindmap+rightCount=3 → 根 topic.extensions 金样形状逐字；rightCount=0 → content '0'（全左合法）；缺省 → 无 extensions 键；logic sheet → 不产。先红。
- [ ] **Step 2: 实现**：build sheet 组装时 root topic 挂 extensions（仅 mindmap+rightCount!==undefined）；types.ts XmindSheet 加 rightCount（若 T1 已加则合并）。
- [ ] **Step 3: 验证**：xmind-io test 全绿+tsc；roundtrip 补「build(rightCount)→parseXmind 还原 rightCount」断言。

### Task 3: web 导入/导出接线

**Files:**
- Modify: `apps/web/src/editor/xmind-import.ts`（定侧优先 rightCount，v3 算法回退）
- Modify: `apps/web/src/editor/xmind-export.ts`（docToXmindSheets 计算 rightCount）
- Modify: 两文件对应测试

**Interfaces:**
- Produces: 导入 mindmap 画布定侧=rightCount 优先（前 N 右/其余左，N clamp [0,分支数]），缺失回退现行 v3；导出 mindmap 画布 rightCount=根直接子级 side==='right' 计数（读侧字段名实现者对照 core read.ts 核实）。

- [ ] **Step 1: 失败测试**（xmind-import.test）：①构造夹具 sheet rightCount=3、5 分支 → 定侧 [R,R,R,L,L]（现行产出为交替 [R,L,R,L,R]，先红）②rightCount 缺省 → 回退现行 v3 行为（既有用例不回归）③rightCount=0 → 全左 ④rightCount 超过分支数 → clamp 全右。导出侧（xmind-export.test）：文档根分支 side 已知时 docToXmindSheets 产 rightCount（mock/构造带 side 的 doc——core setNodeSide 真实调用构造）。
- [ ] **Step 2: 实现**：导入胶水 mindmap 定侧分支改为 rightCount 优先路径；导出链 docToXmindSheets 逐画布数 side==='right'（读侧字段名以 read.ts 实码为准）传 rightCount；头注更新（忠实还原依据=2026-11-15 需求方截图反馈+11 份真实文件 right-number 实证；分侧算法降级为兜底）。
- [ ] **Step 3: 验证**：web test 全量+tsc+eslint。

### Task 4: e2e + 文档 + 门禁收官

**Files:**
- Modify: `apps/web/e2e/import-export.e2e.spec.ts`（往返补 right-number 断言）、`apps/web/e2e/share-export.e2e.spec.ts`（XMind 用例补根 extensions 断言）
- Modify: `docs/features/import-export.md`、`docs/m4-acceptance.md`、`docs/project-status.md`

- [ ] **Step 1: e2e**：往返用例（导入「示例.xmind」→导出）补：导入后导出件 content.json 根 extensions right-number 与导入夹具一致（夹具需带 right-number——helpers/xmind-fixture.ts 若无则补字段，属 e2e 助手非代码约束内文件，允许）；share-export 用例 2 补根 extensions right-number 断言。跑受影响 e2e 全绿。
- [ ] **Step 2: 文档**：features 规则 4 重写（忠实还原 right-number 为主/算法兜底/农千问与思维导图.xmind 实证/Gmind问题汇总 rn=7 与截图 8 右不一致的已知异常专项说明——疑 XMind 8 拖拽不刷新计数，导入按存储值）、规则 15 扩（extensions 写回）、m4 §十五补记、project-status §三指针行。
- [ ] **Step 3: 收官门禁五件套全绿**（真实跑；已知观察项 canvas-tabs:46、collab:566、editor:78）。

## Self-Review

- 需求覆盖：分支左右=用户内容→读/写 right-number 忠实往返 ✓；缺失兜底 v3 不动 ✓；Gmind问题汇总 rn=7 异常→如实导入+专项说明 ✓
- 接缝：T1 类型→T2 消费；T2 产物→T3 导出；T3 导入→T4 e2e 往返背书 ✓
- 农千问验收预期：重导后画布1 右=分支1/2/3（rn=3）左=4~8，与 XMind 截图一致 ✓
