import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ROOT_NODE_ID,
  addChild,
  createTemplateDoc,
  setNodeSide,
  setText,
  ORIGIN_USER,
  getMeta,
  setDocMeta,
} from '@gmind/core';
import { rootKidEffectiveSides, rootSiblingForceSide } from './rootSiblingSide';

/** 按文本查 root 子级 id。 */
function kidByText(doc: Y.Doc, text: string): string {
  const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
  const kids = (nodes.get(ROOT_NODE_ID)?.get('children') as Y.Array<string>)?.toArray() ?? [];
  for (const id of kids) {
    if (String(nodes.get(id)?.get('text')) === text) return id;
  }
  throw new Error(`root 子级「${text}」不存在`);
}

/** 现代文档造数：Tab 语义连续 addChild（自动定侧：前 3 右、第 4 起左）。 */
function modernDoc(texts: string[]): Y.Doc {
  const doc = createTemplateDoc({ title: 'T', children: [] });
  for (const t of texts) {
    const id = addChild(doc, ROOT_NODE_ID);
    setText(doc, id, t, ORIGIN_USER);
  }
  return doc;
}

/** 旧文档造数：root 子级无 side 键（createTemplateDoc 天然不写 side）。 */
function legacyDoc(texts: string[]): Y.Doc {
  return createTemplateDoc({ title: 'T', children: texts.map(text => ({ text })) });
}

describe('rootKidEffectiveSides：root 子级有效侧（持久 ?? 索引兜底）', () => {
  it('现代文档（全持久 side）按持久值', () => {
    const doc = modernDoc(['A', 'B', 'C', 'D']);
    expect(rootKidEffectiveSides(doc)).toEqual(['right', 'right', 'right', 'left']);
  });

  it('旧文档（无 side）按索引兜底：前 3 右、≥3 左', () => {
    const doc = legacyDoc(['A', 'B', 'C', 'D']);
    expect(rootKidEffectiveSides(doc)).toEqual(['right', 'right', 'right', 'left']);
  });

  it('手动换侧（setNodeSide）优先于索引兜底', () => {
    const doc = legacyDoc(['A', 'B']);
    setNodeSide(doc, kidByText(doc, 'B'), 'left');
    expect(rootKidEffectiveSides(doc)).toEqual(['right', 'left']);
  });
});

describe('rootSiblingForceSide：root 级分支同侧落位规则（顺时针修正，2026-10-09 裁定）', () => {
  it('右满 3 + 左空 + 非末位分支（最右上）Enter → 右（紧挨其下方，不再被计数强制左）', () => {
    const doc = modernDoc(['右一', '右二', '右三']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右一'), false)).toBe('right');
    expect(rootSiblingForceSide(doc, kidByText(doc, '右二'), false)).toBe('right');
  });

  it('右满 3 + 左空 + 末位分支（顺时针末位）Enter → 左（开启左列）', () => {
    const doc = modernDoc(['右一', '右二', '右三']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右三'), false)).toBe('left');
  });

  it('右未满 3（如仅 2 个）末位分支 Enter → 右（不触发，正常同侧后插）', () => {
    const doc = modernDoc(['右一', '右二']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右二'), false)).toBe('right');
  });

  it('左列非空时右分支 Enter → 右（同侧保持，与左空不空无关）', () => {
    const doc = modernDoc(['右一', '右二', '右三', '左一']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右一'), false)).toBe('right');
    expect(rootSiblingForceSide(doc, kidByText(doc, '右三'), false)).toBe('right');
  });

  it('左列分支 Enter → 左（同侧保持；末位也不特殊——左列已存在）', () => {
    const doc = modernDoc(['右一', '右二', '右三', '左一']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '左一'), false)).toBe('left');
  });

  it('Shift+Enter（reverse）不触发顺时针：末位右分支仍同侧右（前插语义）', () => {
    const doc = modernDoc(['右一', '右二', '右三']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右三'), true)).toBe('right');
  });

  it('旧文档（无 side）经有效侧兜底：最右上 Enter → 右（bug 场景修复）', () => {
    const doc = legacyDoc(['右一', '右二', '右三']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右一'), false)).toBe('right');
  });

  it('旧文档（无 side）末位分支 Enter → 左（兜底计数同式）', () => {
    const doc = legacyDoc(['右一', '右二', '右三']);
    expect(rootSiblingForceSide(doc, kidByText(doc, '右三'), false)).toBe('left');
  });

  it('logic 结构 / 非 root 子级 → undefined（不干预，addChild 自动定侧/不写侧）', () => {
    const doc = modernDoc(['A', 'B']);
    setDocMeta(doc, { structureType: 'logic' });
    expect(rootSiblingForceSide(doc, kidByText(doc, 'A'), false)).toBeUndefined();
    const mindmap = legacyDoc(['A', 'B']);
    const a = kidByText(mindmap, 'A');
    const child = addChild(mindmap, a); // A 的子级（二级以下）
    expect(rootSiblingForceSide(mindmap, child, false)).toBeUndefined();
  });

  it('structureType 断言防御：modernDoc 默认 mindmap', () => {
    const doc = modernDoc(['A']);
    expect(getMeta(doc).structureType).toBe('mindmap');
  });
});
