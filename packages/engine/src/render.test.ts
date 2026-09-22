import { beforeEach, describe, expect, it } from 'vitest';
import { createScene, ICON_GLYPHS, renderScene } from './render';
import type { NodeVisual, SceneInput } from './render';
import { resolveNodeStyle, THEMES } from './themes';
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
  it('创建边/节点两层（边在下、节点在上），并清空旧内容', () => {
    const junk = document.createElement('div');
    svg.appendChild(junk);
    const scene = createScene(svg);
    const layers = svg.querySelectorAll('g');
    expect(layers).toHaveLength(2);
    expect(layers[0]?.getAttribute('class')).toBe('gm-edges');
    expect(layers[1]?.getAttribute('class')).toBe('gm-nodes');
    expect(svg.contains(junk)).toBe(false);
    expect(scene.nodesLayer).toBe(layers[1]);
    expect(scene.edgesLayer).toBe(layers[0]);
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

  it('图标按固定组序（priority→progress→flag→star）拼进一个 gm-icons 文本，未知组忽略', () => {
    expect(ICON_GLYPHS['priority']).toBeDefined();
    const data = baseData();
    data.set('b', { text: 'x', icons: { star: '1', flag: '1', priority: 'p1', progress: '50' } });
    data.set('c', { text: 'y', icons: { mystery: 'zzz' } });
    renderScene(createScene(svg), makeInput(baseLayout(), data));
    expect(svg.querySelector('.gm-icons')?.textContent).toBe('①◐⚑★');
    expect(nodeG('c')?.querySelector('.gm-icons')).toBeNull();
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

  it('保留节点跨深度复用：icons font-size/fill 随 styleOf 更新，元素引用不变', () => {
    const scene = createScene(svg);
    const data1 = baseData();
    data1.set('b', { text: 'x', icons: { star: '1' } });
    renderScene(scene, makeInput(baseLayout(), data1));
    const icons = nodeG('b')?.querySelector('.gm-icons') as SVGTextElement;
    expect(icons.getAttribute('font-size')).toBe('14'); // depth 2 → level2
    // 升为一级（depth 1）：字号/文字色按主题分级变化。
    const styleL1 = (id: string): ResolvedNodeStyle => resolveNodeStyle(theme, id === 'a' ? 0 : 1, {});
    renderScene(scene, { layout: baseLayout(), theme, styleOf: styleL1, nodeData: data1 });
    expect(nodeG('b')?.querySelector('.gm-icons')).toBe(icons);
    expect(icons.getAttribute('font-size')).toBe('16');
    expect(icons.getAttribute('fill')).toBe('#1f2a44');
  });
});

describe('renderScene：清理与幂等', () => {
  it('更新为空布局后无孤儿元素：两层清空，svg 只剩两层', () => {
    const scene = createScene(svg);
    renderScene(scene, makeInput(baseLayout(), baseData()));
    renderScene(scene, makeInput({ nodes: [], edges: [], collapsedCounts: new Map(), width: 0, height: 0 }, baseData()));
    expect(scene.nodesLayer.children).toHaveLength(0);
    expect(scene.edgesLayer.children).toHaveLength(0);
    expect(svg.children).toHaveLength(2);
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
