import { beforeEach, describe, expect, it } from 'vitest';
import { colorForUser, createCursorLayer, CURSOR_COLORS } from './cursors';
import type { RemoteCursor } from './cursors';
import { createScene, renderScene } from './render';
import { resolveNodeStyle, THEMES } from './themes';
import type { NodeVisual, SceneInput } from './render';
import type { EdgeRoute, LayoutResult, NodeBox, ResolvedNodeStyle, ThemeTokens } from './types';

// ---------------------------------------------------------------------------
// 固定桩：与 render.test.ts 同构的最小场景（5 节点含深处节点，覆盖标签钳制与迁移）。
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

/** a 根 + b/c/d/e 子：d/e 够深（y−18 > 2），用于非钳制标签坐标断言。 */
function baseLayout(): LayoutResult {
  const nodes = [
    box('a', -60, -10, 120, 20, 'right', 0),
    box('b', 60, -20, 100, 40),
    box('c', 60, 20, 80, 20),
    box('d', 200, 100, 80, 30),
    box('e', 200, 200, 80, 30),
  ];
  const edges: EdgeRoute[] = nodes.slice(1).map((n) => ({
    id: `a->${n.id}`,
    from: { x: 0, y: 0 },
    to: { x: n.x, y: n.y },
    kind: 'bezier',
    controls: [
      { x: n.x / 2, y: 0 },
      { x: n.x / 2, y: n.y },
    ],
  }));
  return {
    nodes,
    edges,
    collapsedCounts: new Map(),
    summaries: [], // M6 T6 起布局结果含概要（本桩无概要）
    width: 360,
    height: 320,
  };
}

function baseData(): Map<string, NodeVisual> {
  return new Map([
    ['a', { text: '中心' }],
    ['b', { text: 'B' }],
    ['c', { text: 'C' }],
    ['d', { text: 'D' }],
    ['e', { text: 'E' }],
  ]);
}

function makeInput(layout: LayoutResult): SceneInput {
  return { layout, theme, styleOf, nodeData: baseData() };
}

let svg: SVGSVGElement;
let scene: ReturnType<typeof createScene>;

beforeEach(() => {
  document.body.innerHTML = '';
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  document.body.appendChild(svg);
  scene = createScene(svg);
  renderScene(scene, makeInput(baseLayout()));
});

function nodeG(id: string): SVGGElement | null {
  return svg.querySelector(`[data-node-id="${id}"]`);
}

function cursorLayer(): SVGGElement | null {
  return svg.querySelector('g.gm-cursors');
}

function rectsIn(g: SVGGElement | null, userId: string): NodeListOf<Element> {
  return g?.querySelectorAll(`rect.gm-remote-selection[data-cursor-user="${userId}"]`) ?? ([] as unknown as NodeListOf<Element>);
}

function labelOf(userId: string): SVGGElement | null {
  return svg.querySelector(`g.gm-remote-cursor[data-cursor-user="${userId}"]`);
}

function cursor(userId: string, name: string, color: string, nodeIds: string[]): RemoteCursor {
  return { userId, name, color, nodeIds };
}

// ---------------------------------------------------------------------------
// colorForUser：确定性用户色
// ---------------------------------------------------------------------------

describe('colorForUser', () => {
  it('同一 userId 恒定同色（会话内固定），且始终落在色板内', () => {
    for (const id of ['u-alice', 'u-bob', '张三', 'user-42', 'x']) {
      expect(colorForUser(id)).toBe(colorForUser(id));
      expect(CURSOR_COLORS).toContain(colorForUser(id));
    }
  });

  it('色板 10 色互异（蓝/橙系高对比、避开纯红绿对）', () => {
    expect(CURSOR_COLORS).toHaveLength(10);
    expect(new Set(CURSOR_COLORS).size).toBe(10);
  });

  it('不同 userId 允许碰撞但都合法（FNV-1a 取模）', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `user-${i}`);
    for (const id of ids) expect(CURSOR_COLORS).toContain(colorForUser(id));
  });
});

// ---------------------------------------------------------------------------
// setCursors：初次渲染
// ---------------------------------------------------------------------------

describe('setCursors：初次渲染', () => {
  it('光标层挂在 nodesLayer 末尾（最上层、随视口 transform）', () => {
    const layerApi = createCursorLayer(scene);
    const layer = cursorLayer();
    expect(layer).not.toBeNull();
    expect(layer?.parentNode).toBe(scene.nodesLayer);
    expect(scene.nodesLayer.lastElementChild).toBe(layer);
    expect(layerApi.setCursors).toBeTypeOf('function');
    expect(layerApi.clear).toBeTypeOf('function');
  });

  it('两个用户各在选中节点内得到描边选区框 + 各一个昵称标签', () => {
    createCursorLayer(scene);
    const api = createCursorLayer(scene); // 重建层不残留旧层（防重复挂载）
    expect(svg.querySelectorAll('g.gm-cursors')).toHaveLength(1);
    api.setCursors(
      [cursor('u1', '阿明', '#2563eb', ['b']), cursor('u2', '小李', '#ea580c', ['d'])],
      baseLayout().nodes,
    );

    const rectB = nodeG('b')?.querySelector('rect.gm-remote-selection');
    expect(rectB).not.toBeNull();
    expect(rectB?.getAttribute('data-cursor-user')).toBe('u1');
    expect(rectB?.getAttribute('stroke')).toBe('#2563eb');
    expect(rectB?.getAttribute('stroke-width')).toBe('2.5');
    expect(rectB?.getAttribute('fill')).toBe('none');
    expect(rectB?.getAttribute('width')).toBe('100');
    expect(rectB?.getAttribute('height')).toBe('40');

    const rectD = nodeG('d')?.querySelector('rect.gm-remote-selection');
    expect(rectD?.getAttribute('data-cursor-user')).toBe('u2');
    expect(rectD?.getAttribute('stroke')).toBe('#ea580c');
    expect(rectD?.getAttribute('width')).toBe('80');
    expect(rectD?.getAttribute('height')).toBe('30');

    // 标签：用户色胶囊衬底 + 色点 + 白字昵称，位置在首个节点上方（y−18，
    // 钳制 ≥18 = 胶囊高 16 + 上缘 2；2026-10-11 修复「名字被节点盖住」）
    const label1 = labelOf('u1');
    expect(label1?.parentNode).toBe(cursorLayer());
    expect(label1?.querySelector('circle')?.getAttribute('r')).toBe('4');
    expect(label1?.querySelector('circle')?.getAttribute('fill')).toBe('#2563eb');
    // 胶囊衬底：用户色填充、高 16、宽 = 12 内边距 + 色点 8 + 间距 4 + 「阿明」2 字 ×11
    const chip1 = label1?.querySelector('rect');
    expect(chip1?.getAttribute('fill')).toBe('#2563eb');
    expect(chip1?.getAttribute('height')).toBe('16');
    expect(chip1?.getAttribute('width')).toBe('46');
    expect(label1?.querySelector('text')?.textContent).toBe('阿明');
    expect(label1?.querySelector('text')?.getAttribute('font-size')).toBe('11');
    expect(label1?.getAttribute('transform')).toBe('translate(108, -26)'); // 右上角内收 6：x=60+100-46-6，y=-20-6
    const label2 = labelOf('u2');
    expect(label2?.querySelector('text')?.textContent).toBe('小李');
    expect(label2?.getAttribute('transform')).toBe('translate(228, 94)'); // 右上角内收 6：x=200+80-46-6，y=100-6
    expect(cursorLayer()?.querySelectorAll('g.gm-remote-cursor')).toHaveLength(2);
  });

  it('光标头像（2026-10-11 头像功能）：有 avatar 标签画圆形 <image>（gm-cursor-clip）并隐色点，无 avatar 回退色点', () => {
    const api = createCursorLayer(scene);
    // 无 avatar：色点显、image 隐（默认态，标签构建即二选一回填）
    api.setCursors([{ userId: 'u1', name: '阿明', color: '#2563eb', nodeIds: ['b'] }], baseLayout().nodes);
    let label = labelOf('u1');
    expect(label?.querySelector<SVGCircleElement>('circle')?.style.display).not.toBe('none');
    expect(label?.querySelector<SVGImageElement>('image.gm-remote-cursor-avatar')?.style.display).toBe('none');
    expect(svg.querySelector('#gm-cursor-clip')).not.toBeNull();
    // 有 avatar：image 显（href + 裁剪）并隐色点
    api.setCursors(
      [{ userId: 'u1', name: '阿明', color: '#2563eb', avatar: '/avatars/preset-1.svg', nodeIds: ['b'] }],
      baseLayout().nodes,
    );
    label = labelOf('u1');
    const img = label?.querySelector<SVGImageElement>('image.gm-remote-cursor-avatar');
    expect(img?.style.display).not.toBe('none');
    expect(img?.getAttribute('href')).toBe('/avatars/preset-1.svg');
    expect(img?.getAttribute('clip-path')).toBe('url(#gm-cursor-clip)');
    expect(label?.querySelector<SVGCircleElement>('circle')?.style.display).toBe('none');
  });

  it('单用户多节点选中：多框但单标签（锚定第一个存在节点）', () => {
    createCursorLayer(scene).setCursors(
      [cursor('u1', '阿明', '#2563eb', ['a', 'c'])],
      baseLayout().nodes,
    );
    expect(rectsIn(nodeG('a'), 'u1')).toHaveLength(1);
    expect(rectsIn(nodeG('c'), 'u1')).toHaveLength(1);
    expect(labelOf('u1')?.getAttribute('transform')).toBe('translate(8, -16)'); // 首节点 a 右上角内收 6：x=-60+120-46-6，y=-10-6
    expect(cursorLayer()?.querySelectorAll('g.gm-remote-cursor')).toHaveLength(1);
  });

  it('z 序钉死（2026-10-11 修复「名字被节点盖住」）：后建节点追加在层之后时，setCursors 把 gm-cursors 归位 nodesLayer 末位', () => {
    const api = createCursorLayer(scene);
    // 模拟 renderScene 后建节点：新节点 g 追加在 gm-cursors 之后（会盖住标签）
    const late = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    late.setAttribute('data-node-id', 'late');
    scene.nodesLayer.appendChild(late);
    expect(scene.nodesLayer.lastElementChild).toBe(late);
    api.setCursors([cursor('u1', '阿明', '#2563eb', ['b'])], baseLayout().nodes);
    // 层被 re-append 回末位：标签画在一切节点之上
    expect(scene.nodesLayer.lastElementChild).toBe(cursorLayer());
  });

  it('左列节点镜像贴左上角（2026-10-11 需求方裁定）：x = 盒左缘 + 内收 6', () => {
    // b 改到左列（side left、负 x），胶囊锚左上角而非右上角
    const left = baseLayout();
    left.nodes = left.nodes.map((n) => (n.id === 'b' ? box('b', -260, -20, 100, 40, 'left') : n));
    createCursorLayer(scene).setCursors([cursor('u1', '阿明', '#2563eb', ['b'])], left.nodes);
    // x = -260 + 6（左上角内收），y = -20 - 6（顶缘上方 6px）
    expect(labelOf('u1')?.getAttribute('transform')).toBe('translate(-254, -26)');
  });
});

// ---------------------------------------------------------------------------
// setCursors：幂等协调更新
// ---------------------------------------------------------------------------

describe('setCursors：协调更新', () => {
  it('用户换节点：旧框移除、新框添加、标签仍单且重定位；他用户不受影响', () => {
    const api = createCursorLayer(scene);
    const u2: RemoteCursor = cursor('u2', '小李', '#ea580c', ['b']);
    api.setCursors([cursor('u1', '阿明', '#2563eb', ['d']), u2], baseLayout().nodes);
    const rectB = rectsIn(nodeG('b'), 'u2')[0] as Element;

    api.setCursors([cursor('u1', '阿明', '#2563eb', ['e']), u2], baseLayout().nodes);
    expect(rectsIn(nodeG('d'), 'u1')).toHaveLength(0);
    expect(rectsIn(nodeG('e'), 'u1')).toHaveLength(1);
    expect(svg.querySelectorAll('rect.gm-remote-selection[data-cursor-user="u1"]')).toHaveLength(1);
    expect(svg.querySelectorAll('g.gm-remote-cursor[data-cursor-user="u1"]')).toHaveLength(1);
    expect(labelOf('u1')?.getAttribute('transform')).toBe('translate(228, 194)'); // 右上角内收 6：x=200+80-46-6，y=200-6
    // u2 元素引用与位置原样保留
    expect(rectsIn(nodeG('b'), 'u2')[0]).toBe(rectB);
    expect(labelOf('u2')?.getAttribute('transform')).toBe('translate(108, -26)'); // b 右上角内收 6
  });

  it('用户从集合消失：其框与标签全部移除；保留用户元素不动', () => {
    const api = createCursorLayer(scene);
    api.setCursors(
      [cursor('u1', '阿明', '#2563eb', ['d']), cursor('u2', '小李', '#ea580c', ['b'])],
      baseLayout().nodes,
    );
    api.setCursors([cursor('u2', '小李', '#ea580c', ['b'])], baseLayout().nodes);
    expect(svg.querySelector('rect.gm-remote-selection[data-cursor-user="u1"]')).toBeNull();
    expect(labelOf('u1')).toBeNull();
    expect(rectsIn(nodeG('b'), 'u2')).toHaveLength(1);
    expect(labelOf('u2')?.querySelector('text')?.textContent).toBe('小李');
  });

  it('布局移动/缩放后重传 boxes：框尺寸与标签位置原地回填，不重复建元素', () => {
    const api = createCursorLayer(scene);
    const c: RemoteCursor = cursor('u1', '阿明', '#2563eb', ['b']);
    api.setCursors([c], baseLayout().nodes);
    const rect = rectsIn(nodeG('b'), 'u1')[0] as Element;
    const label = labelOf('u1') as SVGGElement;

    const moved = baseLayout();
    moved.nodes = moved.nodes.map((n) => (n.id === 'b' ? box('b', 160, -20, 140, 60) : n));
    api.setCursors([c], moved.nodes);
    expect(rectsIn(nodeG('b'), 'u1')[0]).toBe(rect); // 引用不变
    expect(rect.getAttribute('width')).toBe('140');
    expect(rect.getAttribute('height')).toBe('60');
    expect(labelOf('u1')).toBe(label);
    expect(label.getAttribute('transform')).toBe('translate(248, -26)'); // 移动后右上角内收 6：x=160+140-46-6，y=-20-6
    expect(svg.querySelectorAll('g.gm-remote-cursor')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// clear 与容错
// ---------------------------------------------------------------------------

describe('clear 与容错', () => {
  it('clear() 清空光标层与所有选区框', () => {
    const api = createCursorLayer(scene);
    api.setCursors(
      [cursor('u1', '阿明', '#2563eb', ['a', 'b']), cursor('u2', '小李', '#ea580c', ['d'])],
      baseLayout().nodes,
    );
    api.clear();
    expect(cursorLayer()?.children).toHaveLength(0);
    expect(svg.querySelectorAll('rect.gm-remote-selection')).toHaveLength(0);
    expect(cursorLayer()).not.toBeNull(); // 层本身保留，可继续 setCursors
  });

  it('不存在的 nodeId 优雅跳过：无框无标签、不抛错；部分存在则框落在存在节点', () => {
    const api = createCursorLayer(scene);
    expect(() =>
      api.setCursors([cursor('u9', '幽灵', '#0d9488', ['ghost'])], baseLayout().nodes),
    ).not.toThrow();
    expect(svg.querySelectorAll('rect.gm-remote-selection')).toHaveLength(0);
    expect(cursorLayer()?.querySelectorAll('g.gm-remote-cursor')).toHaveLength(0);

    api.setCursors([cursor('u8', '混合', '#7c3aed', ['b', 'ghost'])], baseLayout().nodes);
    expect(svg.querySelectorAll('rect.gm-remote-selection')).toHaveLength(1);
    expect(rectsIn(nodeG('b'), 'u8')).toHaveLength(1);
    expect(labelOf('u8')?.getAttribute('transform')).toBe('translate(108, -26)'); // b 右上角内收 6
  });

  it('同一用户重复条目与重复 nodeId 不产生重复元素（键幂等）', () => {
    const api = createCursorLayer(scene);
    api.setCursors(
      [cursor('u1', '阿明', '#2563eb', ['b', 'b']), cursor('u1', '阿明', '#2563eb', ['b'])],
      baseLayout().nodes,
    );
    expect(rectsIn(nodeG('b'), 'u1')).toHaveLength(1);
    expect(svg.querySelectorAll('g.gm-remote-cursor[data-cursor-user="u1"]')).toHaveLength(1);
  });
});
