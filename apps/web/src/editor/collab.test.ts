import { describe, expect, it } from 'vitest';
import { buildPresence, buildRemoteCursors, type AwarenessState } from './collab';

/**
 * Awareness states → 面板/光标数据面的纯函数单测（M2 Task 5）。
 * E2E（collab.e2e.spec.ts）覆盖接线；这里钉住宽松读取纪律：
 * 无身份跳过、editing 宽松解析、自身过滤、clientID 键、坏选区剔除。
 */

const states = (entries: [number, AwarenessState][]): Map<number, AwarenessState> => new Map(entries);

describe('buildPresence', () => {
  it('无身份（user 缺失/空 userId）的客户端不计入在线成员', () => {
    const members = buildPresence(
      states([
        [1, { user: { userId: 'u1', nickname: '甲', color: '#2563eb' }, joinedAt: '2026-01-01T00:00:00Z', editing: true }],
        [2, {}],
        [3, { user: { userId: '', nickname: '乙', color: '#fff' } }],
      ]),
      1,
    );
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ userId: 'u1', editing: true, isSelf: true });
  });

  it('editing 仅在严格 true 时为真；isSelf 按 clientID 判定', () => {
    const members = buildPresence(
      states([
        [10, { user: { userId: 'a', nickname: 'A', color: '#111' }, editing: true }],
        [20, { user: { userId: 'b', nickname: 'B', color: '#222' }, editing: 'yes' }],
      ]),
      20,
    );
    expect(members.find((m) => m.userId === 'a')?.editing).toBe(true);
    expect(members.find((m) => m.userId === 'b')?.editing).toBe(false);
    expect(members.find((m) => m.userId === 'b')?.isSelf).toBe(true);
  });

  it('按 joinedAt 升序稳定排序（缺时间戳排最后同组的确定性由 userId 兜底）', () => {
    const members = buildPresence(
      states([
        [1, { user: { userId: 'z', nickname: 'Z', color: '#111' }, joinedAt: '2026-01-02T00:00:00Z' }],
        [2, { user: { userId: 'a', nickname: 'A', color: '#222' }, joinedAt: '2026-01-01T00:00:00Z' }],
      ]),
      1,
    );
    expect(members.map((m) => m.userId)).toEqual(['a', 'z']);
  });
});

describe('buildRemoteCursors', () => {
  it('过滤自己、无身份者与空/坏选区；userId 取 clientID 字符串（裁定）', () => {
    const cursors = buildRemoteCursors(
      states([
        [1, { user: { userId: 'me', nickname: '我', color: '#111' }, selection: ['root'] }],
        [2, { user: { userId: 'a', nickname: 'A', color: '#222' }, selection: ['n1', 42, null, 'n1'] }],
        [3, { user: { userId: 'b', nickname: 'B', color: '#333' }, selection: [] }],
        [4, { user: { userId: 'c', nickname: 'C', color: '#444' } }],
        [5, { selection: ['n9'] }],
      ]),
      1,
    );
    expect(cursors).toEqual([
      { userId: '2', name: 'A', color: '#222', nodeIds: ['n1', 'n1'] },
    ]);
  });
});
