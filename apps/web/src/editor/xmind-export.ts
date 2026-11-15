// xmind-export.ts：XMind 导出胶水（M4 Task 5，FR-IO-004 一期 XMind 部分）。
//
// doc → XmindNode 树 → buildXmind（@gmind/xmind-io，2020+ zip）→ Blob → 浏览器下载。
// 树遍历自当前画布 rootId（rootIdOf(doc, canvasId)）起先序只走 getNode(doc, id, canvasId)
// 的 childIds（读路径走 core 读 API，唯一写入口约束不涉及读）：换父/删除操作同步维护父 children（deleteNodes 先墓碑再
// removeFromParentChildren），childIds 即存活可达树，墓碑不会出现；折叠只是视图态
// （collapsed 标记不影响数据层子树完整性）——FR-IO-004 的「层级类导出先自动展开折叠」
// 在本架构下自动满足，无需展开步骤，导出恒为完整层级。
// 标记（M7b-W1 八组制；2026-11-14 v2）：icons 全组透传（过滤/映射职责在
// @gmind/xmind-io markers.ts iconsToMarkerIds——emoji/number 组无原生 marker-id
// 不导出的裁定在 build 层落地，树层不预滤）。
// 导出对称 v2（2026-11-14 导入保真 spec §六）：walk 输出补 href/style——href 仅
// http/https 产键（与 setHref 写入口径、导入解析口径对称）；style 仅四键非空才产、
// 值透传字符串（px 形状/非法值过滤在 build 层 stylePropertiesOf）。概要/folded
// 仍不写回（spec §六登记）；图片写回（2026-11-15 需求方反馈「XMind 导出带图」，
// M4 挂账「图片不写回」清偿）：walk 收集图片任务（core 快照 snap.image=
// {key,w,h,placement}），buildXmindBytes 逐唯一 storage 键 fetch /api/images/{key}
// （读取端点公开，同 image-export inlineImages 先例）→ resources/{键尾段} 入 zip
// extra + node.image={path,w,h,align} 回填，build 层产 topic.image src='xap:'+path；
// 同 key 多节点只 fetch 一次、zip 只入一份；单图失败（!res.ok / fetch throw）该键
// 引用节点全部跳过图片、导出不中断，missingImages（=抓取失败的不同图片张数）由
// 调用方 toast 点名（NFR-USE-005 两段式：原因+下一步=可重试）。
// 分侧写回（2026-11-15 分侧忠实还原 Task 3，Task 4 折算修正；同日终审 Important#1
// 口径如实改写）：docToXmindSheets 逐 mindmap 画布经 core countRightSideRootChildren
// 取「引擎渲染的右侧根分支数」→ sheet.rightCount，build 层落根扩展 right-number
// （provider=org.xmind.ui.map.unbalanced，语义=attached 文档序前 N 支居右）——分支左右
// 写回 right-number（右支计数）；XMind 按『前 N 支居右』解读：前缀布局（导入自带
// right-number／Gmind 内未拖拽换侧）逐支一致；非前缀布局（Gmind 拖拽换侧／v3 兜底
// 交替腿导入的文件）计数仍正确，但首次在 XMind 打开会按『前 N 支』重新排一次（不在
// 前 N 的右支静默换侧），一轮后稳定；是否导出时重排为前缀待需求方裁定（features ④10）。
// 计数镜像引擎折算口径（core operations.ts countRightSideRootChildren：
// 持久 side 计数＋无 side 根子级按文档序 index 0-2 视右，与 engine layout.ts 精确同款）：
// Gmind 文档里根分支可以没有持久 side（模板 buildSubtree 直建不写；EditorPage moveNode
// 到画布根 core 有意不写 side），引擎此时按 index 折算渲染——Task 3 初版只数持久 side
// 使这类文档的导出计数与渲染脱节、往返有损，经 T3 评审裁定改用折算计数（正确性修正）。
// 非 mindmap 画布不产键（XMind 只在 map.unbalanced 画布读 right-number，写了也不被还原）。
import type * as Y from 'yjs';
import {
  countRightSideRootChildren,
  DEFAULT_IMAGE_PLACEMENT,
  ICON_GROUPS,
  getMeta,
  getNode,
  listCanvases,
  rootIdOf,
} from '@gmind/core';
import type { NodeImagePlacement } from '@gmind/core';
import { buildXmind, type XmindIcons, type XmindNode, type XmindSheet } from '@gmind/xmind-io';

/** 导出携带的节点样式键（spec §六四键）：fontSize 在内；fontFamily 不在——引擎不支持
 *  节点级 fontFamily 覆盖，spec 裁定不映射。值透传字符串，build 层做 px 形状与非法过滤。 */
const STYLE_EXPORT_KEYS = ['fill', 'border', 'color', 'fontSize'] as const;

/** 图片写回任务（walk 收集 → buildXmindBytes 抓取回填）：node=树内节点引用（抓取
 *  成功后原地回填 image，path=resources/{键尾段}）；key/w/h/align 来自 core 快照
 *  snap.image（w/h 经有限数值守卫，crafted 非数值缺省不产键——build 层 null 判定
 *  跳过同口径）；align=placement ?? bottom（core 读侧缺省锚点）。 */
export interface XmindImageTask {
  node: XmindNode;
  key: string;
  w?: number;
  h?: number;
  align: NodeImagePlacement;
}

/** 存活树 → XmindNode：title = node.text；note 非空才产出 note 键（'' 即无备注，
 *  buildXmind 以真值判定备注，与 T3 裁决一致）；children 按原顺序映射 childIds；
 *  icons 八组全量透传（M7b-W1 八组制；目录外旧组在读取侧 readIcons 不入快照，
 *  目录外旧值由 build 层 iconsToMarkerIds 过滤）；href/style 导出对称 v2 见
 *  STYLE_EXPORT_KEYS 与 walk 内注释（2026-11-14 spec §六）。
 *  图片（2026-11-15 需求方反馈，M4 挂账清偿）：snap.image 收集为 XmindImageTask
 *  挂 imageTasks（缺省不收集）——树层不产 image 键，字节抓取与 node.image 回填在
 *  buildXmindBytes（本模块无 fetch 时树构造保持同步纯函数，既有调用零感知）。
 *  visited 集合环防护（M4 挂账清偿，防御性）：childIds 环（core 写路径不可达——
 *  换父/删除同步维护父 children，但 crafted doc_state / 裸 Y 写可造出）时跳过回边，
 *  保证任意形状下终止（模式同 core subtreeIds 的环防御，环治理归 normalizeTree）。
 * 多画布：canvasId 给定时遍历/根解析限定该画布子图；缺省=core 缺省解析（单画布零差异）。 */
export function docToXmindTree(doc: Y.Doc, canvasId?: string, imageTasks?: XmindImageTask[]): XmindNode {
  const rootId = rootIdOf(doc, canvasId);
  const visited = new Set<string>([rootId]);
  const walk = (id: string): XmindNode => {
    const snap = getNode(doc, id, canvasId);
    if (!snap) throw new Error('导出失败：文档树不完整');
    const children: XmindNode[] = [];
    for (const childId of snap.childIds) {
      if (visited.has(childId)) continue; // 环防护：已访问 id 不再下降（含指回 root）
      const child = getNode(doc, childId, canvasId);
      if (!child || child.deleted) continue; // 防御：悬空 id / 墓碑不入树
      visited.add(childId);
      children.push(walk(childId));
    }
    const icons: XmindIcons = {};
    for (const group of ICON_GROUPS) {
      const values = snap.icons[group];
      if (values !== undefined && values.length > 0) icons[group] = values;
    }
    // href（导出对称 v2，spec §六）：仅 http/https 产键——与 setHref 写入口径
    // （/^https?:\/\//i）、导入解析口径对称；crafted 非 http(s) 值不产（导入侧计超链接降级）。
    const href = /^https?:\/\//i.test(snap.href) ? snap.href : '';
    // style（导出对称 v2，spec §六）：四键非空才产，值透传字符串（快照值经
    // writeStylePatch 恒为 string，typeof 守卫防 crafted 裸写数值——与 build 层
    // fontSize 守卫同口径）；px 形状/非法值/表外键过滤在 build 层 stylePropertiesOf。
    const style: Record<string, string> = {};
    for (const key of STYLE_EXPORT_KEYS) {
      const value = snap.style[key];
      if (typeof value === 'string' && value !== '') style[key] = value;
    }
    const node: XmindNode = {
      title: snap.text,
      ...(snap.note ? { note: snap.note } : {}),
      // 描述（M7c-C1）：非空才产出自定义键（buildXmind 真值判定，与 note 同款口径；
      // XML 侧无对应登记不映射，见 @gmind/xmind-io types.ts XmindNode 头注）。
      ...(snap.description ? { description: snap.description } : {}),
      ...(href ? { href } : {}),
      ...(Object.keys(style).length > 0 ? { style } : {}),
      ...(Object.keys(icons).length > 0 ? { icons } : {}),
      children,
    };
    // 图片写回任务（2026-11-15）：key 非空字符串才收集（crafted 透传形状/空键不产，
    // 与 href 的 crafted 口径同款）；w/h 有限数值守卫；placement 非法值已在读侧剔除、
    // 缺省落 bottom（DEFAULT_IMAGE_PLACEMENT，core 读侧缺省锚点同源）。
    const img = snap.image;
    if (imageTasks && img && typeof img.key === 'string' && img.key !== '') {
      imageTasks.push({
        node,
        key: img.key,
        ...(typeof img.w === 'number' && Number.isFinite(img.w) ? { w: img.w } : {}),
        ...(typeof img.h === 'number' && Number.isFinite(img.h) ? { h: img.h } : {}),
        align: img.placement ?? DEFAULT_IMAGE_PLACEMENT,
      });
    }
    return node;
  };
  return walk(rootId);
}

/** 全部画布 → XmindSheet[]（多画布计划四，裁定 8：XMind 导出全画布多 Sheet，
 *  title=画布名；替换计划三 Task 4 的「当前画布单 Sheet」中间态）。
 *  结构串（2026-11-15 终审 Important#1）：逐画布传 structureType=画布解析结构
 *  （getMeta 读解析画布、缺省 'mindmap'，@gmind/shared StructureType 与
 *  XmindStructureType 三值同构），build 层经 STRUCTURE_EXPORT_MAP 落根
 *  structureClass——此前生产链不传 → 导出件恒无结构串、logic 画布在 XMind 落
 *  默认布局；与 xmind-import 画布结构写回（规则 4 三映射）对称。
 *  分侧写回（2026-11-15 分侧忠实还原 Task 3，Task 4 折算修正，见文件头注）：仅
 *  mindmap 画布经 core countRightSideRootChildren 取「引擎渲染的右侧根分支数」传
 *  rightCount（持久 side 计数＋无 side 根子级按 index 0-2 折算右＋墓碑防御，与
 *  engine layout.ts 同口径；build 层落根扩展 right-number）；非 mindmap 画布不产键。 */
export function docToXmindSheets(doc: Y.Doc, imageTasks?: XmindImageTask[]): XmindSheet[] {
  return listCanvases(doc).map((canvas) => {
    const { structureType } = getMeta(doc, canvas.id);
    // 分侧计数（Task 4 折算修正）：单源 core 折算计数（引擎渲染口径），不再手写统计
    // ——墓碑/悬空 id 防御在 core 内同款（deleted 守卫），画布口径按 canvasId 解析。
    const rightCount = structureType === 'mindmap' ? countRightSideRootChildren(doc, canvas.id) : undefined;
    return {
      title: canvas.name,
      root: docToXmindTree(doc, canvas.id, imageTasks),
      structureType,
      ...(rightCount !== undefined ? { rightCount } : {}),
    };
  });
}

/** 资源名（2026-11-15 图片写回）：storage 键 `files/{fileId}/{ulid}.{ext}` 取尾段——
 *  ulid 全局唯一，不同键尾段无碰撞；path=zip 键，'xap:' 前缀由 build 层补。 */
function resourceNameOf(key: string): string {
  return `resources/${key.split('/').pop()}`;
}

/** doc → .xmind 字节（exportXmind 去 DOM 下载段的纯产物层，图片写回在此抓取）：
 *  walk 收集图片任务 → 按唯一 storage 键并行 fetch /api/images/{key}（读取端点公开，
 *  同源 GET 无附加头，image-export inlineImages 同款事实）→ 成功键入 resources 表
 *  （buildXmind extra：zip 条目 + manifest 登记）并逐任务回填 node.image；失败键
 *  （!res.ok / fetch throw）跳过回填、计入 missingImages，导出不中断。
 *  missingImages = 抓取失败的不同图片张数（同图多节点引用不重复计——toast 口径
 *  「N 张图片」）。无图文档快路径：零 fetch、载荷与旧版逐字节一致。 */
export async function buildXmindBytes(doc: Y.Doc): Promise<{ bytes: Uint8Array; missingImages: number }> {
  const imageTasks: XmindImageTask[] = [];
  const sheets = docToXmindSheets(doc, imageTasks);
  if (imageTasks.length === 0) return { bytes: buildXmind(sheets), missingImages: 0 };

  // 同 key 去重：多节点共用一图只 fetch 一次、zip 只入一份
  const byKey = new Map<string, XmindImageTask[]>();
  for (const task of imageTasks) {
    const list = byKey.get(task.key);
    if (list) list.push(task);
    else byKey.set(task.key, [task]);
  }

  const resources: Record<string, Uint8Array> = {};
  const failed = new Set<string>();
  await Promise.all(
    [...byKey.keys()].map(async (key) => {
      try {
        const res = await fetch(`/api/images/${key}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        resources[resourceNameOf(key)] = new Uint8Array(await res.arrayBuffer());
      } catch {
        failed.add(key); // 单图失败：引用它的全部节点跳过图片，其余导出照常
      }
    }),
  );

  for (const task of imageTasks) {
    if (failed.has(task.key)) continue; // 失败键不回填——节点保持无 image（XMind 无图呈现）
    // w/h 缺省不产键（crafted 非有限数值经收集守卫落 undefined——build 层 != null 同口径跳过）
    task.node.image = {
      path: resourceNameOf(task.key),
      ...(task.w !== undefined ? { w: task.w } : {}),
      ...(task.h !== undefined ? { h: task.h } : {}),
      align: task.align,
    };
  }
  return { bytes: buildXmind(sheets, resources), missingImages: failed.size };
}

/** 生成 .xmind 并触发浏览器下载（文件名 = `${title}.xmind`，title 即编辑器 header
 *  展示的 getMeta(doc).title）。Object URL 在 click 触发下载后于下一宏任务 revoke，
 *  不遗留 URL；无定时器之外的副作用。
 *  多画布（计划四，裁定 8）：全部画布逐个出 Sheet。
 *  2026-11-15 起改 async（图片写回要先 fetch 节点图入包；M4 挂账清偿）：返回
 *  {missingImages}，部分图片抓取失败不阻断下载，由调用方 toast 点名（两段式文案）。 */
export async function exportXmind(doc: Y.Doc, title: string): Promise<{ missingImages: number }> {
  const { bytes, missingImages } = await buildXmindBytes(doc);
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.xmind`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立即 revoke 在部分浏览器会打断尚未起程的下载，推迟到当前任务之后回收
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { missingImages };
}
