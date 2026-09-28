import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Transaction } from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc } from './doc';
import { GmindCoreError } from './errors';
import { childrenIds, countAlive, getNode } from './read';
import {
  addChild,
  applyStyle,
  deleteNodes,
  moveNode,
  setImage,
  setIcon,
  setNote,
  setHref,
  setCollapsed,
  setStyle,
  setText,
  toggleCollapse,
  withTransaction,
  ORIGIN_SYSTEM,
  ORIGIN_USER,
} from './operations';
import { createUndoManager, redo, undo } from './undo';
import { MAX_NOTE_LENGTH, type IconGroup } from './constants';

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

describe('setIcon', () => {
  it('同组替换即覆盖：flag 红→蓝后仅剩蓝（FR-EDT-021）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'flag', 'red');
    expect(getNode(doc, id)!.icons).toEqual({ flag: 'red' });
    setIcon(doc, id, 'flag', 'blue');
    expect(getNode(doc, id)!.icons).toEqual({ flag: 'blue' });
  });

  it('跨组叠加：flag + priority + progress 三组并存', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'flag', 'red');
    setIcon(doc, id, 'priority', 'p1');
    setIcon(doc, id, 'progress', '50');
    expect(getNode(doc, id)!.icons).toEqual({ flag: 'red', priority: 'p1', progress: '50' });
  });

  it('value null 删除该组图标', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'flag', 'red');
    setIcon(doc, id, 'priority', 'p1');
    setIcon(doc, id, 'flag', null);
    expect(getNode(doc, id)!.icons).toEqual({ priority: 'p1' });
  });

  it('emoji 组设置/替换/取消往返：值为单个 emoji 字符（M6 T5 企微对标）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'emoji', '😊');
    expect(getNode(doc, id)!.icons).toEqual({ emoji: '😊' });
    // 组内单选：换 emoji 即覆盖
    setIcon(doc, id, 'emoji', '🚀');
    expect(getNode(doc, id)!.icons).toEqual({ emoji: '🚀' });
    // 再点取消（value null 删组）
    setIcon(doc, id, 'emoji', null);
    expect(getNode(doc, id)!.icons).toEqual({});
  });

  it('emoji 与其他图标组并存：设 emoji 不清除 priority/flag（组间独立）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setIcon(doc, id, 'priority', 'p1');
    setIcon(doc, id, 'flag', '红');
    setIcon(doc, id, 'emoji', '😊');
    expect(getNode(doc, id)!.icons).toEqual({ priority: 'p1', flag: '红', emoji: '😊' });
    // 取消 emoji 不动其他组
    setIcon(doc, id, 'emoji', null);
    expect(getNode(doc, id)!.icons).toEqual({ priority: 'p1', flag: '红' });
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
      () => setIcon(doc, 'nope', 'flag', 'red'),
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
