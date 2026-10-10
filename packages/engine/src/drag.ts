/**
 * 节点拖拽：换父 / 同级排序插入 — M1b Task 9 起步，M7c-D1 按企微对标 spec P0-2 重做，
 * M7c-D3 升级「芯片跟随 + 原位占位 + 真实边落位预览」，M7c-G（需求方 2026-09-30 拖动
 * 吸附实测反馈）把落点解析重写为「列吸附连续模型」。
 *
 * M7c-G 列吸附连续模型（需求方原话「我把节点拉到对应位置，并没有产生吸附最佳节点的
 * 效果。比如我靠近中心节点上下移动，吸附线应该出现在我当前所在位置——我在哪停，他就
 * 应该插在哪两个节点中间。比如我拖到了某个层级的子节点右边或左边（朝左的节点就是左边），
 * 就应该对这个子节点产生吸附效果，松开后就要吸附上去。」）——落点按**区域优先级**解析
 * （纯函数 classifyDropAt，全几何判定，导出供单测直测）：
 * 0. **盒直击禁止**：被拖节点/其后代本体一律 drop-forbidden（整盒，先于一切区域）；
 * 1. **子级吸附区**（最深优先）：节点 N 的生长侧区——right 侧 x ∈ [N.left, N.right +
 *    列间隙 + max(子级列宽, 被拖盒宽)]、left 侧镜像、root 两侧都算（侧别按指针相对根盒
 *    中线）；y ∈ [区顶 − 8, N 子树带底 + 8]，root 区顶取全树带顶——根是整列脊柱，「靠近
 *    中心节点上下移动」要求根侧全程跟随。命中 → child of N：插入 index = P.y 在 N 子级
 *    中的**最近间隙位**（无子级=追加），蓝描边（drop-target）保留、真实边+槽预览同画
 *    （此前只有描边）；
 * 2. **同级插入列**（次优先）：父节点的子级列条带——x ∈ [列x − 24, 列右 + 24]、
 *    y ∈ [首子级带顶 − 带间距, 末子级带底 + 带间距]（列 x/宽、带间距从「移除被拖节点后」
 *    的同侧子级盒实测）。命中 → 插到该父的子级中，index 同按最近间隙位（org 镜像：
 *    子级行条带、index 按 P.x）；
 * 3. **空白**：维持 resolveBlankTarget（root 对应侧末尾，侧别按指针半屏）。
 *    同一指针同中多区取更深节点（子级区先于其父列条带）——候选按 depth 降序遍历即得。
 * - **index 结算口径**：classify 以「移除被拖节点后」的子级堆算最近间隙位（槽中心与
 *   resolveDropSlot/insertCenterY 同公式，同点必同槽）；moveNode 先移除后插入，引擎不再
 *   做二次位次修正。child 区命中与列条带命中统一产出 sibling 写参数 {parentId, index}；
 *   DropTarget 的 child 成员仅为页面既有分支保留，引擎不再产出。
 * - **根级侧别 = 持久侧别直取（逆时针定侧，需求方 2026-09-30；旧「复刻半分逻辑
 *   修正 index」仿真退役）**：持久 side（core addChild 自动定侧 / setNodeSide 写入）
 *   下布局不再翻面，落点解析改为「目标侧 = 芯片所在侧（classify 的 sideHint，指针
 *   相对根盒中线）」，index = 该侧现有二级主题（按 NodeBox 当前 side 过滤）按 y 的
 *   最近插入位映射回文档序（sideInsertDocIndex）。门控：根级左列是否开放改由页面
 *   结构门控决定（deps.rootLeftAllowed，2026-10-09 需求方修复「左侧没有分支主题时
 *   右侧分支无法拖到左侧」——mindmap 恒开放：拖左即建首个左列主题；logic 向右结构
 *   恒右，布局不读 side）；缺省回退几何口径（盒集已有左列主题才开放——logic 全右/
 *   新文档恒右的旧行为）。classifyDropAt/resolveDropSlot/空白解析三处共用同一取值
 *   （同点必同侧）。目标 side 随 DropTarget.side 输出，页面据此调 core setNodeSide
 *   （页面接线注意：仅 mindmap 结构消费该字段）。
 * - **去掉 100ms 点亮门槛**（DROP_HOVER_MS 移除）：预览随指针即时更新（每次 move 直接
 *   结算并画，落点切换即摘旧反馈），释放仍取最后一帧缓存——所见即所提不变。
 * - logic/org 门控（org 镜像区/列见上）、ghost 芯片右下偏移、禁止红描边+芯片变红、
 *   释放同参——全部保留不动。
 *
 * 【组拖动（2026-09-30 需求方「多个节点选中后要能同时拖动到其他节点」）】
 * - **拾起**：deps 新增可选回调 getDragGroup(grabbedId)——按下节点命中当前多选
 *   （size>1 且含 grabbedId）时页面返回整组 id（按布局序 box.y→box.x 升序排序、
 *   排除 root）；否则 [grabbedId] 单节点。控制器内部 drag.ids: string[] 取代单 id
 *   （单节点=长度 1，全路径兼容），组内序 = 拾起时布局序，释放时原样交给 onDrop。
 * - **判定**：classifyDropAt 排除集从「被拖子树」扩为「全组各自子树」并集（组内
 *   任一节点是命中目标本体/祖先 → 禁止）；区域命中与槽位计算不变（组作为整体插入
 *   一个 parent+index）；「移除被拖节点后」的子级堆口径扩为「移除全组后」。
 * - **预览**：ghost 改组芯片——最多 2 层堆叠（第一、二个节点各自盒尺寸文字，第二层
 *   偏移 +6,+6 垫底、第一层盖顶），size>1 时第一层右上角画计数徽章（圆形企微蓝底
 *   白字 ×N，类/testid gm-drag-ghost-badge）；禁止态芯片变红沿用（两层 rect 均为
 *   ghost 直接子元素，页面 CSS `> rect` 同时命中）。edge+槽单套不变（组落同一槽，
 *   槽盒取主拖节点尺寸）。
 * - **根级侧别**：目标侧跟芯片所在侧（组内序不影响侧别判定；主拖节点盒算芯片），
 *   target.side 随组落点一并输出——页面把整组 setNodeSide 到目标侧。
 * - **释放**：onDrop 改传 ids: string[]（单节点长度 1）；页面整组**单事务**原子移动
 *   ——moveNode(id, parentId, index + i) 递增插入保证组内序 = 拾起时布局序（引擎
 *   index 已按「移除全组后」的子级堆结算，序列与结算口径严格自洽），一次 Ctrl+Z
 *   整组回滚。组不含 root（拾起排除）；空白/取消/svg 外语义沿用。
 *
 * 【M7c-D1/D3/F 历史裁决（M7c-G 起带模型/点亮门槛退役，其余仍有效）】
 * M7c-D1 落点三分语义（需求方原话「拖动的功能简直糟糕透了，我都没看懂逻辑是啥」；
 * ±25% 边缘带模型已被 M7c-G 区域模型取代，保留原文备查）：
 * - **拾起**：过阈值激活即在悬浮层建 `g.gm-drag-ghost` 芯片（被拖节点盒大小的圆角
 *   矩形 + 居中文字），逐帧定位到「指针 + 右下偏移」（screen 14px 恒定 → scene 偏移
 *   = 14/scale，M7c-F 复验问题3① 改——原「指针 − 抓取偏移」居中口径会压住光标处
 *   的目标描边）；被拖节点原位挂 `gm-drag-origin`（与 gm-dragging 并挂）——虚线淡
 *   出成占位框，树其余部分不回流。
 * - **落位预览 = 真实连线**（需求方原话「吸附效果应该有一条线和被吸附节点连着，
 *   放开后就真正吸附上去」）：sibling 落点悬停点亮后画 `path.gm-drop-edge`（候选父
 *   盒边中点 → 落位槽盒边中点，render.ts 同款 bezier 公式——这条线就是松手后会
 *   出现的边）+ `rect.gm-drop-slot`（落位槽虚线框）。child 落点仍是目标盒蓝描边
 *   （drop-target）、禁止仍红描边（drop-forbidden），旧横向指示线 gm-drop-indicator
 *   整体移除（被「边+槽」取代）。
 * - **所见即所得 + 预览/释放一致性**：classify→resolve→槽计算收敛为单一结算路径
 *   （computeResolved），逐帧缓存于 pending；释放点 = 最后悬停点（常态）时直接复用
 *   缓存提交，绝不二次计算造成预览与落点分叉；释放点 ≠ 最后悬停点（svg 外兜底
 *   释放等）才用**同一函数**现算——同点必同果。
 * - **根级侧别仿真（「松手跳左侧」根治）→ 逆时针定侧起退役**：layout 的
 *   assignMindmapSides 旧按「累计子树带高过半即翻左」前缀切分，拖放插入改变文档序
 *   后重排，被拖节点可能被分到对侧——resolveDropSlot 曾复刻该半分逻辑做仿真修正。
 *   持久侧别（core node.side，需求方 2026-09-30）下布局不再翻面：侧别 = 落点芯片
 *   所在侧（门控见上方「根级侧别 = 持久侧别直取」），仿真不复存在，index 即最终
 *   index（本节保留原文备查）。
 *
 * M7c-F 复验修复（Kimi K3 复验 commit e484dcc 报四问题）：
 * 1. **上缘带槽位错位**：insertCenterY 首位插入去掉「不高于父盒中线」下钳制——首
 *    兄弟悬在父中线上方时槽曾被钳到父中线，与真实插入位（插首位、锚点顺移）偏离
 *    最多 228px。槽中心 = 首盒上方空隙（首盒 y − 带间距/2），跟随几何。
 * 2. （页面侧）拖动释放不再强制全量 fit，改 rAF panNodeIntoView——见 EditorPage
 *    onDrop 注释。
 * 3. **芯片遮挡目标描边**：芯片跟随改「指针 + 右下偏移」（screen 14px 恒定 → scene
 *    偏移 = 14/scale，读 deps.viewport.scale，无需新增 deps 回调）；禁止态芯片挂
 *    `gm-drag-ghost-forbidden`（描边转红由页面 editor.css 落色）。chipBox（侧别/
 *    最近插入位判定输入）与芯片视觉定位同源（ghostChipBox）。
 * 4. **空白悬停零预览、释放跳对侧**：classify 空白改返回 `kind:'blank'` placement，
 *    resolveBlankTarget 解析为「root 对应侧末尾」sibling 落点（侧别=指针 x 相对
 *    root 盒中线，经 sideHint 传入 resolveDropSlot 过既有侧别仿真；单侧文档槽侧恒
 *    跟结构实际侧 right）——画真实边+槽预览，释放按同一 computeResolved 结算提交。
 *    EditorPage 的 target===null 分支仅作兜底；svg 外 window 兜底释放改为取消（拖
 *    离画布视为放弃，不按远点结算）。
 *
 * 反馈时机（300ms → 100ms，spec P0-2；**M7c-G 起门槛整体移除**，预览即时随指针）：
 * 同一落点悬停满 100ms 才点亮高亮/预览；切换落点立即摘除并重置计时。**释放裁决不再
 * 要求悬停时长**——指针在哪里松开，落点就按哪里结算（企微/XMind 通例）。
 *
 * 被拖节点视觉反馈（需求方「拖动节点时被拖节点零反馈」）：激活瞬间（activate，
 * 过 4px 阈值那一步）给被拖节点 g 挂 `gm-dragging` + `gm-drag-origin` 类，视觉由
 * 页面 CSS 落地；所有结束路径（释放成功、禁止目标静默取消、pointercancel、svg 外
 * pointerup 兜底、destroy）统一经 clearHighlights 摘除——挂/摘以 draggingVisualIds
 * 字段配对，不依赖 this.drag 的清空时序，任何路径不残留类。
 *
 * 原生文字拖选根治（需求方「点击节点拖动时竟然把文字选中了」）：web 侧
 * user-select:none（editor.css .editor-canvas）之外，engine 在候选 pointerdown 与
 * 激活 move 上 e.preventDefault()——按 Pointer Events 规范，取消 pointerdown 抑制
 * 其默认动作（含文本选择起锚与兼容 mousedown 派发），click/dblclick/contextmenu
 * 合成不受影响（页面 onSvgClick / 双击编辑 / justDragged 防抖链路不变）。jsdom
 * 无法复现原生拖选，测试以 event.defaultPrevented 断言；真机由浏览器默认动作
 * 语义保证 + CSS 双保险。
 *
 * 生命周期绑定裁决（沿用 M1b Task 9 + fix round 1）：
 * - pointerdown 命中 <g data-node-id>（主键）才登记候选；折叠徽标 <g data-for-id>
 *   与标记徽标 <g data-marker-group> 嵌在节点 g 内，先排除——点击归页面层。
 * - 位移阈值 4px（screen px）之前不激活：click 仍是 click；激活时记录拖拽 id 与
 *   ghost 偏移（指针场景点 − 节点盒左上角）。
 * - 拖动中每帧命中检测：viewport.toSceneFromEvent → classifyAt 落点分类。
 * - 候选/拖拽期间挂 window 级 pointerup/pointercancel 兜底：svg 外释放（如拖出
 *   窗口）不走 svg 处理器，防候选/拖拽卡死；svg 内释放先冒泡过 svg 处理器（状态
 *   已清），window 处理器成 no-op，天然幂等。
 * - pointercancel 视为取消；setPointerCapture 特性探测 + try/catch（T7 先例）；
 *   destroy() 全解绑、释放捕获、清反馈（不回调 onDrop）。
 * - 给页面的注记：拖拽激活后的释放**不会拦截**浏览器随后合成的 click 事件（本控
 *   制器只在 pointerdown/move 上 preventDefault）——页面仍需 justDragged 防抖
 *   「刚拖拽完」的合成 click（EditorPage 现状）。
 */
import type { NodeBox, Point } from './types';
import type { Viewport } from './viewport';

/** 拖拽激活位移阈值（screen px）。 */
export const DRAG_THRESHOLD_PX = 4;
/** 子级吸附区纵向余量：区上下各外扩此值（M7c-G 需求方定值 8px）。 */
export const ZONE_Y_PAD = 8;
/** 同级插入列横向余量：列两侧各外扩此值（M7c-G 需求方定值 24px；org 镜像为纵向余量）。 */
export const STRIP_X_PAD = 24;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 企微蓝（芯片描边/落位槽描边）。 */
const ACCENT = '#3370ff';
/** 主题边色取不到（画布暂无边 path）时的预览边兜底灰。 */
const EDGE_COLOR_FALLBACK = '#a6b0bf';
/** 垂直兄弟间距实测不到（同侧兄弟 <2）时的槽位兜底（px）。 */
const V_GAP_FALLBACK = 20;
/** 水平列间距实测不到（父级暂无同侧子级）时的槽位兜底（px，企微留白量级）。 */
const H_GAP_FALLBACK = 60;
/** 芯片相对光标的右下偏移（screen px 恒定；scene 偏移 = 此值 / 当前 scale）。 */
const GHOST_CURSOR_OFFSET_PX = 14;
/** 组芯片堆叠层偏移（场景 px，第二层相对第一层 +x,+y；组拖动需求方定值 6）。 */
const GHOST_STACK_OFFSET_PX = 6;
/** 组芯片计数徽章字号（场景 px）。 */
const GHOST_BADGE_FONT_SIZE = 11;
/** 组芯片计数徽章半径（场景 px）。 */
const GHOST_BADGE_RADIUS = 9;

/**
 * 悬停中的几何落点（M7c-G 列吸附连续模型）。index 恒为「移除被拖节点后」的文档序
 * 插入位（最近间隙位，classify 纯几何结算，moveNode 先移除后插入——引擎不再二次修正）；
 * sideHint = root 级命中时的**目标侧别**（逆时针定侧：芯片所在侧，经左列门控——
 * 显式 rootLeftAllowed 结构门控 ?? 几何兜底 rootLeftEnabled；仅根级携带，非 root
 * 级/同侧列命中无此字段）。kind:'blank' =
 * 空白（M7c-F 复验问题4：悬停即解析为 root 对应侧末尾并画预览）；注意与「禁止目标」
 * 的 placement null 区分——后者不参与反馈点亮。
 */
export type DropPlacement =
  /** 子级吸附区命中：变 nodeId 子级、插第 index 位（无子级 index=0 同追加）。 */
  | { kind: 'child'; nodeId: string; index: number; sideHint?: 'left' | 'right' }
  /** 同级插入列命中：插为 parentId 的第 index 个子级。 */
  | { kind: 'sibling'; parentId: string; index: number; sideHint?: 'left' | 'right' }
  | { kind: 'blank' };

/**
 * 释放落点（onDrop 第二参，M7c-G 列吸附连续模型）：
 * - `{kind:'sibling'}` = 插为 parentId 的第 index 个子级（core moveNode 直用；index 为
 *   「移除被拖节点后」的文档序位次——classify 按指针最近间隙位结算，预览与释放共用
 *   同一值。子级吸附区命中也产出本形态（parentId=吸附目标 N、index=P.y 序位，「松开
 *   就吸附上去」），引擎不再产出 child）。**side**（逆时针定侧，需求方 2026-09-30）=
 *   根级落点的目标侧别（'left'|'right'；经左列门控，非根级落点无此字段）——页面在
 *   moveNode 后用它调 core setNodeSide(id, target.side)，实现「拖到哪侧就持久到哪侧」
 *   的手动换侧；仅 mindmap 结构应消费该字段（logic/org 布局不读 side）；
 * - `{kind:'child'}` = 变 nodeId 子级（追加末尾）——仅为页面既有分支保留的类型成员，
 *   引擎现不再产出；
 * - `null` = 禁止目标（释放静默取消）或空白解析失败（root 盒缺失等窗口期）——页面
 *   层保留 moveNode(id,'root') 兜底。
 */
export type DropTarget =
  | { kind: 'child'; nodeId: string }
  | {
      kind: 'sibling';
      parentId: string;
      index: number;
      anchorId: string;
      position: 'before' | 'after';
      /** 根级落点的目标侧别（页面据此调 setNodeSide；非根级/解析失败窗口期缺省）。 */
      side?: 'left' | 'right';
    }
  | null;

/** 落位槽预览（M7c-D3）：松手后节点将出现的盒（场景坐标）+ 预览边两端几何。 */
export interface DropSlotPreview {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 槽所在侧（mindmap 根级 = 侧别仿真结果；非 root = 父级侧；org = 'down'）。 */
  side: NodeBox['side'];
  /** 预览边几何：与 layout.makeEdge 同构（bezier 恒 2 控制点；org 为 elbow）。 */
  edge: { from: Point; to: Point; kind: 'bezier' | 'elbow'; controls?: Point[] };
}

/** 落位槽结算：槽几何 + 最终文档序 index（持久侧别下 classify 的 index 即最终值）。 */
export interface DropSlotResolution {
  slot: DropSlotPreview;
  index: number;
}

/**
 * 落位预览结算（M7c-D3 纯函数，从 boxes 计算、不 import layout.ts——不动布局与金样）：
 * 输入 sibling 目标的文档序 index，输出落位槽与最终 index；父盒/被拖盒缺失（协同删除
 * 窗口期）返回 null（无预览，释放仍按原 target 结算）。
 *
 * 根级侧别（逆时针定侧，需求方 2026-09-30；旧「半分逻辑仿真修正 index」退役）：
 * - 目标侧 = sideHint（classify 按芯片所在侧结算的最终侧）?? 芯片盒中心相对根盒中线；
 * - 门控：显式 args.rootLeftAllowed（结构门控，页面供——mindmap 恒开放：拖左即建
 *   首个左列主题，2026-10-09 需求方修复；logic 向右结构恒右）优先；缺省回退几何
 *   口径 rootLeftEnabled（根级尚无左列二级主题时恒结算右列——logic 全右/新文档
 *   右列起步的旧行为）。与 classifyDropAt 同一取值，同点必同侧；
 * - 持久 side 下布局不再翻面：index 不做任何修正（classify 的侧别感知映射
 *   sideInsertDocIndex 已产出最终文档序位），槽侧 = 目标侧。非 root 父级：
 *   side=父级侧、index 按几何（placeHorizontal 后代继承父侧，无重排）。
 *
 * 槽几何：x = 父盒同侧列（水平间距 = 父盒与首个同侧子级的 x 差，兜底 60）；y = 按
 * index 插入同侧兄弟堆——插中间 = 相邻两盒垂直中点；插首 = 首盒上方空隙（首盒 y −
 * 间距/2，跟随几何不做父中线钳制，M7c-F 复验问题1）；插尾 = 末盒下方对称；无兄弟 =
 * 父盒垂直居中。org（side 'down'）兄弟横排：槽取水平插入位（镜像同款公式），边为
 * 竖直 elbow。
 */
export function resolveDropSlot(args: {
  boxes: NodeBox[];
  /** 目标父级的文档子级序（childrenIdsOf）。 */
  childrenIds: string[];
  draggedId: string;
  parentId: string;
  /** resolveTarget 结算的文档序 index（classify 侧别感知映射后的最终位次）。 */
  index: number;
  /** 芯片盒（场景坐标左上角 + 被拖盒 w/h）——侧别与最近插入位判定输入。 */
  chipBox: { x: number; y: number; w: number; h: number };
  /**
   * 可选：目标侧别覆写（classify/空白解析产出的最终侧）。缺省按芯片盒中心相对父盒
   * 中线推导；空白落点的芯片中心带节点半宽偏移，侧别应取指针侧——由调用方传入。
   */
  sideHint?: 'left' | 'right';
  /**
   * 可选：组拖动（2026-09-30）全组 id（含 draggedId）。缺省 = [draggedId] 单节点。
   * 影响：兄弟堆过滤扩为「移除全组」。槽几何（w/h/列位）仍取主拖节点盒——组落同一槽。
   */
  draggedGroupIds?: string[];
  /**
   * 可选：根级左列是否开放（结构门控，2026-10-09 需求方修复「左侧无分支主题时
   * 无法拖到左侧」）：true = 芯片在左半即落左列（首个左列主题由此建立）；false =
   * 恒右（logic 向右结构）。缺省回退几何口径 rootLeftEnabled（盒集已有左列主题
   * 才开放）——与 classifyDropAt 传同一取值，同点必同侧。
   */
  rootLeftAllowed?: boolean;
}): DropSlotResolution | null {
  const { boxes, childrenIds, draggedId, parentId, index, chipBox, sideHint } = args;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const parentBox = byId.get(parentId);
  const draggedBox = byId.get(draggedId);
  if (!parentBox || !draggedBox) return null;
  const groupIds =
    args.draggedGroupIds && args.draggedGroupIds.length > 0 ? args.draggedGroupIds : [draggedId];

  // parent→children 邻接（盒自带 parentId，反建映射即可算子树带；盒子来自 layout，无环）。
  const kidsOf = new Map<string, NodeBox[]>();
  for (const b of boxes) {
    if (b.parentId === undefined) continue;
    const list = kidsOf.get(b.parentId);
    if (list) list.push(b);
    else kidsOf.set(b.parentId, [b]);
  }
  /** 子树垂直带：盒 + 全部可见后代盒的 min y..max y（= 布局 subtreeH）。 */
  const bandOf = (id: string): { top: number; bottom: number } => {
    const box = byId.get(id);
    if (!box) return { top: 0, bottom: 0 };
    let top = box.y;
    let bottom = box.y + box.h;
    const walk = (nid: string): void => {
      for (const k of kidsOf.get(nid) ?? []) {
        if (k.y < top) top = k.y;
        if (k.y + k.h > bottom) bottom = k.y + k.h;
        walk(k.id);
      }
    };
    walk(id);
    return { top, bottom };
  };

  // 文档序兄弟堆（去全组——组内任一成员现为该父子级的都移走；盒缺失跳过）。
  // 横向布局：非根级文档序即 y 序；根级左列视觉序 = 文档序倒排（顺时针落位
  // 2026-10-09），槽位几何按视觉序结算（见下方 p 换算）。
  const stack = childrenIds
    .filter((id) => !groupIds.includes(id))
    .map((id) => byId.get(id))
    .filter((b): b is NodeBox => b !== undefined);
  const docPos = new Map(stack.map((b, i) => [b.id, i] as const));
  const gi = Math.max(0, Math.min(index, stack.length));

  // —— org（side 'down'）：兄弟横排，槽取水平插入位，边竖直 elbow ——
  if (parentBox.side === 'down') {
    const parentCx = parentBox.x + parentBox.w / 2;
    const gapX =
      stack.length >= 2
        ? Math.max(
            0,
            Math.min(...stack.slice(1).map((b, i) => b.x - (stack[i]!.x + stack[i]!.w))),
          )
        : V_GAP_FALLBACK;
    const vGap =
      stack.length > 0 ? Math.max(0, stack[0]!.y - (parentBox.y + parentBox.h)) : V_GAP_FALLBACK;
    let cx: number;
    if (stack.length === 0) {
      cx = parentCx;
    } else if (gi === 0) {
      // 首位左侧：不左于父盒水平中线（与横向布局「不高于父盒中线」镜像）。
      cx = Math.max(parentCx, stack[0]!.x - gapX / 2 - draggedBox.w / 2);
    } else if (gi >= stack.length) {
      const last = stack[stack.length - 1]!;
      cx = last.x + last.w + gapX / 2 + draggedBox.w / 2;
    } else {
      const prev = stack[gi - 1]!;
      const next = stack[gi]!;
      cx = (prev.x + prev.w + next.x) / 2;
    }
    const y = parentBox.y + parentBox.h + vGap;
    return {
      index: gi,
      slot: {
        x: cx - draggedBox.w / 2,
        y,
        w: draggedBox.w,
        h: draggedBox.h,
        side: 'down',
        edge: {
          from: { x: parentCx, y: parentBox.y + parentBox.h },
          to: { x: cx, y },
          kind: 'elbow',
        },
      },
    };
  }

  // —— 横向（mindmap/logic）：兄弟纵排，槽在父同侧列 ——
  const chipCx = chipBox.x + chipBox.w / 2;
  const parentCx = parentBox.x + parentBox.w / 2;
  const isRootLevel = parentBox.parentId === undefined;
  const chipSide: 'left' | 'right' = sideHint ?? (chipCx >= parentCx ? 'right' : 'left');
  // 持久侧别（逆时针定侧）：根级目标侧 = 芯片所在侧。左列门控 = 显式 rootLeftAllowed
  // （结构门控，页面供——mindmap 恒开放、logic 恒右）?? 几何口径 rootLeftEnabled
  // （与 classifyDropAt 同一取值，同点必同侧）；非 root 继承父侧（placeHorizontal
  // 后代同侧）。
  const leftEnabled = args.rootLeftAllowed ?? rootLeftEnabled(boxes, parentBox);
  const side: 'left' | 'right' = isRootLevel
    ? chipSide === 'left' && !leftEnabled
      ? 'right'
      : chipSide
    : parentBox.side === 'left'
      ? 'left'
      : 'right';
  const finalIndex = gi; // 持久侧别下不再翻面：index 无需仿真修正

  /** 带间距：相邻文档序兄弟带实测（= 布局 V_GAP；不可得兜底 20）。 */
  const vGap =
    stack.length >= 2
      ? Math.max(
          0,
          Math.min(
            ...stack.slice(1).map((b, i) => bandOf(b.id).top - bandOf(stack[i]!.id).bottom),
          ),
        )
      : V_GAP_FALLBACK;

  // 槽所在侧的兄弟列（同父兄弟同侧；根级 = 目标侧兄弟）。根级左列视觉序 = 文档序
  // 倒排（顺时针落位 2026-10-09）：finalIndex 的文档序前缀数 p_doc 换算为视觉位次
  // p_visual = k − p_doc（doc 前缀越多 → 视觉越高），insertCenterY 按视觉序数组取槽
  // 几何——与 classifyDropAt 的 nearestInsertIndex（同视觉序输入）同点必同槽。
  const sideSibs = stack.filter((b) => b.side === side);
  const isLeftVisualReversed = isRootLevel && side === 'left';
  const visualSibs = isLeftVisualReversed ? [...sideSibs].reverse() : sideSibs;
  const pDoc = sideSibs.filter((b) => (docPos.get(b.id) ?? 0) < finalIndex).length;
  const p = isLeftVisualReversed ? visualSibs.length - pDoc : pDoc;
  const centerY = insertCenterY(visualSibs, p, draggedBox.h, vGap, parentBox);
  // 水平列间距：父盒与首个同侧子级的 x 差（企微列距实测），无同侧子级兜底 60。
  const firstSib = sideSibs[0];
  const hGap = firstSib
    ? Math.max(
        0,
        side === 'right'
          ? firstSib.x - (parentBox.x + parentBox.w)
          : parentBox.x - (firstSib.x + firstSib.w),
      )
    : H_GAP_FALLBACK;
  const slotX =
    side === 'right' ? parentBox.x + parentBox.w + hGap : parentBox.x - hGap - draggedBox.w;
  const slotY = centerY - draggedBox.h / 2;
  return {
    index: finalIndex,
    slot: {
      x: slotX,
      y: slotY,
      w: draggedBox.w,
      h: draggedBox.h,
      side,
      edge: previewEdge(parentBox, { x: slotX, y: slotY, w: draggedBox.w, h: draggedBox.h }, side),
    },
  };
}

/**
 * 根级左列门控的**几何兜底口径**（逆时针定侧）：根级尚无任何左列二级主题（按当前
 * 布局盒判定，含被拖组成员——拖动中盒集仍是落点前状态）恒结算右列。logic 全右文档
 * 永不开启；mindmap 新文档（前 3 个右）也先居右，首个左侧节点出现（含第 4 个自动
 * 落左）后开放按芯片所在侧换侧。2026-10-09 起正式门控改由页面结构供给
 * （deps/args rootLeftAllowed：mindmap 恒开放、logic 恒右——修复「左侧无分支主题时
 * 无法拖到左侧」），本函数仅在调用方未显式供给时回退使用。classifyDropAt 与
 * resolveDropSlot 共用同一取值（输入同一盒集/同一显式值 ⇒ 同点必同侧），保证预览、
 * 释放与 target.side 三者一致。
 */
function rootLeftEnabled(boxes: NodeBox[], rootBox: NodeBox): boolean {
  return boxes.some((b) => b.parentId === rootBox.id && b.side === 'left');
}

/**
 * 同侧 y 位次 → 文档序插入位映射（逆时针定侧 + 顺时针落位 2026-10-09）：
 * p 为**视觉插入位**（0 = 该侧列视觉最顶）。右列视觉序 = 文档序：「第 p 位」映射为
 * 文档序中该侧相邻兄弟之间的位次——p=0 取首兄弟文档位（插其前）、p>0 取前一同侧
 * 兄弟文档位 +1（插其后）、尾插取末兄弟文档位 +1。左列（仅 root 级存在）视觉序 =
 * 文档序倒排 v（v[0] = 文档序末位 = 视觉顶）：p=0 或中位 → 落 v[p] 文档位 +1（新
 * 节点成为新视觉顶 / 插于其间）、p=列底之外 → 落文档序首位左主题之前（视觉列底）。
 * 该侧无兄弟时：right → 0（右列自带顶生长）、left → 堆尾（与空白解析「右顶/左尾」
 * 语义一致，logic/全右文档的左半落点由此恒落文档序末尾）。
 */
function sideInsertDocIndex(stack: NodeBox[], side: 'left' | 'right', p: number): number {
  const posOf = new Map(stack.map((b, i) => [b.id, i] as const));
  const docSibs = stack.filter((b) => b.side === side);
  if (docSibs.length === 0) return side === 'right' ? 0 : stack.length;
  if (side === 'left') {
    const v = [...docSibs].reverse(); // 视觉序（v[0]=视觉顶）
    if (p >= v.length) return posOf.get(v[v.length - 1]!.id) ?? 0; // 视觉底之下 → 文档序首位之前
    return (posOf.get(v[p]!.id) ?? 0) + 1; // 视觉顶/其间 → v[p]（视觉下邻）文档位之后
  }
  if (p <= 0) return posOf.get(docSibs[0]!.id) ?? 0;
  if (p >= docSibs.length) {
    const last = docSibs[docSibs.length - 1]!;
    return (posOf.get(last.id) ?? stack.length - 1) + 1;
  }
  return (posOf.get(docSibs[p - 1]!.id) ?? 0) + 1;
}

/** 第 p 个插入位的槽中心 y（同侧兄弟堆；见 resolveDropSlot 槽几何规则）。 */
function insertCenterY(
  sideSibs: NodeBox[],
  p: number,
  nodeH: number,
  vGap: number,
  parentBox: NodeBox,
): number {
  const parentMid = parentBox.y + parentBox.h / 2;
  if (sideSibs.length === 0) return parentMid; // 无兄弟：父盒垂直居中
  if (p === 0) {
    // 首位上方 = 首盒之前的空隙（首盒 y − 带间距/2）：跟随几何，不做父中线钳制——
    // 首兄弟本可悬在父中线上方，钳制会让槽偏离真实插入位（M7c-F 复验问题1）。
    return sideSibs[0]!.y - vGap / 2;
  }
  if (p >= sideSibs.length) {
    const last = sideSibs[sideSibs.length - 1]!;
    return last.y + last.h + vGap / 2 + nodeH / 2; // 插尾：末盒下方（对称处理）
  }
  const prev = sideSibs[p - 1]!;
  const next = sideSibs[p]!;
  return (prev.y + prev.h + next.y) / 2; // 插中间：相邻两盒垂直中点
}

/** 预览边几何：与 layout.makeEdge 同公式（父盒边中点 → 槽盒边中点，控制点水平外伸 dx/2）。 */
function previewEdge(
  parentBox: NodeBox,
  slot: { x: number; y: number; w: number; h: number },
  side: 'left' | 'right',
): DropSlotPreview['edge'] {
  const right = side !== 'left';
  const from: Point = {
    x: right ? parentBox.x + parentBox.w : parentBox.x,
    y: parentBox.y + parentBox.h / 2,
  };
  const to: Point = { x: right ? slot.x : slot.x + slot.w, y: slot.y + slot.h / 2 };
  const extend = Math.abs(to.x - from.x) * 0.5;
  return {
    from,
    to,
    kind: 'bezier',
    controls: [
      { x: from.x + (right ? extend : -extend), y: from.y },
      { x: to.x + (right ? -extend : extend), y: to.y },
    ],
  };
}

// ---------------------------------------------------------------------------
// 列吸附连续模型（M7c-G）：落点区域判定的纯几何函数集（不依赖控制器状态、不 import
// layout.ts——不动布局与金样）。区域优先级：盒直击禁止 > 子级吸附区（depth 降序）>
// 同级插入列（depth 降序）> 空白；同中多区取更深节点（子级区先于其父列条带）。
// ---------------------------------------------------------------------------

/** 盒邻接表（parentId → 可见子盒；盒子来自 layout，无环）。 */
function kidsOfBoxes(boxes: NodeBox[]): Map<string, NodeBox[]> {
  const kidsOf = new Map<string, NodeBox[]>();
  for (const b of boxes) {
    if (b.parentId === undefined) continue;
    const list = kidsOf.get(b.parentId);
    if (list) list.push(b);
    else kidsOf.set(b.parentId, [b]);
  }
  return kidsOf;
}

/** 子树垂直带：盒 + 全部可见后代盒的 min y..max y（= 布局 subtreeH 语义；折叠子树不在盒集）。 */
function subtreeBand(
  id: string,
  byId: Map<string, NodeBox>,
  kidsOf: Map<string, NodeBox[]>,
): { top: number; bottom: number } {
  const box = byId.get(id);
  if (!box) return { top: 0, bottom: 0 };
  let top = box.y;
  let bottom = box.y + box.h;
  const walk = (nid: string): void => {
    for (const k of kidsOf.get(nid) ?? []) {
      if (k.y < top) top = k.y;
      if (k.y + k.h > bottom) bottom = k.y + k.h;
      walk(k.id);
    }
  };
  walk(id);
  return { top, bottom };
}

/** 兄弟堆带间距：相邻文档序带实测最小值（= 布局 V_GAP；不可得兜底 20，与 resolveDropSlot 同口径）。 */
function stackBandGap(
  stack: NodeBox[],
  bandOf: (id: string) => { top: number; bottom: number },
): number {
  if (stack.length < 2) return V_GAP_FALLBACK;
  return Math.max(
    0,
    Math.min(...stack.slice(1).map((b, i) => bandOf(b.id).top - bandOf(stack[i]!.id).bottom)),
  );
}

/**
 * 节点 N 在生长侧 g 的水平生长量（M7c-G 子级吸附区横向延伸）：有同侧子级 = 列间隙 +
 * max(子级列宽, 被拖盒宽)——区缘盖住子级列整列、被拖盒更宽时再外扩（槽随被拖盒宽）；
 * 无子级 = 兜底列距 + 被拖盒宽。
 */
function growthExtent(n: NodeBox, g: 'left' | 'right', kids: NodeBox[], dragW: number): number {
  const gKids = kids.filter((k) => k.side === g);
  if (gKids.length === 0) return H_GAP_FALLBACK + Math.max(0, dragW);
  const colLeft = Math.min(...gKids.map((k) => k.x));
  const colRight = Math.max(...gKids.map((k) => k.x + k.w));
  const gap = g === 'right' ? Math.max(0, colLeft - (n.x + n.w)) : Math.max(0, n.x - colRight);
  return gap + Math.max(colRight - colLeft, Math.max(0, dragW));
}

/**
 * 子级吸附区判定（M7c-G 区域 1）：P 落在 N 的生长侧区内返回吸附侧别（org 为 'down'），
 * 未命中 null。
 * - 横向（mindmap/logic）：right 侧 x ∈ [N.left, N.right + 生长量]、left 侧镜像
 *   [N.left − 生长量, N.right]；root（无 parentId）两侧都算，侧别按指针相对根盒中线
 *   （与 resolveBlankTarget 同口径 ≥ 中线为右）。
 * - y：非 root = [N.top − 8, N 子树带底 + 8]（需求方定值 ±8）；root 区顶取全树带顶——
 *   根是整列脊柱，验收「靠近中心节点上下移动、停哪插哪」要求根侧全程跟随。
 * - org（side 'down'，向下生长）：区 = 本体盒 ∪ 子级行横向范围，y 向下延伸
 *   层距 + max(行高, 被拖盒高)（无子级兜底层距 20）。
 */
function zoneSideAt(
  n: NodeBox,
  p: Point,
  dragW: number,
  dragH: number,
  byId: Map<string, NodeBox>,
  kidsOf: Map<string, NodeBox[]>,
): 'left' | 'right' | 'down' | null {
  const kids = kidsOf.get(n.id) ?? [];
  if (n.side === 'down') {
    const rowLeft = kids.length > 0 ? Math.min(...kids.map((k) => k.x)) : n.x;
    const rowRight = kids.length > 0 ? Math.max(...kids.map((k) => k.x + k.w)) : n.x + n.w;
    const rowTop = kids.length > 0 ? Math.min(...kids.map((k) => k.y)) : n.y + n.h;
    const rowBottom = kids.length > 0 ? Math.max(...kids.map((k) => k.y + k.h)) : n.y + n.h;
    const vGap = kids.length > 0 ? Math.max(0, rowTop - (n.y + n.h)) : V_GAP_FALLBACK;
    const rowH = rowBottom - rowTop;
    return p.x >= Math.min(n.x, rowLeft) &&
      p.x <= Math.max(n.x + n.w, rowRight) &&
      p.y >= n.y - ZONE_Y_PAD &&
      p.y <= n.y + n.h + vGap + Math.max(rowH, Math.max(0, dragH)) + ZONE_Y_PAD
      ? 'down'
      : null;
  }
  const band = subtreeBand(n.id, byId, kidsOf);
  const yTop = (n.parentId === undefined ? band.top : n.y) - ZONE_Y_PAD;
  if (p.y < yTop || p.y > band.bottom + ZONE_Y_PAD) return null;
  if (n.parentId === undefined) {
    const extR = growthExtent(n, 'right', kids, dragW);
    const extL = growthExtent(n, 'left', kids, dragW);
    if (p.x < n.x - extL || p.x > n.x + n.w + extR) return null;
    return p.x >= n.x + n.w / 2 ? 'right' : 'left'; // 侧别按指针半屏（与空白解析同口径）
  }
  if (n.side === 'right') {
    const ext = growthExtent(n, 'right', kids, dragW);
    return p.x >= n.x && p.x <= n.x + n.w + ext ? 'right' : null;
  }
  const ext = growthExtent(n, 'left', kids, dragW);
  return p.x >= n.x - ext && p.x <= n.x + n.w ? 'left' : null;
}

/**
 * 同级插入列判定（M7c-G 区域 2）：P 落在父节点 M 的子级列条带返回侧别（org 'down'）。
 * 横向：x ∈ [列x − 24, 列右 + 24]、y ∈ [首子级带顶 − 带间距, 末子级带底 + 带间距]；
 * 列 x/宽与带间距从「移除被拖节点后」的同侧子级盒实测（stackOf），root 左右分侧各一条。
 * org 镜像：子级行条带 x ∈ [行左 − 行距, 行右 + 行距]、y ∈ [行顶 − 24, 行底 + 24]。
 * 无可见子级（含唯一子级正被拖走）无条带。
 */
function stripSideAt(
  m: NodeBox,
  p: Point,
  byId: Map<string, NodeBox>,
  kidsOf: Map<string, NodeBox[]>,
  stackOf: (parentId: string) => NodeBox[],
): 'left' | 'right' | 'down' | null {
  const stack = stackOf(m.id);
  if (stack.length === 0) return null;
  if (m.side === 'down') {
    const rowLeft = Math.min(...stack.map((k) => k.x));
    const rowRight = Math.max(...stack.map((k) => k.x + k.w));
    const rowTop = Math.min(...stack.map((k) => k.y));
    const rowBottom = Math.max(...stack.map((k) => k.y + k.h));
    const gapX =
      stack.length >= 2
        ? Math.max(
            0,
            Math.min(...stack.slice(1).map((b, i) => b.x - (stack[i]!.x + stack[i]!.w))),
          )
        : V_GAP_FALLBACK;
    return p.x >= rowLeft - gapX &&
      p.x <= rowRight + gapX &&
      p.y >= rowTop - STRIP_X_PAD &&
      p.y <= rowBottom + STRIP_X_PAD
      ? 'down'
      : null;
  }
  const sides: Array<'left' | 'right'> =
    m.parentId === undefined ? ['right', 'left'] : [m.side === 'left' ? 'left' : 'right'];
  const hit: Array<'left' | 'right'> = [];
  for (const g of sides) {
    const gKids = stack.filter((b) => b.side === g);
    if (gKids.length === 0) continue;
    const colLeft = Math.min(...gKids.map((k) => k.x));
    const colRight = Math.max(...gKids.map((k) => k.x + k.w));
    const vg = stackBandGap(gKids, (id) => subtreeBand(id, byId, kidsOf));
    const top = Math.min(...gKids.map((k) => k.y));
    const bottom = Math.max(...gKids.map((k) => k.y + k.h));
    if (
      p.x >= colLeft - STRIP_X_PAD &&
      p.x <= colRight + STRIP_X_PAD &&
      p.y >= top - vg &&
      p.y <= bottom + vg
    ) {
      hit.push(g);
    }
  }
  if (hit.length === 0) return null;
  if (hit.length === 1) return hit[0]!;
  return p.x >= m.x + m.w / 2 ? 'right' : 'left'; // 双侧同时命中（正常几何不重叠）：按指针侧
}

/**
 * 最近间隙插入位（M7c-G「我在哪停，就插在哪两个节点中间」）：argmin_p |槽中心 − P.y|。
 * 槽中心与 resolveDropSlot/insertCenterY 同公式（首位=首盒上方空隙、中间=相邻带中点、
 * 尾位=末盒下方对称外推），同点必同槽；平局取更上（先遇到的 p）。
 */
function nearestInsertIndex(
  sideSibs: NodeBox[],
  py: number,
  nodeH: number,
  vGap: number,
  parentBox: NodeBox,
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let p = 0; p <= sideSibs.length; p += 1) {
    const dist = Math.abs(insertCenterY(sideSibs, p, nodeH, vGap, parentBox) - py);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/** org 槽中心 x：与 resolveDropSlot org 分支同公式（首位不越父中线、中间=相邻盒中点、尾位对称外推）。 */
function orgInsertCenterX(
  stack: NodeBox[],
  p: number,
  nodeW: number,
  gapX: number,
  parentBox: NodeBox,
): number {
  const parentCx = parentBox.x + parentBox.w / 2;
  if (stack.length === 0) return parentCx;
  if (p === 0) return Math.max(parentCx, stack[0]!.x - gapX / 2 - nodeW / 2);
  if (p >= stack.length) {
    const last = stack[stack.length - 1]!;
    return last.x + last.w + gapX / 2 + nodeW / 2;
  }
  const prev = stack[p - 1]!;
  const next = stack[p]!;
  return (prev.x + prev.w + next.x) / 2;
}

/** org 镜像的最近间隙插入位：argmin_p |槽中心 x − P.x|。 */
function nearestOrgInsertIndex(
  stack: NodeBox[],
  px: number,
  nodeW: number,
  gapX: number,
  parentBox: NodeBox,
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let p = 0; p <= stack.length; p += 1) {
    const dist = Math.abs(orgInsertCenterX(stack, p, nodeW, gapX, parentBox) - px);
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  return best;
}

/**
 * 落点解析纯函数（M7c-G 列吸附连续模型主入口；classifyAt 薄委托，导出供单测直测）。
 * 输入盒子几何 + 文档子级序 + 禁止判定，输出悬停落点：
 * 0. 盒直击被拖组任一成员/其后代 → forbiddenId（整盒禁止，不参与区域解析）；
 * 1. 子级吸附区（depth 降序）→ {kind:'child', nodeId, index, sideHint?}；
 * 2. 同级插入列（depth 降序）→ {kind:'sibling', parentId, index, sideHint?}；
 * 3. 都未命中 → {kind:'blank'}（computeResolved 再解析为 root 对应侧末尾）。
 * index = 「移除全组后」子级堆上按指针 y（org 按 x）的最近间隙位——与
 * resolveDropSlot 的槽几何同公式，预览与释放天然一致；root 级命中携带 sideHint =
 * **目标侧别**（逆时针定侧：指针所在侧，经左列门控——显式 args.rootLeftAllowed
 * 结构门控 ?? 几何口径 rootLeftEnabled；sideInsertDocIndex 映射回文档序位次，
 * resolveDropSlot 直接消费、不再仿真修正）。
 */
export function classifyDropAt(args: {
  boxes: NodeBox[];
  childrenIdsOf(nodeId: string): string[];
  isDescendant(id: string, candidateId: string): boolean;
  draggedId: string;
  /**
   * 可选：组拖动（2026-09-30）全组 id（含主拖节点 draggedId）。缺省 = [draggedId]
   * 单节点。排除集 = 全组各自子树的并集（组内任一节点是命中目标本体/祖先 → 禁止）；
   * 「移除被拖节点后」的子级堆口径同步扩为「移除全组后」。区域命中与槽位计算
   * 不变（dragW/H 仍取主拖节点盒——组作为整体插入一个 parent+index）。
   */
  draggedIds?: string[];
  /**
   * 可选：根级左列是否开放（结构门控，2026-10-09 需求方修复「左侧没有分支主题时
   * 右侧分支无法拖到左侧」）：true = 目标侧按指针侧直取（拖左即建首个左列主题）；
   * false = 恒右（logic 向右结构）。缺省回退几何口径 rootLeftEnabled（盒集已有
   * 左列主题才开放，旧行为）。控制器在 classify/resolve/空白解析三处传同一 deps
   * 取值——同点必同侧不变式保持。
   */
  rootLeftAllowed?: boolean;
  point: Point;
}): { placement: DropPlacement | null; forbiddenId: string | null } {
  const { boxes, childrenIdsOf, isDescendant, draggedId, point } = args;
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const draggedBox = byId.get(draggedId);
  const dragW = draggedBox?.w ?? 0;
  const dragH = draggedBox?.h ?? 0;
  const groupIds =
    args.draggedIds && args.draggedIds.length > 0 ? args.draggedIds : [draggedId];
  // 排除集 = 全组各自子树的并集：id 为组成员本体、或为组内任一节点的后代 → 禁止
  // （单组退化为旧「被拖子树」口径）。
  const forbidden = (id: string): boolean =>
    groupIds.some((gid) => id === gid || isDescendant(gid, id));

  // 0) 盒直击：被拖/后代本体一律禁止（含旧「整盒含边缘带」语义的范围）——先于一切区域。
  for (const b of boxes) {
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h) continue;
    if (forbidden(b.id)) return { placement: null, forbiddenId: b.id };
    break; // 盒不重叠（布局不变量）：直击判定即止
  }

  const kidsOf = kidsOfBoxes(boxes);
  const bandOf = (id: string): { top: number; bottom: number } => subtreeBand(id, byId, kidsOf);
  /**
   * 移除全组后的文档序子级堆（盒缺失跳过——折叠/协同删除窗口期）：组作为整体
   * 插入一个 parent+index，堆里现属组内的任一成员都先移走（与释放端 moveNode
   * 先移除后插入的序列口径一致）。
   */
  const stackOf = (parentId: string): NodeBox[] =>
    childrenIdsOf(parentId)
      .filter((cid) => !groupIds.includes(cid))
      .map((cid) => byId.get(cid))
      .filter((b): b is NodeBox => b !== undefined);

  /** 命中侧的插入 index 结算：org 按 P.x；root 按目标侧堆结算再映射文档序（逆时针定侧）。 */
  const indexOfStack = (
    parent: NodeBox,
    side: 'left' | 'right' | 'down',
  ): { index: number; sideHint?: 'left' | 'right' } => {
    const stack = stackOf(parent.id);
    if (side === 'down') {
      const gapX =
        stack.length >= 2
          ? Math.max(
              0,
              Math.min(...stack.slice(1).map((b, i) => b.x - (stack[i]!.x + stack[i]!.w))),
            )
          : V_GAP_FALLBACK;
      return { index: nearestOrgInsertIndex(stack, point.x, dragW, gapX, parent) };
    }
    if (parent.parentId === undefined) {
      // 根级（逆时针定侧）：目标侧 = 指针侧（zoneSideAt/stripSideAt 的侧别），经左列
      // 门控（显式 rootLeftAllowed 结构门控 ?? 几何口径 rootLeftEnabled，与
      // resolveDropSlot 同一取值——logic 恒右/mindmap 恒开放）；index = 该侧二级
      // 主题（按 NodeBox 当前 side 过滤）按 y 的最近插入位映射回文档序。
      // 顺时针落位（2026-10-09）：左列视觉序 = 文档序倒排——槽位几何按视觉序结算，
      // sideInsertDocIndex 同口径映射回文档序（同点必同果不变式保持）。
      const leftEnabled = args.rootLeftAllowed ?? rootLeftEnabled(boxes, parent);
      const targetSide: 'left' | 'right' = side === 'left' && !leftEnabled ? 'right' : side;
      const docSibs = stack.filter((b) => b.side === targetSide);
      const visualSibs = targetSide === 'left' ? [...docSibs].reverse() : docSibs;
      const p = nearestInsertIndex(
        visualSibs,
        point.y,
        dragH,
        stackBandGap(visualSibs, bandOf),
        parent,
      );
      return { index: sideInsertDocIndex(stack, targetSide, p), sideHint: targetSide };
    }
    return {
      index: nearestInsertIndex(stack, point.y, dragH, stackBandGap(stack, bandOf), parent),
    };
  };

  // 候选按 depth 降序（同深度保持盒序）：区域重叠时更深节点优先。
  const ordered = boxes.filter((b) => !forbidden(b.id)).sort((a, z) => z.depth - a.depth);

  // 1) 子级吸附区（最深优先）：命中 → child of N，蓝描边 + 边/槽预览同画。
  for (const n of ordered) {
    const side = zoneSideAt(n, point, dragW, dragH, byId, kidsOf);
    if (side === null) continue;
    const { index, sideHint } = indexOfStack(n, side);
    return { placement: { kind: 'child', nodeId: n.id, index, sideHint }, forbiddenId: null };
  }
  // 2) 同级插入列（次优先）：命中 → 插到该父的子级中（锚点调试信息由 resolveTarget 按 index 回补）。
  for (const m of ordered) {
    if (!kidsOf.has(m.id)) continue;
    const side = stripSideAt(m, point, byId, kidsOf, stackOf);
    if (side === null) continue;
    const { index, sideHint } = indexOfStack(m, side);
    return { placement: { kind: 'sibling', parentId: m.id, index, sideHint }, forbiddenId: null };
  }
  // 3) 空白：维持 M7c-F 裁定——解析为 root 对应侧末尾（resolveBlankTarget）。
  return { placement: { kind: 'blank' }, forbiddenId: null };
}

/** 依赖注入：坐标换算与落点写参数由页面侧提供。 */
export interface DragControllerDeps {
  svg: SVGSVGElement;
  viewport: Viewport;
  /** 当前布局节点盒（场景坐标；每次命中检测实时取，拖拽中可被重布局刷新）。 */
  getBoxes(): NodeBox[];
  /**
   * 释放回调：ids = 被拖组（2026-09-30 批量拖动起为 id 数组——单节点长度 1，组内
   * 序 = 拾起时布局序，页面整组单事务按 index+i 递增提交）。target 见
   * {@link DropTarget}（M7c-G 起恒为 sibling/兜底 null——child 区命中也产出带
   * index 的 sibling；空白已在引擎解析为 root 对应侧末尾 sibling——null 仅在 root
   * 盒缺失等窗口期出现）。
   */
  onDrop(ids: string[], target: DropTarget): void;
  /**
   * 组拾起回调（2026-09-30 需求方批量拖动，可选）：按下节点 grabbedId 命中当前
   * 多选（size>1 且含 grabbedId）时返回整组 id——页面按布局序（box.y→box.x 升序）
   * 排序、排除 root；否则返回 [grabbedId] 单节点。缺省（未提供）= 单节点拖拽；
   * 返回不含 grabbedId（异常/防回归护栏）时控制器降级单节点。
   */
  getDragGroup?(grabbedId: string): string[];
  /** candidateId 是否为 id 的后代（含间接）——后代不可作为落点锚（禁止目标）。 */
  isDescendant(id: string, candidateId: string): boolean;
  /** 文档子级序（页面适配 core childrenIds）：sibling 落点 index 结算输入（事务外纯计算）。 */
  childrenIdsOf(nodeId: string): string[];
  /** 场景坐标悬浮层：芯片/预览边/落位槽宿主（页面在视口 wrapper 内 nodesLayer 之上的 <g>）。 */
  overlayLayer: SVGGElement;
  /** 可选：id 是否允许被换父（页面级门控，如只读态）；缺省允许。 */
  canReparent?(id: string): boolean;
  /**
   * 可选：根级左列是否开放（结构门控，2026-10-09 需求方修复「左侧没有分支主题时
   * 右侧分支无法拖到左侧」）：mindmap → true（拖左即建首个左列主题，页面 onDrop
   * 内 setNodeSide 持久化）；logic 向右结构 → false（恒右，布局不读 side）；org
   * （root side 'down'）不经此门控。缺省回退几何口径（盒集已有左列主题才开放，
   * 旧行为）。classify/resolve/空白解析三处共用本回调同一取值——同点必同侧。
   */
  rootLeftAllowed?(): boolean;
}

/**
 * 拖拽进行中的公开快照。id = 主拖节点（2026-09-30 组拖动起=按下节点；组内其余
 * 成员不在此快照暴露）；offsetX/Y = 抓取偏移（按下点场景坐标 − 被拖盒左上角）；
 * M7c-F 复验问题3① 起芯片定位改用「指针 + 右下偏移」，本快照仅作公开状态留存。
 */
export interface DragSnapshot {
  id: string;
  offsetX: number;
  offsetY: number;
}

/** 落点比较键：目标切换（换节点/换父）即摘旧反馈；同目标内 index 连续变化不重置（预览原地刷新）。 */
function placementKey(p: DropPlacement | null): string | null {
  if (!p) return null;
  if (p.kind === 'blank') return 'blank';
  return p.kind === 'child' ? `child:${p.nodeId}` : `sibling:${p.parentId}`;
}

/** 数值 → 属性串：两位小数去尾零（与 render.ts fmt 同口径，输出确定）。 */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** 光标右下偏移折算成 scene 量：screen 14px 恒定（scale 异常时按 1 兜底）。 */
function ghostSceneOffset(scale: number): number {
  return GHOST_CURSOR_OFFSET_PX / (scale > 0 ? scale : 1);
}

/**
 * 芯片盒（M7c-F 复验问题3①）：左上角 = 指针 scene 点 + 右下偏移（screen 14px 恒定
 * → scene 偏移 = 14/scale），尺寸 = 被拖盒。侧别/最近插入位判定输入，与芯片视觉
 * 定位同源——判定所「见」即芯片所在。
 */
function ghostChipBox(
  scene: Point,
  draggedBox: { w: number; h: number },
  scale: number,
): { x: number; y: number; w: number; h: number } {
  const o = ghostSceneOffset(scale);
  return { x: scene.x + o, y: scene.y + o, w: draggedBox.w, h: draggedBox.h };
}

/**
 * 一次落点结算的完整产物——预览与释放共用的单一计算路径（M7c-D3 一致性裁决：
 * classify→resolve→槽只算一次，释放直接复用，禁止两算分叉）。
 */
interface ResolvedDrop {
  placement: DropPlacement | null;
  forbiddenId: string | null;
  target: DropTarget;
  slot: DropSlotPreview | null;
}

/** 芯片文字宽度估算（无测量适配器）：CJK/全角按 1em、其余按 0.55em 近似。 */
function labelWidthOf(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) w += fontSize * (ch.charCodeAt(0) > 0xff ? 1 : 0.55);
  return w;
}

/** 芯片文字超宽省略（贪心截断 + 省略号）。 */
function truncateLabel(label: string, maxWidth: number, fontSize: number): string {
  if (labelWidthOf(label, fontSize) <= maxWidth) return label;
  let out = label;
  while (out.length > 0 && labelWidthOf(`${out}…`, fontSize) > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

export class DragController {
  private deps: DragControllerDeps | null = null;
  private attached = false;
  /** 阈值前候选：已按下但未激活。 */
  private candidate: { id: string; x: number; y: number; pointerId: number } | null = null;
  /**
   * 激活中的拖拽。ids = 被拖组（2026-09-30 批量拖动：单节点长度 1，组内序 = 拾起时
   * 布局序；id 恒为主拖节点=按下节点，供芯片盒/槽尺寸等单节点口径复用）。
   */
  private drag: {
    id: string;
    ids: string[];
    pointerId: number;
    offsetX: number;
    offsetY: number;
  } | null = null;
  /** 当前悬停落点（比较键见 placementKey）；空白/禁止为 null。 */
  private hoverPlacement: DropPlacement | null = null;
  /** 当前被标 drop-forbidden 的节点 id（组成员本体或其任一后代）。 */
  private hoverForbidden: string | null = null;
  /**
   * 挂 gm-dragging/gm-drag-origin 的节点 id 集（2026-09-30 组拖动起为全组成员；
   * 单节点长度 1。激活挂上、clearHighlights 摘除，配对不依赖 this.drag 清空时序）。
   */
  private draggingVisualIds: string[] = [];
  /**
   * 最后一帧落点结算缓存（classify→resolve→槽一次算成）：预览元素由此绘制，释放
   * 直接复用（释放点 = 缓存点时）——预览与落点永不分叉（M7c-D3 一致性裁决）。
   */
  private pending: { at: Point; resolved: ResolvedDrop } | null = null;
  /** 跟随芯片（g.gm-drag-ghost：圆角矩形 + 居中文字；悬浮层场景坐标）。 */
  private ghost: SVGGElement | null = null;
  /** 落位预览边（path.gm-drop-edge）与落位槽（rect.gm-drop-slot）。 */
  private dropEdge: SVGPathElement | null = null;
  private dropSlot: SVGRectElement | null = null;
  /** 候选/拖拽期间挂着的 window 级兜底监听标记。 */
  private windowBound = false;
  /** 已成功捕获的 pointerId（null = 未捕获）；finish/destroy 释放。 */
  private capturedPointerId: number | null = null;

  /** 拖拽进行中的快照；未拖拽为 null。 */
  get dragging(): DragSnapshot | null {
    return this.drag ? { id: this.drag.id, offsetX: this.drag.offsetX, offsetY: this.drag.offsetY } : null;
  }

  /** 绑定指针监听（幂等；可传新 deps 复用）。 */
  attach(deps: DragControllerDeps): void {
    if (this.attached) {
      this.deps = deps;
      return;
    }
    this.attached = true;
    this.deps = deps;
    deps.svg.addEventListener('pointerdown', this.onPointerDown);
    deps.svg.addEventListener('pointermove', this.onPointerMove);
    deps.svg.addEventListener('pointerup', this.onPointerUp);
    deps.svg.addEventListener('pointercancel', this.onPointerCancel);
  }

  /** 解绑全部监听、释放指针捕获并中止进行中的拖拽（不触发 onDrop；幂等）。 */
  destroy(): void {
    if (this.deps) {
      this.deps.svg.removeEventListener('pointerdown', this.onPointerDown);
      this.deps.svg.removeEventListener('pointermove', this.onPointerMove);
      this.deps.svg.removeEventListener('pointerup', this.onPointerUp);
      this.deps.svg.removeEventListener('pointercancel', this.onPointerCancel);
    }
    this.clearHighlights();
    this.releaseCapture();
    this.unbindWindowFallback();
    this.deps = null;
    this.attached = false;
    this.candidate = null;
    this.drag = null;
    this.pending = null; // 结算缓存随销毁作废（复用 attach 从干净态开始）
  }

  // -------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps || this.candidate || this.drag) return;
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    // 折叠徽标（嵌于节点 g 内）优先排除：徽标点击归页面层。
    if (target?.closest('[data-for-id]')) return;
    // 标记徽标（M7b-W3 点击换组）：同折叠徽标让位纪律——徽标上的按下不进节点
    // 拖拽候选（click 归页面层「点徽章弹同组选盘」）。
    if (target?.closest('[data-marker-group]')) return;
    const g = target?.closest('[data-node-id]');
    if (!g) return;
    const id = g.getAttribute('data-node-id');
    if (!id) return;
    // 原生文字拖选根治（M7c-D1）：取消 pointerdown 默认动作——文本选择不再起锚、
    // 兼容 mousedown 不派发；click/dblclick 合成不受影响（页面点击链路不变）。
    e.preventDefault();
    this.candidate = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    // 候选期尚未捕获指针：svg 外释放只在 window 上可见，兜底防候选卡死。
    this.bindWindowFallback();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const scene = deps.viewport.toSceneFromEvent(e);
      this.updateGhost(scene); // 芯片逐帧跟随
      this.updateHover(scene);
      return;
    }
    if (!this.candidate || e.pointerId !== this.candidate.pointerId) return;
    const dist = Math.hypot(e.clientX - this.candidate.x, e.clientY - this.candidate.y);
    if (dist < DRAG_THRESHOLD_PX) return;
    this.activate(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.candidate && e.pointerId === this.candidate.pointerId) {
      this.candidate = null; // 未激活即抬起：click，不做任何事
      this.unbindWindowFallback();
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    // svg 外兜底释放（window 监听收到 target 在 svg 子树外的事件）＝取消：拖离画布
    // 视为放弃，不按离谱远点结算落点（M7c-F 复验问题4）。指针捕获成功时 pointerup
    // 被重定向至 svg（target=svg），仍走下方正常释放路径。
    const t = e.target;
    if (!(t instanceof Node && deps.svg.contains(t))) {
      this.finish();
      return;
    }
    const ids = this.drag.ids; // finish() 清态前捕获（onDrop 在 finish 之后回调）
    const scene = deps.viewport.toSceneFromEvent(e);
    // 释放结算（M7c-D3 一致性）：常态（释放点 = 最后悬停点）直接复用最后一帧缓存
    // ——所见即所提；仅释放点 ≠ 缓存点（svg 外兜底释放等）才用同一函数现算。
    const resolved =
      this.pending !== null && this.pending.at.x === scene.x && this.pending.at.y === scene.y
        ? this.pending.resolved
        : this.computeResolved(scene, this.classifyAt(scene.x, scene.y));
    if (resolved.forbiddenId !== null) {
      this.finish();
      return; // 组成员本体/组成员后代：静默取消（fix round 1 裁决沿用）
    }
    this.finish();
    deps.onDrop(ids, resolved.target); // 整组（单节点长度 1）/空白 null（含快速释放——见头注）
  };

  private onPointerCancel = (): void => {
    if (!this.candidate && !this.drag) return;
    this.finish();
  };

  /** 过阈值：登记拖拽与 ghost 偏移（可选门控 canReparent 不放行则保持候选不激活）。 */
  private activate(e: PointerEvent): void {
    const deps = this.deps;
    const cand = this.candidate;
    if (!deps || !cand) return;
    if (deps.canReparent && !deps.canReparent(cand.id)) {
      this.candidate = null;
      this.unbindWindowFallback();
      return;
    }
    // 激活即再抑制一次默认动作（拖选拖拽等），与 pointerdown 的抑制双保险。
    e.preventDefault();
    const scene = deps.viewport.toSceneFromEvent(e);
    const box = deps.getBoxes().find((b) => b.id === cand.id);
    // 抓取偏移 = 按下点 − 被拖盒左上角：DragSnapshot 公开字段（页面/测试可读）。
    // M7c-F 复验问题3① 起芯片定位改为「指针 + 右下偏移」，不再消费该偏移。按下点
    // 用候选登记时的 client 坐标换算（与 toSceneFromEvent 同一套 rect 数学），不用
    // 激活 move 点——慢起手时二者可差很远。
    const rect = deps.svg.getBoundingClientRect();
    const downScene = deps.viewport.toScene(cand.x - rect.left, cand.y - rect.top);
    // 组拾起（2026-09-30 需求方批量拖动）：按下节点命中当前多选 → 整组（页面按布局
    // 序排序）；回调缺省或返回不含按下节点（异常护栏）→ 降级单节点。组内序自此
    // 冻结为拾起时布局序，释放时原样交给 onDrop。
    const group = deps.getDragGroup ? deps.getDragGroup(cand.id) : [cand.id];
    const ids = group.includes(cand.id) && group.length > 0 ? [...group] : [cand.id];
    this.drag = {
      id: cand.id,
      ids,
      pointerId: cand.pointerId,
      offsetX: box ? downScene.x - box.x : 0,
      offsetY: box ? downScene.y - box.y : 0,
    };
    this.candidate = null;
    // 被拖组视觉反馈（企微「提起」）：全组成员并挂 gm-dragging（半透明/cursor）+
    // gm-drag-origin（虚线占位），视觉由页面 CSS 落地；摘除统一走 clearHighlights，
    // 任何路径不残留。芯片逐帧定位（指针 + 右下偏移）。
    this.draggingVisualIds = [...ids];
    for (const gid of ids) {
      this.setClass(gid, 'gm-dragging', true);
      this.setClass(gid, 'gm-drag-origin', true);
    }
    this.createGhost(ids);
    this.updateGhost(scene);
    if (typeof deps.svg.setPointerCapture === 'function') {
      try {
        deps.svg.setPointerCapture(e.pointerId);
        this.capturedPointerId = e.pointerId;
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 + window 兜底（Task 7 先例） */
      }
    }
    this.updateHover(scene);
  }

  /** 结束拖拽：清反馈、移芯片/预览、释放捕获、卸 window 兜底（onDrop 由调用方决定）。 */
  private finish(): void {
    this.clearHighlights();
    this.pending = null;
    this.candidate = null;
    this.drag = null;
    this.releaseCapture();
    this.unbindWindowFallback();
  }

  private releaseCapture(): void {
    const svg = this.deps?.svg;
    if (
      this.capturedPointerId !== null &&
      svg &&
      typeof svg.releasePointerCapture === 'function'
    ) {
      try {
        svg.releasePointerCapture(this.capturedPointerId);
      } catch {
        /* 指针可能已释放 */
      }
    }
    this.capturedPointerId = null;
  }

  private bindWindowFallback(): void {
    if (this.windowBound) return;
    this.windowBound = true;
    // svg 内释放会先冒泡过 svg 处理器（状态已清），此兜底处理器成 no-op。
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
  }

  private unbindWindowFallback(): void {
    if (!this.windowBound) return;
    this.windowBound = false;
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
  }

  /**
   * 场景点落点分类（M7c-G 列吸附连续模型）：薄委托到纯函数 classifyDropAt（几何判定
   * 全部在纯函数——盒直击禁止 > 子级吸附区 > 同级插入列 > 空白，depth 降序取更深；
   * 语义与区域定义见 classifyDropAt / zoneSideAt / stripSideAt 头注）。排除集传全组
   * （2026-09-30 组拖动）：组成员本体/组内任一节点的后代一律禁止。
   */
  private classifyAt(
    sceneX: number,
    sceneY: number,
  ): { placement: DropPlacement | null; forbiddenId: string | null } {
    const deps = this.deps;
    const drag = this.drag;
    if (!deps || !drag) return { placement: null, forbiddenId: null };
    return classifyDropAt({
      boxes: deps.getBoxes(),
      childrenIdsOf: (id) => deps.childrenIdsOf(id),
      isDescendant: (id, candidateId) => deps.isDescendant(id, candidateId),
      draggedId: drag.id,
      draggedIds: drag.ids,
      rootLeftAllowed: deps.rootLeftAllowed?.(),
      point: { x: sceneX, y: sceneY },
    });
  }

  /**
   * 释放结算：把几何落点换算成文档写参数（纪律#2：纯计算，事务之外）。
   * M7c-G：child（子级吸附区）与 sibling（同级插入列）的 index 都已在 classify 按
   * 「移除被拖节点后」的子级堆结算为最近间隙位——moveNode 先移除后插入，引擎不再做
   * 二次位次修正（旧「锚点位次 + 同父前移」口径随带模型退役）。锚点不在文档序的降级
   * 分支随之不再需要（classify 与 resolve 同步结算，无协同变更窗口）。anchorId/
   * position 仅作落点意图调试信息（页面按 parentId+index 提交）：index 位前一个子级 =
   * after 锚，index 0 = 首子级 before 锚，空堆 = 父自身。
   */
  private resolveTarget(ids: string[], placement: DropPlacement): DropTarget {
    const deps = this.deps;
    // placement null = 禁止目标（target 恒 null，释放先行取消）；blank 由
    // computeResolved 走 resolveBlankTarget，不经此路径。
    if (!deps || placement === null || placement.kind === 'blank') return null;
    const parentId = placement.kind === 'child' ? placement.nodeId : placement.parentId;
    // 锚点调试信息按「移除全组后」的子级堆结算（组拖动 2026-09-30：组内任一成员
    // 现为该父子级的都先移走，与 classify/释放序列口径一致）。
    const stack = deps
      .childrenIdsOf(parentId)
      .filter((cid) => !ids.includes(cid))
      .map((cid) => deps.getBoxes().find((b) => b.id === cid))
      .filter((b): b is NodeBox => b !== undefined);
    const anchorId = (stack[placement.index - 1] ?? stack[0])?.id ?? parentId;
    // 空堆（追加/变子级）= after 父自身；非空 index 0 = before 首子级。
    const position: 'before' | 'after' =
      placement.index === 0 && stack.length > 0 ? 'before' : 'after';
    // 逆时针定侧：根级命中携带目标侧别（classify 经左列门控产出）→ DropTarget.side，
    // 页面在 moveNode 后据此调 core setNodeSide 完成持久换侧；非根级无 sideHint、
    // 不带 side（持久侧别仅 root 直接子级有语义）。
    return {
      kind: 'sibling',
      parentId,
      index: placement.index,
      anchorId,
      position,
      ...(placement.sideHint !== undefined ? { side: placement.sideHint } : {}),
    };
  }

  /**
   * 空白落点解析（M7c-F 复验问题4）：企微语义「空白=挂 root」但要可预期——目标侧取
   * 指针相对 root 盒中线（右半→right、左半→left），经左列门控（显式结构门控
   * rootLeftAllowed ?? 几何口径 rootLeftEnabled，与 classifyDropAt/resolveDropSlot
   * 同一取值：mindmap 恒开放、logic 恒右）；index 取该侧现有
   * 二级主题（扣除被拖组、按 NodeBox 当前 side 过滤）的**视觉末尾**（sideInsertDocIndex
   * 尾插映射——右列=文档序末兄弟之后、左列=视觉列底即文档序首位左主题之前，顺时针
   * 落位 2026-10-09）。org（root 盒 side 'down'）维持旧口径：恒文档序末尾、侧别仅作
   * sideHint 透传（org 槽分支不消费）。target.side 随解析产出（页面据此调 setNodeSide）
   * ——预览与释放同一结算，槽画在哪松手就落在哪。从节点起拖进入空白才走此路；空白
   * **按下**的框选/平移手势在候选登记（仅节点命中）处即已分流。root 盒缺失（协同删除
   * 窗口期）返回 null → 释放回退页面层 moveNode(id,'root') 兜底。
   */
  private resolveBlankTarget(
    scene: Point,
  ): { target: DropTarget; side: 'left' | 'right' } | null {
    const deps = this.deps;
    const drag = this.drag;
    if (!deps || !drag) return null;
    const boxes = deps.getBoxes();
    const rootBox = boxes.find((b) => b.parentId === undefined);
    if (!rootBox) return null;
    const pointerSide: 'left' | 'right' = scene.x >= rootBox.x + rootBox.w / 2 ? 'right' : 'left';
    const isDown = rootBox.side === 'down';
    // 目标侧：横向按指针侧 + 左列门控（显式结构门控 ?? 几何口径，与 classifyDropAt/
    // resolveDropSlot 同一取值）；org 恒透传指针侧（org 分支不消费侧别）。
    const leftEnabled = deps.rootLeftAllowed?.() ?? rootLeftEnabled(boxes, rootBox);
    const side: 'left' | 'right' = isDown
      ? pointerSide
      : pointerSide === 'left' && !leftEnabled
        ? 'right'
        : pointerSide;
    // 组拖动（2026-09-30）：index 按「移除全组后」的 root 子级结算——组成员现为
    // root 子级的都先移走，与释放端 moveNode 先移除后插入序列自洽。盒缺失跳过。
    const stack = deps
      .childrenIdsOf(rootBox.id)
      .filter((cid) => !drag.ids.includes(cid))
      .map((cid) => boxes.find((b) => b.id === cid))
      .filter((b): b is NodeBox => b !== undefined);
    // 该侧末尾（尾插）映射文档序；org（'down'）恒文档序末尾。
    const index = isDown
      ? stack.length
      : sideInsertDocIndex(stack, side, stack.filter((b) => b.side === side).length);
    // 锚点仅作 DropTarget 调试信息（页面按 parentId+index 提交）：文档序前一个子级。
    const anchorId = stack[index - 1]?.id ?? rootBox.id;
    return {
      target: { kind: 'sibling', parentId: rootBox.id, index, anchorId, position: 'after', side },
      side,
    };
  }

  /**
   * 单一结算路径（M7c-D3）：classify 结果 → resolveTarget / resolveBlankTarget →
   * 落位槽（含根级目标侧结算）。预览绘制与释放提交都只消费本函数产物——同点必
   * 同果。
   */
  private computeResolved(
    scene: Point,
    hit: { placement: DropPlacement | null; forbiddenId: string | null },
  ): ResolvedDrop {
    const deps = this.deps;
    const drag = this.drag;
    if (!deps || !drag) {
      return { placement: hit.placement, forbiddenId: hit.forbiddenId, target: null, slot: null };
    }
    // 落点 → 写参数（纪律#2：纯计算，事务之外）。空白解析为 root 对应侧末尾（问题4）；
    // 禁止目标 placement 为 null，target 恒 null（释放路径先行取消，不会提交）。
    // sideHint：空白按指针侧（resolveBlankTarget 已门控）；child/sibling 命中按
    // classify 携带的目标侧别（仅根级有值，已过左列门控）。target.side 随 target
    // 一并产出（根级落点 → 页面调 setNodeSide 的持久侧）。
    let target: DropTarget = null;
    let sideHint: 'left' | 'right' | undefined;
    if (hit.placement?.kind === 'blank') {
      const blank = this.resolveBlankTarget(scene);
      if (blank) {
        target = blank.target;
        sideHint = blank.side;
      }
    } else if (hit.placement !== null) {
      target = this.resolveTarget(drag.ids, hit.placement);
      sideHint = hit.placement.sideHint;
    }
    let slot: DropSlotPreview | null = null;
    if (target !== null && target.kind === 'sibling') {
      const boxes = deps.getBoxes();
      // 槽盒取主拖节点（按下节点）——组落同一槽（单套预览），组内其余成员随
      // index+i 递增排布，不在预览中逐个画槽。
      const draggedBox = boxes.find((b) => b.id === drag.id);
      if (draggedBox) {
        const resolution = resolveDropSlot({
          boxes,
          childrenIds: deps.childrenIdsOf(target.parentId),
          draggedId: drag.id,
          draggedGroupIds: drag.ids,
          parentId: target.parentId,
          index: target.index,
          // 芯片盒与芯片视觉同源（问题3①：指针 + 右下偏移），侧别/最近插入位判定
          // 跟随所见芯片。
          chipBox: ghostChipBox(scene, draggedBox, deps.viewport.scale),
          // 目标侧覆写（空白=指针侧+门控；根级区域命中=classify 结算的最终侧）。
          sideHint,
          // 左列门控与 classify/空白解析同一取值（同点必同侧）。
          rootLeftAllowed: deps.rootLeftAllowed?.(),
        });
        if (resolution === null) {
          slot = null; // 父盒/被拖盒缺失：无预览，释放仍按原 target 结算
        } else {
          if (resolution.index !== target.index) {
            // 防御性对齐（持久侧别下恒相等——classify 的 index 即最终值）：槽展示
            // 与释放提交用同一 index。
            target = { ...target, index: resolution.index };
          }
          slot = resolution.slot;
        }
      }
    }
    return { placement: hit.placement, forbiddenId: hit.forbiddenId, target, slot };
  }

  /**
   * 悬停反馈状态机（M7c-G 即时模型）：**去掉 100ms 点亮门槛**——每次 move 直接按当前
   * 结算画预览（落点切换先摘旧反馈，同目标内 index 连变原地刷新）；禁止态即时显隐。
   * 释放取最后一帧缓存，一致性机制不变。
   */
  private updateHover(scene: Point): void {
    const drag = this.drag;
    if (!drag) return;
    const hit = this.classifyAt(scene.x, scene.y);
    if (placementKey(hit.placement) !== placementKey(this.hoverPlacement)) {
      this.clearTargetFeedback(); // 目标切换：立即摘除旧描边类/预览（无门槛，无定时器）
      this.hoverPlacement = hit.placement;
    }
    // 单一结算路径逐帧刷新（含同落点内移动：芯片位置实时影响槽位/侧别修正），
    // 释放取最后一帧——与所见严格一致。
    this.pending = { at: scene, resolved: this.computeResolved(scene, hit) };
    this.applyFeedback();
    // 自身/后代的禁止反馈即时显隐。
    if (hit.forbiddenId !== this.hoverForbidden) {
      this.setClass(this.hoverForbidden, 'drop-forbidden', false);
      this.hoverForbidden = hit.forbiddenId;
      if (hit.forbiddenId !== null) this.setClass(hit.forbiddenId, 'drop-forbidden', true);
    }
    // 禁止态芯片同步变红（M7c-F 复验问题3②）：目标盒红描边之外，白底芯片自身的
    // 描边也转红（类由页面 CSS 落色），悬停目标本体时反馈不再被芯片完全遮盖。
    // 芯片随 clearHighlights 整体移除，类无需单独清理。
    this.ghost?.classList.toggle('gm-drag-ghost-forbidden', hit.forbiddenId !== null);
  }

  /**
   * 点亮落点反馈（即时）：child = 目标盒描边（.drop-target）**且**真实边+槽同画
   * （M7c-G：蓝描边保留、边/槽也画）；sibling/空白 = 真实边 + 落位槽。结算无槽
   * （父盒/被拖盒缺失窗口期）时摘除预览，不留残影。
   */
  private applyFeedback(): void {
    const p = this.hoverPlacement;
    if (!p || !this.pending) return;
    if (p.kind === 'child') this.setClass(p.nodeId, 'drop-target', true);
    if (this.pending.resolved.slot === null) this.removeDropPreview();
    else this.drawDropPreview();
  }

  /** 摘除落点反馈：去类/移预览元素并复位落点（点亮定时器随 100ms 门槛一并退役）。 */
  private clearTargetFeedback(): void {
    const p = this.hoverPlacement;
    if (p && p.kind === 'child') this.setClass(p.nodeId, 'drop-target', false);
    this.removeDropPreview();
    this.hoverPlacement = null;
  }

  /**
   * 跟随芯片（企微「拾起」）。单节点（ids 长度 1）= 被拖节点盒大小的白底圆角矩形
   * （企微蓝描边 1.5px）+ 居中文字（被拖节点文本，超宽省略）——旧口径逐属性不变。
   * 组拖动（2026-09-30 需求方）= 组芯片：最多 2 层堆叠（第一、二个节点各自盒尺寸
   * 与文字，第二层偏移 +6,+6 垫底、第一层盖顶），size>1 时第一层右上角画计数徽章
   * （圆形企微蓝底白字 ×N，类/testid gm-drag-ghost-badge）。DOM 结构保持扁平——
   * 两层 rect 均为 ghost g 直接子元素，禁止态 gm-drag-ghost-forbidden 的页面 CSS
   * `> rect` 红描边规则对两层同时生效（变红逻辑沿用）。文字/圆角取自各被拖节点
   * DOM（按属性值精确匹配扫描，规避 id 选择器转义问题）。
   */
  private createGhost(ids: string[]): void {
    const deps = this.deps;
    if (!deps || this.ghost) return;
    const boxes = deps.getBoxes();
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'gm-drag-ghost');
    /** 单节点芯片素材：盒几何 + DOM 取圆角/文字样式（盒缺失 → null 跳层）。 */
    const chipOf = (
      id: string,
    ): {
      w: number;
      h: number;
      rx: string;
      label: string;
      fontSize: number;
      family: string | null;
      fill: string | null;
    } | null => {
      const box = boxes.find((b) => b.id === id);
      if (!box) return null;
      let sourceText: SVGTextElement | null = null;
      let rx = '8';
      const all = deps.svg.querySelectorAll<SVGGElement>('[data-node-id]');
      for (let i = 0; i < all.length; i += 1) {
        if (all[i]!.getAttribute('data-node-id') === id) {
          sourceText = all[i]!.querySelector('text.gm-text');
          rx = all[i]!.querySelector('rect')?.getAttribute('rx') ?? rx;
          break;
        }
      }
      // 行集合并（多行空格连接）作芯片单行文案；无文字节点（桩/异常）则只有矩形。
      const label = sourceText
        ? Array.from(sourceText.children)
            .map((t) => t.textContent ?? '')
            .join(' ')
            .trim() || (sourceText.textContent ?? '').trim()
        : '';
      return {
        w: box.w,
        h: box.h,
        rx,
        label,
        fontSize: parseFloat(sourceText?.getAttribute('font-size') ?? '14') || 14,
        family: sourceText?.getAttribute('font-family') ?? null,
        fill: sourceText?.getAttribute('fill') ?? null,
      };
    };
    // 层序：组 = [第二成员(+6,+6 垫底), 首成员(盖顶)]；单节点 = [首成员无偏移]。
    const layers =
      ids.length > 1 ? [ids[1]!, ids[0]!] : ids.length === 1 ? [ids[0]!] : [];
    for (let li = 0; li < layers.length; li += 1) {
      const chip = chipOf(layers[li]!);
      if (!chip) continue;
      const ox = li === 0 && ids.length > 1 ? GHOST_STACK_OFFSET_PX : 0;
      const oy = ox; // 第二层偏移 +6,+6；第一层（盖顶）无偏移
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', fmt(ox));
      rect.setAttribute('y', fmt(oy));
      rect.setAttribute('width', fmt(chip.w));
      rect.setAttribute('height', fmt(chip.h));
      rect.setAttribute('rx', chip.rx);
      rect.setAttribute('fill', '#ffffff');
      rect.setAttribute('stroke', ACCENT);
      rect.setAttribute('stroke-width', '1.5');
      g.appendChild(rect);
      if (chip.label !== '') {
        const text = document.createElementNS(SVG_NS, 'text');
        text.setAttribute('x', fmt(ox + chip.w / 2));
        text.setAttribute('y', fmt(oy + chip.h / 2 + chip.fontSize * 0.35));
        text.setAttribute('text-anchor', 'middle');
        if (chip.family) text.setAttribute('font-family', chip.family);
        if (chip.fill) text.setAttribute('fill', chip.fill);
        text.setAttribute('font-size', fmt(chip.fontSize));
        text.textContent = truncateLabel(chip.label, chip.w - 16, chip.fontSize);
        g.appendChild(text);
      }
    }
    // 计数徽章（size>1）：第一层芯片右上角（盒右上角点为圆心），圆形企微蓝底 +
    // 白字 ×N——组规模一眼可辨。
    const primary = ids.length > 1 ? boxes.find((b) => b.id === ids[0]) : undefined;
    if (primary) {
      const badge = document.createElementNS(SVG_NS, 'g');
      badge.setAttribute('class', 'gm-drag-ghost-badge');
      badge.setAttribute('data-testid', 'gm-drag-ghost-badge');
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', fmt(primary.w));
      circle.setAttribute('cy', '0');
      circle.setAttribute('r', fmt(GHOST_BADGE_RADIUS));
      circle.setAttribute('fill', ACCENT);
      badge.appendChild(circle);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', fmt(primary.w));
      text.setAttribute('y', fmt(GHOST_BADGE_FONT_SIZE * 0.35));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', '#ffffff');
      text.setAttribute('font-size', fmt(GHOST_BADGE_FONT_SIZE));
      text.textContent = `×${ids.length}`;
      badge.appendChild(text);
      g.appendChild(badge);
    }
    if (!g.hasChildNodes()) return; // 全组盒缺失（异常窗口期）：不建芯片
    deps.overlayLayer.appendChild(g);
    this.ghost = g;
  }

  /**
   * 芯片逐帧定位（M7c-F 复验问题3①）：指针 scene 点 + 右下偏移——screen 像素恒
   * 14px（scene 偏移 = 14 / 当前 scale，读 deps.viewport.scale 折算）。芯片不再以
   * 「指针 − 抓取偏移」居中压住光标处的目标描边/落点反馈。
   */
  private updateGhost(scene: Point): void {
    const deps = this.deps;
    if (!this.ghost || !deps) return;
    const o = ghostSceneOffset(deps.viewport.scale);
    this.ghost.setAttribute(
      'transform',
      `translate(${fmt(scene.x + o)}, ${fmt(scene.y + o)})`,
    );
  }

  private removeGhost(): void {
    this.ghost?.remove();
    this.ghost = null;
  }

  /**
   * 落位预览（M7c-D3 核心）：`path.gm-drop-edge`（候选父盒边中点 → 槽盒边中点，
   * render.ts 同款 bezier/elbow 公式——松手后就是这条边；描边色取画布既有连线，
   * 取不到兜底灰）+ `rect.gm-drop-slot`（槽位虚线圆角框，企微蓝淡填充）。
   */
  private drawDropPreview(): void {
    const deps = this.deps;
    const pending = this.pending;
    if (!deps || !pending || pending.resolved.slot === null) return;
    const slot = pending.resolved.slot;
    if (!this.dropSlot) {
      this.dropSlot = document.createElementNS(SVG_NS, 'rect');
      this.dropSlot.setAttribute('class', 'gm-drop-slot');
      deps.overlayLayer.appendChild(this.dropSlot);
    }
    this.dropSlot.setAttribute('x', fmt(slot.x));
    this.dropSlot.setAttribute('y', fmt(slot.y));
    this.dropSlot.setAttribute('width', fmt(slot.w));
    this.dropSlot.setAttribute('height', fmt(slot.h));
    this.dropSlot.setAttribute(
      'rx',
      deps.svg.querySelector('[data-node-id] rect')?.getAttribute('rx') ?? '8',
    );
    this.dropSlot.setAttribute('fill', 'rgba(51, 112, 255, 0.06)');
    this.dropSlot.setAttribute('stroke', ACCENT);
    this.dropSlot.setAttribute('stroke-width', '1.5');
    this.dropSlot.setAttribute('stroke-dasharray', '5 4');
    if (!this.dropEdge) {
      this.dropEdge = document.createElementNS(SVG_NS, 'path');
      this.dropEdge.setAttribute('class', 'gm-drop-edge');
      deps.overlayLayer.appendChild(this.dropEdge);
    }
    this.dropEdge.setAttribute('d', this.edgePathD(slot.edge));
    this.dropEdge.setAttribute(
      'stroke',
      deps.svg.querySelector('path[data-edge-id]')?.getAttribute('stroke') ?? EDGE_COLOR_FALLBACK,
    );
    this.dropEdge.setAttribute('stroke-width', '2');
  }

  /** 边 path d：与 render.ts edgeD 同公式——预览边与真实连线同形（验收口径）。 */
  private edgePathD(edge: DropSlotPreview['edge']): string {
    const { from, to } = edge;
    if (edge.kind === 'bezier') {
      const c1 = edge.controls?.[0] ?? from;
      const c2 = edge.controls?.[1] ?? to;
      return `M ${fmt(from.x)} ${fmt(from.y)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`;
    }
    const mid = (from.y + to.y) / 2;
    return `M ${fmt(from.x)} ${fmt(from.y)} L ${fmt(from.x)} ${fmt(mid)} L ${fmt(to.x)} ${fmt(mid)} L ${fmt(to.x)} ${fmt(to.y)}`;
  }

  private removeDropPreview(): void {
    this.dropEdge?.remove();
    this.dropEdge = null;
    this.dropSlot?.remove();
    this.dropSlot = null;
  }

  private clearHighlights(): void {
    this.clearTargetFeedback();
    this.setClass(this.hoverForbidden, 'drop-forbidden', false);
    this.hoverForbidden = null;
    // 被拖组反馈兜底摘除：finish/destroy 全走这里（激活与收尾配对，见头注）——
    // 组拖动对全组成员逐个摘类（2026-09-30）。
    for (const gid of this.draggingVisualIds) {
      this.setClass(gid, 'gm-dragging', false);
      this.setClass(gid, 'gm-drag-origin', false);
    }
    this.draggingVisualIds = [];
    // 芯片/预览兜底移除：任何结束路径（释放/取消/destroy/svg 外 pointerup）不残留。
    this.removeGhost();
    this.removeDropPreview();
  }

  private setClass(id: string | null, cls: string, on: boolean): void {
    const svg = this.deps?.svg;
    if (!svg || id === null) return;
    // 按属性值精确匹配（不用选择器插值，避免 id 含特殊字符时的转义问题）。
    const all = svg.querySelectorAll<SVGGElement>('[data-node-id]');
    for (let i = 0; i < all.length; i += 1) {
      const g = all[i] as SVGGElement;
      if (g.getAttribute('data-node-id') === id) {
        if (on) g.classList.add(cls);
        else g.classList.remove(cls);
        return;
      }
    }
  }
}
