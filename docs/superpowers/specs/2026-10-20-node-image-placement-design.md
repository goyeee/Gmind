# 节点图片位置（图文四槽位）+ 拖拽引导 + 图片独立复制/剪切 — 设计 spec

> 日期：2026-10-20。需求方走查追加（PRD 未单列），需求方裁定见 §一；本文为实现的唯一口径。
> 现状依据：`docs/m1-acceptance.md` FR-EDT-020 已登记「引擎图与文本的节点内堆叠视觉为既有后置项（图片画在 x=nodePaddingX、y=0 与标题重叠）」；本包正是清偿该项。

## 一、需求与裁定记录（2026-10-20，逐问确认）

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 图片相对文字的位置模型 | **上下左右四槽位**：图片可在文字的上方/下方/左侧/右侧；默认 **文字在上、图片在下**（`bottom`） |
| 2 | 拖图到「已有图」的目标节点 | **直接替换目标图**：源节点图片清空、文字不动；一次拖拽 = 一步撤销 |
| 3 | 拖拽手势（与拖节点/双击预览/四角缩放共存） | **图片本体直接拖拽**：鼠标悬停图片显示四向 `move` 光标，按住图片即可拖图换位（不再需要额外把手）；位移 ≤4px 仍走单击选中/双击预览，四角缩放手柄优先；图片上的按下不再触发节点拖动（engine 候选排除） |
| 4 | 右键图片菜单 | **复制图片 + 剪切图片**（只读下仅复制）；剪切后可粘回画布且**沿用原 key** |
| 5 | 剪切后的粘贴语义 | **可粘回画布，沿用原 key**（内部图片 payload 优先，不重复上传）；跨文件时走既有 copy 端点 remap |
| 6 | 布局金样纪律冲突 | **授权更新含图节点金样**：仅含图节点几何变化，无图节点逐字节不变；`UPDATE_GOLDENS=1` 重生成并逐条核对 diff |
| 7 | 默认垂直堆叠的图片水平对齐 | **左对齐**（不是居中） |
| 8 | 图文间距 | **固定 8px**；本轮不做「拖拽调边距」 |
| 9 | 描述行/任务行归属 | 描述行跟随标题（同属文字块）；任务行恒贴盒底，不参与图片换位 |
| 10 | 引导虚框形态 | **四侧虚线带 + 命中槽位高亮**（不是与图片等大的虚框） |
| 11 | 右键「复制图片」后能否粘回画布 | **能**，与剪切同一条内部 payload 通道（沿用原 key） |

## 二、数据模型与 core 操作

### 2.1 形状（只增字段，零迁移）

`packages/gmind-core/src/read.ts`：

```ts
export type NodeImagePlacement = 'top' | 'bottom' | 'left' | 'right'; // 图片相对文字

export interface NodeImage {
  key: string;
  w: number;
  h: number;
  /** 图片相对文字的位置；缺省/非法值按 'bottom'（文字在上、图片在下）。 */
  placement?: NodeImagePlacement;
}
```

- 旧文档、旧剪贴板 payload、旧版本快照均无该字段 → 读侧归一为缺省 `bottom`。
- **读取归一**：`getNode` 读 `image` 时，`placement` 非四值之一 → 剔除该键（保留 `{key,w,h}`，不抛错、不改写 Yjs），远端坏数据不传染布局。
- 不新增 Yjs 顶层键、不加 DB 列、不做数据迁移。

### 2.2 写入（唯一入口，校验先于事务）

`packages/gmind-core/src/operations.ts`：

- `setImage(doc, id, image, origin?)`：新增校验——`image.placement` 若存在必须 ∈ 四值，否则抛 `GmindCoreError('INVALID_IMAGE_PLACEMENT', ...)`（校验在 `withTransaction` 之外）；`undefined` 合法（写默认位，不落键）。
- 新增 `moveImage(doc, fromId, toId, image, origin?)`：
  - 校验：`fromId`/`toId` 均存活且 `fromId !== toId`（同节点换位由调用方走 `setImage`；同 id 抛 `INVALID_IMAGE_MOVE`）；`image.placement` 合法。
  - **单事务**：源节点 `delete('image')` + 目标节点 `set('image', image)`；一步撤销、一次广播。
  - 目标已有图直接覆盖（裁定 2）。

### 2.3 快照 / 恢复 / 剪贴板

- `restore.ts` 的 `diffImage` 由「只比 key」扩为 **key + w + h + placement**（尺寸/位置差异也恢复）；`applySnapshot` 的 `setImage` 透传 placement。
- `packages/engine/src/clipboard.ts` 的 `PayloadNode.image` 类型加 `placement?`；复制时透传（缺省不落键）；粘贴时随 `setImage` 写回。
- `IDocHandle.setImage` 签名同步加 `placement?`。
- XMind 导入导出本轮不消费 placement（项目现有链路也不导出节点图片位置）；PNG/JPG 导出走引擎渲染，自动生效。

## 三、布局与渲染（engine）

### 3.1 单源几何：`packages/engine/src/imageLayout.ts`（新增）

纯函数模块，measure/layout/render 共用，避免三处各写一套偏移：

```ts
export const IMAGE_TEXT_GAP = 8;

export type ImagePlacement = NodeImagePlacement;

/** 输入：文字块宽高（标题行集 + 可选描述行）、图片宽高、内边距、任务行高。 */
export interface PackNodeContentInput {
  textW: number;      // 最长行宽 + iconCount×iconSlotWidth
  textH: number;      // 标题行高合计 + 描述行高
  image: { w: number; h: number; placement?: ImagePlacement } | null;
  padX: number;
  minWidth: number;
  taskRowH: number;
}

export interface PackedNodeContent {
  w: number; h: number;
  textX: number; textTop: number;      // 文字块左上（盒内坐标）
  imageX?: number; imageTop?: number;  // 无图时缺省
  taskRowTop?: number;                 // 无任务行时缺省（= h - taskRowH）
}
```

偏移口径（盒内坐标）：

| placement | textX | textTop | imageX | imageTop |
|---|---|---|---|---|
| `bottom` | `padX` | `0` | `padX` | `textH + gap` |
| `top` | `padX` | `imageH + gap` | `padX` | `0` |
| `left` | `padX + imageW + gap` | `(contentH - textH) / 2` | `padX` | `(contentH - imageH) / 2` |
| `right` | `padX` | `(contentH - textH) / 2` | `padX + textW + gap` | `(contentH - imageH) / 2` |

（`contentH` = 左右并排时的内容行高 = `max(textH, imageH)`；`taskRowTop` = 堆叠内容底 + 0，恒等于 `h - taskRowH`。）

几何口径（`padX = theme.nodePaddingX`，`gap = 8`）：

| 场景 | 盒宽 | 盒高 | 文字块 | 图片 |
|---|---|---|---|---|
| 无图 | 既有公式逐字节不变 | 既有公式逐字节不变 | 既有基线 | — |
| `bottom`（默认） | `max(textW, imageW) + 2×padX` | `textH + gap + imageH + taskRowH` | 顶部左对齐 | 文字块下方，**左对齐**（`x = padX`） |
| `top` | 同上 | `imageH + gap + textH + taskRowH` | 图片下方 | 顶部左对齐 |
| `left` | `padX + imageW + gap + textW + padX` | `max(textH, imageH) + taskRowH` | 图片右侧 | 文字块左侧，垂直居中 |
| `right` | 同上 | 同上 | 图片左侧 | 文字块右侧，垂直居中 |
| 任意 | `max(..., theme.minNodeWidth)` | — | — | — |

- `textH` 含描述行（描述行宽度仍按 `theme.maxTextWidth` 截断测量）；`taskRowH = TASK_ROW_H`（有任务信息时），任务行恒最底、通栏。
- 垂直堆叠左对齐（裁定 7），左右并排时文字块与图片各自在内容行内垂直居中；图片水平位置不再依赖 `textW` 是否大于 `imageW`。
- 图片仍受现有 `≤200px` / `≥24px` 尺寸约束，拖位置不缩放。

### 3.2 `measure.ts` / `layout.ts`

- `measureNodeBox` 增加 `imagePlacement?: ImagePlacement`，内部改调 `packNodeContent` 得 `w/h`；`lines`/`descLine` 逻辑不变。
  - 无图路径必须与旧公式**逐字节一致**（现有单测与金样兜底）。
- `layout.ts` 的 `collectTree` 把 `snap.image?.placement` 透传测量；`LayoutNode` 不新增字段（渲染侧直接读 `visual.image`）。
- 含图节点的金样按裁定 6 重生成；diff 只允许出现在含图节点。

### 3.3 `render.ts`

- 文本 tspan 基线由 `packed.textTop + contentCenter(文字块)` 计算；描述行在文字块内标题下方；任务行 `y = packed.taskRowTop`（或继续用 `b.h - TASK_ROW_H`，二者等价）。
- `<image class="gm-image">` 的 `x/y` 取 `packed.imageX/imageTop`，并新增 `data-image-placement="top|bottom|left|right"`（缺省输出 `bottom`）供交互层与 e2e 断言；同时输出 `data-no-node-drag="1"`，让 engine 节点拖拽候选在图片上让位（见 §4.2）。
- 角标（link/note/comment）、任务色条、悬浮日期 chip 的锚点不变（仍相对节点盒）。

## 四、交互（页面侧；engine 仅给图片加节点拖动排除标记）

### 4.1 新模块与层

- `apps/web/src/editor/imageDrag.ts`（新增，纯几何 + 场景层绘制）：
  - `guideLayoutOf(box, padX)` → 内容区（盒内缩 `padX`，过小回退整盒）+ 四侧带矩形（上/下带通栏、左/右带通高；厚度 `clamp(短边/4, 18, 56)`；角部重叠由高亮唯一化解）；
  - `placementAt(layout, point)` → 最近带（指针到带矩形中心的距离最近；同距按 top→bottom→left→right 稳定排序）；
  - `ghostRect` / `findNodeAt` / `findImageNode` / `renderImageDrop`。
- 新层 `g.gm-image-drag-layer` 挂 `g.gm-viewport` 内（层序：`gm-drag-overlay` → `gm-image-handles` → `gm-image-drag-layer`），场景坐标自动跟随平移/缩放；引导线宽按 `1/scale` 保持屏幕像素恒定。

### 4.2 图片本体拖拽（裁定 3）

- 鼠标悬停图片（可编辑态）→ `cursor: move`（四向箭头）；图片本体按下即登记拖拽候选，**不再渲染/依赖额外把手**。
- 与单击/双击共存：pointerdown 只记待定态（不 `preventDefault`、不捕获指针）；位移 **>4px** 才激活拖拽（`setPointerCapture`、显示半透明缩略图跟随指针，最长边 `96px` 屏幕）；≤4px 抬起仍走既有 click（选中/再击开任务面板）与 dblclick（大图预览）。
- 四角缩放手柄优先：`gm-image-resize-handle` 上的按下先于图片本体处理；手柄拖拽期间不触发换位。
- engine 节点拖拽让位：`render.ts` 给 `<image>` 加 `data-no-node-drag="1"`，engine `onPointerDown` 命中该属性即不进节点拖拽候选（文字/边框上按下仍照旧拖节点）。
- 只读态不设 move 光标、不登记拖拽候选；图片右键菜单与双击预览不受影响。

### 4.3 拖拽中的引导（裁定 10）

- 指针所在节点（源节点或其他存活节点）内绘制 **目标节点虚线外框**（`image-drop-outline`）+ **4 条虚线带**：上/下/左/右，厚度 `clamp(内容区短边/4, 18, 56)`，虚线 `5 4`、填充 10%；每条带 `data-testid="image-drop-band-{top|bottom|left|right}"`，容器 `image-drop-guides` 携带 `data-placement`。小节点上四带必然重叠，外框用于明确「当前目标节点」（2026-10-20 走查：仅细带视觉不可辨）。
- 命中槽位：按 `placementAt` 高亮（2.5px 实线描边 + 28% 填充）；同一时刻仅一个高亮。
- 指针不在任何节点盒内 → 不画引导带；在节点内但非图片/文字区 → 仍显示该节点四带（允许放到节点任意位置）。
- 拖拽**只预览不写文档**：松手才落库 → 一次拖拽 = 一步撤销；拖拽中不触发重排。

### 4.4 松手结算

| 落点 | 行为 |
|---|---|
| 源节点 + 当前 placement | 不写、不记撤销 |
| 源节点 + 其他 placement | `setImage(nodeId, {key,w,h,placement})` |
| 其他节点 | `moveImage(fromId, toId, {key,w,h,placement})`（替换目标图） |
| 空白 / pointercancel | 取消，不写文档 |

- 松手后 `afterUserWrite()` 恰一次；`justDraggedRef` 吞掉合成 click（仅在越过 4px 阈值、真正拖拽后）。
- 只读：无 move 光标、无拖拽（图片右键「复制图片」与双击预览保留）。

## 五、右键复制 / 剪切与粘贴（裁定 4/5/11）

### 5.1 图片专属右键菜单

- `onSvgContextMenu` 先判定图片（`event.target.closest('.gm-image')`，捕获重定向时用 `elementFromPoint` 恢复）**先于只读早退**：命中即弹图片菜单，**不弹节点菜单**；`contextMenu` 状态扩展为 `{ x, y, nodeId, image?: true, summaryId? }`。
- 菜单项（`data-testid`）：`menu-image-copy`「复制图片」、`menu-image-cut`「剪切图片」；只读下仅渲染复制项（移动端 `max-width: 768px` 既有 CSS 仍整体隐藏右键菜单，本次不新增长按菜单）。

### 5.2 复制 / 剪切

- 复制：`fetch('/api/images/{key}')` → 统一转 PNG（非 PNG 经 `createImageBitmap` + canvas `toBlob`）→ `new ClipboardItem({ 'image/png': blobPromise })` 写系统剪贴板（`ClipboardItem` 直接接收 promise，保留用户手势激活，避免先 await 再写）；同时写入**内部图片 payload** `{ key, w, h, placement, fileId }`（engine clipboard 模块级内存，`setLastImage/getLastImage/clearLastImage`），并清除节点 payload（`clearInternalFallback` 新增导出；反之 `writeClipboard` 复制节点时清图片 payload）。
- 剪切：复制成功后再 `setImage(nodeId, null)`；一次剪切 = 一步撤销（复制本身不写文档）。
- 剪贴板不可用/写失败：toast 两段式（如「复制图片失败：浏览器未授权剪贴板 / 请检查站点权限后重试」），不静默、不写半截。

### 5.3 粘贴仲裁

- Ctrl/Cmd+V：**内部图片 payload 优先**（`handlePaste` 同步检查）——
  - 选中节点（无选中则 root）→ 插入/替换图片，沿用原 key；跨文件按 key 前缀判定（`remapImageKey`）走既有 `POST /api/files/:id/images/copy` remap；
  - 置一次性 `internalImagePasteRef` 标志让原生 paste 监听让路（避免同一张图再上传一份）；payload 保留，可连续粘贴。
- 无内部 payload + 系统剪贴板有图 → 走现有原生 paste 上传链路（新 key），行为不变。
- 节点已有图时粘贴 → 直接替换（与拖拽落点同口径），一步撤销。
- 复制/剪切图片后复制节点文本：图片 payload 被清除，Ctrl+V 回到节点/文本路径。

## 六、兼容、协同与影响面

- **协同**：placement 是节点 `image` 对象的普通字段，随现有 Yjs update 广播；远端更新走既有重排链路，手柄/拖拽层随 `gm-selected` 与重排刷新。拖拽中源图被远端移除的极端并发按起拖快照 LWW 落库（不做额外提示）。
- **恢复/快照**：见 §2.3；旧快照缺 placement → 默认位。
- **导出**：PNG/JPG 走同一渲染结果；XMind 不涉及。
- **布局金样**：仅含图节点变化（裁定 6）；无图节点逐字节不变；`UPDATE_GOLDENS=1` 后逐条核对 diff 并在验收文档登记。
- **testid 契约**：新增 `image-drop-guides` / `image-drop-outline` / `image-drop-band-{top|bottom|left|right}`、`menu-image-copy`、`menu-image-cut`；既有 `image-resize-handle-*` 不变。
- **不做**：多图同节点、节点内自由坐标、拖拽自动滚屏、拖拽调图文边距、移动端长按菜单、XMind 图片位置、图片 URL 插入。

## 七、验证与文档义务

### 7.1 单测

- engine：`imageLayout` 四槽位 ×（纯文本/带描述/带任务行）几何；无图盒与旧公式逐字节一致；`render.test` 断言四槽位 `data-image-placement`、`data-no-node-drag`、图片坐标、文字基线；`drag.test` 断言图片上按下不进节点拖拽候选；`clipboard.test` placement 往返 + 旧 payload 缺省默认位 + 图片/节点 payload 互斥（set/get/clear）；金样 diff 仅含图节点。
- core：`setImage` placement 校验（非法值抛错且零写入）、`moveImage` 单事务/一步撤销/同 id 退化/目标覆盖、`restore` 差异含 placement/w/h、`getNode` 坏值归一。
- web：`imageDrag.test.ts`——引导带几何、最近槽位命中（含同距稳定序）、ghost 等比；`imageHandles.test.ts` placement 偏移。

### 7.2 e2e（`apps/web/e2e/image-placement.e2e.spec.ts` 新增 + 既有回归）

1. 默认：上传图片后文字在上、图片在下（`data-image-placement="bottom"`，`image` 的 `y` > 0）。
2. 悬停图片显示 `move` 光标；拖图片本体到源节点 top 槽位 → 目标外框 + 4 条引导带出现、命中槽位高亮、不出现 engine 节点拖动芯片；松手后 placement 落库、刷新后保留。
3. 跨节点拖拽：拖到另一节点 left 槽位 → 目标图被替换、源节点图清空、`Ctrl+Z` 一步还原两端。
4. 右键复制：菜单含复制+剪切；复制后系统剪贴板可读到 `image/png`，节点数据不变；选中另一节点 `Ctrl+V` → 图片以**原 key**出现。
5. 右键剪切 → 图片消失 → 选中第三节点 `Ctrl+V` → 仍为原 key。
6. 回归：既有 `image-interactions.e2e.spec.ts` 覆盖四角缩放/双击预览/真键盘粘图；`m1-gaps` 覆盖节点复制粘贴（右键文字区取节点菜单）。

### 7.3 门禁与文档

- 门禁五件套（`AGENTS.md` §三.8）：lint/typecheck 0；单测 engine 417/417、web 107/107、shared/server/xmind-io 全过；core 295/296（仅 bench「1 万次混合操作」3s 阈值机器负载超时，既有存量）；server e2e 195/195；web e2e 182 passed + 1 skipped。
- 当日更新 `docs/m1-acceptance.md`（FR-EDT-020 行补「图与文本堆叠视觉已清偿 + 四槽位/拖拽/复制剪切」与真实用例名/行号）、`docs/project-status.md` §二/§三与门禁基线、`README.md` 进度行。
- 已知取舍登记：拖拽松手才落库（无实时重排预览）；拖拽中无自动滚屏；图片复制依赖浏览器剪贴板权限；一次拖拽与其前 500ms 内的用户写可能被 `captureTimeout` 合并为同一步撤销（Yjs 既有语义）。

## 八、风险

1. **金样范围**：含图节点几何全变；必须逐条核对 diff，若出现无图节点变化立即停。
2. **交互冲突**：图片本体起拖与单击选中/双击预览共用按下链路——以 4px 位移阈值区分，四角缩放手柄优先，engine 节点拖动排除 `data-no-node-drag`；e2e 覆盖（`image-placement` + `image-interactions`）。
3. **剪贴板权限/兼容**：`ClipboardItem` 在非安全上下文/部分浏览器不可用；失败走 toast，不阻塞剪切（剪切需复制成功后才删图）。
4. **撤销粒度**：拖拽/粘贴均为单次写；与既有 500ms `captureTimeout` 的合并语义一致（长停顿可能分步，如实登记）。

## 九、2026-10-20 走查追加（选中轮廓 + 缩放灵敏度）

- **图片聚焦轮廓**：点图片 → 只描图片轮廓（`renderImageFocusOutline` 画在手柄层、压四角手柄之下，`data-testid="image-focus-outline"`），整节点描边由 `applySelectionClasses` 内联退回主题边框（`resolveNodeStyle`），蓝色让位图片轮廓；点文字/节点其他区域 → 整节点蓝框（`gm-image-focused` 类只在「单选 + 点击落点 .gm-image」时置位，选区不匹配/图被移除自动失效；只读同样可见）。`selectOnly` 同 id 不 emit，点击处理显式补刷 `applySelectionClassesRef`。
- **拖角灵敏度 ×2**：`IMAGE_RESIZE_SENSITIVITY = 2`（`resizeImageSizeByDelta` 内位移先乘系数再换算缩放系数）；200px 上限 / 24px 下限 / 等比锁定 / 零位移幂等口径全部不变（需求方在「放开上限 / 角跟手 / 提高系数」三案中选定提高系数）。
- **测试**：web 单测 imageHandles 11 例期望值随 ×2 更新；e2e `image-interactions` 新增「图片选中轮廓：点图片描图片边、点文字描整节点蓝框」（:329），两条缩放用例期望随 ×2 改 48×192。
