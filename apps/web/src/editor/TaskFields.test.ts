import { describe, expect, it } from 'vitest';
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
import { deriveNodesOfDoc } from './TaskFields';

/**
 * 任务字段公共控件（M7c-C3/C4 抽公共）纯函数单测：deriveNodesOfDoc 的快照映射
 * （root 不入列 / parentId 空串归 null / task 深拷贝）与 shared 派生规则的衔接
 * （父级进度 Σ=直属子级均值——业务口径唯一实现在 @gmind/shared，此处只锁接线）。
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
