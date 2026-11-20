import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { getMeta, getNode, childrenIds, listCanvases, listSummaries } from '@gmind/core';
import { taskProgressOf, type DeriveNode } from '@gmind/shared';
import {
  layout,
  resolveNodeStyle,
  resolveThemeId,
  THEMES,
  type DocReader,
  type LayoutResult,
  type MeasureAdapter,
} from '@gmind/engine';

/**
 * 工作台真实内容缩略图（2026-10-21 需求方裁定：推翻 10-20「装饰性静态图」，改真实快照；
 * 2026-11-19 二次裁定「可读优先 + 宽度占缩略图宽度 80%」四问确认，推翻整图包围盒口径）：
 * 引擎 layout 直出 SVG 字符串（内联全部样式属性，零 CSS 依赖——列表卡片 <img> 场景
 * 不携带编辑器样式表）。编辑器在 persisted ack 后节流上传（POST /files/:id/thumbnail），
 * 服务端存 files.thumb_svg；卡片懒加载 GET，无快照回退装饰性 Thumb。
 *
 * 取景窗口：viewBox 固定 176×64（纵横比 2.75:1 = 最小卡 220px × 80% 显示宽 ÷ 64px
 * 显示高），内容经 camera（scale+平移）画进窗口——
 * - 内容塞得下 → 放大到窗口宽 96% 居中（小文件不再窄条；高度超限按高收）；
 * - 塞不下 → 钳可读下限 MIN_SCALE，窗口锚定 root 盒中心（root 直接子级全右锚左
 *   1/4、全左镜像右 1/4、两侧居中——与编辑器「定位中心」单侧偏移同语义），窗口外
 *   节点跳绘。旧格式快照（整图包围盒）显示侧 contain 加 Letterbox 不回退。
 *
 * 简化口径（缩略图不追求像素级复刻）：只画节点盒（填充/边框/圆角）+ 单行标题文本 +
 * 连线（bezier/elbow）；图片/图标/任务行/概要/折叠徽标一律不画。
 * 超限保护：节点 >500 或 SVG 字符串 >200KB 返回 null（调用方放弃本次上传）。
 */

const MAX_NODES = 500;
const MAX_SVG_BYTES = 200_000;
/** 取景窗口（2.75:1）：显示侧 .file-thumb-img width:80% height:64px contain 正好填满。 */
const WIN_W = 176;
const WIN_H = 64;
/** 完整显示时内容宽度目标 = 窗口宽的 96%（余 4% 呼吸边）。 */
const CONTENT_W_RATIO = 0.96;
/** 可读下限：root 文字 20px → 8 窗口单位（显示≈css px）；低于此宁可裁剪不缩成点。 */
const MIN_SCALE = 0.4;
/** 表格缩略图（2026-10-25 原型 TableThumb）：数据行上限（2026-11-19 画布归一 2.75
 *  纵横比后 4 行恰好铺满固定高）。 */
const TABLE_THUMB_ROWS = 4;
/** 表格画布（2026-11-19）：390×142 = 2.75:1（与脑图窗口同纵横比）。 */
const TABLE_W = 390;
const TABLE_H = 142;
const TABLE_PAD = 14;
const TABLE_HEAD_H = 26;
const TABLE_ROW_H = 22;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 数字保留 2 位小数（camera 缩放后坐标含小数，截短省 SVG 字节）。 */
const n2 = (v: number): number => Math.round(v * 100) / 100;

interface Camera {
  s: number;
  camX: number;
  camY: number;
}

/** camera 求解：窗口坐标 = (doc − cam) × s。完整档（target ≥ 可读下限）内容居中；
 *  裁剪档钳 MIN_SCALE 并把窗口锚定 root 盒中心——root 直接子级全右锚窗口左 1/4、
 *  全左镜像右 1/4、两侧/无子级居中（NodeBox.side 直读布局结果，与「定位中心」
 *  单侧偏移同口径；org 的 side='down' 天然走居中）。 */
function solveCamera(
  result: LayoutResult,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  rootBox: LayoutResult['nodes'][number] | undefined,
): Camera {
  const contentW = Math.max(bbox.maxX - bbox.minX, 1);
  const contentH = Math.max(bbox.maxY - bbox.minY, 1);
  const target = Math.min((CONTENT_W_RATIO * WIN_W) / contentW, WIN_H / contentH);
  if (target >= MIN_SCALE) {
    return {
      s: target,
      camX: (bbox.minX + bbox.maxX) / 2 - WIN_W / (2 * target),
      camY: (bbox.minY + bbox.maxY) / 2 - WIN_H / (2 * target),
    };
  }
  const kids = result.nodes.filter((b) => b.depth === 1);
  const allRight = kids.length > 0 && kids.every((b) => b.side === 'right');
  const allLeft = kids.length > 0 && kids.every((b) => b.side === 'left');
  const anchorFx = allRight ? 0.25 : allLeft ? 0.75 : 0.5;
  const cx = rootBox !== undefined ? rootBox.x + rootBox.w / 2 : (bbox.minX + bbox.maxX) / 2;
  const cy = rootBox !== undefined ? rootBox.y + rootBox.h / 2 : (bbox.minY + bbox.maxY) / 2;
  return {
    s: MIN_SCALE,
    camX: cx - (anchorFx * WIN_W) / MIN_SCALE,
    camY: cy - (0.5 * WIN_H) / MIN_SCALE,
  };
}

export function buildThumbSvg(doc: Y.Doc, measure: MeasureAdapter): string | null {
  // 多画布（裁定 3，计划三 Task 4 item 9）：缩略图恒取**第一画布**（canvasOrder 首个
  // 存活）——与当前活动画布无关（工作台卡片一张图代表整个文件）；全部读路径与
  // 布局根按该画布绑定。画布集全灭（crafted 态）：无可画内容，按超限口径返回 null。
  const first = listCanvases(doc)[0];
  if (!first) return null;
  const canvasId = first.id;
  const meta = getMeta(doc, canvasId);
  const theme = THEMES[resolveThemeId(meta.themeId)];
  const reader: DocReader = {
    getMeta: () => getMeta(doc, canvasId),
    getNode: (id) => getNode(doc, id, canvasId),
    childrenIds: (id) => childrenIds(doc, id, canvasId),
    summaries: () => listSummaries(doc, canvasId),
  };
  const result = layout(reader, {
    structure: meta.structureType,
    theme,
    measure,
    rootId: first.rootId,
    styleOf: (id, depth) =>
      resolveNodeStyle(theme, depth, getNode(doc, id, canvasId)?.style ?? {}).textStyle,
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
  const { s, camX, camY } = solveCamera(
    result,
    { minX, minY, maxX, maxY },
    nodes.find((b) => b.id === first.rootId),
  );
  const X = (x: number): number => n2((x - camX) * s);
  const Y = (y: number): number => n2((y - camY) * s);
  const edgeW = Math.max(n2(theme.edgeWidth * s), 0.5);
  const nodeW = Math.max(n2(theme.nodeBorderWidth * s), 0.5);
  const rx = Math.max(n2(theme.nodeBorderRadius * s), 1);

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIN_W} ${WIN_H}">`,
    `<rect width="${WIN_W}" height="${WIN_H}" fill="${theme.canvasBackground}"/>`,
  ];

  for (const e of result.edges) {
    const d =
      e.kind === 'bezier' && e.controls && e.controls.length === 2
        ? `M ${X(e.from.x)} ${Y(e.from.y)} C ${X(e.controls[0]!.x)} ${Y(e.controls[0]!.y)}, ${X(e.controls[1]!.x)} ${Y(e.controls[1]!.y)}, ${X(e.to.x)} ${Y(e.to.y)}`
        : // elbow：中点折线近似（缩略图口径，不追求渲染级 elbow 几何）
          `M ${X(e.from.x)} ${Y(e.from.y)} L ${X((e.from.x + e.to.x) / 2)} ${Y(e.from.y)} L ${X((e.from.x + e.to.x) / 2)} ${Y(e.to.y)} L ${X(e.to.x)} ${Y(e.to.y)}`;
    parts.push(`<path d="${d}" fill="none" stroke="${theme.edgeColor}" stroke-width="${edgeW}"/>`);
  }

  for (const b of nodes) {
    const x = X(b.x);
    const y = Y(b.y);
    const w = n2(b.w * s);
    const h = n2(b.h * s);
    // 取景窗口外跳绘（裁剪档省字节；<img> 场景 SVG 溢出本就裁切，双保险）
    if (x > WIN_W || y > WIN_H || x + w < 0 || y + h < 0) continue;
    const snap = getNode(doc, b.id, canvasId);
    if (!snap || snap.deleted) continue;
    const rs = resolveNodeStyle(theme, b.depth, snap.style ?? {});
    parts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${rs.fill}" stroke="${rs.border}" stroke-width="${nodeW}"/>`,
    );
    const text = snap.text.trim();
    if (text !== '') {
      parts.push(
        `<text x="${X(b.x + b.w / 2)}" y="${Y(b.y + b.h / 2 + rs.fontSize * 0.35)}" text-anchor="middle" font-size="${n2(rs.fontSize * s)}" font-family="${esc(rs.fontFamily)}" fill="${rs.textColor}">${esc(text)}</text>`,
      );
    }
  }

  parts.push('</svg>');
  const svg = parts.join('');
  return svg.length > MAX_SVG_BYTES ? null : svg;
}

/** 表格文件缩略图（2026-10-25 原型 TableThumb 现实化）：按表格形态直出 SVG——
 *  表头（序号/主题/进度/状态）+ 最多 4 行数据（深度缩进圆点+标题截 10 字 +
 *  进度条 + 状态色胶囊），进度取 shared effectiveProgress 同口径（父级 Σ 汇总
 *  一致）。行遍历跳过 collapsed 子树、root 不进表（与 TaskTable 行集同源语义）。
 *  空表（root 无子级）/超限返回 null（回退装饰图）。
 *  画布固定 390×142（2026-11-19 与脑图窗口同 2.75 纵横比，显示框正好填满）。 */
export function buildTableThumbSvg(doc: Y.Doc): string | null {
  const first = listCanvases(doc)[0];
  if (!first) return null;
  const canvasId = first.id;

  // 全量存活节点 → DeriveNode（progress 求值输入；title/order 平铺进表）
  const derive: DeriveNode[] = [];
  const collect = (id: string, parentId: string | null): void => {
    const snap = getNode(doc, id, canvasId);
    if (!snap || snap.deleted) return;
    derive.push({
      id,
      parentId,
      title: snap.text,
      collapsed: snap.collapsed,
      taskActive: snap.taskActive,
      task: snap.task
        ? { ...snap.task, progress: snap.task.progress ?? 0 }
        : undefined,
    });
    for (const cid of childrenIds(doc, id, canvasId)) collect(cid, id);
  };
  collect(first.rootId, null);
  if (derive.length > MAX_NODES) return null;

  // 表行序（DFS 跳过 collapsed 子树；root 不进表）
  const rows: Array<{ title: string; depth: number; progress: number }> = [];
  const walk = (id: string, depth: number): void => {
    for (const cid of childrenIds(doc, id, canvasId)) {
      const snap = getNode(doc, cid, canvasId);
      if (!snap || snap.deleted) continue;
      rows.push({ title: snap.text, depth, progress: taskProgressOf(derive, cid) });
      if (rows.length >= TABLE_THUMB_ROWS) return;
      if (!snap.collapsed) walk(cid, depth + 1);
      if (rows.length >= TABLE_THUMB_ROWS) return;
    }
  };
  walk(first.rootId, 0);
  if (rows.length === 0) return null;

  // 画布固定 390×142（2.75:1）：表头 26 + 行 22×4 + pad×2 = 142 恰好铺满
  const W = TABLE_W;
  const H = TABLE_H;
  const HEAD_H = TABLE_HEAD_H;
  const ROW_H = TABLE_ROW_H;
  const COL_TITLE = 46; // 序号列右缘
  const COL_PROG = W - TABLE_PAD - 108; // 进度条 x
  const COL_STATUS = W - TABLE_PAD - 52; // 状态胶囊 x
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    // 表头（灰底 + 三列标签）
    `<rect x="${TABLE_PAD}" y="${TABLE_PAD}" width="${W - TABLE_PAD * 2}" height="${HEAD_H}" rx="4" fill="#f2f3f5"/>`,
    `<text x="${TABLE_PAD + 10}" y="${TABLE_PAD + 17}" font-size="11" fill="#4e5969">序号</text>`,
    `<text x="${COL_TITLE + 8}" y="${TABLE_PAD + 17}" font-size="11" fill="#4e5969">主题</text>`,
    `<text x="${COL_PROG}" y="${TABLE_PAD + 17}" font-size="11" fill="#4e5969">进度</text>`,
    `<text x="${COL_STATUS}" y="${TABLE_PAD + 17}" font-size="11" fill="#4e5969">状态</text>`,
  ];
  rows.forEach((r, i) => {
    const y = TABLE_PAD + HEAD_H + i * ROW_H;
    const title = r.title.length > 10 ? r.title.slice(0, 10) + '…' : r.title;
    // 深度缩进圆点 + 标题（父级行加粗近似：字重属性）
    const indent = COL_TITLE + 8 + r.depth * 12;
    parts.push(`<circle cx="${indent + 3}" cy="${y + 11}" r="3" fill="#3370ff"/>`);
    parts.push(
      `<text x="${indent + 10}" y="${y + 15}" font-size="11" fill="#1f2329" font-weight="${r.depth === 0 ? '600' : '400'}">${esc(title || '（未命名）')}</text>`,
    );
    // 序号
    parts.push(`<text x="${TABLE_PAD + 10}" y="${y + 15}" font-size="11" fill="#86909c">${i + 1}</text>`);
    // 进度条（底槽 + 填充；0 不填充，100 绿、其余蓝）+ 百分比小字
    parts.push(`<rect x="${COL_PROG}" y="${y + 7}" width="44" height="8" rx="4" fill="#f2f3f5"/>`);
    if (r.progress > 0) {
      const fillW = Math.max(4, Math.round((44 * Math.min(100, r.progress)) / 100));
      parts.push(
        `<rect x="${COL_PROG}" y="${y + 7}" width="${fillW}" height="8" rx="4" fill="${r.progress >= 100 ? '#00b42a' : '#3370ff'}"/>`,
      );
    }
    parts.push(
      `<text x="${COL_PROG + 50}" y="${y + 15}" font-size="10" fill="#86909c">${Math.min(100, Math.round(r.progress))}%</text>`,
    );
    // 状态胶囊（色底 + 白字 9px：已完成/进行中/待开始）
    const [label, color] =
      r.progress >= 100 ? ['已完成', '#00b42a'] : r.progress > 0 ? ['进行中', '#3370ff'] : ['待开始', '#86909c'];
    parts.push(`<rect x="${COL_STATUS}" y="${y + 5}" width="46" height="14" rx="7" fill="${color}"/>`);
    parts.push(
      `<text x="${COL_STATUS + 23}" y="${y + 15.5}" font-size="9" fill="#ffffff" text-anchor="middle">${label}</text>`,
    );
  });
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
