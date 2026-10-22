# 多画布 · 计划一：core 数据模型层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 core 从「一个 Y.Doc = 一棵树 = 固定根 'root'」改造为「一个 Y.Doc = 多画布（每画布一棵独立树）」，旧文档装载时无损迁移，web/server 在默认画布兼容层下全程编译绿、e2e 不红。

**Architecture:** 每画布一个 Y.Map 子图（`canvases: Y.Map<canvasId, {name, rootId, structureType, themeId, nodes, summaries}>`＋`canvasOrder: Y.Array<canvasId>`）。选「每画布子图」而非「共享 nodes map 多 root」的**决定因素 = 裁定 2（撤销不跨画布）**：Y.UndoManager 只能按共享类型划作用域，画布子图使 `createUndoManager(doc, canvasId)` 的 scope 天然成立；共享 map 方案无法实现按画布撤销。节点 id 仍为全局 ULID（评论/任务/标记/awareness 数据层零改动，裁定 4 只需 UI 过滤）。

**Tech Stack:** TypeScript + Yjs（现有栈，无新依赖）。

**Spec:** `docs/superpowers/specs/2026-10-21-multi-canvas-ruling.md`（8 条裁定＋5 条默认假设；本计划落实裁定 1/2/5/6 的 core 侧）

**分层全景（本文件 = 计划一/共四份，后续计划在上一计划收口后另写）：**
1. **core 数据模型层（本计划）**——canvases 结构、装载迁移、读写/repair/undo/restore 画布化、画布管理 op、默认画布兼容层
2. engine 参数化——`'root'` 字面量参数化（layout.ts:211、selection.ts:176）、defs id 场景前缀、每画布视口
3. web UI——底部页签条、activeCanvasId、面板/查找/导出/缩略图/版本预览接「当前画布」口径、移动端只读页签（裁定 7）、光标跨画布隐藏（裁定 4）、评论跨画布定位
4. xmind-io 多 Sheet＋e2e＋验收文档——导入不再拍平（裁定 8）、导出多 Sheet、全量门禁与验收

## Global Constraints

- **唯一写入口**：一切写经 core 操作 API / `withTransaction`；系统通道（docFromState 装载迁移、repair 收敛）除外（AGENTS.md §三.1）
- **校验先于事务**：全部校验/diff/plan 计算在 `withTransaction` 之外，事务内只执行已验证的写（AGENTS.md §三.2）
- **engine 只增不改**：本计划不动 engine
- **协同语义**：新文档级数据（canvases/canvasOrder）必须在 repair/restore 路径同裁定（AGENTS.md §三.7）
- **副本确定性**：迁移产生的画布 id 必须确定性（常量），禁止在收敛/迁移路径用 ulid（副本分叉）
- **兼容层纪律**：所有公开 API 的 `canvasId` 参数**可选**，缺省 = 第一画布——web/server 在计划三之前不改也能编译运行，e2e 全程绿
- **裁定 6**：restore 范围不含 summaries（维持现状，restore.ts 头注口径）
- 门禁：`pnpm lint && pnpm typecheck && pnpm test` 每个 Task 收尾必跑；core 单测全绿（基线 296/297，bench 为机器负载敏感存量）

## 数据模型（全部 Task 的公共上下文，先读这段）

```
Y.Doc
├── meta: Y.Map                 // title、customColumns、tableView、lastEditorUserId（全部保持文档级，默认假设 3）
│                               // 新增 activeCanvasId: string（最后激活画布，LWW；装载迁移时置 LEGACY_CANVAS_ID）
├── canvases: Y.Map<canvasId, Y.Map>   // 每个 value（下称 CanvasMap）：
│     ├── name: string                   // 画布名（默认「画布 N」，可改）
│     ├── rootId: string                 // 第一画布恒 'root'（ROOT_NODE_ID，向后兼容）；新建画布 = ulid
│     ├── structureType: StructureType   // 画布级（裁定 5）
│     ├── themeId: string                // 画布级（裁定 5）
│     ├── deleted?: true                 // 画布墓碑（deleteCanvas 置位，键不删——对齐节点墓碑先例）
│     ├── nodes: Y.Map<nodeId, Y.Map>    // 本画布的树（形状与现行 doc.nodes 完全一致）
│     └── summaries: Y.Map<summaryId, Y.Map>  // 本画布概要（形状同现行 doc.summaries）
└── canvasOrder: Y.Array<canvasId>       // 页签顺序；墓碑画布不在其中
```

- 旧文档（顶层 `nodes`/`summaries` 根类型）经 docFromState 迁移：深拷贝进 `LEGACY_CANVAS_ID='canvas-1'` 画布后清空旧根类型的键（Yjs 根类型不可删除，空壳残留无害，如实注释）
- 迁移幂等：`canvases.size > 0` 即跳过；两个副本对同一旧文档迁移产出**完全一致**（id 常量、name 常量、structureType/themeId 取自 meta 现值）
- 画布增删/排序/activeCanvasId **不进撤销栈**（ORIGIN_SYSTEM 之外的推论：撤销不跨画布，画布管理是文档级操作——列为默认假设 6，计划过审时一并确认）

---

### Task 1: canvas.ts —— 画布结构访问器与读侧

**Files:**
- Create: `packages/gmind-core/src/canvas.ts`
- Test: `packages/gmind-core/src/canvas.test.ts`
- Modify: `packages/gmind-core/src/index.ts`（导出新模块；先确认该文件存在，若聚合出口在别处随现状）

**Interfaces:**
- Produces（后续所有 Task 依赖）：
  - `LEGACY_CANVAS_ID: 'canvas-1'`
  - `MAX_CANVAS_NAME_LENGTH = 50`
  - `CanvasInfo { id: string; name: string; rootId: string; structureType: StructureType; themeId: string }`
  - `canvasesMap(doc): Y.Map<Y.Map<unknown>>`
  - `canvasOrderArr(doc): Y.Array<string>`
  - `listCanvases(doc): CanvasInfo[]`（按 canvasOrder 序，跳过墓碑）
  - `resolveCanvasId(doc, canvasId?): string`（canvasId ?? meta.activeCanvasId ?? canvasOrder 首个存活 ?? LEGACY_CANVAS_ID；结果不存在时回落首个存活）
  - `canvasMapOf(doc, canvasId?): Y.Map<unknown>`（不存在时抛 `GmindCoreError('CANVAS_NOT_FOUND', '画布不存在')`）
  - `canvasNodesMap(doc, canvasId?): Y.Map<Y.Map<unknown>>`
  - `canvasSummariesMap(doc, canvasId?): Y.Map<Y.Map<unknown>>`
  - `rootIdOf(doc, canvasId?): string`
  - `ensureCanvasShape(canvas: Y.Map<unknown>): { nodes; summaries }`（防御：nodes/summaries 键缺失或非 Y.Map 时补建——装载容错，repair 也用它）

- [ ] **Step 1: 写失败测试** `canvas.test.ts`：空 doc 上 `listCanvases` 返回 []、`resolveCanvasId` 回落 LEGACY_CANVAS_ID；手工搭一个双画布 doc 后 `listCanvases` 按 order 返回且跳过墓碑；`canvasMapOf(doc,'nope')` 抛 CANVAS_NOT_FOUND；`ensureCanvasShape` 对缺 nodes 键的 CanvasMap 补建

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @gmind/core test -- canvas.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 canvas.ts**

```ts
import * as Y from 'yjs';
import type { StructureType } from '@gmind/shared';
import { GmindCoreError } from './errors';
import { ROOT_NODE_ID } from './doc';

/** 迁移画布 id：确定性常量（副本一致纪律——迁移路径禁止 ulid）。 */
export const LEGACY_CANVAS_ID = 'canvas-1';
/** 画布名长度上限（校验先于事务，renameCanvas/addCanvas 共用）。 */
export const MAX_CANVAS_NAME_LENGTH = 50;

export interface CanvasInfo {
  id: string;
  name: string;
  rootId: string;
  structureType: StructureType;
  themeId: string;
}

export function canvasesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('canvases') as Y.Map<Y.Map<unknown>>;
}

export function canvasOrderArr(doc: Y.Doc): Y.Array<string> {
  return doc.getArray('canvasOrder');
}

function aliveOrder(doc: Y.Doc): string[] {
  const canvases = canvasesMap(doc);
  return canvasOrderArr(doc).toArray().filter((id) => {
    const c = canvases.get(id);
    return c !== undefined && c.get('deleted') !== true;
  });
}

/** 画布 id 解析：显式 > meta.activeCanvasId > 首个存活 > LEGACY 常量。结果不存活时回落首个存活。 */
export function resolveCanvasId(doc: Y.Doc, canvasId?: string): string {
  const order = aliveOrder(doc);
  const candidates = [
    canvasId,
    doc.getMap('meta').get('activeCanvasId') as string | undefined,
    order[0],
    LEGACY_CANVAS_ID,
  ];
  for (const c of candidates) {
    if (c === undefined) continue;
    const m = canvasesMap(doc).get(c);
    if (m !== undefined && m.get('deleted') !== true) return c;
  }
  return LEGACY_CANVAS_ID; // 空文档/迁移前：由调用方 decide 是否需要真实存在
}

export function canvasMapOf(doc: Y.Doc, canvasId?: string): Y.Map<unknown> {
  const id = resolveCanvasId(doc, canvasId);
  const m = canvasesMap(doc).get(id);
  if (m === undefined || m.get('deleted') === true) {
    throw new GmindCoreError('CANVAS_NOT_FOUND', '画布不存在');
  }
  return m;
}

/** 防御取画布内子图：键缺失/类型不符即补建（装载容错与 repair 共用，读取绝不抛错）。 */
export function ensureCanvasShape(
  canvas: Y.Map<unknown>,
): { nodes: Y.Map<Y.Map<unknown>>; summaries: Y.Map<Y.Map<unknown>> } {
  let nodes = canvas.get('nodes') as Y.Map<Y.Map<unknown>> | undefined;
  if (!(nodes instanceof Y.Map)) {
    nodes = new Y.Map<Y.Map<unknown>>();
    canvas.set('nodes', nodes);
  }
  let summaries = canvas.get('summaries') as Y.Map<Y.Map<unknown>> | undefined;
  if (!(summaries instanceof Y.Map)) {
    summaries = new Y.Map<Y.Map<unknown>>();
    canvas.set('summaries', summaries);
  }
  return { nodes, summaries };
}

export function canvasNodesMap(doc: Y.Doc, canvasId?: string): Y.Map<Y.Map<unknown>> {
  return ensureCanvasShape(canvasMapOf(doc, canvasId)).nodes;
}

export function canvasSummariesMap(doc: Y.Doc, canvasId?: string): Y.Map<Y.Map<unknown>> {
  return ensureCanvasShape(canvasMapOf(doc, canvasId)).summaries;
}

export function rootIdOf(doc: Y.Doc, canvasId?: string): string {
  const r = canvasMapOf(doc, canvasId).get('rootId');
  return typeof r === 'string' && r !== '' ? r : ROOT_NODE_ID;
}

export function listCanvases(doc: Y.Doc): CanvasInfo[] {
  const canvases = canvasesMap(doc);
  return aliveOrder(doc).map((id) => {
    const c = canvases.get(id) as Y.Map<unknown>;
    const name = c.get('name');
    const rootId = c.get('rootId');
    const structureType = c.get('structureType');
    const themeId = c.get('themeId');
    return {
      id,
      name: typeof name === 'string' && name !== '' ? name : '画布',
      rootId: typeof rootId === 'string' && rootId !== '' ? rootId : ROOT_NODE_ID,
      structureType: (structureType as StructureType | undefined) ?? 'mindmap',
      themeId: typeof themeId === 'string' && themeId !== '' ? themeId : 'gmind-light',
    };
  });
}
```

注：`errors.ts` 的 `GmindCoreErrorCode` 联合类型需加 `'CANVAS_NOT_FOUND'`（在 Task 1 实现里一并改，测试断言 code）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @gmind/core test -- canvas.test.ts`
Expected: PASS

- [ ] **Step 5: 门禁**

Run: `pnpm lint && pnpm typecheck && pnpm --filter @gmind/core test`
Expected: 全绿（此刻无任何调用方，兼容层未接，零波及）

- [ ] **Step 6: Commit**

```bash
git add packages/gmind-core/src/canvas.ts packages/gmind-core/src/canvas.test.ts packages/gmind-core/src/errors.ts packages/gmind-core/src/index.ts
git commit -m "feat(core): 多画布 Task1 画布结构访问器与读侧"
```

---

### Task 2: 装载迁移与模板多画布化（doc.ts）

**Files:**
- Modify: `packages/gmind-core/src/doc.ts`（docFromState 迁移、createTemplateDoc 新结构、countNodes 口径）
- Test: `packages/gmind-core/src/doc.test.ts`（追加用例，不改既有用例语义——既有用例全部走迁移后形状，断言应原样通过；若既有断言直接读 `doc.getMap('nodes')`，迁移后该 map 已清空，需改为经 `canvasNodesMap(doc)` 读——**允许改测试的读取路径，禁止改断言语义**）

**Interfaces:**
- Consumes: Task 1 全部
- Produces: `isLegacyDocShape(doc): boolean`、`migrateLegacyToCanvases(doc): void`（docFromState 内部调用，不导出也可，导出供测试直调）；`createTemplateDoc` 产出新形状（旧调用方零感知）；`countNodes(doc, canvasId?)` 兼容签名

- [ ] **Step 1: 写失败测试**

追加用例（关键断言）：
```ts
it('旧形状文档装载迁移：nodes/summaries/structure/theme 深拷贝进 canvas-1，旧根类型清空，两次装载结果一致（副本确定性）', () => {
  const legacy = createLegacyDoc(); // 测试内手工搭：顶层 nodes 含 root+2 子、meta.structureType='logic'、一条 summary
  const a = docFromState(docToState(legacy));
  const b = docFromState(docToState(legacy));
  expect(listCanvases(a)).toHaveLength(1);
  expect(listCanvases(a)[0]).toMatchObject({ id: LEGACY_CANVAS_ID, name: '画布 1', rootId: ROOT_NODE_ID, structureType: 'logic' });
  expect(getNode(a, firstChildId)?.text).toBe('子主题'); // 经兼容层读到迁移后内容
  expect(a.getMap('nodes').size).toBe(0); // 旧根类型已清空
  expect(Y.encodeStateAsUpdate(a)).toEqual(Y.encodeStateAsUpdate(b)); // 确定性
});
it('迁移幂等：新形状文档再进 docFromState 不产生第二画布', () => { /* docFromState 两次，canvases 恒 1 */ });
```

- [ ] **Step 2: 跑确认失败** — `pnpm --filter @gmind/core test -- doc.test.ts`，Expected: FAIL（listCanvases 为空）

- [ ] **Step 3: 实现**

`doc.ts` 追加（createTemplateDoc 改造见下）：

```ts
import { LEGACY_CANVAS_ID, canvasesMap, canvasOrderArr } from './canvas';

/** 旧形状判定：顶层 nodes 非空且 canvases 为空。 */
export function isLegacyDocShape(doc: Y.Doc): boolean {
  return canvasesMap(doc).size === 0 && doc.getMap('nodes').size > 0;
}

/** 深拷贝 Y.Map 子树（Yjs 共享类型不可换父，迁移只能逐键重建；保留全部节点 id 与字段）。 */
function copyNodesDeep(src: Y.Map<unknown>, dst: Y.Map<unknown>): void {
  src.forEach((value, key) => {
    if (value instanceof Y.Map) {
      const m = new Y.Map<unknown>();
      value.forEach((v, k) => {
        if (v instanceof Y.Array) m.set(k, new Y.Array()); // 先占位，下文填
        else m.set(k, v); // 标量原样（text/parentId/side/task/icons/custom…）
      });
      value.forEach((v, k) => {
        if (v instanceof Y.Array) (m.get(k) as Y.Array<unknown>).push(v.toArray());
      });
      dst.set(key, m);
    }
  });
}

/** 旧文档 → 多画布迁移（装载通道，ORIGIN_SYSTEM；确定性：id/name 常量，structure/theme 取 meta 现值）。 */
export function migrateLegacyToCanvases(doc: Y.Doc): void {
  if (!isLegacyDocShape(doc)) return; // 幂等
  doc.transact(() => {
    const meta = doc.getMap('meta');
    const canvas = new Y.Map<unknown>();
    canvas.set('name', '画布 1');
    canvas.set('rootId', ROOT_NODE_ID);
    canvas.set('structureType', meta.get('structureType') ?? 'mindmap');
    canvas.set('themeId', meta.get('themeId') ?? 'gmind-light');
    const nodes = new Y.Map<unknown>();
    copyNodesDeep(doc.getMap('nodes'), nodes);
    canvas.set('nodes', nodes);
    const summaries = new Y.Map<unknown>();
    copyNodesDeep(doc.getMap('summaries') as Y.Map<unknown>, summaries);
    canvas.set('summaries', summaries);
    canvasesMap(doc).set(LEGACY_CANVAS_ID, canvas);
    canvasOrderArr(doc).push([LEGACY_CANVAS_ID]);
    meta.set('activeCanvasId', LEGACY_CANVAS_ID);
    // 旧根类型清空（Yjs 根类型不可删除，空壳残留无害）
    const legacyNodes = doc.getMap('nodes');
    legacyNodes.forEach((_, k) => legacyNodes.delete(k));
    const legacySummaries = doc.getMap('summaries');
    legacySummaries.forEach((_, k) => legacySummaries.delete(k));
  }, ORIGIN_SYSTEM);
}
```

`docFromState` 在 `normalizeTree` **之前**插入 `migrateLegacyToCanvases(doc)`（迁移后形状才进收敛；normalizeTree 的多画布化在 Task 5，本 Task 期间 normalizeTree 仍读旧顶层 nodes——已清空，零修复返回 0，安全）。

`createTemplateDoc` 改造：产物改为新形状——画布 id 用 ulid（**新建路径非迁移路径，允许 ulid**；两个副本并发新建各自文档无共享），rootId 仍 `ROOT_NODE_ID`（第一画布恒 'root' 兼容纪律），name=「画布 1」，nodes/summaries 建在画布内。顶层 `nodes` 根类型不再写（保持不存在）。

`countNodes(doc, canvasId?)`：`doc.getMap('nodes')` 改读 `canvasNodesMap(doc, canvasId)`——canvasId 缺省走 resolveCanvasId 兼容层。

- [ ] **Step 4: 跑测试** — `pnpm --filter @gmind/core test -- doc.test.ts` Expected: PASS（含既有用例经读取路径调整后）
- [ ] **Step 5: 全量** — `pnpm --filter @gmind/core test` Expected: 仅 read/operations/repair 相关用例因「nodes 搬家」失败（预期中的红，Task 3/4/5 逐个收绿）——**本 Task 允许 core 测试出现仅由读取路径导致的红，提交前在 commit message 如实登记**
- [ ] **Step 6: Commit** — `git commit -m "feat(core): 多画布 Task2 装载迁移与模板多画布化（部分测试红，Task3-5 收绿）"`

---

### Task 3: read.ts 画布化（兼容签名扫荡）

**Files:**
- Modify: `packages/gmind-core/src/read.ts`（全部函数）
- Test: `packages/gmind-core/src/read.test.ts`（追加双画布用例；既有用例读取路径随 Task 2 同步）

**Interfaces:**
- Produces: 全部公开读函数统一签名模式 `fn(doc, canvasId?, ...rest)`——**canvasId 恒为 doc 之后第一个可选参数**（例外：本就 `(doc, nodeId)` 形态的函数改 `(doc, nodeId, canvasId?)`，nodeId 保持第二参以最小化调用方 diff）。完整函数清单（以 `grep "^export function" read.ts` 为准逐个核对）：`getMeta / setDocMeta(见 Task 3 附) / markLastEditor / getNode / requireAliveNode(read.ts:434) / childrenOf / subtreeIds / pathToRoot / countAliveReachable / countCollapsedReachable / isAncestorOf / canContainSummary(若有) / assigneeEntriesOf / 其余以现文件为准`
- **口径变化（裁定 1）**：`countAliveReachable(doc, canvasId?)` 自 `rootIdOf(doc, canvasId)` 起算——每画布独立配额基数。doc 级合计由调用方需要时自行 Σ（server files.node_count 在计划三裁定口径，本计划不动 server）

关键转换模式（每个函数照此，一个例子写全）：

```ts
// 前：
export function subtreeIds(doc: Y.Doc, rootId: string = ROOT_NODE_ID): string[] {
  const nodes = nodesMap(doc); ...
}
// 后：
export function subtreeIds(doc: Y.Doc, rootId?: string, canvasId?: string): string[] {
  const nodes = canvasNodesMap(doc, canvasId);
  const start = rootId ?? rootIdOf(doc, canvasId); ...
}
```

`getMeta`：返回的 `structureType/themeId` 改读**解析画布**（`canvasMapOf`）；`title/customColumns/tableView` 仍读 meta。`setDocMeta({structureType|themeId})` 写画布级（`canvasMapOf(doc, canvasId).set(...)`）；`title` 仍写 meta。签名加 `canvasId?` 第三参。

- [ ] **Step 1: 失败测试**——`read.test.ts` 追加：双画布 doc 上 `countAliveReachable(doc, c1)===3 / (doc, c2)===5`；`getMeta(doc, c2).themeId` 读画布 2 的值；缺省 canvasId 读第一画布
- [ ] **Step 2-4**: 跑红 → 按上模式逐函数改造 → 跑绿（`pnpm --filter @gmind/core test -- read.test`）
- [ ] **Step 5: 门禁** `pnpm typecheck && pnpm --filter @gmind/core test`——read 收绿，operations/repair 仍红属预期
- [ ] **Step 6: Commit** `git commit -m "feat(core): 多画布 Task3 read 层画布化（配额按画布口径）"`

---

### Task 4: operations.ts 画布化（写层扫荡，含 undo 切换）

**Files:**
- Modify: `packages/gmind-core/src/operations.ts`、`packages/gmind-core/src/undo.ts`、`packages/gmind-core/src/export.ts`
- Test: `packages/gmind-core/src/operations.test.ts`、`packages/gmind-core/src/undo.test.ts`（追加）

**Interfaces:**
- Produces: 全部写 op 同 Task 3 模式加 `canvasId?`（末位可选参数）：`addChild / setText / deleteNodes / moveNode / setNodeSide / setNote / setDescription / setHref / setImage / moveImage / setIcon / setNodeTask / setCollapsed / toggleCollapse / setCustomColumns(文档级不动) / setTableView(文档级不动)` 及以现文件为准的其余 op。`createUndoManager(doc, canvasId?)` 新签名
- **ROOT 特判推广**：`moveNode`/`deleteNodes` 的 `id === ROOT_NODE_ID` 拦截改 `id === rootIdOf(doc, canvasId)`（任一画布根都不可删/不可换父）

`undo.ts` 改造（裁定 2 的落地）：

```ts
import { canvasMapOf, resolveCanvasId } from './canvas';

/** 撤销栈：canvasId 给定时 scope=该画布子图（撤销不跨画布，需求方 2026-10-21 裁定 2）；
 *  缺省保持整文档（旧调用方兼容）。捕获/orign/合并语义不变。 */
export function createUndoManager(doc: Y.Doc, canvasId?: string): Y.UndoManager {
  const scope: Y.Doc | Y.Map<unknown> =
    canvasId === undefined ? doc : canvasMapOf(doc, canvasId);
  return new Y.UndoManager(scope as never, {
    trackedOrigins: new Set([ORIGIN_USER]),
    captureTimeout: 500,
  });
}
```

`export.ts cloneExpanded(doc, canvasId?)`：遍历范围改画布 nodes map、根改 rootIdOf。

**逐 op 校验点**（每改一个核对一处）：op 内部的 `doc.getMap('nodes')` → `canvasNodesMap(doc, canvasId)`；`doc.getMap('summaries')` 引用（setNodeTask 无、概要 op 在 summary.ts=Task 7）；同值守卫/校验全部保持在 withTransaction 之外（纪律复核）。

- [ ] **Step 1: 失败测试**——双画布：c1 的 `addChild` 不出现在 c2 的 `subtreeIds`；`moveNode` 移 c2 根抛 ROOT_FORBIDDEN；`createUndoManager(doc,c1)` 撤销 c1 编辑后 c2 内容不变（裁定 2 钉死用例）
- [ ] **Step 2-4**: 红 → 改造 → 绿（`pnpm --filter @gmind/core test -- operations undo`）
- [ ] **Step 5: 门禁**——operations/undo 收绿；repair/summary/restore 红属预期
- [ ] **Step 6: Commit** `git commit -m "feat(core): 多画布 Task4 写层画布化+按画布撤销"`

---

### Task 5: repair.ts 多画布化（本计划最大风险点）

**Files:**
- Modify: `packages/gmind-core/src/repair.ts`（normalizeTree / normalizeTreeFor / deriveNormalizeDirty / 全部 plan-apply 对 / attachRemoteNormalization / planSideBackfill）
- Test: `packages/gmind-core/src/repair.test.ts`、`packages/gmind-core/src/remote-sync.test.ts`、`packages/gmind-core/src/chaos.test.ts`

**规则重述（⓪-⑧ 全部改为「画布内作用域」，新增 ⑨⑩ 画布级）：**

- 作用域替换：`nodesMap(doc)` → `ensureCanvasShape(canvasMap).nodes`；`summaries` → 画布内 summaries；`ROOT_NODE_ID` → 该画布 `rootId`
- **⑨ 画布根防御**：canvas.rootId 指向缺失/墓碑节点 → 重建该 root（text=''、parentId=''、空 children），存活孤儿按 ⑤ 挂回（原规则⑥的推广）
- **⑩ 画布序与墓碑收敛**：canvasOrder 中非字符串/指向不存在或墓碑画布的项 → 移除；存活画布不在 order 中 → 按 canvasId 升序追加（确定性）；画布墓碑（deleted=true）的 nodes/summaries **不动**（冻结不变量推广：墓碑是快照/还原依据）
- `normalizeTree(doc)` 全量 = 逐存活画布跑 ⓪-⑧＋一次 ⑨⑩；`normalizeTreeFor` 的脏区集合从「nodeId 集合」改「`canvasId → Set<nodeId>`」映射
- `deriveNormalizeDirty`：嵌套形状深一层——tr.changed 里出现的内层 nodes map 需反查所属画布（逐存活画布做 `===` 同一性比对）；反查不到/未知形状 → 返回 null 退全量安全阀（先例不变）
- `attachRemoteNormalization` 接口不变，内部走新脏区映射
- 等价性论证与混沌套件：修补丁里的等价性头注（repair.ts:52-61）改写为多画布口径；`chaos.test.ts` 操作池加「跨画布并发写」维度（两个画布上并发 addChild/moveNode/deleteNodes 后双副本收敛一致）

- [ ] **Step 1: 失败测试**——双画布：c1 制造孤儿不影响 c2；c2 根墓碑触发 ⑨ 重建；order 含墓碑项被 ⑩ 清；`chaos` 新维度用例（允许长测，标记同既有 chaos 约定）
- [ ] **Step 2-4**: 红 → 改造 → `pnpm --filter @gmind/core test -- repair remote-sync chaos` 绿
- [ ] **Step 5: 全量门禁**——此刻 core 应**全部收绿**（summary/restore 若仍红，进入 Task 6/7 前先在 commit message 登记）
- [ ] **Step 6: Commit** `git commit -m "feat(core): 多画布 Task5 repair 多画布化（规则⑨⑩+混沌新维度）"`

---

### Task 6: summary.ts 与 restore.ts 画布化

**Files:**
- Modify: `packages/gmind-core/src/summary.ts`、`packages/gmind-core/src/restore.ts`
- Test: `packages/gmind-core/src/summary.test.ts`、`packages/gmind-core/src/restore.test.ts`

**Interfaces:**
- summary：`validSummarySegment / setSummary / removeSummary / listSummaries / planSummaryRepair / applySummaryRepair` 全部加 `canvasId?`，summaries map 改读画布内（Task 5 已把 repair 调用点切过来）
- restore：`restoreFromSnapshot(target, snapshot)` 改**逐画布**执行：画布集合并集按 canvasId 对齐（id 相同才配对的先例——画布增删随快照回滚：target 有而 snapshot 无的画布置墓碑＋移出 order；snapshot 有而 target 无的整画布深拷贝重建）；每画布内复用现有「可达集先序 diff」逻辑，根从 `rootIdOf(canvas)` 取；**summaries 不进 diff（裁定 6，现状口径保持）**；meta.title 恒排除（先例）；画布的 name/structureType/themeId 纳入 diff（对齐 meta⑤ 先例）
- 头注同步改写（含「概要口径已裁定 2026-10-21」引用，保持与现行注释一致）

- [ ] **Step 1: 失败测试**——双画布快照恢复：c1 内容回滚、c2 不动（同快照则同回滚）；snapshot 多出的画布重建；概要在恢复后保持 target 现状（裁定 6 钉死）
- [ ] **Step 2-4**: 红 → 改造 → 绿
- [ ] **Step 5: 门禁** `pnpm lint && pnpm typecheck && pnpm --filter @gmind/core test`——**core 全绿**
- [ ] **Step 6: Commit** `git commit -m "feat(core): 多画布 Task6 概要/恢复画布化"`

---

### Task 7: 画布管理写操作（web 计划三的唯一接口）

**Files:**
- Modify: `packages/gmind-core/src/canvas.ts`（追加写 op）或新建 `packages/gmind-core/src/canvas-ops.ts`（与读侧分离，推荐）
- Test: `packages/gmind-core/src/canvas-ops.test.ts`

**Interfaces:**
- Produces（计划三 web 页签条直接消费）：
  - `addCanvas(doc, opts?: { name?: string; structureType?: StructureType; themeId?: string }, origin = ORIGIN_USER): string`——新 rootId=ulid、root 文本「中心主题」（沿用 2026-10-09 新建空白文档裁定）、name 缺省 `画布 ${存活数+1}`（**事务外计算**，校验先于事务）、追加 order 末尾、置 meta.activeCanvasId=新 id（system 语义并入同事务）。返回新 canvasId
  - `renameCanvas(doc, canvasId, name, origin?)`——校验：trim 后空名抛 `CANVAS_NAME_EMPTY`、长度 >50 抛 `CANVAS_NAME_TOO_LONG`（errors.ts 补两码）；同值守卫（同名零事务）
  - `deleteCanvas(doc, canvasId, origin?)`——校验：**最后一张存活画布抛 `CANVAS_LAST_FORBIDDEN`**（默认假设 5）；置画布墓碑 deleted=true＋移出 order；nodes/summaries 内容不动（墓碑冻结不变量）；activeCanvasId 指向被删画布时改指 order 首个存活
  - `reorderCanvases(doc, canvasId, toIndex, origin?)`——order 内移动；index 钳制 [0, len-1]；同位零事务
  - `setActiveCanvas(doc, canvasId)`——meta.activeCanvasId LWW，ORIGIN_SYSTEM（视图态不进撤销栈）
- 以上全部 ORIGIN 口径：内容型操作（add/rename/delete/reorder）user origin 可撤销与否按「默认假设 6：画布管理不进撤销栈」——实现为 user origin 但 UndoManager scope=画布子图天然不含 canvases/canvasOrder 两个 doc 级根类型，**无需特殊处理即满足假设 6**（在注释中写明这个巧合是设计依据）

- [ ] **Step 1: 失败测试**——addCanvas 后 listCanvases 增 1 且 active 指向新画布；rename 空名/超长抛错零变更；deleteCanvas 最后一张抛 CANVAS_LAST_FORBIDDEN；reorder 钳制；撤销 c1 编辑不影响画布管理状态（假设 6 钉死）
- [ ] **Step 2-4**: 红 → 实现 → 绿
- [ ] **Step 5: 门禁三件套**
- [ ] **Step 6: Commit** `git commit -m "feat(core): 多画布 Task7 画布管理写操作"`

---

### Task 8: 收口 —— 全量门禁与波及面确认

- [ ] **Step 1**: `pnpm lint && pnpm typecheck && pnpm test` 全绿（core/xmind-io/engine/web/shared 全包单测；web 单测若因 core 形状变化红，只允许改读取路径不改语义——同 Task 2 纪律）
- [ ] **Step 2**: `pnpm --filter @gmind/server test:e2e`（server 零改动预期全绿——验证兼容层承诺：server 读 `countAliveReachable(doc)` 缺省第一画布、`files.structure` 回填经 getMeta 缺省画布）
- [ ] **Step 3**: `WEB_PORT=5174 API_ORIGIN=http://localhost:3001 pnpm --filter @gmind/web e2e` 全绿（兼容层承诺的终验：web 未改一行，单画布行为与改造前完全一致）
- [ ] **Step 4**: 若以上全绿 → `git commit`（如有测试读取路径调整）；若红 → 不修 web 业务代码，回 core 兼容层修（兼容层契约破坏 = 本计划的 bug）
- [ ] **Step 5**: 更新 `docs/project-status.md` §二 状态表多画布行：「计划一 core 层 ✅」；启动计划二（engine 参数化）的编写

## Self-Review 记录（计划作者已核）

- **Spec 覆盖**：裁定 1（Task 3 countAliveReachable 口径）、2（Task 4 undo scope）、5（Task 2/3 画布级 structure/theme）、6（Task 6 restore 不含 summaries+钉死测试）；假设 1（Task 2/7 命名）、3（customColumns 文档级不动）、5（Task 7 CANVAS_LAST_FORBIDDEN）、6（Task 4/7 scope 巧合）；裁定 3/4/7/8 属 engine/web/xmind-io 层，归计划二三四
- **类型一致**：`resolveCanvasId/canvasNodesMap/rootIdOf/ensureCanvasShape/listCanvases` 在 Task 1 定义、Task 2-7 引用一致；错误码 CANVAS_NOT_FOUND/CANVAS_NAME_EMPTY/CANVAS_NAME_TOO_LONG/CANVAS_LAST_FORBIDDEN 在 Task 1/7 定义处标明
- **已知留白（如实登记）**：Task 3/4 的「全函数清单」以执行时 `grep "^export function"` 现文件为准（本计划撰写时逐个核对过 read.ts/operations.ts 出口，未逐一抄录）；deriveNormalizeDirty 的反查实现细节留给执行者按 Step 3 口径落地，混沌用例给出判定标准而非全量代码
