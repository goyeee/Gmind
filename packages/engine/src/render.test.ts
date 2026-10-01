import { beforeEach, describe, expect, it } from 'vitest';
import { createScene, renderScene } from './render';
import { MARKER_CATALOG } from './markers';
import type { NodeVisual, SceneInput } from './render';
import { resolveNodeStyle, THEMES } from './themes';
import { colorForUser } from './cursors';
import type { EdgeRoute, LayoutResult, NodeBox, ResolvedNodeStyle, ThemeTokens } from './types';

// ---------------------------------------------------------------------------
// 固定桩：手工构造 LayoutResult（渲染器只吃布局数据，不依赖 layout()）。
// ---------------------------------------------------------------------------

const theme: ThemeTokens = THEMES['gmind-blue'];
const styleOf = (id: string): ResolvedNodeStyle => resolveNodeStyle(theme, id === 'a' ? 0 : 2, {});

function box(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  side: NodeBox['side'] = 'right',
  depth = 2,
): NodeBox {
  return { id, x, y, w, h, side, depth };
}

function edge(id: string, kind: EdgeRoute['kind']): EdgeRoute {
  const [from, to] = [
    { x: 0, y: 0 },
    { x: 60, y: 10 },
  ];
  return kind === 'bezier'
    ? { id, from, to, kind, controls: [{ x: 40, y: 0 }, { x: 20, y: 10 }] }
    : { id, from, to, kind };
}

/** 三节点（a 根 + b/c 子）两 bezier 边的基线布局。 */
function baseLayout(collapsed?: Record<string, number>): LayoutResult {
  return {
    nodes: [box('a', -60, -10, 120, 20, 'right', 0), box('b', 60, -20, 100, 40), box('c', 60, 20, 80, 20)],
    edges: [edge('a->b', 'bezier'), edge('a->c', 'bezier')],
    collapsedCounts: new Map(Object.entries(collapsed ?? {}).map(([k, v]) => [k, v])),
    summaries: [],
    width: 220,
    height: 60,
  };
}

function baseData(): Map<string, NodeVisual> {
  return new Map([
    ['a', { text: '中心' }],
    ['b', { text: '第一行\n第二行' }],
    ['c', { text: 'C' }],
    ['d', { text: 'D' }],
  ]);
}

function makeInput(layout: LayoutResult, nodeData: Map<string, NodeVisual>): SceneInput {
  return { layout, theme, styleOf, nodeData };
}

let svg: SVGSVGElement;

beforeEach(() => {
  document.body.innerHTML = '';
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.appendChild(svg);
});

function nodeG(id: string): SVGGElement | null {
  return svg.querySelector(`[data-node-id="${id}"]`);
}

function edgePath(id: string): SVGPathElement | null {
  return svg.querySelector(`[data-edge-id="${id}"]`);
}

describe('createScene', () => {
  it('创建边/概要/节点三层（边在下、节点在上），并清空旧内容', () => {
    const junk = document.createElement('div');
    svg.appendChild(junk);
    const scene = createScene(svg);
    const layers = svg.querySelectorAll('g');
    expect(layers).toHaveLength(3);
    expect(layers[0]?.getAttribute('class')).toBe('gm-edges');
    expect(layers[1]?.getAttribute('class')).toBe('gm-summaries');
    expect(layers[2]?.getAttribute('class')).toBe('gm-nodes');
    expect(svg.contains(junk)).toBe(false);
    expect(scene.nodesLayer).toBe(layers[2]);
    expect(scene.edgesLayer).toBe(layers[0]);
    expect(scene.summariesLayer).toBe(layers[1]);
  });
});

describe('renderScene：初次渲染', () => {
  it('节点/边数量正确，节点 g 带 data-node-id 且 transform 即盒子位置', () => {
    renderScene(createScene(svg), makeInput(baseLayout(), baseData()));
    expect(svg.querySelectorAll('[data-node-id]')).toHaveLength(3);
    expect(svg.querySelectorAll('[data-edge-id]')).toHaveLength(2);
    const g = nodeG('b');
    expect(g).not.toBeNull();
    expect(g?.getAttribute('transform')).toBe('translate(60, -20)');
    expect(g?.parentNode).toBe(svg.querySelector('.gm-nodes'));
  });

  it('rect 样式来自 styleOf（root 填充/边框）与主题（圆角/边宽）', () => {
    renderScene(createScene(svg), makeInput(baseLayout(), baseData()));
    const rootRect = nodeG('a')?.querySelector('rect');
    expect(rootRect?.getAttribute('fill')).toBe('#3370ff');
    expect(rootRect?.getAttribute('stroke')).toBe('#2b5fd9');
    expect(rootRect?.getAttribute('rx')).toBe('8');
    expect(rootRect?.getAttribute('stroke-width')).toBe('1');
    expect(rootRect?.getAttribute('width')).toBe('120');
    const leafRect = nodeG('b')?.querySelector('rect');
    expect(leafRect?.getAttribute('fill')).toBe('#ffffff');
  });

  it('text 按 \\n 分行成多个 tspan，fill/字体取解析样式', () => {
    renderScene(createScene(svg), makeInput(baseLayout(), baseData()));
    const text = nodeG('b')?.querySelector('text.gm-text');
    expect(text?.getAttribute('fill')).toBe('#3d4757');
    expect(text?.getAttribute('font-size')).toBe('14');
    const tspans = text?.querySelectorAll('tspan');
    expect(tspans).toHaveLength(2);
    expect(tspans?.[0]?.textContent).toBe('第一行');
    expect(tspans?.[1]?.textContent).toBe('第二行');
  });

  it('标记八组制（M7b-W1）：gm-markers 徽标按固定组序展开各组值数组，未知组/未知值忽略', () => {
    expect(MARKER_CATALOG.other.some((d) => d.value === 'done')).toBe(true);
    const data = baseData();
    // multi 组（other/emoji）多枚叠加、single 组（priority）单枚；旧五组字符串键与未知组忽略
    data.set('b', { text: 'x', icons: { priority: ['p0'], other: ['done', 'cancel'], emoji: ['😄'], progress: '50', flag: '红', star: '蓝', mystery: 'zzz' } });
    data.set('c', { text: 'y', icons: { other: ['nope'] } });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const badges = svg.querySelectorAll('.gm-markers .gm-marker-badge');
    expect(badges.length).toBe(4); // p0 + done + cancel + 😄（组序 mood→priority→…→other→emoji）
    expect(badges[0].getAttribute('data-marker-group')).toBe('priority'); // 点击换组命中锚点（M7b-W3）
    expect(badges[0].getAttribute('data-marker-value')).toBe('p0');
    expect(badges[1].getAttribute('data-marker-group')).toBe('other');
    expect(badges[1].getAttribute('data-marker-value')).toBe('done');
    expect(badges[3].getAttribute('data-marker-group')).toBe('emoji');
    expect(nodeG('c')?.querySelectorAll('.gm-markers .gm-marker-badge').length).toBe(0); // 未知值不产徽标（容器空）
  });

  it('优先级组渲染彩色圆徽（circleText：P0-P4/急高中低），值不在目录不渲染', () => {
    const data = baseData();
    data.set('b', { text: 'x', icons: { priority: ['p0'] } });
    data.set('c', { text: 'y', icons: { priority: ['p9'] } }); // 越界值（未收敛窗口期）：防御忽略
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const badge = nodeG('b')?.querySelector('.gm-marker-badge');
    expect(badge).not.toBeNull();
    const r = badge?.querySelector('circle');
    expect(r?.getAttribute('fill')).toBe('#e34d4d'); // P0 红（企微转录）
    expect(Number(r?.getAttribute('r'))).toBe(7); // 14×14 内半径 7
    expect(badge?.querySelector('text')?.textContent).toBe('P0');
    expect(nodeG('c')?.querySelectorAll('.gm-marker-badge').length).toBe(0);
  });

  it('进度组「未开始」（2026-10-01 需求方反馈任务 3）：none 画 0% 空心环徽章（无扇形路径）', () => {
    const data = baseData();
    data.set('b', { text: 'x', icons: { progress: ['none'] } });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const badge = nodeG('b')?.querySelector('.gm-marker-badge');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-marker-value')).toBe('none');
    // 空心环：stroke 圆（fill=none）+ 无扇形 path（fraction=0 不落零面积退化路径）
    const ring = badge?.querySelector('circle');
    expect(ring?.getAttribute('fill')).toBe('none');
    expect(ring?.getAttribute('stroke')).toBe('#47a26b');
    expect(badge?.querySelector('path')).toBeNull();
  });

  it('徽章悬停标题（2026-10-01 需求方反馈任务 4）：徽章首个子元素是 <title>（MARKER_CATALOG 中文 label）', () => {
    const data = baseData();
    data.set('b', { text: 'x', icons: { priority: ['p0'], progress: ['none'] } });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const badges = nodeG('b')?.querySelectorAll('.gm-marker-badge');
    expect(badges?.length).toBe(2);
    expect(badges?.[0]?.querySelector('title')?.textContent).toBe('优先级 P0');
    expect(badges?.[1]?.querySelector('title')?.textContent).toBe('进度 未开始');
  });

  it('multi 组叠加与组序：priority/other/emoji 三组徽标按固定组序展开，槽位逐枚递增', () => {
    const data = baseData();
    data.set('b', { text: 'x', icons: { priority: ['p3'], other: ['done', 'clock'], emoji: ['😄'] } });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const g = nodeG('b')!;
    const badges = g.querySelectorAll('.gm-marker-badge');
    expect(badges.length).toBe(4);
    const xs = [...badges].map((b) => b.getAttribute('transform'));
    expect(xs[0]).toContain(String(12 + 3)); // 第 1 槽 nodePaddingX + 居中偏移
    expect(xs[1]).toContain(String(12 + 20 + 3)); // 第 2 槽
    expect(xs[3]).toContain(String(12 + 3 * 20 + 3)); // 第 4 槽
    expect(g.querySelector('.gm-text')?.getAttribute('x')).toBe(String(12 + 4 * 20)); // 文字起点按 4 槽
  });

  it('徽标协调更新：换值重建徽标行（内容正确），组清空移除整行', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('b', { text: 'x', icons: { priority: ['p1'] } });
    renderScene(scene, makeInput(baseLayout(), data));
    const badge = nodeG('b')?.querySelector('.gm-marker-badge');
    expect(badge?.querySelector('circle')?.getAttribute('fill')).toBe('#ef8e3e'); // P1 橙（企微转录）
    expect(badge?.querySelector('text')?.textContent).toBe('P1');
    const data2 = baseData();
    data2.set('b', { text: 'x', icons: { priority: ['p4'] } });
    renderScene(scene, makeInput(baseLayout(), data2));
    const badge2 = nodeG('b')?.querySelector('.gm-marker-badge');
    // 签名变化 → 整行重建（徽标为无状态绘制），断言内容正确而非引用恒定
    expect(badge2).not.toBeNull();
    expect(badge2?.querySelector('text')?.textContent).toBe('P4');
    const data3 = baseData();
    data3.set('b', { text: 'x' });
    renderScene(scene, makeInput(baseLayout(), data3));
    expect(nodeG('b')?.querySelector('.gm-markers')).toBeNull();
    expect(badge!.isConnected).toBe(false);
  });

  it('multi 组 toggle 追加/移除即时反映（协调更新按签名重建整行）', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('b', { text: 'x', icons: { other: ['done'] } });
    renderScene(scene, makeInput(baseLayout(), data));
    expect(nodeG('b')?.querySelectorAll('.gm-marker-badge').length).toBe(1);
    const data2 = baseData();
    data2.set('b', { text: 'x', icons: { other: ['done', 'important'] } });
    renderScene(scene, makeInput(baseLayout(), data2));
    expect(nodeG('b')?.querySelectorAll('.gm-marker-badge').length).toBe(2);
    const data3 = baseData();
    data3.set('b', { text: 'x' });
    renderScene(scene, makeInput(baseLayout(), data3));
    expect(nodeG('b')?.querySelector('.gm-markers')).toBeNull();
  });

  it('note 角标（非空才渲染 N，含 <title> 悬停预览子元素）、link 角标（非空才渲染）', () => {
    const data = baseData();
    data.set('b', { text: 'x', note: '有笔记', href: 'https://example.com' });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    // 角标直接文本 = 'N'（<title> 是 SVG 标准 tooltip 子元素，FR-EDT-018 悬停预览）
    const noteBadge = svg.querySelector('.gm-note-badge');
    expect(noteBadge?.childNodes[0]?.textContent).toBe('N');
    expect(noteBadge?.querySelector('title')?.textContent).toBe('有笔记');
    expect(svg.querySelector('.gm-link-badge')?.textContent).not.toBe('');
    expect(nodeG('a')?.querySelector('.gm-note-badge')).toBeNull();
    expect(nodeG('a')?.querySelector('.gm-link-badge')).toBeNull();
  });

  it('note 角标 <title> 预览截断前 200 字，且随 note 更新回填', () => {
    const long = '字'.repeat(260);
    const data = baseData();
    data.set('b', { text: 'x', note: long });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const titleOf = (): string | null | undefined =>
      svg.querySelector('.gm-note-badge')?.querySelector('title')?.textContent;
    expect(titleOf()).toHaveLength(200);
    data.set('b', { text: 'x', note: '更新后' });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    expect(titleOf()).toBe('更新后'); // textContent 重建后 title 子元素随之回填
  });

  it('image 节点渲染 <image>，href 拼接 /api/images/{key}，宽高直用 image.w/h', () => {
    const data = baseData();
    data.set('b', { text: 'x', image: { key: 'abc123', w: 120, h: 80 } });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const img = nodeG('b')?.querySelector('image.gm-image');
    expect(img?.getAttribute('href')).toBe('/api/images/abc123');
    expect(img?.getAttribute('width')).toBe('120');
    expect(img?.getAttribute('height')).toBe('80');
    expect(nodeG('a')?.querySelector('image.gm-image')).toBeNull();
  });

  it('折叠徽标 +N：仅 collapsedCount>0 渲染，文案 +N，右侧节点在盒右侧', () => {
    renderScene(createScene(svg), makeInput(baseLayout({ b: 3 }), baseData()));
    const badge = svg.querySelector('.gm-collapse-badge');
    expect(badge?.getAttribute('data-for-id')).toBe('b');
    expect(badge?.textContent).toBe('+3');
    expect(badge?.getAttribute('transform')).toBe('translate(100, 11)'); // w=100, h=40 → (100, 20-9)
    expect(nodeG('a')?.querySelector('.gm-collapse-badge')).toBeNull();
  });

  it('折叠计数为 0 不渲染徽标', () => {
    renderScene(createScene(svg), makeInput(baseLayout({ a: 0 }), baseData()));
    expect(svg.querySelector('.gm-collapse-badge')).toBeNull();
  });

  it('左侧节点徽标在盒左侧；org（down）节点徽标在盒下方', () => {
    const layout = baseLayout({ c: 1, e: 1 });
    layout.nodes = [
      box('a', -60, -10, 120, 20, 'right', 0),
      box('b', 60, -20, 100, 40),
      box('c', -140, 20, 80, 20, 'left'),
      box('e', -50, 100, 100, 40, 'down'),
    ];
    layout.edges = [];
    const data = baseData();
    data.set('e', { text: 'E' });
    renderScene(createScene(svg), makeInput(layout, data));
    const leftBadge = svg.querySelector('[data-for-id="c"]');
    expect(leftBadge?.getAttribute('transform')).toBe('translate(-28, 1)'); // (-28, 10-9)
    const downBadge = svg.querySelector('[data-for-id="e"]');
    expect(downBadge?.getAttribute('transform')).toBe('translate(36, 40)'); // (50-14, 40)
  });

  it('bezier 边 d 为 M/C 四点；elbow 边为正交段（org 语义）', () => {
    const layout = baseLayout();
    layout.edges = [
      edge('a->b', 'bezier'),
      { id: 'a->c', from: { x: 50, y: 100 }, to: { x: 80, y: 200 }, kind: 'elbow' },
    ];
    renderScene(createScene(svg), makeInput(layout, baseData()));
    expect(edgePath('a->b')?.getAttribute('d')).toBe('M 0 0 C 40 0 20 10 60 10');
    expect(edgePath('a->c')?.getAttribute('d')).toBe('M 50 100 L 50 150 L 80 150 L 80 200');
    expect(edgePath('a->b')?.getAttribute('stroke')).toBe(theme.edgeColor);
    expect(edgePath('a->b')?.getAttribute('stroke-width')).toBe('2');
    expect(edgePath('a->b')?.getAttribute('fill')).toBe('none');
  });
});

describe('renderScene：协调更新（保元素引用）', () => {
  it('改文本：同一 <g> 元素被复用（引用相等），tspan 内容更新；未变文本 tspan 引用不变', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout(), baseData()));
    const gB = nodeG('b') as SVGGElement;
    const gA = nodeG('a') as SVGGElement;
    const tspanA = gA.querySelector('tspan') as SVGTSpanElement;
    const data2 = baseData();
    data2.set('b', { text: '新的\n两行' });
    renderScene(scene, makeInput(baseLayout(), data2));
    expect(nodeG('b')).toBe(gB);
    const tspans = gB.querySelectorAll('tspan');
    expect(tspans).toHaveLength(2);
    expect(tspans[0]?.textContent).toBe('新的');
    expect(gA.querySelector('tspan')).toBe(tspanA);
  });

  it('删节点 → 元素移除；增节点 → 新元素出现', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout(), baseData()));
    const gC = nodeG('c') as SVGGElement;
    const layout2 = baseLayout();
    layout2.nodes = baseLayout().nodes.filter((n) => n.id !== 'c');
    layout2.nodes.push(box('d', 60, 60, 50, 20));
    layout2.edges = [edge('a->b', 'bezier')];
    const data2 = baseData();
    renderScene(scene, makeInput(layout2, data2));
    expect(gC.isConnected).toBe(false);
    expect(nodeG('c')).toBeNull();
    expect(nodeG('d')).not.toBeNull();
    expect(svg.querySelectorAll('[data-node-id]')).toHaveLength(3);
  });

  it('边结构切换 bezier→elbow：同一路径元素（id 稳定），d 重算', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout(), baseData()));
    const path = edgePath('a->b') as SVGPathElement;
    const layout2 = baseLayout();
    layout2.edges = [edge('a->b', 'elbow'), edge('a->c', 'bezier')];
    renderScene(scene, makeInput(layout2, baseData()));
    expect(edgePath('a->b')).toBe(path);
    expect(path.getAttribute('d')).toBe('M 0 0 L 0 5 L 60 5 L 60 10');
  });

  it('徽标随 collapsedCounts 增删：出现 → 消失，且节点 g 引用不变', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout({ b: 2 }), baseData()));
    const gB = nodeG('b') as SVGGElement;
    const badge = gB.querySelector('.gm-collapse-badge') as SVGGElement;
    renderScene(scene, makeInput(baseLayout(), baseData()));
    expect(nodeG('b')).toBe(gB);
    expect(gB.querySelector('.gm-collapse-badge')).toBeNull();
    renderScene(scene, makeInput(baseLayout({ b: 7 }), baseData()));
    expect(gB.querySelector('.gm-collapse-badge')?.textContent).toBe('+7');
    expect(badge.isConnected).toBe(false); // 旧徽标元素被移除，新元素重建
  });

  it('保留节点 image 更新：key/宽高变化 → 属性回填，元素引用不变', () => {
    const scene = createScene(svg);
    const data1 = baseData();
    data1.set('b', { text: 'x', image: { key: 'old', w: 100, h: 60 } });
    renderScene(scene, makeInput(baseLayout(), data1));
    const img = nodeG('b')?.querySelector('image.gm-image') as SVGImageElement;
    const data2 = baseData();
    data2.set('b', { text: 'x', image: { key: 'new', w: 150, h: 90 } });
    renderScene(scene, makeInput(baseLayout(), data2));
    expect(nodeG('b')?.querySelector('image.gm-image')).toBe(img);
    expect(img.getAttribute('href')).toBe('/api/images/new');
    expect(img.getAttribute('width')).toBe('150');
    expect(img.getAttribute('height')).toBe('90');
  });

  it('保留节点文本加宽盒子：link 角标 x 随右缘移动，元素引用不变', () => {
    const scene = createScene(svg);
    const data1 = baseData();
    data1.set('b', { text: '短', href: 'https://example.com' });
    renderScene(scene, makeInput(baseLayout(), data1));
    const link = nodeG('b')?.querySelector('.gm-link-badge') as SVGTextElement;
    expect(link.getAttribute('x')).toBe('94'); // w=100 − 6
    const data2 = baseData();
    data2.set('b', { text: '一段长了很多的文本', href: 'https://example.com' });
    const layout2 = baseLayout();
    layout2.nodes = [layout2.nodes[0] as NodeBox, box('b', 60, -20, 200, 40), layout2.nodes[2] as NodeBox];
    renderScene(scene, makeInput(layout2, data2));
    expect(nodeG('b')?.querySelector('.gm-link-badge')).toBe(link);
    expect(link.getAttribute('x')).toBe('194'); // w=200 − 6
  });

  it('保留节点跨深度复用：标记行随深度变化更新位移，徽标引用不变', () => {
    const scene = createScene(svg);
    const data1 = baseData();
    data1.set('b', { text: 'x', icons: { other: ['done'] } });
    renderScene(scene, makeInput(baseLayout(), data1));
    const badge = nodeG('b')?.querySelector('.gm-marker-badge') as SVGGElement;
    expect(badge).not.toBeNull();
    // 升为一级（depth 1）：盒高变化 → 标记行位移，徽标引用保持。
    const styleL1 = (id: string): ResolvedNodeStyle => resolveNodeStyle(theme, id === 'a' ? 0 : 1, {});
    renderScene(scene, { layout: baseLayout(), theme, styleOf: styleL1, nodeData: data1 });
    expect(nodeG('b')?.querySelector('.gm-marker-badge')).toBe(badge);
  });
});

// ---------------------------------------------------------------------------
// 标记行签名缓存一致性（需求方 bug：加表情→取消→再加同一表情，徽章只剩无字形占位）。
// 病灶在 lastMarkersSig 与 DOM 真态失配：摘除整行后签名残留，re-add 同值命中旧签名
// 跳过重建。以下四例钉住：re-add 重建、换值重建、无变化幂等、多组交错增删。
// ---------------------------------------------------------------------------

describe('renderScene：标记行签名缓存（remove→re-add 完整重建）', () => {
  it('复现用例：加表情→整行摘除→再加同一表情，徽章必须带字形（不得残留空占位壳）', () => {
    const scene = createScene(svg);
    const withEmoji = baseData();
    withEmoji.set('b', { text: 'x', icons: { emoji: ['😊'] } });
    const without = baseData();
    renderScene(scene, makeInput(baseLayout(), withEmoji));
    expect(nodeG('b')?.querySelectorAll('.gm-marker-badge')).toHaveLength(1);
    // 取消：整行摘除（容器与徽章一并离场，不留 gm-markers）
    renderScene(scene, makeInput(baseLayout(), without));
    expect(nodeG('b')?.querySelector('.gm-markers')).toBeNull();
    // 再加同一表情：签名与残留旧签名相同也必须完整重建字形
    renderScene(scene, makeInput(baseLayout(), withEmoji));
    const badge = nodeG('b')?.querySelector('.gm-marker-badge');
    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-marker-group')).toBe('emoji');
    expect(badge?.getAttribute('data-marker-value')).toBe('😊');
    expect(badge?.querySelector('text')?.textContent).toBe('😊'); // 字形本体（修复前：容器空壳）
  });

  it('同组换值（A→B，含 A→无→B 穿插摘行）：glyph 文本随值更新，不停留旧字形', () => {
    const scene = createScene(svg);
    const a = baseData();
    a.set('b', { text: 'x', icons: { emoji: ['😊'] } });
    const b = baseData();
    b.set('b', { text: 'x', icons: { emoji: ['😍'] } });
    const without = baseData();
    renderScene(scene, makeInput(baseLayout(), a));
    expect(nodeG('b')?.querySelector('.gm-marker-badge text')?.textContent).toBe('😊');
    renderScene(scene, makeInput(baseLayout(), b));
    expect(nodeG('b')?.querySelector('.gm-marker-badge text')?.textContent).toBe('😍');
    // A→无→B：中间摘行不得让旧值签名串扰新值重建
    renderScene(scene, makeInput(baseLayout(), without));
    expect(nodeG('b')?.querySelector('.gm-markers')).toBeNull();
    renderScene(scene, makeInput(baseLayout(), b));
    expect(nodeG('b')?.querySelector('.gm-marker-badge text')?.textContent).toBe('😍');
  });

  it('幂等：同 icons 连续两次 render，标记行容器与徽章元素引用不变（不重建）', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('b', { text: 'x', icons: { emoji: ['😊'], priority: ['p0'] } });
    renderScene(scene, makeInput(baseLayout(), data));
    const row = nodeG('b')?.querySelector('.gm-markers');
    const badge = nodeG('b')?.querySelector('.gm-marker-badge');
    expect(row).not.toBeNull();
    expect(badge).not.toBeNull();
    renderScene(scene, makeInput(baseLayout(), data));
    expect(nodeG('b')?.querySelector('.gm-markers')).toBe(row);
    expect(nodeG('b')?.querySelector('.gm-marker-badge')).toBe(badge);
    expect(nodeG('b')?.querySelectorAll('.gm-marker-badge')).toHaveLength(2);
  });

  it('多组共存（表情+优先级）增删交错：字形与组/值锚点随签名逐次对齐', () => {
    const scene = createScene(svg);
    const both = baseData();
    both.set('b', { text: 'x', icons: { emoji: ['😊'], priority: ['p0'] } });
    const onlyPriority = baseData();
    onlyPriority.set('b', { text: 'x', icons: { priority: ['p0'] } });
    const swapped = baseData();
    swapped.set('b', { text: 'x', icons: { emoji: ['😊'], priority: ['p2'] } });

    renderScene(scene, makeInput(baseLayout(), both));
    let badges = nodeG('b')?.querySelectorAll('.gm-marker-badge');
    expect(badges).toHaveLength(2); // 固定组序：priority 在前、emoji 在后
    expect(badges?.[0]?.getAttribute('data-marker-group')).toBe('priority');
    expect(badges?.[0]?.querySelector('text')?.textContent).toBe('P0');
    expect(badges?.[1]?.getAttribute('data-marker-value')).toBe('😊');

    renderScene(scene, makeInput(baseLayout(), onlyPriority)); // 摘表情（行保留）
    badges = nodeG('b')?.querySelectorAll('.gm-marker-badge');
    expect(badges).toHaveLength(1);
    expect(badges?.[0]?.getAttribute('data-marker-value')).toBe('p0');

    renderScene(scene, makeInput(baseLayout(), both)); // re-add 同表情
    badges = nodeG('b')?.querySelectorAll('.gm-marker-badge');
    expect(badges).toHaveLength(2);
    expect(badges?.[1]?.querySelector('text')?.textContent).toBe('😊');
    expect(badges?.[0]?.querySelector('text')?.textContent).toBe('P0');

    renderScene(scene, makeInput(baseLayout(), swapped)); // 优先级换值 p0→p2
    badges = nodeG('b')?.querySelectorAll('.gm-marker-badge');
    expect(badges).toHaveLength(2);
    expect(badges?.[0]?.querySelector('text')?.textContent).toBe('P2');
    expect(badges?.[1]?.querySelector('text')?.textContent).toBe('😊');
  });
});

describe('renderScene：评论角标（FR-CMT-002）', () => {
  it('count>0 渲染 .gm-comment-badge（内容=计数）；0/缺省不渲染', () => {
    const data = baseData();
    data.set('b', { text: 'x', commentCount: 2 });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const badge = nodeG('b')?.querySelector('.gm-comment-badge');
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('text-anchor')).toBe('end');
    // 未计数的节点与 count=0 均不渲染
    expect(nodeG('a')?.querySelector('.gm-comment-badge')).toBeNull();
    const scene2 = createScene(svg);
    const data0 = baseData();
    data0.set('b', { text: 'x', commentCount: 0 });
    renderScene(scene2, makeInput(baseLayout(), data0));
    expect(nodeG('b')?.querySelector('.gm-comment-badge')).toBeNull();
  });

  it('槽位确定：与 note/link 同一右上角方案，从右缘起每步 18 错位且 fill 随样式', () => {
    const data = baseData();
    data.set('b', { text: 'x', commentCount: 3 });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    const badge = nodeG('b')?.querySelector('.gm-comment-badge') as SVGTextElement;
    expect(badge.getAttribute('x')).toBe('94'); // w=100 − 6（仅评论角标 → 最右位）
    expect(badge.getAttribute('y')).toBe('12');
    expect(badge.getAttribute('fill')).toBe('#3d4757');
    // 与 note/link 共存：link 最右、note 次之、comment 第三位
    const data2 = baseData();
    data2.set('b', { text: 'x', commentCount: 3, note: '有笔记', href: 'https://example.com' });
    renderScene(createScene(svg), makeInput(baseLayout(), data2));
    const stacked = nodeG('b')?.querySelector('.gm-comment-badge') as SVGTextElement;
    expect(stacked.getAttribute('x')).toBe('58'); // 100 − 6 − 18 − 18
    // 仅 note 共存：让一位
    const data3 = baseData();
    data3.set('b', { text: 'x', commentCount: 3, note: '有笔记' });
    renderScene(createScene(svg), makeInput(baseLayout(), data3));
    const withNote = nodeG('b')?.querySelector('.gm-comment-badge') as SVGTextElement;
    expect(withNote.getAttribute('x')).toBe('76'); // 100 − 6 − 18
  });

  it('计数变化就地更新（元素引用不变，内容/x 回填）；归零移除、再增重建', () => {
    const scene = createScene(svg);
    const data1 = baseData();
    data1.set('b', { text: 'x', commentCount: 1 });
    renderScene(scene, makeInput(baseLayout(), data1));
    const badge = nodeG('b')?.querySelector('.gm-comment-badge') as SVGTextElement;
    const data2 = baseData();
    data2.set('b', { text: 'x', commentCount: 5, note: '有笔记' });
    renderScene(scene, makeInput(baseLayout(), data2));
    expect(nodeG('b')?.querySelector('.gm-comment-badge')).toBe(badge); // 身份保持
    expect(badge.textContent).toBe('5');
    expect(badge.getAttribute('x')).toBe('76'); // note 出现 → 让位回填
    const data3 = baseData();
    data3.set('b', { text: 'x' });
    renderScene(scene, makeInput(baseLayout(), data3));
    expect(nodeG('b')?.querySelector('.gm-comment-badge')).toBeNull();
    const data4 = baseData();
    data4.set('b', { text: 'x', commentCount: 2 });
    renderScene(scene, makeInput(baseLayout(), data4));
    expect(nodeG('b')?.querySelector('.gm-comment-badge')?.textContent).toBe('2');
  });
});

describe('renderScene：清理与幂等', () => {
  it('更新为空布局后无孤儿元素：三层清空，svg 只剩三层', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout(), baseData()));
    renderScene(scene, makeInput({ nodes: [], edges: [], collapsedCounts: new Map(), summaries: [], width: 0, height: 0 }, baseData()));
    expect(scene.nodesLayer.children).toHaveLength(0);
    expect(scene.edgesLayer.children).toHaveLength(0);
    expect(scene.summariesLayer.children).toHaveLength(0);
    expect(svg.children).toHaveLength(3);
  });

  it('重复渲染同一输入：DOM 结构与元素引用稳定（幂等）', () => {
    const scene = createScene(svg);
    const input = makeInput(baseLayout({ b: 2 }), baseData());
    renderScene(scene, input);
    const refs = [...svg.querySelectorAll('[data-node-id], [data-edge-id], .gm-collapse-badge')];
    renderScene(scene, input);
    const refs2 = [...svg.querySelectorAll('[data-node-id], [data-edge-id], .gm-collapse-badge')];
    expect(refs2).toHaveLength(refs.length);
    refs.forEach((r, i) => expect(refs2[i]).toBe(r));
    expect(scene.nodesLayer.children).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 概要 bracket 渲染（M6 Task 6，企微对标）：只增不改——g[data-summary-id] +
// 下括弧 path（片段盒下方 12px，两侧端子上挑 6px）+ 居中 label。
// ---------------------------------------------------------------------------

describe('renderScene：概要 bracket（M6 Task 6）', () => {
  function summaryLayout(
    summaries: Array<{ id: string; x: number; y: number; w: number; label: string; labelX?: number; labelAnchor?: 'start' | 'end' | 'middle' }>,
  ): LayoutResult {
    return { ...baseLayout(), summaries };
  }

  it('渲染 g[data-summary-id]：transform=(x,y)、下括弧 path（M 0 -6 L 0 0 L w 0 L w -6）、label 居中在行下方', () => {
    renderScene(createScene(svg), makeInput(summaryLayout([{ id: 'sm1', x: 40, y: 80, w: 100, label: '上半周' }]), baseData()));
    const g = svg.querySelector('[data-summary-id="sm1"]') as SVGGElement;
    expect(g).not.toBeNull();
    expect(g.getAttribute('class')).toBe('gm-summary');
    expect(g.parentNode).toBe(svg.querySelector('.gm-summaries'));
    expect(g.getAttribute('transform')).toBe('translate(40, 80)');
    const path = g.querySelector('path.gm-summary-bracket') as SVGPathElement;
    expect(path.getAttribute('d')).toBe('M 0 -6 L 0 0 L 100 0 L 100 -6');
    expect(path.getAttribute('fill')).toBe('none');
    expect(path.getAttribute('stroke')).toBe(theme.edgeColor);
    expect(path.getAttribute('stroke-width')).toBe(String(theme.edgeWidth));
    const label = g.querySelector('text.gm-summary-label') as SVGTextElement;
    expect(label.textContent).toBe('上半周');
    expect(label.getAttribute('x')).toBe('50'); // w/2 居中
    expect(label.getAttribute('text-anchor')).toBe('middle');
    expect(Number(label.getAttribute('y'))).toBeGreaterThan(0); // 行下方基线
  });

  it('协调更新：label 变化就地更新；几何变化重算 transform/d；概要消失元素移除', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(summaryLayout([{ id: 'sm1', x: 40, y: 80, w: 100, label: 'A' }]), baseData()));
    const g = svg.querySelector('[data-summary-id="sm1"]') as SVGGElement;
    const label = g.querySelector('text.gm-summary-label') as SVGTextElement;
    // label 变化 + 几何变化：元素引用恒定，属性重算
    renderScene(scene, makeInput(summaryLayout([{ id: 'sm1', x: 60, y: 120, w: 140, label: 'B' }]), baseData()));
    expect(svg.querySelector('[data-summary-id="sm1"]')).toBe(g);
    expect(g.getAttribute('transform')).toBe('translate(60, 120)');
    expect(g.querySelector('path.gm-summary-bracket')?.getAttribute('d')).toBe('M 0 -6 L 0 0 L 140 0 L 140 -6');
    expect(g.querySelector('text.gm-summary-label')).toBe(label);
    expect(label.textContent).toBe('B');
    expect(label.getAttribute('x')).toBe('70');
    // 概要消失 → 元素移除
    renderScene(scene, makeInput(summaryLayout([]), baseData()));
    expect(svg.querySelector('[data-summary-id="sm1"]')).toBeNull();
    expect(g.isConnected).toBe(false);
  });

  it('既有节点/边元素不受概要增删影响（只增不改：引用恒定）', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(summaryLayout([]), baseData()));
    const gB = svg.querySelector('[data-node-id="b"]') as SVGGElement;
    const edgePath = svg.querySelector('[data-edge-id="a->b"]') as SVGPathElement;
    renderScene(scene, makeInput(summaryLayout([{ id: 'sm1', x: 0, y: 0, w: 50, label: 'x' }]), baseData()));
    expect(svg.querySelector('[data-node-id="b"]')).toBe(gB);
    expect(svg.querySelector('[data-edge-id="a->b"]')).toBe(edgePath);
    renderScene(scene, makeInput(summaryLayout([]), baseData()));
    expect(svg.querySelector('[data-node-id="b"]')).toBe(gB);
    expect(svg.querySelector('[data-edge-id="a->b"]')).toBe(edgePath);
  });

  // M7b 概要标签避让：同侧概要由布局层给出外置锚点（labelX + labelAnchor），渲染
  // 层只消费；字段缺省回退旧居中口径（w/2 + middle），同侧↔跨侧互转时属性就地跟随。
  it('labelX/labelAnchor：外置锚点逐字段消费；缺省回退居中；互转就地更新且引用恒定', () => {
    const scene = createScene(svg);
    // 外置（右列概要：bracket 右端外 6px，anchor=start）
    renderScene(scene, makeInput(summaryLayout([{ id: 'sm1', x: 40, y: 80, w: 100, label: '工作日', labelX: 106, labelAnchor: 'start' }]), baseData()));
    const label = svg.querySelector('text.gm-summary-label') as SVGTextElement;
    expect(label.getAttribute('x')).toBe('106');
    expect(label.getAttribute('text-anchor')).toBe('start');
    expect(label.getAttribute('y')).toBe('14'); // 基线偏移不受外置影响
    // 缺省字段（跨侧/org）：回退 w/2 + middle，元素引用恒定
    renderScene(scene, makeInput(summaryLayout([{ id: 'sm1', x: 40, y: 80, w: 100, label: '工作日' }]), baseData()));
    expect(svg.querySelector('text.gm-summary-label')).toBe(label);
    expect(label.getAttribute('x')).toBe('50');
    expect(label.getAttribute('text-anchor')).toBe('middle');
    // 左列镜像（anchor=end）：锚点在 bracket 左端外侧，引用仍恒定
    renderScene(scene, makeInput(summaryLayout([{ id: 'sm1', x: 40, y: 80, w: 100, label: '工作日', labelX: -6, labelAnchor: 'end' }]), baseData()));
    expect(svg.querySelector('text.gm-summary-label')).toBe(label);
    expect(label.getAttribute('x')).toBe('-6');
    expect(label.getAttribute('text-anchor')).toBe('end');
  });
});

// ---------------------------------------------------------------------------
// 任务视觉（M7c-C2，spec 2026-09-29-m7c §R4）：状态色左边条 / 负责人头像 /
// 有效进度 / 预期日期徽标 / 无任务信息零变化。语义源：mindgrid 节点卡 +
// @gmind/shared derive（effectiveProgress/isOverdue 口径）；色值企微底色四态。
// ---------------------------------------------------------------------------

describe('renderScene：任务视觉（M7c-C2）', () => {
  const TODAY = '2026-09-28';

  function taskInput(data: Map<string, NodeVisual>, nodes?: NodeBox[]): SceneInput {
    const layout = baseLayout();
    if (nodes) layout.nodes = nodes;
    return { layout, theme, styleOf, nodeData: data, today: TODAY };
  }

  it('状态条四色：todo 灰/doing 蓝/done 绿/blocked 橙（左缘 3px 全盒高竖条；todo 有任务信息也出灰条）', () => {
    const data = baseData();
    data.set('b', { text: 'x', task: { status: 'doing' } });
    data.set('c', { text: 'y', task: { status: 'done' } });
    data.set('d', { text: 'z', task: { owners: ['u1'] } }); // status 缺省 todo + 负责人 → 灰条
    const layout = baseLayout();
    layout.nodes.push(box('d', 60, 60, 100, 40));
    const scene = createScene(svg);
    renderScene(scene, taskInput(data, layout.nodes));
    const barOf = (id: string): SVGRectElement | null =>
      nodeG(id)?.querySelector('rect.gm-task-bar') ?? null;
    expect(barOf('b')?.getAttribute('fill')).toBe('#3370ff');
    expect(barOf('b')?.getAttribute('x')).toBe('0');
    expect(barOf('b')?.getAttribute('width')).toBe('3');
    expect(barOf('b')?.getAttribute('height')).toBe('40'); // 全盒高
    expect(barOf('c')?.getAttribute('fill')).toBe('#34c724');
    expect(barOf('d')?.getAttribute('fill')).toBe('#86909c');
    // 协调更新：doing → blocked 就地换色
    data.set('b', { text: 'x', task: { status: 'blocked' } });
    renderScene(scene, taskInput(data, layout.nodes));
    expect(barOf('b')?.getAttribute('fill')).toBe('#ff8800');
  });

  it('负责人头像：首人 colorForUser 色点；多人尾随「+n」小字', () => {
    const data = baseData();
    data.set('b', { text: 'x', task: { owners: ['u1'] } });
    data.set('c', { text: 'y', task: { owners: ['u1', 'u2', 'u3'] } });
    renderScene(createScene(svg), taskInput(data));
    const dotB = nodeG('b')?.querySelector('circle.gm-task-owner');
    expect(dotB).not.toBeNull();
    expect(dotB?.getAttribute('fill')).toBe(colorForUser('u1')); // Gmind 成员色单源
    expect(dotB?.getAttribute('r')).toBe('5');
    expect(nodeG('b')?.querySelector('.gm-task-owner-plus')).toBeNull();
    const dotC = nodeG('c')?.querySelector('circle.gm-task-owner');
    expect(dotC?.getAttribute('fill')).toBe(colorForUser('u1')); // 首人色
    expect(nodeG('c')?.querySelector('.gm-task-owner-plus')?.textContent).toBe('+2');
  });

  it('有效进度：叶=自身百分比（progress>0 才显示）；父=Σ 直属子级均值；灰字', () => {
    const data = baseData();
    data.set('b', { text: 'x', task: { progress: 40 } }); // 叶
    data.set('c', { text: 'y', task: { owners: ['u1'], progress: 0 } }); // 叶 0 → 不显示
    // 父 d（有任务信息）子 e/f 各 30/50 → Σ = round(80/2) = 40
    data.set('d', { text: 'D', task: { owners: ['u9'] } });
    data.set('e', { text: 'E', task: { progress: 30 } });
    data.set('f', { text: 'F', task: { progress: 50 } });
    const nodes = [
      box('a', -60, -10, 120, 20, 'right', 0),
      box('b', 60, -20, 100, 40),
      box('c', 60, 20, 80, 40),
      box('d', 60, 60, 120, 40),
      { ...box('e', 220, 40, 80, 40), parentId: 'd' },
      { ...box('f', 220, 80, 80, 40), parentId: 'd' },
    ];
    renderScene(createScene(svg), taskInput(data, nodes));
    const progOf = (id: string): SVGTextElement | null =>
      nodeG(id)?.querySelector('text.gm-task-progress') ?? null;
    expect(progOf('b')?.textContent).toBe('40%'); // 叶自身
    expect(progOf('b')?.getAttribute('fill')).toBe('#86909c');
    expect(progOf('c')).toBeNull(); // progress=0 不显示
    expect(progOf('d')?.textContent).toBe('40%'); // 父 Σ 汇总（直属子级均值）
  });

  it('日期徽标：MM-DD 灰底；逾期红底白字（dueDate<今天且进度<100 且非 done）', () => {
    const data = baseData();
    data.set('b', { text: 'x', task: { dueDate: '2026-09-01' } }); // 逾期（进度 0 < 100）
    data.set('c', { text: 'y', task: { dueDate: '2026-10-01' } }); // 未到期
    renderScene(createScene(svg), taskInput(data));
    const bgOf = (id: string): SVGRectElement | null =>
      nodeG(id)?.querySelector('rect.gm-task-due-bg') ?? null;
    const dueOf = (id: string): SVGTextElement | null =>
      nodeG(id)?.querySelector('text.gm-task-due') ?? null;
    expect(dueOf('b')?.textContent).toBe('09-01'); // YYYY-MM-DD → MM-DD（同 mindgrid）
    expect(bgOf('b')?.getAttribute('fill')).toBe('#f53f3f'); // 逾期红底
    expect(dueOf('b')?.getAttribute('fill')).toBe('#ffffff'); // 白字
    expect(bgOf('c')?.getAttribute('fill')).toBe('#f2f3f5'); // 常态灰底
    expect(dueOf('c')?.getAttribute('fill')).toBe('#86909c');

    const scene = createScene(svg);
    // done 状态：过期日期也不判逾期（isOverdue 口径）
    data.set('b', { text: 'x', task: { status: 'done', dueDate: '2026-09-01' } });
    renderScene(scene, taskInput(data));
    expect(bgOf('b')?.getAttribute('fill')).toBe('#f2f3f5');
    // 叶有效进度 100：过期日期不判逾期
    data.set('b', { text: 'x', task: { progress: 100, dueDate: '2026-09-01' } });
    renderScene(scene, taskInput(data));
    expect(bgOf('b')?.getAttribute('fill')).toBe('#f2f3f5');
    // 父 Σ ≥ 100：过期日期不判逾期（子甲 100 / 子乙 100）
    const nodes = [
      box('a', -60, -10, 120, 20, 'right', 0),
      box('b', 60, -20, 140, 40),
      { ...box('e', 240, -40, 80, 40), parentId: 'b' },
      { ...box('f', 240, 0, 80, 40), parentId: 'b' },
    ];
    data.set('b', { text: 'x', task: { owners: ['u1'], dueDate: '2026-09-01' } });
    data.set('e', { text: 'E', task: { progress: 100 } });
    data.set('f', { text: 'F', task: { progress: 100 } });
    renderScene(scene, taskInput(data, nodes));
    expect(bgOf('b')?.getAttribute('fill')).toBe('#f2f3f5');
  });

  it('无任务信息零变化：todo 全缺省与无 task 的节点 DOM 与纯脑图节点逐字节一致', () => {
    const svg1 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const svg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg1);
    document.body.appendChild(svg2);
    const plain = baseData();
    plain.set('b', { text: 'x' });
    // 基线：全无 task 数据
    renderScene(createScene(svg1), makeInput(baseLayout(), plain));
    // 对照：b 带 todo 全缺省 task（owners 空/进度 0/无日期）——纯脑图节点保持现状
    const data = baseData();
    data.set('b', { text: 'x', task: { status: 'todo' } });
    renderScene(createScene(svg2), makeInput(baseLayout(), data));
    expect(svg2.innerHTML).toBe(svg1.innerHTML);
    expect(svg2.querySelectorAll('.gm-task-bar, .gm-task-row')).toHaveLength(0);
  });

  it('任务行占位：主文本/标记行在任务行上方区域居中（基线上移）；任务清空恢复原基线', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('b', { text: 'x', task: { status: 'doing' } }); // b 盒 h=40 → contentCenter=(40-20)/2=10
    renderScene(scene, taskInput(data));
    // 基线 = contentCenter + fontSize×0.35 = 10 + 4.9（无任务时 20 + 4.9 = 24.9）
    expect(nodeG('b')?.querySelector('tspan')?.getAttribute('y')).toBe('14.9');
    // 任务清空 → 无任何任务元素、几何回位（现状口径；行高 = fontSize×1.4 = 19.6）
    renderScene(scene, makeInput(baseLayout(), baseData()));
    expect(nodeG('b')?.querySelector('.gm-task-bar')).toBeNull();
    expect(nodeG('b')?.querySelector('.gm-task-row')).toBeNull();
    expect(nodeG('b')?.querySelectorAll('tspan')[0]?.getAttribute('y')).toBe('15.1'); // 两行首行回位
  });
});

// ---------------------------------------------------------------------------
// 描述行（M7c-C1，spec 2026-09-29-m7c §R1）：text 下方第二行——12px 灰 #86909c、
// 单行省略（截断在测量期完成，直绘 box.descLine）、占底部条带（任务行上方）；
// 无描述零变化（DOM 与现状一致）。
// ---------------------------------------------------------------------------

describe('renderScene：描述行（M7c-C1）', () => {
  it('有 descLine 渲染第二行：灰 #86909c、12px、内容直绘、x 与主文本对齐；主文本基线上移', () => {
    const scene = createScene(svg);
    const nodes = baseLayout().nodes.map((n) => (n.id === 'c' ? { ...n, h: 40, descLine: '一句话描述' } : n));
    renderScene(scene, makeInput({ ...baseLayout(), nodes }, baseData()));
    const desc = nodeG('c')?.querySelector('text.gm-desc') as SVGTextElement;
    expect(desc).not.toBeNull();
    expect(desc.textContent).toBe('一句话描述');
    expect(desc.getAttribute('fill')).toBe('#86909c');
    expect(desc.getAttribute('font-size')).toBe('12');
    expect(desc.getAttribute('font-weight')).toBe('400');
    expect(desc.getAttribute('x')).toBe('12'); // textX = nodePaddingX（c 无图标）
    // c 盒 h=40：描述行独占底部条带 → 中心 30，基线 = 30 + 12×0.35 = 34.2
    expect(desc.getAttribute('y')).toBe('34.2');
    // 主文本（单行，level2 字号 14）居中于余下区域：contentCenter=(40-20)/2=10 → y=14.9
    expect(nodeG('c')?.querySelector('tspan')?.getAttribute('y')).toBe('14.9');
  });

  it('无 descLine 不渲染描述行（零变化）；描述移除后元素回收', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout(), baseData()));
    expect(svg.querySelector('.gm-desc')).toBeNull();
    // 描述出现 → 渲染；再移除 → 元素移除（协调差分）
    const nodes = baseLayout().nodes.map((n) => (n.id === 'c' ? { ...n, h: 40, descLine: 'D' } : n));
    renderScene(scene, makeInput({ ...baseLayout(), nodes }, baseData()));
    expect(nodeG('c')?.querySelector('text.gm-desc')).not.toBeNull();
    renderScene(scene, makeInput(baseLayout(), baseData()));
    expect(nodeG('c')?.querySelector('text.gm-desc')).toBeNull();
  });

  it('描述与任务行并存：描述行在任务行上方（基线各占一条带），主文本居中于剩余区域', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('c', { text: 'x', task: { status: 'doing', progress: 40 } });
    const nodes = baseLayout().nodes.map((n) => (n.id === 'c' ? { ...n, h: 60, descLine: 'D' } : n));
    // taskInput 是 M7c-C2 describe 的局部助手，此处同款内联（today 供逾期判定）
    renderScene(scene, { layout: { ...baseLayout(), nodes }, theme, styleOf, nodeData: data, today: '2026-09-28' });
    // 描述行中心 = h - TASK_ROW_H（任务行）- TASK_ROW_H/2 = 60-20-10 = 30 → y = 34.2
    const desc = nodeG('c')?.querySelector('text.gm-desc') as SVGTextElement;
    expect(desc.getAttribute('y')).toBe('34.2');
    // 主文本：contentCenter = (60-20-20)/2 = 10 → y = 10 + 14×0.35 = 14.9
    expect(nodeG('c')?.querySelector('tspan')?.getAttribute('y')).toBe('14.9');
    // 任务行元素在（C2 口径，rowY = h - TASK_ROW_H/2 = 50）
    expect(nodeG('c')?.querySelector('.gm-task-row')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 长文本断行（Kimi 复验溢出修复）：行结构单源 = 测量贪心断行（box.lines 经
// renderScene 合并进 visual.lines），长文本不再画成一行溢出节点盒右缘。
// ---------------------------------------------------------------------------

describe('renderScene：长文本断行（box.lines 直绘）', () => {
  it('盒带 lines：按测量断行绘多 tspan（兜底 split 不再生效），基线与显式 \\n 两行同式', () => {
    const data = baseData();
    data.set('b', { text: '长'.repeat(30) }); // 视觉文本仍是一整段（无显式换行）
    const layout2 = baseLayout();
    layout2.nodes = [
      layout2.nodes[0] as NodeBox,
      { ...box('b', 60, -20, 264, 40), lines: ['长'.repeat(24), '长'.repeat(6)] },
      layout2.nodes[2] as NodeBox,
    ];
    renderScene(createScene(svg), makeInput(layout2, data));
    const tspans = nodeG('b')?.querySelectorAll('tspan');
    expect(tspans).toHaveLength(2); // 按断行两行，而非 30 字单行溢出盒右缘
    expect(tspans?.[0]?.textContent).toBe('长'.repeat(24));
    expect(tspans?.[1]?.textContent).toBe('长'.repeat(6));
    // 基线同式：contentCenter = 40/2 = 20，行高 14×1.4 = 19.6，fontSize×0.35 = 4.9
    expect(tspans?.[0]?.getAttribute('y')).toBe('15.1'); // 20 − 9.8 + 4.9
    expect(tspans?.[1]?.getAttribute('y')).toBe('34.7'); // 20 + 9.8 + 4.9
  });

  it('同 text 不同断行：tspan 随行内容签名重建（lastText 缓存键纳入行集，防御）', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('b', { text: '一二三四五' });
    renderScene(scene, makeInput(baseLayout(), data));
    expect(nodeG('b')?.querySelectorAll('tspan')).toHaveLength(1);
    // 视觉文本不变，盒新带断行结果（如字号变化触发重排）→ 行内容变化须重建 tspan
    const layout2 = baseLayout();
    layout2.nodes = [
      layout2.nodes[0] as NodeBox,
      { ...box('b', 60, -20, 100, 40), lines: ['一二三四', '五'] },
      layout2.nodes[2] as NodeBox,
    ];
    renderScene(scene, makeInput(layout2, data));
    const tspans = nodeG('b')?.querySelectorAll('tspan');
    expect(tspans).toHaveLength(2);
    expect(tspans?.[0]?.textContent).toBe('一二三四');
    expect(tspans?.[1]?.textContent).toBe('五');
  });
});


describe('renderScene：任务行签名缓存（remove→re-add 完整重建，与标记行同不变式）', () => {
  const taskOf = (status: string, due: string) => ({
    status, progress: 40, owners: ['01M352X50QV7T99S3WBH6PDTR5'], startDate: null, dueDate: due, doneDate: null,
  });
  it('任务信息移除后重加相同数据 → 任务行完整重建（日期徽标在位，不得残留空壳）', () => {
    const scene = createScene(svg);
    const withTask = baseData();
    (withTask.set as (k: string, v: unknown) => void)('b', { text: 'x', task: taskOf('doing', '2026-10-15') });
    const without = baseData();
    renderScene(scene, makeInput(baseLayout(), withTask));
    expect(nodeG('b')?.querySelector('.gm-task-row')).not.toBeNull();
    renderScene(scene, makeInput(baseLayout(), without));
    expect(nodeG('b')?.querySelector('.gm-task-row')).toBeNull();
    renderScene(scene, makeInput(baseLayout(), withTask));
    const row = nodeG('b')?.querySelector('.gm-task-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.gm-task-due')?.textContent).toContain('10-15');
  });
});

// ---------------------------------------------------------------------------
// 简洁模式（M7b 补课，mindgrid 账号级显示偏好「脑图简洁模式」）：SceneInput.compact
// = true 时状态色条/任务行条带/描述行均隐藏，任务进度改内联小字画在标题行右缘
// （gm-task-progress-inline，槽宽 TASK_PROGRESS_W 与测量侧盒宽下限同源）；缺省
// false = 原路径，DOM 逐字节不变（金样锁定）。
// ---------------------------------------------------------------------------

describe('renderScene：简洁模式（compact）', () => {
  const TODAY = '2026-09-28';

  function compactInput(
    data: Map<string, NodeVisual>,
    opts: { compact: boolean; nodes?: NodeBox[] },
  ): SceneInput {
    const layout = baseLayout();
    if (opts.nodes) layout.nodes = opts.nodes;
    return { layout, theme, styleOf, nodeData: data, today: TODAY, compact: opts.compact };
  }

  it('compact：状态条与任务行隐藏，进度内联标题行右缘（有任务信息）；无任务节点零内联', () => {
    const data = baseData();
    data.set('b', { text: 'x', task: { status: 'doing', progress: 50 } });
    renderScene(createScene(svg), compactInput(data, { compact: true }));
    expect(nodeG('b')?.querySelector('rect.gm-task-bar')).toBeNull();
    expect(nodeG('b')?.querySelector('g.gm-task-row')).toBeNull();
    const inline = nodeG('b')?.querySelector('text.gm-task-progress-inline');
    expect(inline?.textContent).toBe('50%');
    expect(inline?.getAttribute('fill')).toBe('#86909c');
    // 内联槽右对齐：x = 盒宽 − nodePaddingX（gmind-blue=12；槽宽 TASK_PROGRESS_W 由测量侧预留）
    expect(inline?.getAttribute('x')).toBe('88'); // b.w=100 − 12
    // 基线 = contentCenter(=b.h/2=20) + 11×0.35 = 23.85（紧凑盒行中心，不扣任务条带）
    expect(inline?.getAttribute('y')).toBe('23.85');
    // 无任务信息节点（root a）：纯标题+标记，无内联进度
    expect(nodeG('a')?.querySelector('text.gm-task-progress-inline')).toBeNull();
  });

  it('compact：描述行不渲染（手工构造盒携带 descLine 也隐藏——渲染侧独立裁定）', () => {
    const nodes = baseLayout().nodes.map((n) => (n.id === 'c' ? { ...n, h: 40, descLine: '一句话描述' } : n));
    renderScene(createScene(svg), compactInput(baseData(), { compact: true, nodes }));
    expect(nodeG('c')?.querySelector('text.gm-desc')).toBeNull();
    // 主文本回紧凑盒垂直居中：contentCenter = 40/2 = 20 → y = 20 + 14×0.35 = 24.9
    expect(nodeG('c')?.querySelector('tspan')?.getAttribute('y')).toBe('24.9');
  });

  it('compact 往返切换：切回详细模式条带/任务行恢复（签名缓存随容器重建归零），再切回再隐藏', () => {
    const scene = createScene(svg);
    const data = baseData();
    data.set('b', { text: 'x', task: { progress: 40, dueDate: '2026-10-15' } });
    renderScene(scene, compactInput(data, { compact: true }));
    expect(nodeG('b')?.querySelector('.gm-task-bar, .gm-task-row')).toBeNull();
    expect(nodeG('b')?.querySelector('text.gm-task-progress-inline')?.textContent).toBe('40%');
    renderScene(scene, compactInput(data, { compact: false })); // 切回详细
    expect(nodeG('b')?.querySelector('rect.gm-task-bar')).not.toBeNull();
    expect(nodeG('b')?.querySelector('text.gm-task-progress')?.textContent).toBe('40%');
    expect(nodeG('b')?.querySelector('text.gm-task-progress-inline')).toBeNull();
    renderScene(scene, compactInput(data, { compact: true })); // 再切回简洁
    expect(nodeG('b')?.querySelector('.gm-task-bar, .gm-task-row')).toBeNull();
    expect(nodeG('b')?.querySelector('text.gm-task-progress-inline')?.textContent).toBe('40%');
  });

  it('缺省（不传 compact）与 compact:false 输出逐字节一致（金样锁定口径）', () => {
    const svg1 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const svg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.appendChild(svg1);
    document.body.appendChild(svg2);
    const data = baseData();
    data.set('b', { text: 'x', task: { status: 'doing', progress: 50 } });
    renderScene(createScene(svg1), makeInput(baseLayout(), data));
    renderScene(createScene(svg2), compactInput(data, { compact: false }));
    expect(svg2.innerHTML).toBe(svg1.innerHTML);
  });
});
