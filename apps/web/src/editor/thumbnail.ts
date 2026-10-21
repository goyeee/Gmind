import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { getMeta, getNode, childrenIds, listSummaries } from '@gmind/core';
import {
  layout,
  resolveNodeStyle,
  resolveThemeId,
  THEMES,
  type DocReader,
  type MeasureAdapter,
} from '@gmind/engine';

/**
 * 工作台真实内容缩略图（2026-10-21 需求方裁定：推翻 10-20「装饰性静态图」，改真实快照）：
 * 引擎 layout 直出 SVG 字符串（内联全部样式属性，零 CSS 依赖——列表卡片 <img> 场景
 * 不携带编辑器样式表）。编辑器在 persisted ack 后节流上传（POST /files/:id/thumbnail），
 * 服务端存 files.thumb_svg；卡片懒加载 GET，无快照回退装饰性 Thumb。
 *
 * 简化口径（缩略图不追求像素级复刻）：只画节点盒（填充/边框/圆角）+ 单行标题文本 +
 * 连线（bezier/elbow）；图片/图标/任务行/概要/折叠徽标一律不画。
 * 超限保护：节点 >500 或 SVG 字符串 >200KB 返回 null（调用方放弃本次上传）。
 */

const MAX_NODES = 500;
const MAX_SVG_BYTES = 200_000;
const PAD = 16;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildThumbSvg(doc: Y.Doc, measure: MeasureAdapter): string | null {
  const meta = getMeta(doc);
  const theme = THEMES[resolveThemeId(meta.themeId)];
  const reader: DocReader = {
    getMeta: () => getMeta(doc),
    getNode: (id) => getNode(doc, id),
    childrenIds: (id) => childrenIds(doc, id),
    summaries: () => listSummaries(doc),
  };
  const result = layout(reader, {
    structure: meta.structureType,
    theme,
    measure,
    styleOf: (id, depth) => resolveNodeStyle(theme, depth, getNode(doc, id)?.style ?? {}).textStyle,
  });
  const nodes = result.nodes;
  if (nodes.length === 0 || nodes.length > MAX_NODES) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of nodes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const w = maxX - minX + PAD * 2;
  const h = maxY - minY + PAD * 2;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX - PAD} ${minY - PAD} ${w} ${h}">`,
    `<rect x="${minX - PAD}" y="${minY - PAD}" width="${w}" height="${h}" fill="${theme.canvasBackground}"/>`,
  ];

  for (const e of result.edges) {
    const d =
      e.kind === 'bezier' && e.controls && e.controls.length === 2
        ? `M ${e.from.x} ${e.from.y} C ${e.controls[0]!.x} ${e.controls[0]!.y}, ${e.controls[1]!.x} ${e.controls[1]!.y}, ${e.to.x} ${e.to.y}`
        : // elbow：中点折线近似（缩略图口径，不追求渲染级 elbow 几何）
          `M ${e.from.x} ${e.from.y} L ${(e.from.x + e.to.x) / 2} ${e.from.y} L ${(e.from.x + e.to.x) / 2} ${e.to.y} L ${e.to.x} ${e.to.y}`;
    parts.push(`<path d="${d}" fill="none" stroke="${theme.edgeColor}" stroke-width="${theme.edgeWidth}"/>`);
  }

  for (const b of nodes) {
    const snap = getNode(doc, b.id);
    if (!snap || snap.deleted) continue;
    const rs = resolveNodeStyle(theme, b.depth, snap.style ?? {});
    parts.push(
      `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${theme.nodeBorderRadius}" fill="${rs.fill}" stroke="${rs.border}" stroke-width="${theme.nodeBorderWidth}"/>`,
    );
    const text = snap.text.trim();
    if (text !== '') {
      parts.push(
        `<text x="${b.x + b.w / 2}" y="${b.y + b.h / 2 + rs.fontSize * 0.35}" text-anchor="middle" font-size="${rs.fontSize}" font-family="${esc(rs.fontFamily)}" fill="${rs.textColor}">${esc(text)}</text>`,
      );
    }
  }

  parts.push('</svg>');
  const svg = parts.join('');
  return svg.length > MAX_SVG_BYTES ? null : svg;
}

/** 缩略图会话级缓存（objectURL | null=无快照）：文件卡片懒加载共用；编辑器上传
 *  成功后 invalidateThumb 让回工作台时拿到新图。objectURL 不主动 revoke（会话级缓存，
 *  量级=打开过的文件数，可接受）。 */
const thumbCache = new Map<string, string | null>();

export function invalidateThumb(fileId: string): void {
  thumbCache.delete(fileId);
}

/** 卡片真实缩略图懒加载：GET /api/files/:id/thumbnail（Bearer 走 fetch，<img> 带不了
 *  头）→ blob objectURL；404/异常 → null（调用方回退装饰性 Thumb）。 */
export function useRealThumb(fileId: string): string | null {
  const [url, setUrl] = useState<string | null>(thumbCache.get(fileId) ?? null);
  useEffect(() => {
    const cached = thumbCache.get(fileId);
    if (cached !== undefined) {
      setUrl(cached);
      return;
    }
    let alive = true;
    const token = localStorage.getItem('gmind.token');
    void fetch(`/api/files/${fileId}/thumbnail`, {
      headers: { Authorization: `Bearer ${token ?? ''}` },
    })
      .then(async (r) => {
        if (!r.ok) {
          thumbCache.set(fileId, null);
          return;
        }
        const obj = URL.createObjectURL(await r.blob());
        thumbCache.set(fileId, obj);
        if (alive) setUrl(obj);
      })
      .catch(() => {
        thumbCache.set(fileId, null); // 网络失败按无快照处理（下次挂载重试——缓存 null 防热循环）
      });
    return () => {
      alive = false;
    };
  }, [fileId]);
  return url;
}
