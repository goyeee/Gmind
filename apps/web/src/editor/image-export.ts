// image-export.ts：PNG/JPG 导出胶水（M4 Task 9，FR-IO-003/005）。
//
// 流程：core cloneExpanded（仅导出快照不改画布——展开折叠发生在克隆上）→
// engine exportSceneSvg（detached 容器离屏渲染 + XMLSerializer 序列化）→
// inlineImages（SVG-as-image 上下文禁载一切外部资源，/api/images/ 引用必须内联为
// data URL 后才能被 Image 加载）→ Canvas 栅格化（JPG 或非透明 PNG 先铺白底）→
// toBlob（PNG 无损 / JPEG 质量 0.92）→ a[download] 触发浏览器下载。
//
// 图片鉴权事实（storage.controller.ts）：/api/images/* 读取端点公开（浏览器 <img>
// 无法带 Authorization，仅上传鉴权），同源 fetch 即可，无需附加头。
import type * as Y from 'yjs';
import {
  childrenIds,
  cloneExpanded,
  countAliveReachable,
  getMeta,
  getNode,
  listCanvases,
  listSummaries,
  resolveCanvasId,
  rootIdOf,
} from '@gmind/core';
import { exportSceneSvg, type DocReader } from '@gmind/engine';
import { MAX_DOC_NODES } from '@gmind/shared';

export interface ImageExportOptions {
  format: 'png' | 'jpg';
  scale: 1 | 2 | 3;
  /** 透明背景（PNG 生效；JPG 无 alpha 通道恒白底）。 */
  transparent: boolean;
  /** 导出画布（多画布 Task 4 item 8）：缺省=core 缺省解析（单画布零差异）。
   *  配额/克隆/布局/文件名全部按该画布口径。 */
  canvasId?: string;
}

/** @gmind/core 读 API → engine DocReader（与 EditorPage.tsx 底部装配适配器同形——
 *  含 summaries，M6 T6；终审 Important 修复：此处缺省时导出静默丢概要 bracket）；
 *  此处模块级纯函数，避免页面组件与导出胶水互相 import 成环。 */
function readerOf(d: Y.Doc, canvasId?: string): DocReader {
  return {
    getMeta: () => getMeta(d, canvasId),
    getNode: (id) => getNode(d, id, canvasId),
    childrenIds: (id) => childrenIds(d, id, canvasId),
    summaries: () => listSummaries(d, canvasId),
  };
}

/**
 * 导出文件名口径（多画布 Task 4 item 8）：单画布 = 文件标题（现状不动）；
 * 多画布 = 文件标题＋导出画布名（「-」连接）。导出画布名与像素作用画布同口径——
 * 显式 canvasId 取其名；缺省按 core 缺省解析（meta.activeCanvasId 回退链）。
 */
export function imageExportFileName(doc: Y.Doc, title: string, canvasId?: string): string {
  const infos = listCanvases(doc);
  if (infos.length < 2) return title;
  const scopeId = canvasId ?? resolveCanvasId(doc);
  const name = infos.find((info) => info.id === scopeId)?.name;
  return name !== undefined ? `${title}-${name}` : title;
}

/** 导出图片并触发浏览器下载（文件名 = 文件标题［＋画布名，多画布时］）。导出失败
 *  抛 Error，由调用方 toast 呈现；成功后调用方负责 export_done 埋点（本模块不碰
 *  网络埋点）。 */
export async function exportImage(
  doc: Y.Doc,
  title: string,
  opts: ImageExportOptions,
): Promise<void> {
  const canvasId = opts.canvasId;
  // FR-IO-005 防御：服务端配额与协同 WS 双闸已保证 ≤500，此处为最后一道客户端
  // 闸门——防御手工 doc-state / 未来新入口绕过配额时把超大文档拉爆 Canvas 尺寸上限。
  // 多画布（裁定 1 配额按画布）：计数口径 = 导出画布。
  if (countAliveReachable(doc, canvasId) > MAX_DOC_NODES) throw new Error('文件过大，请拆分后导出');

  // 仅导出快照不改画布：折叠是视图态，导出恒为完整层级——在克隆上展开
  // （多画布：克隆的展开/根解析/读绑定全部限定导出画布）。
  const expanded = cloneExpanded(doc, canvasId);
  try {
    const meta = getMeta(expanded, canvasId);
    const { svg, width, height } = exportSceneSvg(readerOf(expanded, canvasId), {
      structure: meta.structureType,
      themeId: meta.themeId,
      rootId: rootIdOf(expanded, canvasId),
    });
    const inlined = await inlineImages(svg);
    // JPG 恒不透明；PNG 取消透明勾选时同样铺白底（canvas 默认透明黑）
    const canvas = await rasterize(
      inlined,
      width * opts.scale,
      height * opts.scale,
      opts.format === 'jpg' || !opts.transparent,
    );
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, opts.format === 'png' ? 'image/png' : 'image/jpeg', 0.92),
    );
    if (!blob) throw new Error('导出失败：画面编码失败');
    downloadBlob(blob, `${imageExportFileName(doc, title, canvasId)}.${opts.format}`);
  } finally {
    expanded.destroy(); // 快照克隆用完即弃，不泄漏 Yjs 实例
  }
}

/**
 * 内联图片引用：把序列化 SVG 里 image[href^='/api/images/'] 换成 data URL。
 * 单张失败（网络抖动/资源缺失）保留原 href 并继续——SVG-as-image 下外链图片
 * 渲染为空白，但不阻断整图导出。
 */
async function inlineImages(svg: string): Promise<string> {
  if (!svg.includes('/api/images/')) return svg; // 快路径：无图片引用原样返回
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  for (const img of Array.from(parsed.querySelectorAll('image'))) {
    const href = img.getAttribute('href');
    if (!href || !href.startsWith('/api/images/')) continue;
    try {
      const res = await fetch(href); // 同源公开 GET（storage.controller 读取端点无鉴权）
      if (!res.ok) continue;
      const dataUrl = await blobToDataURL(await res.blob());
      img.setAttribute('href', dataUrl);
      // 兼容只认 xlink:href 的旧渲染器：双写（序列化时自动补 xlink 命名空间声明）
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', dataUrl);
    } catch {
      // 保留原 href 并继续
    }
  }
  return new XMLSerializer().serializeToString(parsed.documentElement);
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * SVG 字符串 → 目标尺寸 Canvas。opaque 时先铺白底再绘制。SVG 自带 width/height
 * 属性，Image 按其解码，drawImage 显式目标尺寸完成 xN 放大（1x 布局 × scale）。
 */
async function rasterize(
  svg: string,
  width: number,
  height: number,
  opaque: boolean,
): Promise<HTMLCanvasElement> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('导出失败：画面资源加载失败'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('导出失败：Canvas 不可用');
    if (opaque) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 触发浏览器下载（与 xmind-export.ts 的 exportXmind 同一模式：Object URL 在
 *  click 触发下载后于下一宏任务回收，不遗留 URL）。 */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
