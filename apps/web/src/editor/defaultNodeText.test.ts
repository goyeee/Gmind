import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ROOT_NODE_ID,
  addChild,
  createTemplateDoc,
  deleteNodes,
  setText,
  ORIGIN_USER,
} from '@gmind/core';
import { nextChildText } from './defaultNodeText';

/** root 下按文本造子级（分支层造数）。 */
function branch(doc: Y.Doc, text: string): string {
  const id = addChild(doc, ROOT_NODE_ID);
  setText(doc, id, text, ORIGIN_USER);
  return id;
}

describe('nextChildText：新增节点默认命名（分支主题/子主题 + 序号，2026-10-09 裁定）', () => {
  it('root 下空兄弟 → 分支主题 1', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    expect(nextChildText(doc, ROOT_NODE_ID)).toBe('分支主题 1');
  });

  it('root 下已有 分支主题 1/3（删 2 跳号）→ 分支主题 4（max+1 不复用空号）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    branch(doc, '分支主题 1');
    branch(doc, '分支主题 3');
    expect(nextChildText(doc, ROOT_NODE_ID)).toBe('分支主题 4');
  });

  it('非根父级下空兄弟 → 子主题 1', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const b = branch(doc, '分支主题 1');
    expect(nextChildText(doc, b)).toBe('子主题 1');
  });

  it('非根父级下已有 子主题 2 → 子主题 3', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const b = branch(doc, '分支主题 1');
    const s = addChild(doc, b);
    setText(doc, s, '子主题 2', ORIGIN_USER);
    expect(nextChildText(doc, b)).toBe('子主题 3');
  });

  it('第三级及更深同样叫 子主题 N（层级不加深前缀，序号=该父级下局部序号）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const b = branch(doc, '分支主题 1');
    const s = addChild(doc, b);
    setText(doc, s, '子主题 1', ORIGIN_USER);
    expect(nextChildText(doc, s)).toBe('子主题 1'); // s 下尚无子级 → 第三级首个从 1 起
    const third = addChild(doc, s);
    setText(doc, third, '子主题 1', ORIGIN_USER);
    expect(nextChildText(doc, s)).toBe('子主题 2'); // s 下已有 子主题 1 → 2
  });

  it('用户编辑保留前缀的「分支主题 2：登录」仍占用 2 号（前缀匹配）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    branch(doc, '分支主题 1');
    branch(doc, '分支主题 2：登录');
    expect(nextChildText(doc, ROOT_NODE_ID)).toBe('分支主题 3');
  });

  it('墓碑兄弟不计数：删掉 分支主题 2 后新增复用 2 号', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const b1 = branch(doc, '分支主题 1');
    const b2 = branch(doc, '分支主题 2');
    deleteNodes(doc, [b2]);
    expect(nextChildText(doc, ROOT_NODE_ID)).toBe('分支主题 2');
    expect(b1).toBeTruthy();
  });

  it('各父级子主题序号独立（两个分支下互不影响）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const b1 = branch(doc, '分支主题 1');
    const b2 = branch(doc, '分支主题 2');
    const s = addChild(doc, b1);
    setText(doc, s, '子主题 1', ORIGIN_USER);
    expect(nextChildText(doc, b1)).toBe('子主题 2');
    expect(nextChildText(doc, b2)).toBe('子主题 1');
  });

  it('自定义文本与旧默认「新主题」兄弟不干扰序号 → 从 1 起', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    branch(doc, '周一');
    branch(doc, '新主题');
    expect(nextChildText(doc, ROOT_NODE_ID)).toBe('分支主题 1');
  });

  it('父节点不存在的防御兜底 → 子主题 1', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    expect(nextChildText(doc, 'no-such-node')).toBe('子主题 1');
  });
});
