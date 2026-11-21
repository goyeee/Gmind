// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type * as Y from 'yjs';
import {
  addCanvas,
  addChild,
  createTemplateDoc,
  getNode,
  listCanvases,
  ORIGIN_USER,
  ROOT_NODE_ID,
  rootIdOf,
  setActiveCanvas,
  setCustomColumns,
  setCustomField,
  setNodeTask,
  setText,
  withTransaction,
} from '@gmind/core';
import { taskProgressOf } from '@gmind/shared';
import { AssigneeField, CustomFieldInput, deriveNodesOfDoc, SmartDateInput } from './TaskFields';
import * as TaskFields from './TaskFields';

/**
 * 任务字段公共控件（M7c-C3/C4 抽公共）纯函数单测：deriveNodesOfDoc 的快照映射
 * （root 不入列 / parentId 空串归 null / task 深拷贝）与 shared 派生规则的衔接
 * （父级进度 Σ=直属子级均值——业务口径唯一实现在 @gmind/shared，此处只锁接线）。
 * 另含 SmartDateInput 外部值同步守卫的行为回归（jsdom + react-dom 渲染，Kimi P2）。
 */

function buildDoc(): Y.Doc {
  const doc = createTemplateDoc({ title: 'T', children: [] });
  withTransaction(
    doc,
    ORIGIN_USER,
    () => {
      const a = addChild(doc, ROOT_NODE_ID);
      setText(doc, a, '任务A');
      const a1 = addChild(doc, a);
      setText(doc, a1, '子任务A1');
      const a2 = addChild(doc, a);
      setText(doc, a2, '子任务A2');
      setNodeTask(doc, a1, { progress: 40 });
      setNodeTask(doc, a2, { progress: 80, owners: ['u1'] }); // 单负责人（2026-11-20 裁定：多人走人员列）
      setNodeTask(doc, a, { status: 'doing', progress: 20, dueDate: '2026-09-30' }); // 0%→doing 必须显式选进度（新门禁）
    },
  );
  return doc;
}

describe('协作者与任务成员目录', () => {
  it('任务候选可包含历史负责人，但仅协作者目录不会把历史负责人算成协作成员', () => {
    const build = (TaskFields as unknown as {
      buildMemberIndexes: (
        collaborators: Array<{ userId: string; nickname: string }>,
        presence: Array<{ userId: string; nickname: string }>,
        docOwnerIds: readonly string[],
      ) => { memberIndex: Map<string, { nickname: string }>; collaboratorIndex: Map<string, { nickname: string }> };
    }).buildMemberIndexes;
    const result = build(
      [{ userId: 'owner', nickname: '创建者' }, { userId: 'editor', nickname: '协作者' }],
      [{ userId: 'guest', nickname: '在线成员' }],
      ['owner', 'historical-owner'],
    );
    expect([...result.memberIndex.keys()]).toEqual(['owner', 'editor', 'guest', 'historical-owner']);
    expect([...result.collaboratorIndex.keys()]).toEqual(['owner', 'editor', 'guest']);
    expect(result.collaboratorIndex.has('historical-owner')).toBe(false);
  });
});

describe('deriveNodesOfDoc（M7c-C3/C4 抽公共）', () => {
  it('root 不入列；parentId 空串归 null；字段映射 text→title', () => {
    const nodes = deriveNodesOfDoc(buildDoc());
    expect(nodes.map((n) => n.id)).not.toContain(ROOT_NODE_ID);
    expect(nodes).toHaveLength(3);
    const a = nodes.find((n) => n.title === '任务A');
    expect(a).toBeDefined();
    expect(a?.parentId).toBe(ROOT_NODE_ID); // 直属子级 parentId=root（非空串，原样保留）
    const a1 = nodes.find((n) => n.title === '子任务A1');
    expect(a1?.parentId).toBe(a?.id);
    expect(a1?.order).toBe(0);
  });

  it('任务面板可选包含 root：根任务自动汇总读取子任务总进度', () => {
    const doc = buildDoc();
    setNodeTask(doc, ROOT_NODE_ID, { autoProgress: true });
    const nodes = deriveNodesOfDoc(doc, undefined, true);
    const root = nodes.find((n) => n.id === ROOT_NODE_ID);
    expect(root).toBeDefined();
    expect(taskProgressOf(nodes, ROOT_NODE_ID)).toBe(20);
  });

  it('task 字段透传（status/owners/dates）， owners 数组为拷贝（改副本不动 doc）', () => {
    const doc = buildDoc();
    const nodes = deriveNodesOfDoc(doc);
    const a = nodes.find((n) => n.title === '任务A');
    expect(a?.task?.status).toBe('doing');
    expect(a?.task?.dueDate).toBe('2026-09-30');
    const a2 = nodes.find((n) => n.title === '子任务A2');
    // 2026-11-20 新写入只存 ownerId（owners 键删除，读侧兼容仅对旧文档生效）
    expect(a2?.task?.ownerId).toBe('u1');
    expect(a2?.task?.owners).toEqual([]);
    a2?.task?.owners.push('mutated');
    expect(getNode(doc, a2?.id ?? '')?.task.ownerId).toBe('u1'); // 拷贝防御不改 doc
  });

  it('未设置字段的节点按读取侧缺省值（todo/0/null）；手动父级不汇总，开自动后 Σ 与 shared 同口径', () => {
    const doc = buildDoc();
    const aId = getNode(doc, ROOT_NODE_ID)!.childIds.find((id) => getNode(doc, id)?.text === '任务A');
    expect(aId).toBeTruthy();
    // 缺省口径看「未设置任何任务字段」的节点（夹具任务A 现为 doing/20——新门禁要求显式进度）
    const bId = addChild(doc, ROOT_NODE_ID);
    setText(doc, bId, '任务B');
    let nodes = deriveNodesOfDoc(doc);
    const b = nodes.find((n) => n.title === '任务B');
    expect(b?.task?.progress).toBe(0);
    expect(b?.task?.startDate).toBeNull();
    expect(b?.task?.owners).toEqual([]);
    expect(taskProgressOf(nodes, b?.id ?? '')).toBe(0);
    // 开启自动汇总后：Σ = 直属真正任务子级 (40+80)/2 = 60（taskProgressOf 新口径）
    setNodeTask(doc, aId!, { autoProgress: true });
    nodes = deriveNodesOfDoc(doc);
    expect(taskProgressOf(nodes, aId!)).toBe(60);
  });

  it('人员进度列（assignee）条目拉平进 customAssignees；effectiveProgress 按 2026-10-11 口径合成', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '任务X' }] });
    const id = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    setCustomColumns(doc, [{ id: 'w1', name: '前端配合', type: 'assignee' }], ORIGIN_USER);
    setNodeTask(doc, id, { owners: ['uA'], progress: 60 }, ORIGIN_USER);
    setCustomField(doc, id, 'w1', { uB: 80, uC: 30 }, ORIGIN_USER);
    const nodes = deriveNodesOfDoc(doc);
    const n = nodes.find((x) => x.title === '任务X')!;
    expect(n.customAssignees).toEqual([
      { user: 'uB', progress: 80, weight: 1 },
      { user: 'uC', progress: 30, weight: 1 },
    ]);
    // 2026-11-20 新口径：人员子进度不参与任务总进度——总进度=owner 独立值 60
    expect(taskProgressOf(nodes, n.id)).toBe(60);
  });

  it('人员列自定义比重（2026-10-12 裁定）：列 weighted=true 时映射每人 weight，合成按加权平均', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '任务W' }] });
    const id = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    setCustomColumns(
      doc,
      [{ id: 'w1', name: '测试', type: 'assignee', weighted: true }],
      ORIGIN_USER,
    );
    setNodeTask(doc, id, { owners: ['uA'], progress: 60 }, ORIGIN_USER);
    // uB 进度 100 比重 3、uC 进度 0 比重 1——weight 仅兼容读取映射（customAssignees），
    // 2026-11-20 裁定：人员比重不再参与任务总进度（总进度=owner 独立值 60）
    setCustomField(doc, id, 'w1', { uB: { progress: 100, weight: 3 }, uC: { progress: 0 } }, ORIGIN_USER);
    const nodes = deriveNodesOfDoc(doc);
    const n = nodes.find((x) => x.title === '任务W')!;
    expect(n.customAssignees).toEqual([
      { user: 'uB', progress: 100, weight: 3 },
      { user: 'uC', progress: 0, weight: 1 },
    ]);
    expect(taskProgressOf(nodes, n.id)).toBe(60);
  });

  it('无 assignee 条目的节点不出现 customAssignees 键（快照零新增键面）', () => {
    const nodes = deriveNodesOfDoc(buildDoc());
    for (const n of nodes) expect('customAssignees' in n).toBe(false);
  });

  it('多画布（Task 4 评审修复）：canvasId 限定当前画布子树，异画布节点不入列', () => {
    const doc = buildDoc(); // 画布 1：任务A/子任务A1/子任务A2
    const c1 = listCanvases(doc)[0]!.id;
    const c2 = addCanvas(doc, { name: '画布 2' });
    setActiveCanvas(doc, c1); // addCanvas 会把活动置新，固定回首画布
    const r2 = rootIdOf(doc, c2);
    const b = addChild(doc, r2, { text: '画布2任务' }, ORIGIN_USER, c2);
    setNodeTask(doc, b, { progress: 10, owners: ['uZ'] }, ORIGIN_USER, c2);
    // 限定画布 2：只有画布 2 子树（root 不入列、parentId 挂画布 2 root）
    const inC2 = deriveNodesOfDoc(doc, c2);
    expect(inC2.map((n) => n.title)).toEqual(['画布2任务']);
    expect(inC2[0]?.parentId).toBe(r2);
    expect(inC2[0]?.task?.ownerId).toBe('uZ');
    // 缺省解析（activeCanvasId=画布 1）：仍拉平画布 1，不含画布 2 节点
    const inDefault = deriveNodesOfDoc(doc);
    expect(inDefault.map((n) => n.title)).not.toContain('画布2任务');
    expect(inDefault).toHaveLength(3);
    doc.destroy();
  });
});

describe('SmartDateInput 外部值同步守卫（Kimi P2 回归）', () => {
  it('焦点在另一个 SmartDateInput 时本实例仍同步外部值；自身聚焦中不打断', () => {
    // React 18 createRoot 手动渲染要求显式声明 act 环境（无 @testing-library，直挂 react-dom）
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const dateInputs = (): HTMLInputElement[] =>
      [...container.querySelectorAll<HTMLInputElement>('input[data-smart-date]')];
    const renderBoth = (v1: string | null, v2: string | null): void => {
      act(() => {
        root.render(
          createElement(
            'div',
            null,
            createElement(SmartDateInput, { value: v1, onCommit: () => undefined }),
            createElement(SmartDateInput, { value: v2, onCommit: () => undefined }),
          ),
        );
      });
    };
    try {
      renderBoth('2026-01-01', null);
      const [first, second] = dateInputs();
      expect(first.value).toBe('2026-01-01');
      // 焦点滞留在**另一个**日期框（快速面板提交日期后的真实场景）：
      // 旧守卫按 [data-smart-date] 全局判焦会连坐跳过本实例同步且永不再触发
      // （focus 会触发空值实例的 onFocus 预填，属状态更新，包进 act）
      act(() => {
        second.focus();
      });
      expect(document.activeElement).toBe(second);
      renderBoth('2026-03-15', null);
      expect(first.value).toBe('2026-03-15'); // 他处焦点不连坐，外部值照常落格
      // 自身聚焦中（正在编辑本格）：同步跳过，本地编辑值不被远端值打断
      act(() => {
        first.focus();
      });
      renderBoth('2026-04-01', null);
      expect(first.value).toBe('2026-03-15');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});

describe('CustomFieldInput（自定义属性单字段，任务 2 公共控件）', () => {
  it('按列类型渲染：text 占位+初值 / person 空值占位+成员 chips / progress 0-100 初值 / date 直染 SmartDateInput', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const memberIndex = new Map([
      ['u1', { userId: 'u1', nickname: '甲' }],
      ['u2', { userId: 'u2', nickname: '乙' }],
    ]);
    const onCommit = (): void => undefined;
    const onAssigneeProgress = (): void => undefined;
    const onAssigneeToggle = (): void => undefined;
    try {
      act(() => {
        root.render(
          createElement(
            'div',
            null,
            createElement(CustomFieldInput, {
              def: { id: 'c1', name: '备注', type: 'text' },
              value: '初值',
              memberIndex,
              onCommit,
              onAssigneeProgress,
              onAssigneeToggle,
              testIdPrefix: 'cf',
            }),
            createElement(CustomFieldInput, {
              def: { id: 'c2', name: '复核人', type: 'assignee' },
              value: null,
              memberIndex,
              onCommit,
              onAssigneeProgress,
              onAssigneeToggle,
              testIdPrefix: 'cf',
            }),
            createElement(CustomFieldInput, {
              def: { id: 'c3', name: '权重', type: 'progress' },
              value: 60,
              memberIndex,
              onCommit,
              onAssigneeProgress,
              onAssigneeToggle,
              testIdPrefix: 'cf',
            }),
            createElement(CustomFieldInput, {
              def: { id: 'c4', name: '截止', type: 'date' },
              value: '2026-10-01',
              memberIndex,
              onCommit,
              onAssigneeProgress,
              onAssigneeToggle,
              testIdPrefix: 'cf',
            }),
          ),
        );
      });
      // text：单行输入，初值 + 「填写…」占位
      const text = container.querySelector<HTMLInputElement>('input[data-testid="cf-c1"]');
      expect(text).toBeTruthy();
      expect(text!.value).toBe('初值');
      expect(text!.placeholder).toBe('填写…');
      // person：空值占位「选择成员」+ 成员 chips（MemberMultiSelect，testid 前缀拼接）
      expect(container.textContent).toContain('选择成员');
      expect(container.querySelector('[data-testid="cf-c2-member-u1"]')).toBeTruthy();
      expect(container.querySelector('[data-testid="cf-c2-member-u2"]')).toBeTruthy();
      // progress：0-100 数字输入带初值
      const progress = container.querySelector<HTMLInputElement>('input[data-testid="cf-c3"]');
      expect(progress).toBeTruthy();
      expect(progress!.value).toBe('60');
      expect(progress!.max).toBe('100');
      // date：复用 SmartDateInput（data-smart-date 标记 + testid 透传）
      const date = container.querySelector<HTMLInputElement>('input[data-testid="cf-c4"]');
      expect(date).toBeTruthy();
      expect(date!.getAttribute('data-smart-date')).toBe('1');
      expect(date!.value).toBe('2026-10-01');
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});

describe('AssigneeField 面板形态（2026-11-21 需求方二次裁定：不单独列行，跟负责人一样）', () => {
  const memberIndex = new Map([
    ['u1', { userId: 'u1', nickname: '甲' }],
    ['u2', { userId: 'u2', nickname: '乙' }],
  ]);
  const render = (props: Record<string, unknown>): { container: HTMLDivElement; cleanup: () => void } => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(AssigneeField, props as never));
    });
    return {
      container,
      cleanup: () => {
        act(() => {
          root.unmount();
        });
        container.remove();
      },
    };
  };

  it('传入 onAvatarPick：只渲染成员 chips（无单独行/×/占位），已指派成员点头像回调带当前进度，点 chip 本体取消指派', () => {
    const picks: Array<{ userId: string; progress: number }> = [];
    const toggles: Array<{ userId: string; assigned: boolean }> = [];
    const { container, cleanup } = render({
      value: { u1: { progress: 40 } },
      memberIndex,
      onAssigneeProgress: () => undefined,
      onAssigneeToggle: (userId: string, assigned: boolean) => toggles.push({ userId, assigned }),
      onAvatarPick: (userId: string, progress: number) => picks.push({ userId, progress }),
      testId: 'af',
    });
    try {
      // 无单独行、无 ×、无输入框、无占位文案（与负责人区块同构，chips 唯一形态）
      expect(container.querySelector('.task-assignee-row')).toBeNull();
      expect(container.querySelector('[data-testid="af-remove-u1"]')).toBeNull();
      expect(container.querySelector('input[data-testid="af-progress-u1"]')).toBeNull();
      expect(container.textContent).not.toContain('选择成员并更新进度');
      // 已指派 u1：chip 内头像独立按钮存在；未指派 u2：只有普通 chip
      const btn = container.querySelector<HTMLButtonElement>('button[data-testid="af-avatar-u1"]');
      expect(btn).toBeTruthy();
      expect(container.querySelector('[data-testid="af-avatar-u2"]')).toBeNull();
      expect(container.querySelector('[data-testid="af-member-u2"]')).toBeTruthy();
      // 点 u1 头像 → onAvatarPick 带当前进度 40
      act(() => {
        btn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(picks).toEqual([{ userId: 'u1', progress: 40 }]);
      // 点 u1 chip 本体（名字部分）→ 取消指派
      const chip = container.querySelector<HTMLButtonElement>('button[data-testid="af-member-u1"]');
      expect(chip).toBeTruthy();
      act(() => {
        chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(toggles).toEqual([{ userId: 'u1', assigned: false }]);
    } finally {
      cleanup();
    }
  });

  it('未传 onAvatarPick（表格单元格弹层形态）：保持行+进度输入框原行为', () => {
    const { container, cleanup } = render({
      value: { u1: { progress: 40 } },
      memberIndex,
      onAssigneeProgress: () => undefined,
      onAssigneeToggle: () => undefined,
      testId: 'af',
    });
    try {
      expect(container.querySelector('button[data-testid="af-avatar-u1"]')).toBeNull();
      expect(container.querySelector('[data-testid="af-row-u1"]')).toBeTruthy();
      const input = container.querySelector<HTMLInputElement>('input[data-testid="af-progress-u1"]');
      expect(input).toBeTruthy();
      expect(input!.value).toBe('40');
    } finally {
      cleanup();
    }
  });
});
