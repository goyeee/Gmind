/**
 * 离屏渲染与 SVG 序列化（M4 Task 9，FR-IO-003）。
 *
 * 绑定裁决（M4 计划 Task 9）：
 * - renderScene 消费的是 SceneInput（layout/theme/styleOf/nodeData），不直接吃
 *   DocReader——本模块负责组装：layout() 算布局（与画布同参：同主题/同结构/同测量
 *   口径），再建 **detached** 容器（不挂 document）渲染进独立 svg，不触碰页面
 *   既有场景 DOM。
 * - 折叠是视图态：传入的 reader 应是「已展开克隆」（core cloneExpanded 产物），
 *   渲染层按 collapsed 裁剪树，克隆展开后 collapsedCounts 恒空、导出恒为完整层级。
 * - 序列化用 XMLSerializer（createElementNS 创建的元素自带 SVG 命名空间声明）；
 *   显式写 width/height 属性 = 布局包围盒（向上取整的整数 px）——web 侧 Canvas
 *   栅格化按整数取尺寸，3x 时 IHDR 宽高可被 3 整除（e2e 断言依据）。
 * - 布局坐标可为负（根盒中心 (0,0)）：viewBox 平移到包围盒原点，内容不被裁剪。
 */
import { layout } from './layout';
import {
  createScene,
  renderScene,
  SUMMARY_CHIP_PAD_X,
  SUMMARY_LABEL_BASELINE,
  type NodeVisual,
} from './render';
import { resolveNodeStyle, resolveThemeId, THEMES } from './themes';
import type { DocReader, MeasureAdapter, StructureType } from './types';
import { contentBounds } from './viewport';

export interface ExportSceneOptions {
  structure: StructureType;
  themeId: string;
}

/** Canvas measureText 测量（与 EditorPage 装配同口径；jsdom 无 2d 上下文时退化为
 *  每码点 1px 的确定性兜底，同 measure.ts 的 defaultAdapter 策略）。 */
function createExportMeasure(): MeasureAdapter {
  const ctx = document.createElement('canvas').getContext('2d');
  return {
    measureTextLine(text, style) {
      if (!ctx) return [...text].length;
      ctx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
      return ctx.measureText(text).width;
    },
  };
}

/** 离屏渲染并序列化完整 SVG 字符串（含 xmlns 与尺寸），供 web 侧内联图片后栅格化。 */
export function exportSceneSvg(
  reader: DocReader,
  opts: ExportSceneOptions,
): { svg: string; width: number; height: number } {
  const theme = THEMES[resolveThemeId(opts.themeId)];
  const measure = createExportMeasure();
  const result = layout(reader, {
    structure: opts.structure,
    theme,
    measure,
    // 样式闭合 doc 读取（carry-in 裁决 2：主题分级 + nodeStyle 覆盖）
    styleOf: (id, depth) =>
      resolveNodeStyle(theme, depth, reader.getNode(id)?.style ?? {}).textStyle,
  });

  // 渲染输入：深度表（renderScene 的 styleOf 只要 id）+ 节点视觉数据（文本/图标/
  // 角标/图片）。布局结果即存活渲染集，逐盒读取即可（无需再遍历 children）。
  const depthById = new Map<string, number>();
  const nodeData = new Map<string, NodeVisual>();
  for (const b of result.nodes) {
    depthById.set(b.id, b.depth);
    const snap = reader.getNode(b.id);
    if (snap) {
      nodeData.set(b.id, {
        text: snap.text,
        icons: snap.icons,
        note: snap.note,
        href: snap.href,
        image: snap.image ?? null,
        // 任务视觉（M7c-C2 只增不改）：无任务信息节点不产任何元素，导出产物不变。
        task: snap.task,
      });
    }
  }

  // detached 容器：不挂 document，导出后整体丢弃（无事件绑定、无视口/光标层）。
  const container = document.createElement('div');
  const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  container.appendChild(svgEl);
  renderScene(createScene(svgEl), {
    layout: result,
    theme,
    styleOf: (id) =>
      resolveNodeStyle(theme, depthById.get(id) ?? 0, reader.getNode(id)?.style ?? {}),
    nodeData,
  });

  // 导出边界：minX/minY 可为负，viewBox 平移到原点；宽高向上取整为正整数
  // （空文档退化为 1×1，不产生 0 尺寸 svg）。基准 = contentBounds（只按节点盒，
  // M6 T6 裁决「概要不扩画布边界」——画布 fit-to-view 口径不变）；但导出是
  // 静态整图截图，概要是画面内容，被裁即丢——按布局结果的 summaries 自行外扩
  // （镜像 renderScene 消费 layout.summaries 的口径，不重读 reader）。无概要时
  // 外扩恒零，产物逐字节不变。
  const bounds = contentBounds(result);
  let minX = bounds.minX;
  const minY = bounds.minY;
  let maxX = bounds.minX + bounds.width;
  let maxY = bounds.minY + bounds.height;
  for (const s of result.summaries) {
    // 括号本体绘制范围恒为 [s.x, s.x+s.w]（brace 形态锚定盒两种朝向同口径；
    // bracket 形态 = 旧横括线 x..x+w）。
    minX = Math.min(minX, s.x);
    maxX = Math.max(maxX, s.x + s.w);
    if (s.brace !== undefined) {
      // brace 形态（2026-10-01 反馈任务 1）：竖括号带 y..y+h 全高入包围盒；外置
      // chip（文本锚 labelX、实测宽 labelW）两端各加 chip 内边距（render 的
      // SUMMARY_CHIP_PAD_X 单源）——否则整图截图裁掉 chip 边框。chip 垂直居中于
      // 带（带高 ≥ 36 > chip 高 20），y 向被带覆盖，无需额外外扩。
      if (s.labelX !== undefined && s.labelW !== undefined) {
        const left =
          s.labelAnchor === 'end' ? s.labelX - s.labelW - SUMMARY_CHIP_PAD_X : s.labelX - SUMMARY_CHIP_PAD_X;
        minX = Math.min(minX, s.x + left);
        maxX = Math.max(maxX, s.x + left + s.labelW + SUMMARY_CHIP_PAD_X * 2);
      }
      maxY = Math.max(maxY, s.y + (s.h ?? 0));
      continue;
    }
    // bracket 形态（跨侧 / org）：标签外置锚点横向纳入（labelX/labelAnchor，
    // 宽为布局实测 labelW）。anchor=end 文本自锚点向左延伸、middle 居中（防御
    // 分支，布局不产）。
    if (s.labelX !== undefined && s.labelW !== undefined) {
      const left =
        s.labelAnchor === 'end'
          ? s.labelX - s.labelW
          : s.labelAnchor === 'middle'
            ? s.labelX - s.labelW / 2
            : s.labelX;
      minX = Math.min(minX, s.x + left);
      maxX = Math.max(maxX, s.x + left + s.labelW);
    }
    // 视觉下缘 = bracket 横线 y + label 基线（render 的 SUMMARY_LABEL_BASELINE）；
    // 端子上挑（-6）恒在成员盒内（y=片段底+12 ≥ 片段底），无需上扩。
    maxY = Math.max(maxY, s.y + SUMMARY_LABEL_BASELINE);
  }
  const width = Math.max(1, Math.ceil(maxX - minX));
  const height = Math.max(1, Math.ceil(maxY - minY));
  svgEl.setAttribute('width', String(width));
  svgEl.setAttribute('height', String(height));
  svgEl.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);

  const svg = new XMLSerializer().serializeToString(svgEl);
  return { svg, width, height };
}
