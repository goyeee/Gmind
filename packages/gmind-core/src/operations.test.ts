import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Transaction } from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc, docToState } from './doc';
import { GmindCoreError } from './errors';
import { childrenIds, countAlive, getMeta, getNode } from './read';
import {
  addChild,
  applyStyle,
  deleteNodes,
  moveNode,
  setImage,
  setIcon,
  setCustomColumns,
  setCustomField,
  setNodeTask,
  setNote,
  setDescription,
  setHref,
  setCollapsed,
  setNodeSide,
  setStyle,
  setText,
  setTableView,
  toggleCollapse,
  withTransaction,
  ORIGIN_SYSTEM,
  ORIGIN_USER,
} from './operations';
import { createUndoManager, redo, undo } from './undo';
import {
  CUSTOM_COLUMN_LIMIT,
  CUSTOM_COLUMN_NAME_MAX,
  CUSTOM_TEXT_MAX_LENGTH,
  MARKER_MULTI_MAX,
  MAX_DESCRIPTION_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_TASK_OWNERS,
  OTHER_VALUES,
  TABLE_BUILTIN_COLUMN_KEYS,
  type CustomColumnDef,
  type IconGroup,
  type TableViewSort,
} from './constants';

/** 按文本查节点 id（测试辅助；模板生成的 ULID 不可预知）。 */
function findIdByText(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node with text "${text}" not found`);
}

/** 删除/移动用例的固定树：root → [A[A1[A1a], A2], B[B1]]。 */
function buildTestTree(): Y.Doc {
  return createTemplateDoc({
    title: 'T',
    children: [
      { text: 'A', children: [{ text: 'A1', children: [{ text: 'A1a' }] }, { text: 'A2' }] },
      { text: 'B', children: [{ text: 'B1' }] },
    ],
  });
}

/** 全文档节点快照（用于断言「树无变化」）。 */
function fullSnapshot(doc: Y.Doc): string {
  const out: Record<string, unknown> = {};
  for (const id of doc.getMap('nodes').keys()) out[id] = getNode(doc, id);
  return JSON.stringify(out);
}

describe('addChild', () => {
  it('返回 26 位 ULID 且 getNode 读回默认字段齐全', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const id = addChild(doc, ROOT_NODE_ID, { text: 'A' });
    expect(id).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}$/);
    const snap = getNode(doc, id)!;
    expect(snap).not.toBeNull();
    expect(snap.parentId).toBe(ROOT_NODE_ID);
    expect(snap.text).toBe('A');
    expect(snap.childIds).toEqual([]);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([id]);
  });

  it('不带 opts.text 默认空串，重复 addChild 产出唯一 id', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const a = addChild(doc, ROOT_NODE_ID);
    const b = addChild(doc, ROOT_NODE_ID);
    expect(a).not.toBe(b);
    expect(getNode(doc, a)!.text).toBe('');
    expect(getNode(doc, b)!.text).toBe('');
  });

  it('指定 index 插入到对应位置（childrenIds 顺序）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    const before = childrenIds(doc, ROOT_NODE_ID);
    const c = addChild(doc, ROOT_NODE_ID, { index: 1, text: 'C' });
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([before[0], c, before[1]]);
  });

  it('index 越界 clamp 到末尾（负数与超过长度）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    const neg = addChild(doc, ROOT_NODE_ID, { index: -3 });
    expect(childrenIds(doc, ROOT_NODE_ID)[2]).toBe(neg);
    const over = addChild(doc, ROOT_NODE_ID, { index: 99 });
    expect(childrenIds(doc, ROOT_NODE_ID)[3]).toBe(over);
  });

  it('opts.text 超 500 字抛 TEXT_TOO_LONG（T3 评审遗留）且文档零变更', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    try {
      addChild(doc, ROOT_NODE_ID, { text: '长'.repeat(501) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('TEXT_TOO_LONG');
      expect((e as GmindCoreError).message).toBe('节点文本长度已达上限');
    }
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([]);
    expect(doc.getMap('nodes').size).toBe(1);
  });

  it('对 root addChild 合法；对不存在 parent 抛 NODE_NOT_FOUND；对墓碑 parent 抛 NODE_DELETED', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    expect(addChild(doc, ROOT_NODE_ID, { text: 'R1' })).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}$/);

    expect(() => addChild(doc, 'nope')).toThrow(GmindCoreError);
    try {
      addChild(doc, 'nope');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }

    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const aNode = doc.getMap('nodes').get(aId) as { set: (k: string, v: unknown) => void };
    doc.transact(() => aNode.set('deleted', true));
    try {
      addChild(doc, aId);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
  });
});

describe('setText', () => {
  it('正常写入文本', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '旧文本' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setText(doc, id, '新文本');
    expect(getNode(doc, id)!.text).toBe('新文本');
  });

  it('501 字抛 TEXT_TOO_LONG（消息固定）且文档未被修改', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '原文本' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = getNode(doc, id)!.text;
    try {
      setText(doc, id, '长'.repeat(501));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('TEXT_TOO_LONG');
      expect((e as GmindCoreError).message).toBe('节点文本长度已达上限');
    }
    expect(getNode(doc, id)!.text).toBe(before);
  });
});

describe('withTransaction', () => {
  it('fn 返回值透传，且 origin 写入事务（afterTransaction 可捕获）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    let captured: unknown;
    doc.on('afterTransaction', (tr: Transaction) => {
      captured = tr.origin;
    });
    const ret = withTransaction(doc, ORIGIN_SYSTEM, () => 'ok');
    expect(ret).toBe('ok');
    expect(captured).toBe('system');
  });

  it('origin 常量：ORIGIN_USER=user、ORIGIN_SYSTEM=system', () => {
    expect(ORIGIN_USER).toBe('user');
    expect(ORIGIN_SYSTEM).toBe('system');
  });
});

describe('withTransaction 嵌套：normalize 由最外层统一执行（内层跳过）', () => {
  it('外层包两个 addChild：撤销栈恰一条，一次 undo 撤销两个子节点，redo 恢复', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const um = createUndoManager(doc); // 先于外层事务创建（user origin）
    const ids: string[] = [];
    withTransaction(doc, ORIGIN_USER, () => {
      ids.push(addChild(doc, ROOT_NODE_ID, { text: 'A' }));
      ids.push(addChild(doc, ROOT_NODE_ID, { text: 'B' }));
    });

    expect(um.undoStack.length).toBe(1); // 恰一条（不是三条：嵌套不产生独立撤销单元）
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual(ids);

    expect(undo(um)).toBe(true); // 一次 undo 撤销两个子节点
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([]);
    for (const id of ids) expect(getNode(doc, id)).toBeNull();

    expect(redo(um)).toBe(true);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual(ids);
    for (const id of ids) expect(getNode(doc, id)).not.toBeNull();
  });

  it('内层不重复 normalize：预置违例的修复归最外层 system origin，undo 不复活残缺', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const aId = findIdByText(doc, 'A');
    const um = createUndoManager(doc);
    // 裸写预置违例（ghost 条目；origin null 不进撤销栈）
    doc.transact(() => {
      const rootChildren = (doc.getMap('nodes').get(ROOT_NODE_ID) as Y.Map<unknown>).get(
        'children',
      ) as Y.Array<string>;
      rootChildren.push(['ghost-id']);
    });
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId, 'ghost-id']); // 残缺在库

    withTransaction(doc, ORIGIN_USER, () => {
      addChild(doc, ROOT_NODE_ID, { text: 'B' }); // 嵌套 withTransaction
    });
    expect(um.undoStack.length).toBe(1);
    // 修复已发生（外层脏区覆盖 root children 数组）：ghost 条目被清理
    expect(childrenIds(doc, ROOT_NODE_ID)).not.toContain('ghost-id');

    expect(undo(um)).toBe(true); // 撤销 user 事务：B 消失
    // 修复不随 undo 复活 → 修复写入归最外层 system origin（不在 user 栈项内）
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId]);
    expect(getNode(doc, aId)!.deleted).toBe(false);
  });

  it('外层 fn 抛出：内层跳过 normalize，文档除 fn 自身部分写入外无修复提交', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const aId = findIdByText(doc, 'A');
    doc.transact(() => {
      const rootChildren = (doc.getMap('nodes').get(ROOT_NODE_ID) as Y.Map<unknown>).get(
        'children',
      ) as Y.Array<string>;
      rootChildren.push(['ghost-id']);
    });
    let newId = '';
    expect(() =>
      withTransaction(doc, ORIGIN_USER, () => {
        newId = addChild(doc, ROOT_NODE_ID, { text: 'B' }); // 内层 withTransaction 已提交
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // fn 自身部分写入已提交（Yjs 语义：抛出前已集成的写入保留）
    expect(getNode(doc, newId)).not.toBeNull();
    // 内层 normalize 未越权提交：预置 ghost 残留原样（normalize 写入随外层跳过）
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId, 'ghost-id', newId]);
  });
});

describe('deleteNodes', () => {
  it('删叶子：deleted=true、从父 children 消失、其余树不动', () => {
    const doc = buildTestTree();
    const b1Id = findIdByText(doc, 'B1');
    const bId = findIdByText(doc, 'B');
    const rootChildIdsBefore = getNode(doc, ROOT_NODE_ID)!.childIds;
    const aliveBefore = countAlive(doc);
    const before = JSON.parse(fullSnapshot(doc));

    deleteNodes(doc, [b1Id]);

    expect(getNode(doc, b1Id)!.deleted).toBe(true);
    expect(childrenIds(doc, bId)).toEqual([]);
    // 其余树不动：除 b1 本体与父 B 的 children 外，全部节点快照与删除前一致
    const after = JSON.parse(fullSnapshot(doc));
    for (const id of Object.keys(before)) {
      if (id === b1Id) continue;
      if (id === bId) {
        expect(after[id].childIds).toEqual([]);
        after[id].childIds = before[id].childIds; // children 变化已被上面单独断言
      }
      expect(after[id], id).toEqual(before[id]);
    }
    expect(getNode(doc, ROOT_NODE_ID)!.childIds).toEqual(rootChildIdsBefore);
    expect(countAlive(doc)).toBe(aliveBefore - 1);
  });

  it('删中间节点：整个子树全部墓碑；后代自身 children 数组保留（raw 检查）', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a1aId = findIdByText(doc, 'A1a');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');

    deleteNodes(doc, [aId]);

    for (const id of [aId, a1Id, a1aId, a2Id]) {
      expect(getNode(doc, id)!.deleted).toBe(true);
    }
    // 后代节点的 children 数组保留不动（快照可还原）
    const a1Raw = doc.getMap('nodes').get(a1Id) as Y.Map<unknown>;
    const a1Children = a1Raw.get('children') as Y.Array<string>;
    expect(a1Children).toBeInstanceOf(Y.Array);
    expect(a1Children.toArray()).toEqual([a1aId]);
    const aRaw = doc.getMap('nodes').get(aId) as Y.Map<unknown>;
    expect((aRaw.get('children') as Y.Array<string>).toArray()).toEqual([a1Id, a2Id]);
    // 从父 children 移除，其余树不动
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([bId]);
    expect(getNode(doc, bId)!.deleted).toBe(false);
  });

  it("deleteNodes(['root'])：root 存活，原全部子孙墓碑（FR-EDT-002 降级）", () => {
    const doc = buildTestTree();
    const allNonRoot = [...doc.getMap('nodes').keys()].filter((id) => id !== ROOT_NODE_ID);

    deleteNodes(doc, ['root']);

    expect(getNode(doc, ROOT_NODE_ID)!.deleted).toBe(false);
    expect(getNode(doc, ROOT_NODE_ID)!.childIds).toEqual([]);
    for (const id of allNonRoot) {
      expect(getNode(doc, id)!.deleted, id).toBe(true);
    }
    expect(countAlive(doc)).toBe(0);
  });

  it('混入不存在的 id 静默忽略，其余正常处理', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const bId = findIdByText(doc, 'B');

    deleteNodes(doc, ['no-such-id', bId]);

    expect(getNode(doc, 'no-such-id')).toBeNull();
    expect(getNode(doc, bId)!.deleted).toBe(true);
    expect(getNode(doc, aId)!.deleted).toBe(false);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId]);
  });

  it('批量 [祖先, 后代] 连删：不改动已墓碑祖先的保留 children 数组（T4 评审钉死）', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a1aId = findIdByText(doc, 'A1a');
    const a2Id = findIdByText(doc, 'A2');
    const childIdsBefore = getNode(doc, aId)!.childIds;

    deleteNodes(doc, [aId, a1Id]);

    // 后代处理不得改动祖先保留的 children 数组（快照还原约束）
    const aRaw = doc.getMap('nodes').get(aId) as Y.Map<unknown>;
    expect((aRaw.get('children') as Y.Array<string>).toArray()).toEqual(childIdsBefore);
    expect((aRaw.get('children') as Y.Array<string>).toArray()).toEqual([a1Id, a2Id]);
    expect(getNode(doc, aId)!.childIds).toEqual(childIdsBefore);
    // 后代仍正常墓碑
    expect(getNode(doc, a1Id)!.deleted).toBe(true);
    expect(getNode(doc, a1aId)!.deleted).toBe(true);
  });
});

describe('moveNode', () => {
  it('移动到新父：parentId 更新、旧父移除、插入新父指定位置', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');
    const b1Id = findIdByText(doc, 'B1');

    moveNode(doc, a2Id, bId, 0);

    expect(getNode(doc, a2Id)!.parentId).toBe(bId);
    expect(getNode(doc, a2Id)!.deleted).toBe(false);
    expect(childrenIds(doc, aId)).toEqual([a1Id]);
    expect(childrenIds(doc, bId)).toEqual([a2Id, b1Id]);
  });

  it('index 缺省追加末尾，同父内移动仅重排', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
    });
    const aId = findIdByText(doc, 'A');
    const cId = findIdByText(doc, 'C');

    moveNode(doc, cId, ROOT_NODE_ID);

    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId, findIdByText(doc, 'B'), cId]);
    expect(getNode(doc, cId)!.parentId).toBe(ROOT_NODE_ID);

    moveNode(doc, cId, ROOT_NODE_ID, 0);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([cId, aId, findIdByText(doc, 'B')]);
  });

  it('移动到自己后代抛 CYCLE_FORBIDDEN 且树无变化', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1aId = findIdByText(doc, 'A1a');
    const before = fullSnapshot(doc);

    try {
      moveNode(doc, aId, a1aId);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('CYCLE_FORBIDDEN');
    }
    expect(fullSnapshot(doc)).toBe(before);
  });

  it("moveNode('root', …) 抛 ROOT_FORBIDDEN", () => {
    const doc = buildTestTree();
    const bId = findIdByText(doc, 'B');
    try {
      moveNode(doc, ROOT_NODE_ID, bId);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('ROOT_FORBIDDEN');
    }
  });

  it('移动到墓碑父抛 NODE_DELETED；不存在父抛 NODE_NOT_FOUND', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');

    const bRaw = doc.getMap('nodes').get(bId) as { set: (k: string, v: unknown) => void };
    doc.transact(() => bRaw.set('deleted', true));
    try {
      moveNode(doc, a2Id, bId);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
    // 树无变化：a2 仍在原位
    expect(getNode(doc, a2Id)!.parentId).toBe(aId);

    try {
      moveNode(doc, a2Id, 'nope');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }
  });
});

describe('setNote', () => {
  it(`恰好 ${MAX_NOTE_LENGTH} 字写入成功并经 getNode 读回`, () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const note = '注'.repeat(MAX_NOTE_LENGTH);
    setNote(doc, id, note);
    expect(getNode(doc, id)!.note).toBe(note);
  });

  it(`${MAX_NOTE_LENGTH + 1} 字抛 NOTE_TOO_LONG（消息固定）且文档零变更`, () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    try {
      setNote(doc, id, '注'.repeat(MAX_NOTE_LENGTH + 1));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('NOTE_TOO_LONG');
      expect((e as GmindCoreError).message).toBe('备注长度已达上限');
    }
    expect(fullSnapshot(doc)).toBe(before);
  });
});

describe('setDescription（M7c-C1）', () => {
  it(`恰好 ${MAX_DESCRIPTION_LENGTH} 字写入成功并经 getNode 读回；空串清除`, () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const desc = '描'.repeat(MAX_DESCRIPTION_LENGTH);
    setDescription(doc, id, desc);
    expect(getNode(doc, id)!.description).toBe(desc);
    setDescription(doc, id, '');
    expect(getNode(doc, id)!.description).toBe('');
  });

  it(`${MAX_DESCRIPTION_LENGTH + 1} 字抛 DESCRIPTION_TOO_LONG（两段式文案）且文档零变更`, () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    try {
      setDescription(doc, id, '描'.repeat(MAX_DESCRIPTION_LENGTH + 1));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('DESCRIPTION_TOO_LONG');
      expect((e as GmindCoreError).message).toBe(`描述长度已达上限（最多 ${MAX_DESCRIPTION_LENGTH} 字），请精简后再保存`);
    }
    expect(fullSnapshot(doc)).toBe(before);
  });

  it('ORIGIN_USER 写入可撤销（undo 回到写入前空串；同 setIcon undo 用例的单写模式，避免 captureTimeout 合并歧义）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const um = createUndoManager(doc);
    setDescription(doc, id, '一句话描述');
    expect(getNode(doc, id)!.description).toBe('一句话描述');
    undo(um);
    expect(getNode(doc, id)!.description).toBe('');
  });
});

describe('setHref', () => {
  it('https 与 http 合法写入；空串合法（清除链接）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setHref(doc, id, 'https://a.dev');
    expect(getNode(doc, id)!.href).toBe('https://a.dev');
    setHref(doc, id, 'http://a.dev');
    expect(getNode(doc, id)!.href).toBe('http://a.dev');
    setHref(doc, id, '');
    expect(getNode(doc, id)!.href).toBe('');
  });

  it('javascript: 与 ftp: 抛 INVALID_HREF（消息固定）且文档零变更', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    for (const bad of ['javascript:alert(1)', 'ftp://x']) {
      try {
        setHref(doc, id, bad);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(GmindCoreError);
        expect((e as GmindCoreError).code).toBe('INVALID_HREF');
        expect((e as GmindCoreError).message).toBe('链接仅支持 http/https');
      }
    }
    expect(fullSnapshot(doc)).toBe(before);
  });
});

describe('setImage', () => {
  it('写入 {key,w,h} 并经 getNode 读回；null 清除（image 读回 null）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    expect(getNode(doc, id)!.image).toBeNull();
    const image = { key: 'img-1', w: 120, h: 80 };
    setImage(doc, id, image);
    expect(getNode(doc, id)!.image).toEqual(image);
    setImage(doc, id, null);
    expect(getNode(doc, id)!.image).toBeNull();
  });
});

describe('setIcon（M7b-W1 八组制多值）', () => {
  it('single 组替换即覆盖：flag flag→flagPennant 后仅剩新值（组内单选语义）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'flag', 'flag');
    expect(getNode(doc, id)!.icons).toEqual({ flag: ['flag'] });
    setIcon(doc, id, 'flag', 'flagPennant');
    expect(getNode(doc, id)!.icons).toEqual({ flag: ['flagPennant'] });
  });

  it('跨组并存 + multi 组叠加：mood/priority/other/emoji 四组（值目录内取值）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'priority', 'p2');
    setIcon(doc, id, 'mood', 'smile');
    setIcon(doc, id, 'other', 'important');
    setIcon(doc, id, 'other', 'done'); // multi 组叠加
    setIcon(doc, id, 'emoji', '😄');
    expect(getNode(doc, id)!.icons).toEqual({
      mood: ['smile'],
      priority: ['p2'],
      other: ['important', 'done'],
      emoji: ['😄'],
    });
  });

  it('multi 组 toggle：同值再点移除该枚（组空删键）；异值继续追加至上限 8', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'other', 'important');
    setIcon(doc, id, 'other', 'important'); // 再点同值 = 移除该枚
    expect(getNode(doc, id)!.icons).toEqual({});
    for (const v of OTHER_VALUES.slice(0, MARKER_MULTI_MAX)) setIcon(doc, id, 'other', v); // 前 8 枚入组（目录 27 枚，只取上限数）
    expect(getNode(doc, id)!.icons.other).toHaveLength(MARKER_MULTI_MAX);
    expect(() => setIcon(doc, id, 'other', 'printer')).toThrow(GmindCoreError);
    try {
      setIcon(doc, id, 'other', 'printer');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('INVALID_ICON_OVERFLOW');
      expect((e as GmindCoreError).message).toBe('该组图标最多 8 个，请先移除后再添加');
    }
    // 移除一枚后可继续追加（toggle 语义）
    setIcon(doc, id, 'other', 'done');
    expect(getNode(doc, id)!.icons.other).toHaveLength(7);
    setIcon(doc, id, 'other', 'printer');
    expect(getNode(doc, id)!.icons.other).toHaveLength(8);
    expect(getNode(doc, id)!.icons.other).not.toContain('done');
  });

  it('value null 删除该组图标（single/multi 同语义）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'other', 'done');
    setIcon(doc, id, 'priority', 'p0');
    setIcon(doc, id, 'other', null);
    expect(getNode(doc, id)!.icons).toEqual({ priority: ['p0'] });
  });

  it('emoji 组 multi 语义：目录内字符追加/同值再点移除/null 清组', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'emoji', '😄');
    expect(getNode(doc, id)!.icons).toEqual({ emoji: ['😄'] });
    // multi：再点同值 = 移除该枚（组空删键）
    setIcon(doc, id, 'emoji', '😄');
    expect(getNode(doc, id)!.icons).toEqual({});
    setIcon(doc, id, 'emoji', '😄');
    setIcon(doc, id, 'emoji', '👍'); // 叠加
    expect(getNode(doc, id)!.icons).toEqual({ emoji: ['😄', '👍'] });
    // 再点取消（value null 删组）
    setIcon(doc, id, 'emoji', null);
    expect(getNode(doc, id)!.icons).toEqual({});
  });

  it('非法组名抛 INVALID_ICON_GROUP（消息固定）且文档零变更', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    try {
      setIcon(doc, id, 'nope' as unknown as IconGroup, 'x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('INVALID_ICON_GROUP');
      expect((e as GmindCoreError).message).toBe('未知的图标分组');
    }
    expect(fullSnapshot(doc)).toBe(before);
  });

  it('值不在组目录抛 INVALID_ICON_VALUE（消息固定）且文档零变更（M7a-T1 值校验沿用）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    // 企微目录外值一律拒绝：priority 无 '9'/'p9'，other 无 'nope'，emoji 目录 28 字符外拒绝（旧值经 repair 收敛，不走写入口）
    for (const bad of [['priority', '9'], ['priority', 'p9'], ['other', 'nope'], ['emoji', '🚀']] as Array<[IconGroup, string]>) {
      try {
        setIcon(doc, id, bad[0] as IconGroup, bad[1]!);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(GmindCoreError);
        expect((e as GmindCoreError).code).toBe('INVALID_ICON_VALUE');
        expect((e as GmindCoreError).message).toBe('未知的图标取值');
      }
    }
    expect(fullSnapshot(doc)).toBe(before);
  });

  it('multi 组移除方向不校验目录：目录外旧值可被 toggle 清除（repair 窗口期兜底）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    // 造目录外旧值（裸写 icons Y.Map，模拟 repair 未收敛窗口）
    withTransaction(doc, ORIGIN_USER, () => {
      const node = doc.getMap('nodes').get(id) as Y.Map<unknown>;
      const icons = new Y.Map<unknown>();
      node.set('icons', icons);
      icons.set('other', Y.Array.from(['junk']));
    });
    setIcon(doc, id, 'other', 'junk'); // 移除方向：无需目录内
    expect(getNode(doc, id)!.icons).toEqual({});
  });

  it('undo 回滚 setIcon：组值回到写入前', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const um = createUndoManager(doc);
    setIcon(doc, id, 'priority', 'p4');
    expect(getNode(doc, id)!.icons).toEqual({ priority: ['p4'] });
    undo(um);
    expect(getNode(doc, id)!.icons).toEqual({});
  });
});

// ══ 任务字段（M7a-T1）══════════════════════════════════════════════════════

/** 今日 YYYY-MM-DD（与 @gmind/shared todayStr 同式；联动断言用）。 */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

describe('setNodeTask（M7a-T1）', () => {
  it('缺省任务读取为 todo/0/[]/null×3；patch 各字段写入后读回', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    expect(getNode(doc, id)!.task).toEqual({
      status: 'todo',
      progress: 0,
      owners: [],
      startDate: null,
      dueDate: null,
      doneDate: null,
    });
    setNodeTask(doc, id, {
      status: 'doing',
      progress: 40,
      owners: ['u1', 'u2'],
      startDate: '2026-09-01',
      dueDate: '2026-10-01',
    });
    expect(getNode(doc, id)!.task).toEqual({
      status: 'doing',
      progress: 40,
      owners: ['u1', 'u2'],
      startDate: '2026-09-01',
      dueDate: '2026-10-01',
      doneDate: null,
    });
  });

  it('未提供的键不动；日期 null 清除（删键，读取回落 null）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { dueDate: '2026-12-31', progress: 10 });
    setNodeTask(doc, id, { dueDate: null });
    expect(getNode(doc, id)!.task).toMatchObject({ dueDate: null, progress: 10 });
  });

  it('空 patch 零变更（不开事务，状态字节级不变）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { progress: 30 });
    const before = docToState(doc);
    const origins: string[] = [];
    doc.on('afterTransaction', (tr: Transaction) => origins.push(String(tr.origin)));
    setNodeTask(doc, id, {});
    expect(origins).toEqual([]);
    expect(Buffer.from(docToState(doc)).equals(Buffer.from(before))).toBe(true);
  });

  it('status→done 联动：自动 doneDate=今天、progress=100（@gmind/shared applyStatusRules）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { progress: 40 });
    setNodeTask(doc, id, { status: 'done' });
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'done', progress: 100, doneDate: todayLocal() });
  });

  it('status→done 联动 progress 恒置 100：patch 显式 progress 也被覆盖（mindgrid 语义）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { status: 'done', progress: 60 }); // 不传 doneDate → 联动触发
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'done', progress: 100, doneDate: todayLocal() });
  });

  it('status→done 时 patch 显式给 doneDate 则联动分支不触发（progress/doneDate 保留 patch 值）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { status: 'done', progress: 60, doneDate: '2026-01-15' });
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'done', progress: 60, doneDate: '2026-01-15' });
  });

  it('status 离开 done 清空 doneDate；手改 doneDate 不反写 status', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { status: 'done' }); // doneDate=今天
    setNodeTask(doc, id, { status: 'doing' });
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'doing', doneDate: null });
    // 手改 doneDate：status 保持
    setNodeTask(doc, id, { status: 'done' });
    setNodeTask(doc, id, { doneDate: '2026-03-01' });
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'done', doneDate: '2026-03-01' });
  });

  it('校验拒绝（先于事务零变更）：status/progress/owners/date 四类错误码与两段式文案', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'finished' }, 'TASK_INVALID_STATUS'],
      [{ progress: 101 }, 'TASK_INVALID_PROGRESS'],
      [{ progress: 50.5 }, 'TASK_INVALID_PROGRESS'],
      [{ progress: -1 }, 'TASK_INVALID_PROGRESS'],
      [{ owners: 'u1' }, 'TASK_INVALID_OWNERS'],
      [{ owners: ['', 'u1'] }, 'TASK_INVALID_OWNERS'],
      [{ owners: ['x'.repeat(65)] }, 'TASK_INVALID_OWNERS'],
      [{ owners: Array.from({ length: 21 }, (_, i) => `u${i}`) }, 'TASK_INVALID_OWNERS'],
      [{ startDate: '2026-02-30' }, 'TASK_INVALID_DATE'],
      [{ dueDate: '2026/02/28' }, 'TASK_INVALID_DATE'],
      [{ doneDate: '26-02-28' }, 'TASK_INVALID_DATE'],
    ];
    for (const [patch, code] of cases) {
      try {
        setNodeTask(doc, id, patch as never);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(GmindCoreError);
        expect((e as GmindCoreError).code, JSON.stringify(patch)).toBe(code);
        expect((e as GmindCoreError).message, JSON.stringify(patch)).toMatch(/，请/); // 两段式：原因 + 「，请…」下一步
      }
    }
    expect(fullSnapshot(doc)).toBe(before); // 全部拒绝：零变更
  });

  it('owners 去重保序（≤20 项判定以去重后计），闰日合法接受', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { owners: ['u1', 'u2', 'u1'] });
    expect(getNode(doc, id)!.task.owners).toEqual(['u1', 'u2']);
    setNodeTask(doc, id, { startDate: '2024-02-29' }); // 闰日合法
    expect(getNode(doc, id)!.task.startDate).toBe('2024-02-29');
  });

  it('undo/redo：captureTimeout 内的连续任务写合并为一个撤销单元，一体回滚/重做', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const um = createUndoManager(doc);
    setNodeTask(doc, id, { progress: 40 });
    setNodeTask(doc, id, { status: 'done' });
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'done', progress: 100, doneDate: todayLocal() });
    undo(um); // 500ms 内两写同栈项：一次回滚到任务字段初始态
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'todo', progress: 0, doneDate: null });
    redo(um);
    expect(getNode(doc, id)!.task).toMatchObject({ status: 'done', progress: 100, doneDate: todayLocal() });
  });

  it('root 节点同样可写任务字段（任务常驻所有节点）；墓碑/缺失节点拒绝', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    setNodeTask(doc, ROOT_NODE_ID, { status: 'doing' });
    expect(getNode(doc, ROOT_NODE_ID)!.task.status).toBe('doing');
    const ghost = 'not-exist';
    try {
      setNodeTask(doc, ghost, { status: 'todo' });
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }
  });
});

describe('setCollapsed / toggleCollapse', () => {
  it('setCollapsed 默认 system origin：undo 不回退折叠（spec §4.2 第 5 条裁决）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const um = createUndoManager(doc);
    setText(doc, id, '改过的文本'); // user origin，进撤销栈
    setCollapsed(doc, id, true); // system origin，不进栈
    expect(getNode(doc, id)!.collapsed).toBe(true);

    um.undo();

    expect(getNode(doc, id)!.text).toBe('A'); // 文本回滚
    expect(getNode(doc, id)!.collapsed).toBe(true); // 折叠不回滚
  });

  it('toggleCollapse 翻转 collapsed 值', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    expect(getNode(doc, id)!.collapsed).toBe(false);
    toggleCollapse(doc, id);
    expect(getNode(doc, id)!.collapsed).toBe(true);
    toggleCollapse(doc, id);
    expect(getNode(doc, id)!.collapsed).toBe(false);
  });
});

describe('setStyle', () => {
  it('多键 patch 写入并读回；value null 删除对应键', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    expect(getNode(doc, id)!.style).toEqual({});
    setStyle(doc, id, { color: '#ff0000', fontWeight: 'bold' });
    expect(getNode(doc, id)!.style).toEqual({ color: '#ff0000', fontWeight: 'bold' });
    setStyle(doc, id, { color: null });
    expect(getNode(doc, id)!.style).toEqual({ fontWeight: 'bold' });
  });
});

describe('applyStyle', () => {
  it("scope 'subtree'：3 层子树全部生效，且一次 undo 全部回滚（单事务，FR-EDT-015）", () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a1aId = findIdByText(doc, 'A1a');
    const um = createUndoManager(doc);

    applyStyle(doc, [aId], { color: 'red' }, 'subtree');

    expect(um.undoStack.length).toBe(1); // 一个用户事务 = 一条撤销单元
    // A 的 3 层子树全部生效：A、A1/A2、A1a
    for (const id of [aId, a1Id, a1aId, findIdByText(doc, 'A2')]) {
      expect(getNode(doc, id)!.style, id).toEqual({ color: 'red' });
    }
    // 子树之外不受影响
    expect(getNode(doc, findIdByText(doc, 'B'))!.style).toEqual({});
    expect(getNode(doc, findIdByText(doc, 'B1'))!.style).toEqual({});
    expect(getNode(doc, ROOT_NODE_ID)!.style).toEqual({});

    um.undo();
    for (const id of [aId, a1Id, a1aId, findIdByText(doc, 'A2')]) {
      expect(getNode(doc, id)!.style, id).toEqual({});
    }
  });

  it("scope 'single'：仅写自身，后代不受影响；多 root 各自生效", () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const bId = findIdByText(doc, 'B');

    applyStyle(doc, [aId, bId], { color: 'blue' }, 'single');

    expect(getNode(doc, aId)!.style).toEqual({ color: 'blue' });
    expect(getNode(doc, bId)!.style).toEqual({ color: 'blue' });
    expect(getNode(doc, a1Id)!.style).toEqual({});
    expect(getNode(doc, ROOT_NODE_ID)!.style).toEqual({});
  });

  it('rootIds 含不存在 id 抛 NODE_NOT_FOUND 且收集先于事务、文档零变更', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const before = fullSnapshot(doc);
    try {
      applyStyle(doc, [aId, 'nope'], { color: 'red' }, 'subtree');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }
    expect(fullSnapshot(doc)).toBe(before);
  });
});

describe('富内容/样式 setter 存活校验', () => {
  it('不存在节点一律抛 NODE_NOT_FOUND；墓碑节点抛 NODE_DELETED', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = fullSnapshot(doc);
    const calls: Array<() => void> = [
      () => setNote(doc, 'nope', 'n'),
      () => setHref(doc, 'nope', 'https://a.dev'),
      () => setImage(doc, 'nope', null),
      () => setIcon(doc, 'nope', 'flag', 'flag'),
      () => setNodeTask(doc, 'nope', { status: 'doing' }),
      () => setCollapsed(doc, 'nope', true),
      () => toggleCollapse(doc, 'nope'),
      () => setStyle(doc, 'nope', { color: 'red' }),
      () => applyStyle(doc, ['nope'], { color: 'red' }, 'single'),
    ];
    for (const call of calls) {
      try {
        call();
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(GmindCoreError);
        expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
      }
    }
    expect(fullSnapshot(doc)).toBe(before);

    deleteNodes(doc, [aId]);
    try {
      setNote(doc, aId, 'n');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
  });
});

// ---------------------------------------------------------------------------
// 同值守卫（M7c-E4，需求方 #4「内容没变化或最终没变化时不应该显示保存中——这得
// 保存多少个历史啊」）：写入口在校验后、事务前比较现值，全同＝零变更不开事务。
// 断言口径：afterTransaction 计数（零事务 = 不亮「保存中」、服务端不落空历史、
// 撤销栈无空项，三者同源）。
// ---------------------------------------------------------------------------

describe('同值守卫（M7c-E4：内容无变化不开事务）', () => {
  function withCounter(): { doc: Y.Doc; count: () => number } {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '甲' }] });
    let n = 0;
    doc.on('afterTransaction', () => {
      n += 1;
    });
    return { doc, count: () => n };
  }

  it('setText 同值 → 零事务；写值变化 → 恰一次', () => {
    const { doc, count } = withCounter();
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setText(doc, id, '甲');
    expect(count()).toBe(0);
    setText(doc, id, '乙');
    expect(count()).toBe(1);
    setText(doc, id, '乙');
    expect(count()).toBe(1);
  });

  it('setText 对缺 text 键节点写空串 → 零事务（缺键归空串，与读取侧口径一致）', () => {
    const { doc, count } = withCounter();
    const id = addChild(doc, ROOT_NODE_ID, {}); // 空节点（无文本写入；其建节点事务不计入）
    const base = count();
    setText(doc, id, '');
    expect(count()).toBe(base);
  });

  it('setDescription / setNote 同值 → 零事务（含首次写缺省空串）', () => {
    const { doc, count } = withCounter();
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setDescription(doc, id, '');
    setNote(doc, id, '');
    expect(count()).toBe(0);
    setDescription(doc, id, '描述');
    setNote(doc, id, '备注');
    expect(count()).toBe(2);
    setDescription(doc, id, '描述');
    setNote(doc, id, '备注');
    expect(count()).toBe(2);
  });

  it('setIcon single 组同值/移除空组 → 零事务；multi 组移除空组 → 零事务', () => {
    const { doc, count } = withCounter();
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'priority', null); // 组本就不存在=已是移除态
    setIcon(doc, id, 'priority', 'p0');
    expect(count()).toBe(1);
    setIcon(doc, id, 'priority', 'p0'); // single 组同值
    expect(count()).toBe(1);
    setIcon(doc, id, 'other', null); // multi 组空组移除
    expect(count()).toBe(1);
    setIcon(doc, id, 'priority', null); // 真移除
    expect(count()).toBe(2);
  });

  it('setNodeTask 同 patch 幂等 → 零事务；done 态重复点「已完成」（联动注入同值）→ 零事务', () => {
    const { doc, count } = withCounter();
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeTask(doc, id, { status: 'doing' });
    expect(count()).toBe(1);
    setNodeTask(doc, id, { status: 'doing' });
    expect(count()).toBe(1);
    setNodeTask(doc, id, { status: 'done' }); // 联动注入 doneDate=今天+progress=100
    const doneCount = count();
    setNodeTask(doc, id, { status: 'done' }); // 注入字段与现值全同 → 零变更
    expect(count()).toBe(doneCount);
    setNodeTask(doc, id, { owners: ['U1'] });
    expect(count()).toBe(doneCount + 1);
    setNodeTask(doc, id, { owners: ['U1'] });
    expect(count()).toBe(doneCount + 1);
  });
});

// ---------------------------------------------------------------------------
// 逆时针定侧（需求方 2026-09-30「按 enter 和 tab 新增的二级主题应该是逆时针的。
// 默认一开始在右侧新增，当二级主题为三个以上时，第四个就要放到左侧（思维导图模式
// 时），然后以后再多的新增也都在左侧了，用户可以手动调整到右侧」）：
// addChild root 级自动定侧（第 1~3 右 / 第 4 起左）、setNodeSide 手动调整、
// moveNode 换父清侧。断言口径：getNode(doc, id)!.side。
// ---------------------------------------------------------------------------

describe('逆时针定侧（root 级 side 字段）', () => {
  it('addChild 到 root：第 1~3 个 side=right，第 4 个起 side=left', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const sides: Array<string | undefined> = [];
    for (let i = 0; i < 6; i += 1) {
      const id = addChild(doc, ROOT_NODE_ID, { text: `N${i}` });
      sides.push(getNode(doc, id)!.side);
    }
    expect(sides).toEqual(['right', 'right', 'right', 'left', 'left', 'left']);
  });

  it('非 root 父级不写 side（缺省字段不出现）', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const id = addChild(doc, aId, { text: 'A3' });
    expect(getNode(doc, id)!.side).toBeUndefined();
    expect('side' in (getNode(doc, id)!)).toBe(false);
  });

  it('计数含无 side 字段的旧节点（模板文档按 index 折算：index 0-2 视为右、≥3 视为左）', () => {
    // 模板预置 4 个二级主题（旧格式，无 side 键）→ index 0-2 折算右侧=3 已满 → 新建左侧
    const doc = createTemplateDoc({
      title: 'T',
      children: [{ text: 'A' }, { text: 'B' }, { text: 'C' }, { text: 'D' }],
    });
    const snapA = getNode(doc, findIdByText(doc, 'A'))!;
    expect(snapA.side).toBeUndefined(); // 旧节点无 side 键
    const id = addChild(doc, ROOT_NODE_ID, { text: 'E' });
    expect(getNode(doc, id)!.side).toBe('left');
  });

  it('手动 setNodeSide 后再新建按当前计数：换走一个右侧后新建回补右侧', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const [a, b, c] = [0, 1, 2].map((i) => addChild(doc, ROOT_NODE_ID, { text: `N${i}` }));
    setNodeSide(doc, c, 'left'); // 手动把第 3 个调到左 → 右侧现有 2
    expect(getNode(doc, c)!.side).toBe('left');
    const d = addChild(doc, ROOT_NODE_ID, { text: 'N3' });
    expect(getNode(doc, d)!.side).toBe('right'); // 右侧计数 2 < 3 → 回补右侧
    const e = addChild(doc, ROOT_NODE_ID, { text: 'N4' });
    expect(getNode(doc, e)!.side).toBe('left'); // 右侧计数回满 3 → 左
    const f = addChild(doc, ROOT_NODE_ID, { text: 'N5' });
    expect(getNode(doc, f)!.side).toBe('left');
    expect([a, b].map((id) => getNode(doc, id)!.side)).toEqual(['right', 'right']);
  });

  it('墓碑不入定侧计数：删掉一个右侧二级主题后新建回补右侧', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const ids = [0, 1, 2].map((i) => addChild(doc, ROOT_NODE_ID, { text: `N${i}` }));
    deleteNodes(doc, [ids[0] as string]);
    const next = addChild(doc, ROOT_NODE_ID, { text: 'N3' });
    expect(getNode(doc, next)!.side).toBe('right');
  });

  it('setNodeSide：合法写入读回；非法值抛 INVALID_NODE_SIDE；非 root 直接子级抛 SIDE_ONLY_ROOT_CHILD', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    setNodeSide(doc, aId, 'left');
    expect(getNode(doc, aId)!.side).toBe('left');
    try {
      setNodeSide(doc, aId, 'up' as never);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('INVALID_NODE_SIDE');
    }
    try {
      setNodeSide(doc, a1Id, 'left'); // A1 是二级（父非 root）
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('SIDE_ONLY_ROOT_CHILD');
    }
    expect(getNode(doc, aId)!.side).toBe('left'); // 拒绝路径零变更
  });

  it('setNodeSide 同值 → 零事务（拖放重复释放幂等）；异值恰一次', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '甲' }] });
    let n = 0;
    doc.on('afterTransaction', () => {
      n += 1;
    });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setNodeSide(doc, id, 'right');
    expect(n).toBe(1);
    setNodeSide(doc, id, 'right'); // 同值：零事务
    expect(n).toBe(1);
    setNodeSide(doc, id, 'left');
    expect(n).toBe(2);
  });

  it('moveNode 换父离开 root 级 → 清 side；root 内重排 → 保留；深层换入 root → 不自动定侧', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [{ text: 'A' }, { text: 'B', children: [{ text: 'B1' }] }],
    });
    const aId = findIdByText(doc, 'A');
    const b1Id = findIdByText(doc, 'B1');
    setNodeSide(doc, aId, 'left');

    moveNode(doc, aId, b1Id); // root 级 → 深层：清侧
    expect(getNode(doc, aId)!.side).toBeUndefined();

    moveNode(doc, aId, ROOT_NODE_ID); // 深层 → root 级：不自动定侧
    expect(getNode(doc, aId)!.side).toBeUndefined();

    setNodeSide(doc, aId, 'left');
    const cId = addChild(doc, ROOT_NODE_ID, { text: 'C' }); // A 无 side 且在左 → 右侧计数 0 → right
    expect(getNode(doc, cId)!.side).toBe('right');
    moveNode(doc, aId, ROOT_NODE_ID, 2); // root 内重排（A:1→2）：side 保留
    expect(getNode(doc, aId)!.side).toBe('left');
    // 重排前序：root children=[B, A, C] → 移除 A 再插 index 2 → [B, C, A]
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([findIdByText(doc, 'B'), cId, aId]);
  });
});

// ---------------------------------------------------------------------------
// 表格自定义列（doc 级 schema + 节点 custom 值）：setCustomColumns 整表替换
// （删列同事务清孤儿键）、setCustomField 单字段写入（值按列类型校验）。
// 断言口径：getMeta(doc).customColumns / getNode(doc, id)!.custom。
// ---------------------------------------------------------------------------

describe('setCustomColumns（自定义列 schema 整表替换）', () => {
  it('写入读回：按入参顺序透传（增/删/改名/重排一次写入）；无键文档读取为 []', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    expect(getMeta(doc).customColumns).toEqual([]);
    setCustomColumns(doc, [
      { id: 'c1', name: '负责人', type: 'person' },
      { id: 'c2', name: '截止', type: 'date' },
    ]);
    expect(getMeta(doc).customColumns).toEqual([
      { id: 'c1', name: '负责人', type: 'person' },
      { id: 'c2', name: '截止', type: 'date' },
    ]);
    // 重排 + 改名走同一整表替换
    setCustomColumns(doc, [
      { id: 'c2', name: '截止日', type: 'date' },
      { id: 'c1', name: '负责人', type: 'person' },
    ]);
    expect(getMeta(doc).customColumns).toEqual([
      { id: 'c2', name: '截止日', type: 'date' },
      { id: 'c1', name: '负责人', type: 'person' },
    ]);
    // 清空 = 删除全部列
    setCustomColumns(doc, []);
    expect(getMeta(doc).customColumns).toEqual([]);
  });

  it('校验矩阵（拒绝即零变更）：非数组/id 空/id 重复/name 空/name 超长/type 非法 → CUSTOM_COLUMN_INVALID', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    setCustomColumns(doc, [{ id: 'c1', name: 'A', type: 'text' }]);
    const before = JSON.stringify(getMeta(doc).customColumns);
    const bad: Array<[unknown, string]> = [
      [['x' as never], '数组形状'],
      [[{ id: '', name: 'A', type: 'text' }], 'id 空'],
      [[{ id: 'c1', name: 'A', type: 'text' }, { id: 'c1', name: 'B', type: 'date' }], 'id 重复'],
      [[{ id: 'c2', name: '', type: 'text' }], 'name 空'],
      [[{ id: 'c2', name: '长'.repeat(CUSTOM_COLUMN_NAME_MAX + 1), type: 'text' }], 'name 超长'],
      [[{ id: 'c2', name: 'A', type: 'number' as never }], 'type 非法'],
      [[null as never], '非对象项'],
    ];
    for (const [input, label] of bad) {
      try {
        setCustomColumns(doc, input as CustomColumnDef[]);
        expect.unreachable(`${label} 应被拒绝`);
      } catch (e) {
        expect(e, label).toBeInstanceOf(GmindCoreError);
        expect((e as GmindCoreError).code, label).toBe('CUSTOM_COLUMN_INVALID');
      }
    }
    expect(JSON.stringify(getMeta(doc).customColumns)).toBe(before); // 全部拒绝：零变更
  });

  it(`上限 ${CUSTOM_COLUMN_LIMIT} 列：恰好合法，第 ${CUSTOM_COLUMN_LIMIT + 1} 列抛 CUSTOM_COLUMN_OVERFLOW（两段式文案）`, () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const full = Array.from({ length: CUSTOM_COLUMN_LIMIT }, (_, i) => ({
      id: `c${i}`,
      name: `列${i}`,
      type: 'text' as const,
    }));
    setCustomColumns(doc, full);
    expect(getMeta(doc).customColumns).toHaveLength(CUSTOM_COLUMN_LIMIT);
    try {
      setCustomColumns(doc, [...full, { id: 'cx', name: '超', type: 'text' }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('CUSTOM_COLUMN_OVERFLOW');
      expect((e as GmindCoreError).message).toBe(
        `自定义列最多 ${CUSTOM_COLUMN_LIMIT} 列，请先删除不需要的列再新增`,
      );
    }
    expect(getMeta(doc).customColumns).toHaveLength(CUSTOM_COLUMN_LIMIT); // 拒绝：零变更
  });

  it('同值守卫：同清单重复提交零事务；空清单对无键文档零事务（M7c-E4）', () => {
    let n = 0;
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    doc.on('afterTransaction', () => {
      n += 1;
    });
    setCustomColumns(doc, []); // 空清单对无键文档 = 零变更
    expect(n).toBe(0);
    const cols: CustomColumnDef[] = [{ id: 'c1', name: '文本', type: 'text' }];
    setCustomColumns(doc, cols);
    expect(n).toBe(1);
    setCustomColumns(doc, [{ id: 'c1', name: '文本', type: 'text' }]); // 同值守卫
    expect(n).toBe(1);
    setCustomColumns(doc, [{ id: 'c1', name: '改名', type: 'text' }]);
    expect(n).toBe(2);
  });

  it('删列清孤儿：同一事务清理全部节点（含墓碑）该列键，保留列的值不动', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    setCustomColumns(doc, [
      { id: 't1', name: '备注列', type: 'text' },
      { id: 'g1', name: '进度列', type: 'progress' },
    ]);
    const [aId, bId] = childrenIds(doc, ROOT_NODE_ID);
    setCustomField(doc, aId!, 't1', '甲的文本');
    setCustomField(doc, aId!, 'g1', 40);
    setCustomField(doc, bId!, 't1', '乙的文本');
    deleteNodes(doc, [bId!]); // 墓碑节点也携带孤儿键

    setCustomColumns(doc, [{ id: 'g1', name: '进度列', type: 'progress' }]); // 删除 t1
    expect(getMeta(doc).customColumns).toEqual([{ id: 'g1', name: '进度列', type: 'progress' }]);
    expect(getNode(doc, aId!)!.custom).toEqual({ g1: 40 }); // 保留列不动
    expect(getNode(doc, bId!)!.custom).toBeUndefined(); // 墓碑孤儿键同事务清理
  });

  it('可撤销：undo 整体回滚 schema 与被清的节点值（同一事务）；redo 复原', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const um = createUndoManager(doc);
    setCustomColumns(doc, [{ id: 'c1', name: '文本', type: 'text' }]);
    um.stopCapturing(); // 隔离 captureTimeout，三笔写各自成撤销单元（栈深测试同款）
    setCustomField(doc, aId, 'c1', 'v');
    um.stopCapturing();
    setCustomColumns(doc, []); // 删列 + 清值（同事务）
    expect(getMeta(doc).customColumns).toEqual([]);
    expect(getNode(doc, aId)!.custom).toBeUndefined();

    undo(um);
    expect(getMeta(doc).customColumns).toEqual([{ id: 'c1', name: '文本', type: 'text' }]);
    expect(getNode(doc, aId)!.custom).toEqual({ c1: 'v' }); // 值随同一撤销单元恢复
    undo(um);
    expect(getNode(doc, aId)!.custom).toBeUndefined();
    undo(um);
    expect(getMeta(doc).customColumns).toEqual([]);
    redo(um);
    expect(getMeta(doc).customColumns).toEqual([{ id: 'c1', name: '文本', type: 'text' }]);
  });
});

describe('setCustomField（节点自定义列值）', () => {
  function docWithCols(): { doc: Y.Doc; nodeId: string } {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setCustomColumns(doc, [
      { id: 't1', name: '文本列', type: 'text' },
      { id: 'p1', name: '人员列', type: 'person' },
      { id: 'g1', name: '进度列', type: 'progress' },
      { id: 'd1', name: '日期列', type: 'date' },
    ]);
    return { doc, nodeId: childrenIds(doc, ROOT_NODE_ID)[0]! };
  }

  it('四类型合法写入读回（getNode().custom 透传；缺省节点无 custom 字段）', () => {
    const { doc, nodeId } = docWithCols();
    expect('custom' in (getNode(doc, nodeId)!)).toBe(false);
    setCustomField(doc, nodeId, 't1', '一句话');
    setCustomField(doc, nodeId, 'p1', ['U1', 'U2']);
    setCustomField(doc, nodeId, 'g1', 65);
    setCustomField(doc, nodeId, 'd1', '2026-10-01');
    expect(getNode(doc, nodeId)!.custom).toEqual({
      t1: '一句话',
      p1: ['U1', 'U2'],
      g1: 65,
      d1: '2026-10-01',
    });
    // 整值替换（person 无 toggle 语义）
    setCustomField(doc, nodeId, 'p1', ['U3']);
    expect(getNode(doc, nodeId)!.custom!.p1).toEqual(['U3']);
  });

  it('person 去重保序（[U1,U2,U1] → [U1,U2]，与 owners 存储口径一致）', () => {
    const { doc, nodeId } = docWithCols();
    setCustomField(doc, nodeId, 'p1', ['U1', 'U2', 'U1']);
    expect(getNode(doc, nodeId)!.custom!.p1).toEqual(['U1', 'U2']);
  });

  it('null/undefined 删键；对缺键 null 幂等', () => {
    const { doc, nodeId } = docWithCols();
    setCustomField(doc, nodeId, 't1', 'v');
    setCustomField(doc, nodeId, 't1', null);
    expect(getNode(doc, nodeId)!.custom).toBeUndefined();
    setCustomField(doc, nodeId, 't1', undefined); // 缺键删键：幂等 no-op
    expect(getNode(doc, nodeId)!.custom).toBeUndefined();
    setCustomField(doc, nodeId, 'd1', '2026-01-31');
    setCustomField(doc, nodeId, 'd1', undefined);
    expect(getNode(doc, nodeId)!.custom).toBeUndefined();
  });

  it('colId 不在 schema → CUSTOM_FIELD_UNKNOWN_COL（两段式文案，零变更）', () => {
    const { doc, nodeId } = docWithCols();
    try {
      setCustomField(doc, nodeId, 'nope', 'x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('CUSTOM_FIELD_UNKNOWN_COL');
      expect((e as GmindCoreError).message).toBe('列 nope 不存在或已删除，请刷新表格后重试');
    }
    expect(getNode(doc, nodeId)!.custom).toBeUndefined();
  });

  it('非法矩阵（拒绝即零变更）：text 非串/超长、person 非数组/坏项/超上限、progress 小数/越界/NaN、date 非法', () => {
    const { doc, nodeId } = docWithCols();
    setCustomField(doc, nodeId, 't1', '占位');
    const before = JSON.stringify(getNode(doc, nodeId)!.custom);
    const cases: Array<[string, unknown, string]> = [
      ['t1', 42, 'text 非串'],
      ['t1', '长'.repeat(CUSTOM_TEXT_MAX_LENGTH + 1), 'text 超长'],
      ['p1', 'U1', 'person 非数组'],
      ['p1', ['U1', 42], 'person 坏项'],
      ['p1', [''], 'person 空串项'],
      ['p1', Array.from({ length: MAX_TASK_OWNERS + 1 }, (_, i) => `U${i}`), 'person 超上限'],
      ['g1', 1.5, 'progress 小数'],
      ['g1', -1, 'progress 负数'],
      ['g1', 101, 'progress 越界'],
      ['g1', Number.NaN, 'progress NaN'],
      ['g1', '50', 'progress 串'],
      ['d1', '2026-02-30', 'date 非日历日'],
      ['d1', '2026-1-1', 'date 非补零形状'],
      ['d1', 20261001, 'date 非串'],
    ];
    for (const [colId, value, label] of cases) {
      try {
        setCustomField(doc, nodeId, colId, value as never);
        expect.unreachable(`${label} 应被拒绝`);
      } catch (e) {
        expect(e, label).toBeInstanceOf(GmindCoreError);
        const code = (e as GmindCoreError).code;
        expect(
          code === 'CUSTOM_FIELD_INVALID_VALUE' ||
            code === 'CUSTOM_FIELD_TEXT_TOO_LONG',
          `${label} 错误码`,
        ).toBe(true);
      }
    }
    expect(JSON.stringify(getNode(doc, nodeId)!.custom)).toBe(before); // 全部拒绝：零变更
  });

  it('同值守卫：同值零事务、null 对缺键零事务、person 去重后同值零事务（M7c-E4）', () => {
    let n = 0;
    const { doc, nodeId } = docWithCols();
    doc.on('afterTransaction', () => {
      n += 1;
    });
    setCustomField(doc, nodeId, 'g1', null); // 缺键删键：零事务
    expect(n).toBe(0);
    setCustomField(doc, nodeId, 'g1', 50);
    expect(n).toBe(1);
    setCustomField(doc, nodeId, 'g1', 50); // 同值：零事务
    expect(n).toBe(1);
    setCustomField(doc, nodeId, 'p1', ['U1', 'U2']);
    expect(n).toBe(2);
    setCustomField(doc, nodeId, 'p1', ['U1', 'U2', 'U1']); // 去重后同值：零事务
    expect(n).toBe(2);
  });

  it('节点缺失/墓碑 → NODE_NOT_FOUND / NODE_DELETED（零变更）', () => {
    const { doc, nodeId } = docWithCols();
    expect(() => setCustomField(doc, 'nope', 't1', 'x')).toThrow(GmindCoreError);
    try {
      setCustomField(doc, 'nope', 't1', 'x');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }
    deleteNodes(doc, [nodeId]);
    try {
      setCustomField(doc, nodeId, 't1', 'x');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
  });
});

// ---------------------------------------------------------------------------
// 表格视图列体系（meta.tableView 统一列序/隐藏/固定/排序）：setTableView 整体
// 写入（canonical 归一 + 同值守卫 + 默认 system origin 不进撤销栈）。
// ---------------------------------------------------------------------------

describe('setTableView（表格视图持久态整体写入）', () => {
  it('写入读回：order/hidden/pinned/sort 一次落盘，getMeta 防御读回 canonical 形状', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    setCustomColumns(doc, [{ id: 'c1', name: '备注', type: 'text' }]);
    setTableView(doc, {
      order: ['c1', 'owner', 'status', 'progress', 'startDate', 'dueDate', 'doneDate', 'updatedAt', 'title'],
      hidden: ['owner'],
      pinned: ['title'],
      sort: { key: 'c1', dir: -1 },
    });
    expect(getMeta(doc).tableView).toEqual({
      order: ['c1', 'owner', 'status', 'progress', 'startDate', 'dueDate', 'doneDate', 'updatedAt', 'title'],
      hidden: ['owner'],
      pinned: ['title'],
      sort: { key: 'c1', dir: -1 },
    });
  });

  it('入参归一：多余 key 剔除、order 补全缺失 key、hidden 剔 title、sort 形状非法归 null（不抛）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    setCustomColumns(doc, [{ id: 'c1', name: '备注', type: 'text' }]);
    setTableView(doc, {
      order: ['ghost', 'status'] as string[],
      hidden: ['title', 'status', 'status'],
      pinned: ['ghost', 'status'],
      sort: { key: 'ghost', dir: 2 } as unknown as TableViewSort,
    });
    expect(getMeta(doc).tableView).toEqual({
      order: ['status', 'title', 'owner', 'progress', 'startDate', 'dueDate', 'doneDate', 'updatedAt', 'c1'],
      hidden: ['status'],
      pinned: ['status'],
      sort: null,
    });
  });

  it('非对象入参抛 TABLE_VIEW_INVALID 且零变更', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    for (const bad of ['x', 42, [], null]) {
      try {
        setTableView(doc, bad as never);
        expect.unreachable(`raw=${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(GmindCoreError);
        expect((e as GmindCoreError).code).toBe('TABLE_VIEW_INVALID');
      }
    }
    expect(doc.getMap('meta').get('tableView')).toBeUndefined();
  });

  it('同值守卫：归一后与现值全同 → 零事务；缺字段入参按归一结果比较（非逐字段）', () => {
    let n = 0;
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    doc.on('afterTransaction', () => {
      n += 1;
    });
    setTableView(doc, { order: [], hidden: [], pinned: [], sort: null }); // 缺省序写入（1 次）
    expect(n).toBe(1);
    setTableView(doc, { order: [...TABLE_BUILTIN_COLUMN_KEYS], hidden: [], pinned: [], sort: null }); // 归一后同值：零事务
    expect(n).toBe(1);
    setTableView(doc, { order: [], hidden: [], pinned: [], sort: { key: 'title', dir: 1 } }); // sort 变更：1 次
    expect(n).toBe(2);
    expect(getMeta(doc).tableView!.sort).toEqual({ key: 'title', dir: 1 });
  });

  it('默认 system origin 不进撤销栈（视图态裁定，同 collapsed）；视图写不影响既有 user 撤销', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const um = createUndoManager(doc);
    setTableView(doc, { order: [], hidden: ['owner'], pinned: [], sort: null });
    expect(undo(um)).toBe(false); // 无可撤销内容
    expect(getMeta(doc).tableView!.hidden).toEqual(['owner']); // 视图态仍在
  });
});
