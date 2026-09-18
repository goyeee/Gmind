import { beforeAll, describe, expect, it } from 'vitest';
import type * as Y from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc } from './doc';
import { insertSpec, outlineToSpec, type SpecNode } from './clipboard';
import { addChild, deleteNodes, moveNode, setText } from './operations';
import { countAlive, getNode, isAlive, subtreeIds } from './read';

/**
 * 500 节点性能冒烟基准（M1a Task 9，宽松阈值锁定「操作复杂度无意外超线性」）：
 * ① outlineToSpec + insertSpec 建 500 节点树 < 1000ms；
 * ② 同一文档上 1 万次混合操作（addChild/setText/moveNode/deleteNodes+补充）< 3000ms。
 * 正式 40fps 渲染压测在 M1b 引擎层。CI 不 skip（阈值有 3 倍余量，裁决见任务简报）。
 * 确定性：随机源为固定种子 LCG（禁 Math.random），全部操作合法（任何抛错即失败）。
 */

/** 确定性 32 位 LCG（Math.imul 精确无溢出），返回 0..2^32-1 的无符号整数序列。 */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** 生成恰好 500 行的 Tab 缩进大纲：25 分支 ×（1 分支 + 15 子项，其中 4 项各带 1 孙）= 500，深度 3。 */
function build500Outline(): string {
  const lines: string[] = [];
  for (let b = 0; b < 25; b += 1) {
    lines.push(`分支-${b}`);
    for (let j = 0; j < 15; j += 1) {
      lines.push(`\t子项-${b}-${j}`);
      if (j >= 11) lines.push(`\t\t叶子-${b}-${j}`);
    }
  }
  return lines.join('\n');
}

/** 递归统计 spec 森林节点总数。 */
function countSpecNodes(forest: SpecNode[]): number {
  let n = 0;
  const walk = (nodes: SpecNode[]): void => {
    for (const s of nodes) {
      n += 1;
      walk(s.children);
    }
  };
  walk(forest);
  return n;
}

/** 存活子节点数（children 数组可能残留墓碑 id，须按存活过滤）。 */
function aliveChildCount(doc: Y.Doc, id: string): number {
  let n = 0;
  for (const childId of getNode(doc, id)?.childIds ?? []) {
    if (isAlive(doc, childId)) n += 1;
  }
  return n;
}

let doc: Y.Doc;
let forest: SpecNode[];
let buildMs = 0;

beforeAll(() => {
  const outline = build500Outline();
  const t0 = performance.now();
  forest = outlineToSpec(outline);
  doc = createTemplateDoc({ title: '基准文档', children: [] });
  insertSpec(doc, ROOT_NODE_ID, 0, forest);
  buildMs = performance.now() - t0;
});

describe('500 节点性能冒烟基准', () => {
  it('建树（outlineToSpec + insertSpec）< 1000ms 且 countAlive === 500', () => {
    expect(forest).toHaveLength(25);
    expect(countSpecNodes(forest)).toBe(500);
    expect(countAlive(doc)).toBe(500);
    expect(buildMs).toBeLessThan(1000);
    console.info(`[bench] 500 节点建树（parse+insertSpec）${Math.round(buildMs)}ms（阈值 1000ms）`);
  });

  it('1 万次混合操作（addChild/setText/moveNode/deleteNodes+补充）< 3000ms', () => {
    const lcg = makeLcg(0x1234abcd);
    // 存活节点 id 池（不含 root）：全程与文档存活集精确同步，保证每次操作合法不抛错
    const pool: string[] = [];
    for (const id of subtreeIds(doc, ROOT_NODE_ID)) {
      if (id !== ROOT_NODE_ID) pool.push(id);
    }
    const pick = (): string => pool[lcg() % pool.length];
    const TARGET_ALIVE = 480;

    const t0 = performance.now();
    for (let i = 0; i < 10000; i += 1) {
      switch (i % 4) {
        case 0: {
          // addChild（池超上限时降级为 setText，防止存活数无界膨胀）
          if (pool.length < 500) {
            pool.push(addChild(doc, pick(), { text: `新增-${i}` }));
          } else {
            setText(doc, pick(), `文本-${i}`);
          }
          break;
        }
        case 1: {
          setText(doc, pick(), `文本-${i}`);
          break;
        }
        case 2: {
          // moveNode：目标若落入自身子树（含自身）则回退 root——root 永远合法
          const id = pick();
          let target = pick();
          if (subtreeIds(doc, id).includes(target)) target = ROOT_NODE_ID;
          moveNode(doc, id, target);
          break;
        }
        default: {
          // deleteNodes（优先叶子，偶尔级联删子树）+ 立即补充到目标存活数
          let id = pick();
          for (let tries = 0; tries < 8 && aliveChildCount(doc, id) > 0; tries += 1) {
            id = pick();
          }
          const removed = subtreeIds(doc, id); // 将被墓碑化的存活子树（含自身）
          deleteNodes(doc, [id]);
          const removedSet = new Set(removed);
          for (let k = pool.length - 1; k >= 0; k -= 1) {
            if (removedSet.has(pool[k])) pool.splice(k, 1);
          }
          while (pool.length < TARGET_ALIVE) {
            const parent = pool.length > 0 ? pick() : ROOT_NODE_ID;
            pool.push(addChild(doc, parent, { text: `补充-${i}` }));
          }
          break;
        }
      }
    }
    const opsMs = performance.now() - t0;

    expect(opsMs).toBeLessThan(3000);
    const alive = countAlive(doc);
    expect(alive).toBeGreaterThanOrEqual(300);
    expect(alive).toBeLessThanOrEqual(500);
    expect(pool.length).toBe(alive); // 池与存活集精确一致 = 全程操作合法的佐证
    console.info(
      `[bench] 1 万次混合操作 ${Math.round(opsMs)}ms（阈值 3000ms），最终存活 ${alive}`,
    );
  });
});
