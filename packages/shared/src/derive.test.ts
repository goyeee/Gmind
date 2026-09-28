import { describe, expect, it } from 'vitest';
import {
  applyStatusRules,
  childrenOf,
  dayKey,
  effectiveProgress,
  flattenVisible,
  isOverdue,
  sortValue,
  todayStr,
  type DeriveNode,
  type DeriveTask,
} from './derive';

function task(p: Partial<DeriveTask> = {}): DeriveTask {
  return { status: 'todo', progress: 0, startDate: null, dueDate: null, doneDate: null, owners: [], ...p };
}

function node(id: string, parentId: string | null, extra: Partial<DeriveNode> = {}): DeriveNode {
  return { id, parentId, title: id, ...extra };
}

describe('childrenOf（源自 mindgrid）', () => {
  it('按 parentId 过滤、按 order 升序（缺省 order 视为 0）', () => {
    const a = node('a', null, { order: 2 });
    const b = node('b', null);
    const c = node('c', null, { order: 1 });
    const child = node('x', 'a');
    expect(childrenOf([a, b, c, child], null).map((n) => n.id)).toEqual(['b', 'c', 'a']);
    expect(childrenOf([a, b, c, child], 'a').map((n) => n.id)).toEqual(['x']);
    expect(childrenOf([a, b, c, child], 'missing')).toEqual([]);
  });

  it('空串 parentId 与 null 同为根（Gmind 适配：快照 root parentId 为空串）', () => {
    const a = node('a', '');
    const b = node('b', null);
    expect(childrenOf([a, b], null).map((n) => n.id)).toEqual(['a', 'b']);
    expect(childrenOf([a, b], '').map((n) => n.id)).toEqual(['a', 'b']);
  });
});

describe('effectiveProgress（父=直属子级均值，递归）', () => {
  it('叶子用自身 task.progress；无 task 视为 0；不存在的 id 为 0', () => {
    const leaf = node('leaf', null, { task: task({ progress: 40 }) });
    const noTask = node('noTask', null);
    expect(effectiveProgress([leaf], 'leaf')).toBe(40);
    expect(effectiveProgress([noTask], 'noTask')).toBe(0);
    expect(effectiveProgress([leaf], 'ghost')).toBe(0);
  });

  it('父级 = 子级有效进度的算术平均（含缺省子节点），Math.round 取整', () => {
    // P 的两个子级：A 有 task(100)，B 无 task（缺省计 0）→ P = 50
    const a = node('a', 'p', { task: task({ progress: 100 }) });
    const b = node('b', 'p');
    const p = node('p', null);
    expect(effectiveProgress([a, b, p], 'p')).toBe(50);
  });

  it('多层级递归向上汇总（孙→子→父）', () => {
    // X(100) ← P；Y(50) ← P ⇒ P = 75；G = avg(P=75, C=100) = 88（87.5 四舍五入）
    const x = node('x', 'p', { task: task({ progress: 100 }) });
    const y = node('y', 'p', { task: task({ progress: 50 }) });
    const p = node('p', 'g');
    const c = node('c', 'g', { task: task({ progress: 100 }) });
    const g = node('g', null);
    const nodes = [x, y, p, c, g];
    expect(effectiveProgress(nodes, 'p')).toBe(75);
    expect(effectiveProgress(nodes, 'g')).toBe(88);
  });

  it('均值四舍五入：0 与 55 → 28（27.5 向上取整）', () => {
    const a = node('a', 'p', { task: task({ progress: 0 }) });
    const b = node('b', 'p', { task: task({ progress: 55 }) });
    const p = node('p', null);
    expect(effectiveProgress([a, b, p], 'p')).toBe(28);
  });
});

describe('isOverdue（逾期边界，源自 mindgrid）', () => {
  const today = '2026-09-28';

  it('dueDate < today 且有效进度 < 100 且未完成 → 逾期', () => {
    const n = node('n', null, { task: task({ dueDate: '2026-09-27', progress: 50, status: 'doing' }) });
    expect(isOverdue(n, [n], today)).toBe(true);
  });

  it('dueDate = 今天不算逾期（严格小于）', () => {
    const n = node('n', null, { task: task({ dueDate: today, progress: 0 }) });
    expect(isOverdue(n, [n], today)).toBe(false);
  });

  it('有效进度 100 不算逾期（即便自身 progress 字段 < 100，以汇总值为准）', () => {
    const k1 = node('k1', 'n', { task: task({ progress: 100 }) });
    const k2 = node('k2', 'n', { task: task({ progress: 100 }) });
    const n = node('n', null, { task: task({ dueDate: '2026-09-27', progress: 0, status: 'doing' }) });
    expect(effectiveProgress([k1, k2, n], 'n')).toBe(100);
    expect(isOverdue(n, [k1, k2, n], today)).toBe(false);
  });

  it('status=done 不算逾期；无 dueDate 不算逾期', () => {
    const done = node('done', null, { task: task({ dueDate: '2026-09-27', progress: 10, status: 'done' }) });
    expect(isOverdue(done, [done], today)).toBe(false);
    const noDue = node('noDue', null, { task: task({ progress: 10 }) });
    expect(isOverdue(noDue, [noDue], today)).toBe(false);
    const noTask = node('noTask', null);
    expect(isOverdue(noTask, [noTask], today)).toBe(false);
  });

  it('today 缺省取本地今天：昨天到期且未完成 → 逾期', () => {
    const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000);
    const n = node('n', null, { task: task({ dueDate: yesterday, progress: 0 }) });
    expect(isOverdue(n, [n])).toBe(true);
  });
});

describe('flattenVisible（折叠态裁剪，源自 mindgrid）', () => {
  const a = node('a', null, { order: 0 });
  const b = node('b', 'a', { collapsed: true });
  const c = node('c', 'b');
  const d = node('d', null, { order: 1 });
  const nodes = [a, b, c, d];

  it('不传 rootId：全部根进表 depth=0，折叠节点子树被裁剪', () => {
    const rows = flattenVisible(nodes);
    expect(rows.map((r) => [r.node.id, r.depth, r.hasChildren])).toEqual([
      ['a', 0, true],
      ['b', 1, true],
      ['d', 0, false],
    ]);
  });

  it('传 rootId：根不进表、直属子级 depth=0，深度优先保持 order 序', () => {
    const x = node('x', 'r', { order: 0 });
    const z = node('z', 'x');
    const y = node('y', 'r', { order: 1 });
    const r = node('r', null);
    const rows = flattenVisible([r, x, y, z], 'r');
    expect(rows.map((row) => [row.node.id, row.depth, row.hasChildren])).toEqual([
      ['x', 0, true],
      ['z', 1, false],
      ['y', 0, false],
    ]);
  });

  it('非根节点折叠裁剪其子树；树根折叠时不输出任何行', () => {
    const x = node('x', 'r', { collapsed: true });
    const z = node('z', 'x');
    const rCollapsed = node('r', null, { collapsed: true });
    const rOpen = node('r', null);
    expect(flattenVisible([rOpen, x, z], 'r').map((row) => row.node.id)).toEqual(['x']);
    expect(flattenVisible([rCollapsed, x, z], 'r')).toEqual([]);
  });

  it('rootId 不存在 → 空表', () => {
    expect(flattenVisible(nodes, 'ghost')).toEqual([]);
  });
});

describe('sortValue（列排序键，照搬 mindgrid：todo<doing<blocked<done）', () => {
  const leaf = node('leaf', 'p', { task: task({ progress: 40 }) });
  const p = node('p', null, { title: '标题' });
  const nodes = [leaf, p];

  it('progress 列返回有效进度（父级=汇总值）', () => {
    expect(sortValue(nodes, leaf, 'progress')).toBe(40);
    expect(sortValue(nodes, p, 'progress')).toBe(40);
  });

  it('owner 列取首人名；未分配返回 \\uffff 排最后', () => {
    const multi = node('m', null, { task: task({ owners: ['u2', 'u1'] }) });
    const none = node('none', null, { task: task() });
    const noTask = node('noTask', null);
    expect(sortValue([multi], multi, 'owner')).toBe('u2');
    expect(sortValue([none], none, 'owner')).toBe('\uffff');
    expect(sortValue([noTask], noTask, 'owner')).toBe('\uffff');
  });

  it('status 列按 todo(0) < doing(1) < blocked(2) < done(3)；无 task 按 todo', () => {
    const mk = (status: DeriveTask['status']) => node(status, null, { task: task({ status }) });
    expect(sortValue([mk('todo')], mk('todo'), 'status')).toBe(0);
    expect(sortValue([mk('doing')], mk('doing'), 'status')).toBe(1);
    expect(sortValue([mk('blocked')], mk('blocked'), 'status')).toBe(2);
    expect(sortValue([mk('done')], mk('done'), 'status')).toBe(3);
    const noTask = node('noTask', null);
    expect(sortValue([noTask], noTask, 'status')).toBe(0);
  });

  it('三个日期列：未填返回 9999 排最后，否则返回原值', () => {
    const n = node('n', null, {
      task: task({ startDate: '2026-01-01', dueDate: null, doneDate: '2026-02-02' }),
    });
    expect(sortValue([n], n, 'startDate')).toBe('2026-01-01');
    expect(sortValue([n], n, 'dueDate')).toBe('9999');
    expect(sortValue([n], n, 'doneDate')).toBe('2026-02-02');
    const noTask = node('noTask', null);
    expect(sortValue([noTask], noTask, 'startDate')).toBe('9999');
  });

  it('updatedAt 列返回时间戳（缺省 0）；其余列（含 title）返回标题原文', () => {
    const n = node('n', null, { title: '乙', updatedAt: 123 });
    const noTs = node('noTs', null);
    expect(sortValue([n], n, 'updatedAt')).toBe(123);
    expect(sortValue([noTs], noTs, 'updatedAt')).toBe(0);
    expect(sortValue([n], n, 'title')).toBe('乙');
    expect(sortValue([n], n, 'unknown')).toBe('乙');
  });
});

describe('applyStatusRules（完成联动，源自 mindgrid；规则唯一实现）', () => {
  it('status→done：自动 doneDate=今天 且 progress 拉满（覆盖 patch 里更小的 progress）', () => {
    const before = node('n', null, { task: task({ status: 'doing', progress: 30 }) });
    const patch = applyStatusRules(before, { status: 'done', progress: 40 });
    expect(patch).toEqual({ status: 'done', progress: 100, doneDate: todayStr() });
  });

  it('手动传入 doneDate 时不覆盖：不自动填今天、也不强制进度', () => {
    const before = node('n', null, { task: task({ status: 'doing', progress: 30 }) });
    const patch = applyStatusRules(before, { status: 'done', doneDate: '2026-01-01' });
    expect(patch).toEqual({ status: 'done', doneDate: '2026-01-01' });
  });

  it('移出 done：自动清 doneDate（未显式传时）；显式传 doneDate 则保留', () => {
    const before = node('n', null, { task: task({ status: 'done', progress: 100, doneDate: '2026-01-01' }) });
    expect(applyStatusRules(before, { status: 'todo' })).toEqual({ status: 'todo', doneDate: null });
    expect(applyStatusRules(before, { status: 'todo', doneDate: '2026-03-03' })).toEqual({
      status: 'todo',
      doneDate: '2026-03-03',
    });
  });

  it('status 未变化不触发联动；无 task 的 before 按缺省 todo 处理', () => {
    const doneNode = node('n', null, { task: task({ status: 'done', doneDate: '2026-01-01' }) });
    expect(applyStatusRules(doneNode, { status: 'done', progress: 50 })).toEqual({ status: 'done', progress: 50 });
    const bare = node('bare', null);
    expect(applyStatusRules(bare, { status: 'done' })).toEqual({ status: 'done', progress: 100, doneDate: todayStr() });
    // 同值 status（todo→todo）也不触发
    expect(applyStatusRules(bare, { status: 'todo' })).toEqual({ status: 'todo' });
  });

  it('不修改入参 patch/before（纯函数）', () => {
    const before = node('n', null, { task: task({ status: 'doing' }) });
    const patch = { status: 'done' as const };
    applyStatusRules(before, patch);
    expect(patch).toEqual({ status: 'done' });
    expect(before.task?.doneDate).toBeNull();
  });
});

describe('日期工具（移植自 mindgrid types.ts，本地时区）', () => {
  it('dayKey 用本地时区年月日并补零', () => {
    expect(dayKey(new Date(2026, 8, 28, 23, 59).getTime())).toBe('2026-09-28');
    expect(dayKey(new Date(2026, 0, 1, 0, 0).getTime())).toBe('2026-01-01');
  });

  it('todayStr = dayKey(Date.now())', () => {
    expect(todayStr()).toBe(dayKey(Date.now()));
  });
});
