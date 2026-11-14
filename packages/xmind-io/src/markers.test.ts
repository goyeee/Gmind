// markers.test.ts：标记双向映射表 v2 逐行断言（2026-11-14 导入保真度升级）。
// 映射表单源：docs/superpowers/specs/2026-11-14-xmind-import-fidelity-design.md §三
// （置信级逐行照抄 spec，禁止自行增删 id）。
import { describe, expect, it } from 'vitest';
import { iconsToMarkerIds, markersToIcons } from './markers';
import type { XmindIcons } from './types';

/** spec §3.1 导入方向逐行：XMind id → Gmind 组.值。 */
const IMPORT_ROWS: Array<[string, Record<string, Partial<XmindIcons>>]> = [
  // 进度九档（实测 5：oct/half/3quar/7oct/done，推断 4：quar/3oct/5oct/start）
  ['进度九档落 progress 组', {
    'task-start': { progress: ['none'] },
    'task-oct': { progress: ['p12'] },
    'task-quar': { progress: ['p25'] },
    'task-3oct': { progress: ['p37'] },
    'task-half': { progress: ['p50'] },
    'task-5oct': { progress: ['p62'] },
    'task-3quar': { progress: ['p75'] },
    'task-7oct': { progress: ['p87'] },
    'task-done': { progress: ['done'] },
  }],
  // smiley 族落 mood 组（2026-11-14 推翻 M7b「emoji 组不从 XMind 导入」；
  // smile/sad/cry 同名推断、laugh 实测形近→smile）
  ['smiley 族落 mood 组', {
    'smiley-smile': { mood: ['smile'] },
    'smiley-sad': { mood: ['sad'] },
    'smiley-cry': { mood: ['cry'] },
    'smiley-laugh': { mood: ['smile'] },
  }],
  // 人物族六色→other.person（orange 实测，余推断；颜色丢）
  ['people 族落 other.person', {
    'people-red': { other: ['person'] },
    'people-orange': { other: ['person'] },
    'people-yellow': { other: ['person'] },
    'people-green': { other: ['person'] },
    'people-blue': { other: ['person'] },
    'people-purple': { other: ['person'] },
  }],
  // symbol 族（实测）→ other 对应值：wrong→cancel、right→done 语义对位
  ['symbol 族落 other 组', {
    'symbol-plus': { other: ['plus'] },
    'symbol-question': { other: ['question'] },
    'symbol-wrong': { other: ['cancel'] },
    'symbol-right': { other: ['done'] },
    'symbol-idea': { other: ['idea'] },
    c_symbol_like: { other: ['like'] }, // 下划线精确 id（实测）
  }],
  // 箭头四向同名（up 实测，余推断；颜色丢）
  ['arrow 四向落 arrow 组', {
    'arrow-up': { arrow: ['up'] },
    'arrow-down': { arrow: ['down'] },
    'arrow-left': { arrow: ['left'] },
    'arrow-right': { arrow: ['right'] },
  }],
];

describe('markersToIcons v2（导入：XMind marker-id → 八组制）', () => {
  for (const [name, rows] of IMPORT_ROWS) {
    it(name, () => {
      for (const [id, icons] of Object.entries(rows)) {
        expect(markersToIcons([id])).toEqual({ icons, dropped: 0 });
      }
    });
  }

  it('既有族不回归：priority-1..9（8/9 clamp 7→low）、flag-red、star-red', () => {
    // PRIORITY_LEGACY_MAP 镜像（与 core 同步）：6→mid、7→low；urgent/high 无旧数字档对应
    const want = ['p0', 'p1', 'p2', 'p3', 'p4', 'mid', 'low', 'low', 'low'];
    for (let n = 1; n <= 9; n += 1) {
      expect(markersToIcons([`priority-${n}`]).icons).toEqual({ priority: [want[n - 1]] });
    }
    expect(markersToIcons(['priority-8']).icons).toEqual({ priority: ['low'] }); // clamp 7
    expect(markersToIcons(['flag-red']).icons).toEqual({ flag: ['flag'] });
    expect(markersToIcons(['star-red']).icons).toEqual({ other: ['important'] });
    expect(markersToIcons(['star-blue']).icons).toEqual({ other: ['important'] }); // 前缀匹配
  });

  it('未映射/非法 id 丢弃并计数：arrow-refresh、symbol-minus、week-1、month-01、c_number_1、空串、非字符串', () => {
    const ids: string[] = ['arrow-refresh', 'symbol-minus', 'week-1', 'month-01', 'c_number_1', '', 42 as unknown as string];
    expect(markersToIcons(ids)).toEqual({ icons: {}, dropped: ids.length });
    expect(markersToIcons(['smiley-love', 'smiley-kiss'])).toEqual({ icons: {}, dropped: 2 }); // spec 点名不收：拼写无法核实
    expect(markersToIcons(['symbol-love'])).toEqual({ icons: {}, dropped: 1 }); // symbol 陌生成员同弃
  });

  it('单选组 first-wins：progress/mood/arrow 后续被吞计 dropped（priority/flag 沿用现行）', () => {
    expect(markersToIcons(['task-done', 'task-half'])).toEqual({ icons: { progress: ['done'] }, dropped: 1 });
    expect(markersToIcons(['smiley-laugh', 'smiley-sad'])).toEqual({ icons: { mood: ['smile'] }, dropped: 1 });
    expect(markersToIcons(['arrow-up', 'arrow-down'])).toEqual({ icons: { arrow: ['up'] }, dropped: 1 });
    expect(markersToIcons(['priority-1', 'priority-2'])).toEqual({ icons: { priority: ['p0'] }, dropped: 1 });
    expect(markersToIcons(['flag-red', 'flag-blue'])).toEqual({ icons: { flag: ['flag'] }, dropped: 1 });
    // 不同单选组互不吞噬
    expect(markersToIcons(['task-done', 'smiley-sad', 'arrow-up'])).toEqual({
      icons: { progress: ['done'], mood: ['sad'], arrow: ['up'] },
      dropped: 0,
    });
  });

  it('other 组 multi 并存：like+question 共存、star-red 与 c_symbol_like 共存；同值重复按丢弃登记', () => {
    expect(markersToIcons(['c_symbol_like', 'symbol-question'])).toEqual({
      icons: { other: ['like', 'question'] },
      dropped: 0,
    });
    expect(markersToIcons(['star-red', 'c_symbol_like'])).toEqual({
      icons: { other: ['important', 'like'] },
      dropped: 0,
    });
    expect(markersToIcons(['star-red', 'star-red'])).toEqual({ icons: { other: ['important'] }, dropped: 1 }); // 既有吞噬不回归
  });
});

describe('iconsToMarkerIds v2（导出：八组制 → XMind marker-id）', () => {
  it('progress 八档→task-*；none 不产出（task-start 未实测）', () => {
    expect(iconsToMarkerIds({ progress: ['p12'] })).toEqual(['task-oct']);
    expect(iconsToMarkerIds({ progress: ['p25'] })).toEqual(['task-quar']);
    expect(iconsToMarkerIds({ progress: ['p37'] })).toEqual(['task-3oct']);
    expect(iconsToMarkerIds({ progress: ['p50'] })).toEqual(['task-half']);
    expect(iconsToMarkerIds({ progress: ['p62'] })).toEqual(['task-5oct']);
    expect(iconsToMarkerIds({ progress: ['p75'] })).toEqual(['task-3quar']);
    expect(iconsToMarkerIds({ progress: ['p87'] })).toEqual(['task-7oct']);
    expect(iconsToMarkerIds({ progress: ['done'] })).toEqual(['task-done']);
    expect(iconsToMarkerIds({ progress: ['none'] })).toEqual([]);
  });

  it('mood 仅 smile→smiley-laugh；sad/cry/love/kiss 不产出', () => {
    expect(iconsToMarkerIds({ mood: ['smile'] })).toEqual(['smiley-laugh']);
    expect(iconsToMarkerIds({ mood: ['sad', 'cry', 'love', 'kiss'] })).toEqual([]);
  });

  it('other：like/question/plus/cancel/done/idea→symbol 族与 c_symbol_like；person→people-orange；important→star-red', () => {
    expect(iconsToMarkerIds({ other: ['like'] })).toEqual(['c_symbol_like']);
    expect(iconsToMarkerIds({ other: ['question'] })).toEqual(['symbol-question']);
    expect(iconsToMarkerIds({ other: ['plus'] })).toEqual(['symbol-plus']);
    expect(iconsToMarkerIds({ other: ['cancel'] })).toEqual(['symbol-wrong']);
    expect(iconsToMarkerIds({ other: ['done'] })).toEqual(['symbol-right']);
    expect(iconsToMarkerIds({ other: ['idea'] })).toEqual(['symbol-idea']);
    expect(iconsToMarkerIds({ other: ['person'] })).toEqual(['people-orange']);
    expect(iconsToMarkerIds({ other: ['important'] })).toEqual(['star-red']);
    expect(iconsToMarkerIds({ other: ['like', 'question'] })).toEqual(['c_symbol_like', 'symbol-question']); // multi 逐枚
  });

  it('arrow 四向同名→arrow-*；leftright 不产出', () => {
    expect(iconsToMarkerIds({ arrow: ['up'] })).toEqual(['arrow-up']);
    expect(iconsToMarkerIds({ arrow: ['down'] })).toEqual(['arrow-down']);
    expect(iconsToMarkerIds({ arrow: ['left'] })).toEqual(['arrow-left']);
    expect(iconsToMarkerIds({ arrow: ['right'] })).toEqual(['arrow-right']);
    expect(iconsToMarkerIds({ arrow: ['leftright'] })).toEqual([]);
  });

  it('emoji/number 组与其余 other slug 不产出（零虚增 marker-id）；undefined → 空数组', () => {
    expect(iconsToMarkerIds({ emoji: ['😊'], number: ['1'], other: ['calendar', 'clock'] })).toEqual([]);
    expect(iconsToMarkerIds(undefined)).toEqual([]);
    expect(iconsToMarkerIds({})).toEqual([]);
  });

  it('既有导出不回归：priority 9 档现行 PRIORITY_EXPORT、flag 三值→flag-red', () => {
    expect(iconsToMarkerIds({ priority: ['p0'] })).toEqual(['priority-1']);
    expect(iconsToMarkerIds({ priority: ['p4'] })).toEqual(['priority-5']);
    expect(iconsToMarkerIds({ priority: ['urgent'] })).toEqual(['priority-1']); // 最高档
    expect(iconsToMarkerIds({ priority: ['high'] })).toEqual(['priority-6']);
    expect(iconsToMarkerIds({ priority: ['mid'] })).toEqual(['priority-7']);
    expect(iconsToMarkerIds({ priority: ['low'] })).toEqual(['priority-9']);
    expect(iconsToMarkerIds({ flag: ['flag', 'flagRect', 'flagPennant'] })).toEqual(['flag-red', 'flag-red', 'flag-red']);
  });
});

describe('往返恒等（marker-id → Gmind 值 → marker-id）', () => {
  it('smiley-laugh → mood.smile → smiley-laugh；c_symbol_like → other.like → c_symbol_like（spec 点名）', () => {
    expect(iconsToMarkerIds(markersToIcons(['smiley-laugh']).icons)).toEqual(['smiley-laugh']);
    expect(iconsToMarkerIds(markersToIcons(['c_symbol_like']).icons)).toEqual(['c_symbol_like']);
  });

  it('实测/推断原生族往返恒等：task-oct、task-done、symbol-right、symbol-question、arrow-up、people-orange', () => {
    for (const id of ['task-oct', 'task-done', 'symbol-right', 'symbol-question', 'arrow-up', 'people-orange']) {
      expect(iconsToMarkerIds(markersToIcons([id]).icons)).toEqual([id]);
    }
  });
});
