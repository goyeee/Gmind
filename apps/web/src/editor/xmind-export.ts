// xmind-export.ts：XMind 导出胶水（M4 Task 5，FR-IO-004 一期 XMind 部分）。
//
// doc → XmindNode 树 → buildXmind（@gmind/xmind-io，2020+ zip）→ Blob → 浏览器下载。
// 树遍历自当前画布 rootId（rootIdOf(doc, canvasId)）起先序只走 getNode(doc, id, canvasId)
// 的 childIds（读路径走 core 读 API，唯一写入口约束不涉及读）：换父/删除操作同步维护父 children（deleteNodes 先墓碑再
// removeFromParentChildren），childIds 即存活可达树，墓碑不会出现；折叠只是视图态
// （collapsed 标记不影响数据层子树完整性）——FR-IO-004 的「层级类导出先自动展开折叠」
// 在本架构下自动满足，无需展开步骤，导出恒为完整层级。
// 标记（M7a-T1）：仅出三组（priority/icon/emoji，值目录内；marker-id 映射口径在
// @gmind/xmind-io markers.ts）。
import type * as Y from 'yjs';
import { ICON_GROUPS, getNode, listCanvases, rootIdOf } from '@gmind/core';
import { buildXmind, type XmindIcons, type XmindNode, type XmindSheet } from '@gmind/xmind-io';

/** 存活树 → XmindNode：title = node.text；note 非空才产出 note 键（'' 即无备注，
 *  buildXmind 以真值判定备注，与 T3 裁决一致）；children 按原顺序映射 childIds；
 *  icons 只取三组键（M7a-T1：值目录外的旧值/未知组不携带，导出仅出三组）。
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
    return {
      title: snap.text,
      ...(snap.note ? { note: snap.note } : {}),
      // 描述（M7c-C1）：非空才产出自定义键（buildXmind 真值判定，与 note 同款口径；
      // XML 侧无对应登记不映射，见 @gmind/xmind-io types.ts XmindNode 头注）。
      ...(snap.description ? { description: snap.description } : {}),
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
