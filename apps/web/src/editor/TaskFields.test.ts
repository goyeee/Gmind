// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type * as Y from 'yjs';
import {
  addChild,
  createTemplateDoc,
  getNode,
  ORIGIN_USER,
  ROOT_NODE_ID,
  setNodeTask,
  setText,
  withTransaction,
} from '@gmind/core';
import { effectiveProgress } from '@gmind/shared';
import { CustomFieldInput, deriveNodesOfDoc, SmartDateInput } from './TaskFields';

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
      setNodeTask(doc, a2, { progress: 80, owners: ['u1', 'u2'] });
      setNodeTask(doc, a, { status: 'doing', dueDate: '2026-09-30' });
    },
  );
  return doc;
}

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

  it('task 字段透传（status/owners/dates）， owners 数组为拷贝（改副本不动 doc）', () => {
    const doc = buildDoc();
    const nodes = deriveNodesOfDoc(doc);
    const a = nodes.find((n) => n.title === '任务A');
    expect(a?.task?.status).toBe('doing');
    expect(a?.task?.dueDate).toBe('2026-09-30');
    const a2 = nodes.find((n) => n.title === '子任务A2');
    expect(a2?.task?.owners).toEqual(['u1', 'u2']);
    a2?.task?.owners.push('mutated');
    expect(getNode(doc, a2?.id ?? '')?.task.owners).toEqual(['u1', 'u2']);
  });

  it('未设置字段的节点按读取侧缺省值（todo/0/null）；进度 Σ 与 shared 同口径', () => {
    const doc = buildDoc();
    const nodes = deriveNodesOfDoc(doc);
    // 「任务A」只设了 status/dueDate：progress/startDate/doneDate/owners 走缺省
    const a = nodes.find((n) => n.title === '任务A');
    expect(a?.task?.progress).toBe(0);
    expect(a?.task?.startDate).toBeNull();
    expect(a?.task?.owners).toEqual([]);
    // 父「任务A」自身进度 0：Σ = 直属子级 (40+80)/2 = 60（effectiveProgress 单一实现）
    expect(effectiveProgress(nodes, a?.id ?? '')).toBe(60);
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
              testIdPrefix: 'cf',
            }),
            createElement(CustomFieldInput, {
              def: { id: 'c2', name: '复核人', type: 'person' },
              value: null,
              memberIndex,
              onCommit,
              testIdPrefix: 'cf',
            }),
            createElement(CustomFieldInput, {
              def: { id: 'c3', name: '权重', type: 'progress' },
              value: 60,
              memberIndex,
              onCommit,
              testIdPrefix: 'cf',
            }),
            createElement(CustomFieldInput, {
              def: { id: 'c4', name: '截止', type: 'date' },
              value: '2026-10-01',
              memberIndex,
              onCommit,
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
