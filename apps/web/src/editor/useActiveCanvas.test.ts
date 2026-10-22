/**
 * 画布状态中枢单测（多画布计划三 Task 1，brief Step 1 先红）——controller 层无
 * DOM/React 依赖，直接钉死：
 * 1. switchCanvas 编排顺序（清临时态 → 存旧视口 → setActiveCanvas → 同步事件 →
 *    重建并恢复/首访 fit）与 reader/handle 画布绑定（切后读到 c2 的树）；
 * 2. UndoManager 按画布隔离（c1 编辑撤销不触 c2）且每画布缓存一个实例；
 * 3. 视口 Map 存取正确（回程恢复存档；capture 返回 null 不覆盖旧档）；
 * 4. 活动画布被删 → reconcileActive 同步回退编排。
 * React 薄壳 useActiveCanvas 只做状态镜像与 Y 观察器装配，逻辑全部在此层。
 */
import { describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import {
  addCanvas,
  createTemplateDoc,
  deleteCanvas,
  getNode,
  listCanvases,
  ORIGIN_USER,
  rootIdOf,
  setActiveCanvas,
  setText,
  undo as coreUndo,
} from '@gmind/core';
import type { ViewportState } from '@gmind/engine';
import {
  canvasIdPrefix,
  createActiveCanvasController,
  handleOf,
  readerOf,
  type CanvasSwitchDeps,
} from './useActiveCanvas';

interface Harness {
  deps: CanvasSwitchDeps;
  /** 编排调用顺序记录（含 onActiveChange 同步事件，由用例自行接入）。 */
  log: string[];
  rebuilt: Array<{ id: string; saved: ViewportState | null }>;
  setViewport(state: ViewportState | null): void;
}

function makeHarness(): Harness {
  const log: string[] = [];
  const rebuilt: Array<{ id: string; saved: ViewportState | null }> = [];
  let current: ViewportState | null = null;
  return {
    log,
    rebuilt,
    setViewport: (s) => {
      current = s;
    },
    deps: {
      captureViewport: () => {
        log.push('capture');
        return current;
      },
      rebuildForCanvas: (id, saved) => {
        log.push(`rebuild:${id}`);
        rebuilt.push({ id, saved });
      },
      resetEphemeral: (discard?: boolean) => {
        log.push(discard === true ? 'reset:discard' : 'reset');
      },
    },
  };
}

/**
 * 双画布文档：c1 = 模板首画布（root + 子节点「甲」），c2 = addCanvas 新建（空树，
 * 根文本「中心主题」）。addCanvas 会把 meta.activeCanvasId 置新，测试统一把初始
 * 活动画布固定回 c1。
 */
function makeTwoCanvasDoc(): { doc: Y.Doc; c1: string; c2: string } {
  const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
  const c1 = listCanvases(doc)[0].id;
  const c2 = addCanvas(doc, { name: '画布 2' });
  setActiveCanvas(doc, c1);
  return { doc, c1, c2 };
}

describe('createActiveCanvasController 初始态', () => {
  it('activeCanvasId 跟随 meta.activeCanvasId（resolveCanvasId 口径）；list 按 canvasOrder；当前画布 UM 预建', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const c = createActiveCanvasController(doc, makeHarness().deps);
    expect(c.activeCanvasId).toBe(c1);
    expect(c.list().map((i) => i.id)).toEqual([c1, c2]);
    expect(c.um()).toBeDefined();
    c.destroy();
  });

  it('meta.activeCanvasId 指向第二画布时初始跟随该画布（装载恢复上次画布语义）', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    setActiveCanvas(doc, c2);
    const c = createActiveCanvasController(doc, makeHarness().deps);
    expect(c.activeCanvasId).toBe(c2);
    c.destroy();
  });
});

describe('switchCanvas 编排', () => {
  it('顺序：清临时态 → 存旧视口 → 写 meta → 同步事件 → 重建（首访 saved=null 交 fit）；meta.activeCanvasId 已落写', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    const h = makeHarness();
    const c = createActiveCanvasController(doc, h.deps, {
      onActiveChange: (id) => h.log.push(`active:${id}`),
    });
    h.setViewport({ scale: 2, tx: 10, ty: 20 });
    c.switchCanvas(c2);
    expect(h.log).toEqual(['reset', 'capture', `active:${c2}`, `rebuild:${c2}`]);
    expect(h.rebuilt).toEqual([{ id: c2, saved: null }]);
    expect(c.activeCanvasId).toBe(c2);
    expect(doc.getMap('meta').get('activeCanvasId')).toBe(c2);
    c.destroy();
  });

  it('视口 Map：回程恢复旧画布存档；capture 返回 null 不覆盖已存档位', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const h = makeHarness();
    const c = createActiveCanvasController(doc, h.deps);
    h.setViewport({ scale: 2, tx: 10, ty: 20 });
    c.switchCanvas(c2); // c1 存档 {2,10,20}；c2 首访 fit
    h.setViewport({ scale: 0.5, tx: -3, ty: 7 });
    c.switchCanvas(c1); // c2 存档 {0.5,-3,7}；恢复 c1 存档
    expect(h.rebuilt[1]).toEqual({ id: c1, saved: { scale: 2, tx: 10, ty: 20 } });
    h.setViewport(null); // 无视口可存（防御分支）
    c.switchCanvas(c2); // c1 档位不被 null 覆盖；恢复 c2 存档
    expect(h.rebuilt[2]).toEqual({ id: c2, saved: { scale: 0.5, tx: -3, ty: 7 } });
    c.switchCanvas(c1);
    expect(h.rebuilt[3]).toEqual({ id: c1, saved: { scale: 2, tx: 10, ty: 20 } });
    c.destroy();
  });

  it('同画布幂等：不触发任何编排步骤', () => {
    const { doc, c1 } = makeTwoCanvasDoc();
    const h = makeHarness();
    const c = createActiveCanvasController(doc, h.deps);
    c.switchCanvas(c1);
    expect(h.log).toEqual([]);
    expect(h.rebuilt).toEqual([]);
    c.destroy();
  });
});

describe('reader/handle 画布绑定', () => {
  it('readerOf 惰性解析当前画布：switchCanvas 后读到 c2 的树，c1 节点不可见', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    const h = makeHarness();
    let bound = '';
    const c = createActiveCanvasController(doc, h.deps, {
      onActiveChange: (id) => {
        bound = id;
      },
    });
    bound = c.activeCanvasId;
    const reader = readerOf(doc, () => bound);
    expect(reader.getNode('root')?.text).toBe('本周计划');
    expect(reader.childrenIds('root')).toHaveLength(1); // 子节点「甲」
    c.switchCanvas(c2);
    const c2Root = rootIdOf(doc, c2);
    expect(reader.getNode(c2Root)?.text).toBe('中心主题');
    expect(reader.getNode('root')).toBeNull(); // c1 的树在新画布口径下不可见
    expect(reader.childrenIds(c2Root)).toEqual([]);
    expect(reader.summaries?.()).toEqual([]);
    c.destroy();
  });

  it('handleOf 写路径落绑定画布：切前写 c1、切后写 c2，互不越界', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const h = makeHarness();
    let bound = '';
    const c = createActiveCanvasController(doc, h.deps, {
      onActiveChange: (id) => {
        bound = id;
      },
    });
    bound = c.activeCanvasId;
    const handle = handleOf(doc, () => bound);
    const inC1 = handle.addChild(rootIdOf(doc, c1), { text: '经handle' });
    expect(getNode(doc, inC1, c1)?.text).toBe('经handle');
    expect(getNode(doc, inC1, c2)).toBeNull();
    handle.setText(inC1, '改写');
    expect(getNode(doc, inC1, c1)?.text).toBe('改写');
    c.switchCanvas(c2);
    const inC2 = handle.addChild(rootIdOf(doc, c2), { text: 'c2子' });
    expect(getNode(doc, inC2, c2)?.text).toBe('c2子');
    expect(getNode(doc, inC2, c1)).toBeNull();
    c.destroy();
  });

  it('getter 返回 undefined 时回退缺省解析（兼容旧调用形）', () => {
    const { doc } = makeTwoCanvasDoc();
    const reader = readerOf(doc, () => undefined);
    expect(reader.getNode('root')?.text).toBe('本周计划');
  });
});

describe('UndoManager 按画布隔离（裁定 2）', () => {
  it('每画布缓存一个实例；c1 编辑不进 c2 撤销栈，回切 c1 可撤销', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const c = createActiveCanvasController(doc, makeHarness().deps);
    const umC1 = c.um();
    expect(c.um()).toBe(umC1); // 缓存同实例
    c.switchCanvas(c2);
    const umC2 = c.um();
    expect(umC2).not.toBe(umC1);
    // 在 c2 活动期间对 c1 落写（评论定位等跨画布路径的先决隔离语义）
    setText(doc, rootIdOf(doc, c1), '改名', ORIGIN_USER, c1);
    expect(coreUndo(umC2)).toBe(false); // c2 栈不触 c1 编辑
    expect(getNode(doc, rootIdOf(doc, c1), c1)?.text).toBe('改名');
    c.switchCanvas(c1);
    expect(c.um()).toBe(umC1); // 回切复用缓存实例（撤销栈保住）
    expect(coreUndo(umC1)).toBe(true);
    expect(getNode(doc, rootIdOf(doc, c1), c1)?.text).toBe('本周计划');
    c.destroy();
  });
});

describe('reconcileActive（活动画布被删的同步回退）', () => {
  it('当前画布被 deleteCanvas 墓碑化 → 回退到 resolveCanvasId 结果并走完整编排', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const h = makeHarness();
    const c = createActiveCanvasController(doc, h.deps);
    c.switchCanvas(c2);
    expect(c.activeCanvasId).toBe(c2);
    deleteCanvas(doc, c2); // core 内置把 meta.activeCanvasId 回退到首个存活
    c.reconcileActive();
    expect(c.activeCanvasId).toBe(c1);
    expect(h.rebuilt.at(-1)).toEqual({ id: c1, saved: null });
    expect(c.list().map((i) => i.id)).toEqual([c1]);
    c.destroy();
  });

  it('当前画布存活时 no-op（不触发重建）', () => {
    const { doc, c1 } = makeTwoCanvasDoc();
    const h = makeHarness();
    const c = createActiveCanvasController(doc, h.deps);
    c.reconcileActive();
    expect(c.activeCanvasId).toBe(c1);
    expect(h.rebuilt).toEqual([]);
    c.destroy();
  });

  it('reconcile 路径丢弃在途编辑（discard=true）：resetEphemeral 不再按墓碑画布提交，回退完成、后续读不抛', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const h = makeHarness();
    // 模拟 EditorPage resetEphemeral：画布存活时提交（close(true)）不抛；画布被删
    // 成墓碑后提交写抛 CANVAS_NOT_FOUND，仅丢弃（close(false)）不抛。
    let tombstoned = false;
    const deps: CanvasSwitchDeps = {
      ...h.deps,
      resetEphemeral: (discard?: boolean) => {
        h.log.push(discard === true ? 'reset:discard' : 'reset');
        if (discard !== true && tombstoned) throw new Error('CANVAS_NOT_FOUND');
      },
    };
    const c = createActiveCanvasController(doc, deps);
    c.switchCanvas(c2); // 用户路径：提交在途编辑（画布存活，不抛）
    expect(h.log).toEqual(['reset', 'capture', `rebuild:${c2}`]);
    deleteCanvas(doc, c2); // 远端删除活动画布 → 观察器同步触发 reconcile
    tombstoned = true;
    expect(() => c.reconcileActive()).not.toThrow(); // 修复前：reset 抛错中断回退
    expect(h.log.filter((e) => e === 'reset:discard')).toHaveLength(1);
    expect(c.activeCanvasId).toBe(c1); // 回退完成，不留墓碑
    expect(h.rebuilt.at(-1)).toEqual({ id: c1, saved: null });
    // 后续读路径（readerOf 当帧画布口径）不再抛 CANVAS_NOT_FOUND
    expect(readerOf(doc, () => c.activeCanvasId).getNode(rootIdOf(doc, c1))?.text).toBe(
      '本周计划',
    );
    c.destroy();
  });
});

describe('canvasIdPrefix（idPrefix 契约）', () => {
  it('从画布 id 派生：c<id>-，不从画布名派生', () => {
    expect(canvasIdPrefix('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(
      'c01ARZ3NDEKTSV4RRFFQ69G5FAV-',
    );
    expect(canvasIdPrefix('canvas-1')).toBe('ccanvas-1-'); // 迁移常量同样吃得住
  });
});
