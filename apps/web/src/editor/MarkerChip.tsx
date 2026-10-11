import type { ReactElement } from 'react';
import { drawMarkerBadge, type MarkerGlyphDef } from '@gmind/engine';

/**
 * chip 几何（M7b-R1 重做，2026-10-10 随 MarkerPanel 退役自其提取）：直接复用
 * engine drawMarkerBadge 的 SVG 徽章——任务面板/表格与画布字形**单一来源**
 * （此前手写 CSS chip 缺 mood/star/bulb 等自定义 kind 的分支，回落显示英文
 * slug；且 flex 压缩把圆徽压瘪）。SVG 按 size 缩放。2026-10-01 需求方反馈任务 1
 * 起表格标题格（TaskTable NodeMarkers）同用本组件（size=14）。
 *
 * 可选定位属性（2026-10-01 需求方反馈任务 1：表格标题格标记单源化复用本组件）：
 *  title=HTML 悬停提示（徽章 SVG <title> 已原生同文案，此处在 DOM 侧补锚点）；
 *  markerGroup/markerValue → data-marker-group/value（与画布 g.gm-marker-badge
 *  同名属性，表格/画布/e2e 同口径定位）。
 */
export function MarkerChip({
  def,
  size = 18,
  title,
  markerGroup,
  markerValue,
}: {
  def: MarkerGlyphDef;
  size?: number;
  title?: string;
  markerGroup?: string;
  markerValue?: string;
}): ReactElement {
  return (
    <span
      className="marker-chip-svg"
      style={{ width: size, height: size, display: 'inline-block', flex: 'none' }}
      aria-hidden
      title={title}
      data-marker-group={markerGroup}
      data-marker-value={markerValue}
      ref={(el) => {
        if (!el || el.firstElementChild) return;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 14 14');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        const badge = drawMarkerBadge(def);
        if (badge) {
          badge.removeAttribute('class');
          svg.appendChild(badge);
        }
        el.appendChild(svg);
      }}
    />
  );
}
