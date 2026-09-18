# @gmind/core

Gmind 内核：Yjs 文档结构、读快照、写操作、自愈、撤销、剪贴板数据层。纯数据层，无渲染/无 DOM。本文的 API 清单即 M1b 的契约面——只增不改，破坏性变更需过里程碑裁决。

## Quickstart

```ts
import * as core from '@gmind/core';
const doc = core.createTemplateDoc({ title: '我的脑图', children: [{ text: '主题 A' }] }); // 建档
const id = core.addChild(doc, core.ROOT_NODE_ID, { text: '主题 B' }); // 写操作（user origin，可撤销）
core.undo(core.createUndoManager(doc)); // 撤销最近一次 user 写事务
const state = core.docToState(doc); // 序列化；docFromState(state) 还原（入口即收敛）
```

## 公共 API 清单（src/index.ts 全量导出，45 个运行时值 + 类型）

### constants

- `MAX_TEXT_LENGTH = 500` — 节点文本上限
- `MAX_NOTE_LENGTH = 5000` — 节点备注上限
- `ICON_GROUPS = ['priority', 'progress', 'flag', 'star']` — 图标组
- `type IconGroup = (typeof ICON_GROUPS)[number]`

### errors

- `class GmindCoreError extends Error` — `constructor(code: GmindCoreErrorCode, message: string)`
- `type GmindCoreErrorCode = 'NODE_NOT_FOUND' | 'NODE_DELETED' | 'ROOT_FORBIDDEN' | 'CYCLE_FORBIDDEN' | 'TEXT_TOO_LONG' | 'NOTE_TOO_LONG' | 'INVALID_HREF' | 'INVALID_ICON_GROUP'`

### read（只读快照与存活查询）

- `interface DocMeta { title: string; structureType: StructureType; themeId: string }`
- `interface NodeImage { key: string; w: number; h: number }`
- `interface NodeSnapshot { id; text; parentId; childIds; note; href; image: NodeImage | null; icons: Partial<Record<IconGroup, string>>; style: Record<string, string>; collapsed; deleted }`
- `getMeta(doc: Y.Doc): DocMeta`
- `setDocMeta(doc: Y.Doc, patch: Partial<DocMeta>, origin = 'user'): void`
- `getNode(doc: Y.Doc, id: string): NodeSnapshot | null`
- `childrenIds(doc: Y.Doc, id: string): string[]`
- `isAlive(doc: Y.Doc, id: string): boolean`
- `subtreeIds(doc: Y.Doc, id: string, includeDeleted = false): string[]`
- `pathToRoot(doc: Y.Doc, id: string): string[]`
- `countAlive(doc: Y.Doc): number`
- `requireAliveNode(doc: Y.Doc, id: string): Y.Map<unknown>` — 缺失/墓碑分别抛 NODE_NOT_FOUND / NODE_DELETED

### operations（写操作与事务；origin 默认 ORIGIN_USER）

- `const ORIGIN_USER = 'user'` / `const ORIGIN_SYSTEM = 'system'`、`type WriteOrigin = string`（转出自 undo）
- `interface AddChildOptions { index?: number; text?: string }`
- `interface WithTransactionOptions { normalize?: boolean }` — 默认 true，事务后按脏区 normalize
- `withTransaction<T>(doc: Y.Doc, origin: WriteOrigin, fn: () => T, opts?: WithTransactionOptions): T`
- `addChild(doc: Y.Doc, parentId: string, opts?: AddChildOptions, origin?: WriteOrigin): string`
- `setText(doc: Y.Doc, id: string, text: string, origin?: WriteOrigin): void`
- `deleteNodes(doc: Y.Doc, ids: string[], origin?: WriteOrigin): void` — 墓碑软删
- `moveNode(doc: Y.Doc, id: string, newParentId: string, index?: number, origin?: WriteOrigin): void`
- `setNote(doc: Y.Doc, id: string, note: string, origin?: WriteOrigin): void`
- `setHref(doc: Y.Doc, id: string, href: string, origin?: WriteOrigin): void`
- `setImage(doc: Y.Doc, id: string, image: NodeImage | null, origin?: WriteOrigin): void`
- `setIcon(doc: Y.Doc, id: string, group: IconGroup, value: string | null, origin?: WriteOrigin): void`
- `setCollapsed(doc: Y.Doc, id: string, collapsed: boolean, origin?: WriteOrigin): void` — 默认 ORIGIN_SYSTEM（不进撤销栈）
- `toggleCollapse(doc: Y.Doc, id: string, origin?: WriteOrigin): void`
- `setStyle(doc: Y.Doc, id: string, patch: Record<string, string | number | null>, origin?: WriteOrigin): void`
- `type StyleScope = 'subtree' | 'single'`
- `applyStyle(doc: Y.Doc, rootIds: string[], patch: Record<string, string | number | null>, scope: StyleScope, origin?: WriteOrigin): void`

### repair（自愈/规范化，均以 system origin 写入）

- `normalizeTree(doc: Y.Doc, origin?: string): number` — 全量收敛，返回修复写入数
- `normalizeTreeFor(doc: Y.Doc, origin: string, dirtyNodeIds: Set<string>): number` — 增量收敛指定脏区
- `deriveNormalizeDirty(doc: Y.Doc, tr: Y.Transaction): Set<string> | null` — 从事务派生脏节点集

### undo（撤销/重做，仅跟踪 ORIGIN_USER 事务，FR-EDT-004）

- `createUndoManager(doc: Y.Doc): Y.UndoManager` — captureTimeout 500ms 合并
- `capUndoStack(um: Y.UndoManager, max?: number): void` — 默认 `UNDO_STACK_MAX = 100`
- `undo(um: Y.UndoManager): boolean`
- `redo(um: Y.UndoManager): boolean`

### clipboard（子树 ⇄ 缩进大纲，FR-EDT-009/010）

- `interface SpecNode { text: string; children: SpecNode[] }`
- `subtreeToOutlineText(doc: Y.Doc, id: string): string` — Tab 缩进纯文本；text 内换行折叠为空格（有损）
- `outlineToSpec(text: string): SpecNode[]`
- `insertSpec(doc: Y.Doc, parentId: string, index: number, spec: SpecNode[], origin?: WriteOrigin): string[]` — 全量预校验，任一非法则零变更拒绝

### doc / templates（文档构建与序列化）

- `const ROOT_NODE_ID = 'root'` — 中心主题固定 id，不可删/不可换父
- `interface TemplateNodeSpec { text: string; children?: TemplateNodeSpec[] }`
- `interface TemplateSpec { title: string; structure?: StructureType; theme?: string; children: TemplateNodeSpec[] }`
- `createTemplateDoc(spec: TemplateSpec): Y.Doc`
- `docToState(doc: Y.Doc): Uint8Array`
- `docFromState(state: Uint8Array): Y.Doc` — 导入即 normalize（自愈安全网）
- `countNodes(doc: Y.Doc): number`
- `const SEED_TEMPLATES: TemplateSpec[]` — 3 个注册赠送模板（数据本体在 templates.ts，经 doc.ts 转出）

## 已知良性依赖环

`doc → repair`（docFromState 调 normalizeTree）与 `repair → doc`（ROOT_NODE_ID）互引，均为调用期取值、无模块求值期解引用，ESM 下无 TDZ 风险；是否重构延至 M1b 裁决。
