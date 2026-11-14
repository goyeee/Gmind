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
// 值透传字符串（px 形状/非法值过滤在 build 层 stylePropertiesOf）。图片/概要/folded
// 不写回（spec §六登记）。
import type * as Y from 'yjs';
import { ICON_GROUPS, getNode, listCanvases, rootIdOf } from '@gmind/core';
import { buildXmind, type XmindIcons, type XmindNode, type XmindSheet } from '@gmind/xmind-io';

/** 导出携带的节点样式键（spec §六四键）：fontSize 在内；fontFamily 不在——引擎不支持
 *  节点级 fontFamily 覆盖，spec 裁定不映射。值透传字符串，build 层做 px 形状与非法过滤。 */
const STYLE_EXPORT_KEYS = ['fill', 'border', 'color', 'fontSize'] as const;

/** 存活树 → XmindNode：title = node.text；note 非空才产出 note 键（'' 即无备注，
 *  buildXmind 以真值判定备注，与 T3 裁决一致）；children 按原顺序映射 childIds；
 *  icons 八组全量透传（M7b-W1 八组制；目录外旧组在读取侧 readIcons 不入快照，
 *  目录外旧值由 build 层 iconsToMarkerIds 过滤）；href/style 导出对称 v2 见
 *  STYLE_EXPORT_KEYS 与 walk 内注释（2026-11-14 spec §六）。
 *  visited 集合环防护（M4 挂账清偿，防御性）：childIds 环（core 写路径不可达——
 *  换父/删除同步维护父 children，但 crafted doc_state / 裸 Y 写可造出）时跳过回边，
 *  保证任意形状下终止（模式同 core subtreeIds 的环防御，环治理归 normalizeTree）。
 * 多画布（计划三 Task 4 item 12，中间态）：canvasId 给定时遍历/根解析限定该画布
 * 子图——导出当前画布单 Sheet（全量多 Sheet 属计划四，Global Constraints 已登记）；
 * 缺省=core 缺省解析（单画布零差异）。 */
export function docToXmindTree(doc: Y.Doc, canvasId?: string): XmindNode {
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
    return {
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
  };
  return walk(rootId);
}

/** 全部画布 → XmindSheet[]（多画布计划四，裁定 8：XMind 导出全画布多 Sheet，
 *  title=画布名；替换计划三 Task 4 的「当前画布单 Sheet」中间态）。 */
export function docToXmindSheets(doc: Y.Doc): XmindSheet[] {
  return listCanvases(doc).map((canvas) => ({
    title: canvas.name,
    root: docToXmindTree(doc, canvas.id),
  }));
}

/** 生成 .xmind 并触发浏览器下载（文件名 = `${title}.xmind`，title 即编辑器 header
 *  展示的 getMeta(doc).title）。Object URL 在 click 触发下载后于下一宏任务 revoke，
 *  不遗留 URL；无定时器之外的副作用。
 *  多画布（计划四，裁定 8）：全部画布逐个出 Sheet。 */
export function exportXmind(doc: Y.Doc, title: string): void {
  const bytes = buildXmind(docToXmindSheets(doc));
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
}
