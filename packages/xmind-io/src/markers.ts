// markers.ts：XMind marker-id ⇄ Gmind 八组制标记的双向映射（2026-11-14 导入保真度 v2）。
// 映射表单源：docs/superpowers/specs/2026-11-14-xmind-import-fidelity-design.md §三
// （真实文件真值 + 置信级逐行标注）；置信纪律：spec 标「不收」的 id 一律不入表
// （宁可少映射不可歪映射），smiley-love/smiley-kiss 因拼写无法核实同样不收。
//
// 导入口径（v2 全量表，2026-11-14 裁定）：既有 priority-1..9（regex，8/9 clamp 7）、
// flag-*（任意颜色前缀）、star-*（前缀，颜色丢）三族沿用；新增四族——task-* 进度九档
// （实测 5：task-oct/half/3quar/7oct/done，推断 4：task-quar/3oct/5oct/start，证伪删行即可）、
// smiley-smile/sad/cry（同名推断）与 smiley-laugh（实测，形近映射大笑→微笑，需求方可
// 否决改丢弃）、people-red/orange/yellow/green/blue/purple 六色（orange 实测余推断，
// 全族语义同一「人」，颜色丢）、symbol-plus/question/wrong/right/idea 与 c_symbol_like
// （下划线精确 id，全部实测；wrong→cancel、right→done 语义对位）、arrow-up/down/left/
// right（up 实测余推断，颜色丢）。arrow-refresh、symbol-minus 与一切陌生族
// （week-*/month-*/c_number-*…）无法核实，丢弃并计入 dropped（图标降级，
// FR-IO-002「未映射丢弃并登记」口径）。
//
// **推翻 M7b 旧裁定「emoji 组不从 XMind 导入」（2026-11-14）**：XMind 表情 marker 族
// 与 Gmind mood 组有稳定对应（见上 smiley 四 id），落 mood 组入表；emoji unicode 组
// （28 字符）仍无 XMind 原生源，导入恒不产出、导出不写回（裁定 4 落地形态）。
//
// 单选组（priority/flag/progress/mood/arrow）同节点重复「首个胜、后续计 dropped」
// （M7a-R1 2.4 现行规则沿用并扩到新三组）；other 组 multi 并存（同值重复同样按丢弃
// 登记；上限 8 由 setIcon 拒绝→胶水捕获计图标，不在本层截断）。
//
// 导出口径（v2 对称，原则不变：**不造 XMind 不存在的 marker-id**，只逆写导入表中
// 「实测/推断」id）：priority 九档 → priority-N（urgent 取最高档 1、low 落 9，现行
// PRIORITY_EXPORT）；flag 三值 → flag-red（代表 id，形状/颜色不保真）；other.important
// → star-red（既有）；progress 八档 → task-*（none 不写，task-start 未实测）、mood.smile
// → smiley-laugh（sad/cry/love/kiss 不写）、other 六值 → symbol 族/c_symbol_like、
// other.person → people-orange（实测 id 作代表）、arrow 四向 → arrow-*（leftright 不写）
// 五张镜像表；emoji 28 / number 10 与其余 other slug 无原生对应，不写（登记往返残余）。
//
// 镜像模式（本包零依赖 gmind/*，注释标注「与 core 同步」，core 变更须同步抄录）：
// PRIORITY_LEGACY_MAP ↔ core constants.ts PRIORITY_LEGACY_MAP；progress/mood/arrow/
// other 各 slug 集 ↔ core PROGRESS_VALUES/MOOD_VALUES/ARROW_VALUES/OTHER_VALUES。

import type { XmindIcons } from './types';

type MarkerGroup = NonNullable<keyof XmindIcons>;

/** 优先级档映射（与 core PRIORITY_LEGACY_MAP 同步镜像：M7a '1'-'7' → 企微九档）。 */
const PRIORITY_LEGACY_MAP: Record<string, string> = {
  '1': 'p0',
  '2': 'p1',
  '3': 'p2',
  '4': 'p3',
  '5': 'p4',
  '6': 'mid',
  '7': 'low',
};

/** 导出方向：priority slug → XMind priority-N（urgent 取最高档 1，low 落 9）。 */
const PRIORITY_EXPORT: Record<string, string> = {
  p0: '1',
  p1: '2',
  p2: '3',
  p3: '4',
  p4: '5',
  urgent: '1',
  high: '6',
  mid: '7',
  low: '9',
};

/**
 * 导入方向精确表（spec §3.1 逐行，不含 priority/flag/star 三族——它们走下方 regex/
 * 前缀分支）。slug 值与 core 对应目录同步镜像：progress ↔ PROGRESS_VALUES、
 * mood ↔ MOOD_VALUES、other ↔ OTHER_VALUES、arrow ↔ ARROW_VALUES。
 */
const MARKER_IMPORT_MAP: Record<string, { group: MarkerGroup; value: string }> = {
  // 进度九档（XMind 8 进度八档同构 + start 推断档；5 实测 + 4 推断）。
  'task-start': { group: 'progress', value: 'none' },
  'task-oct': { group: 'progress', value: 'p12' },
  'task-quar': { group: 'progress', value: 'p25' },
  'task-3oct': { group: 'progress', value: 'p37' },
  'task-half': { group: 'progress', value: 'p50' },
  'task-5oct': { group: 'progress', value: 'p62' },
  'task-3quar': { group: 'progress', value: 'p75' },
  'task-7oct': { group: 'progress', value: 'p87' },
  'task-done': { group: 'progress', value: 'done' },
  // 表情族（2026-11-14 推翻 M7b「emoji 组不从 XMind 导入」入表口径）。
  'smiley-smile': { group: 'mood', value: 'smile' }, // 推断（同名）
  'smiley-sad': { group: 'mood', value: 'sad' }, // 推断（同名）
  'smiley-cry': { group: 'mood', value: 'cry' }, // 推断（同名）
  'smiley-laugh': { group: 'mood', value: 'smile' }, // 实测，形近（大笑→微笑）
  // 人物族六色（orange 实测，余推断；颜色丢）。
  'people-red': { group: 'other', value: 'person' },
  'people-orange': { group: 'other', value: 'person' },
  'people-yellow': { group: 'other', value: 'person' },
  'people-green': { group: 'other', value: 'person' },
  'people-blue': { group: 'other', value: 'person' },
  'people-purple': { group: 'other', value: 'person' },
  // 符号族（全部实测；wrong→cancel、right→done 语义对位）。
  'symbol-plus': { group: 'other', value: 'plus' },
  'symbol-question': { group: 'other', value: 'question' },
  'symbol-wrong': { group: 'other', value: 'cancel' },
  'symbol-right': { group: 'other', value: 'done' },
  'symbol-idea': { group: 'other', value: 'idea' },
  'c_symbol_like': { group: 'other', value: 'like' }, // 实测，下划线精确 id
  // 箭头四向（up 实测，余推断；颜色丢）。
  'arrow-up': { group: 'arrow', value: 'up' },
  'arrow-down': { group: 'arrow', value: 'down' },
  'arrow-left': { group: 'arrow', value: 'left' },
  'arrow-right': { group: 'arrow', value: 'right' },
};

/** 单选组集合（spec §3.1：首个胜、后续计 dropped；other 组 multi 并存不在此列）。 */
const SINGLE_SELECT: ReadonlySet<MarkerGroup> = new Set(['priority', 'flag', 'progress', 'mood', 'arrow']);

// ── 导出方向五张镜像表（spec §3.2：只逆写「实测/推断」id，无对应值不入表=不写）──

/** progress slug → task-*（与 core PROGRESS_VALUES 同步镜像；none 不写，task-start 未实测）。 */
const PROGRESS_EXPORT: Record<string, string> = {
  p12: 'task-oct',
  p25: 'task-quar',
  p37: 'task-3oct',
  p50: 'task-half',
  p62: 'task-5oct',
  p75: 'task-3quar',
  p87: 'task-7oct',
  done: 'task-done',
};

/** mood slug → smiley-*（与 core MOOD_VALUES 同步镜像；仅 smile 有实测 id，余不写）。 */
const MOOD_EXPORT: Record<string, string> = {
  smile: 'smiley-laugh',
};

/** other slug → symbol 族/c_symbol_like（与 core OTHER_VALUES 同步镜像，实测六值）。 */
const OTHER_EXPORT: Record<string, string> = {
  like: 'c_symbol_like',
  question: 'symbol-question',
  plus: 'symbol-plus',
  cancel: 'symbol-wrong',
  done: 'symbol-right',
  idea: 'symbol-idea',
};

/** arrow slug → arrow-*（与 core ARROW_VALUES 同步镜像；leftright 不写）。 */
const ARROW_EXPORT: Record<string, string> = {
  up: 'arrow-up',
  down: 'arrow-down',
  left: 'arrow-left',
  right: 'arrow-right',
};

/** other.person → people-orange（实测 id 作代表，颜色不保真）。 */
const PERSON_EXPORT: Record<string, string> = {
  person: 'people-orange',
};

/** 导入方向：marker-id 列表 → 八组制标记（组值数组）+ 丢弃计数（计入图标降级）。 */
export function markersToIcons(ids: string[]): { icons: XmindIcons; dropped: number } {
  let dropped = 0;
  const icons: XmindIcons = {};
  const singleSeen = new Set<MarkerGroup>(); // 单选组已占用（首个胜）
  const otherSeen = new Set<string>(); // other 组已落值（同值重复按丢弃登记）
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') {
      dropped += 1;
      continue;
    }
    let hit: { group: MarkerGroup; value: string } | undefined;
    const pr = /^priority-([1-9])$/.exec(id);
    if (pr) {
      const legacy = Number(pr[1]) >= 8 ? '7' : pr[1]; // 8/9 clamp 7（M7a 口径）
      hit = { group: 'priority', value: PRIORITY_LEGACY_MAP[legacy] as string };
    } else if (/^flag-/.test(id)) {
      hit = { group: 'flag', value: 'flag' }; // 任意颜色前缀：颜色信息无对应位，丢弃
    } else if (/^star-/.test(id)) {
      hit = { group: 'other', value: 'important' }; // 颜色丢（橙星）
    } else {
      hit = MARKER_IMPORT_MAP[id];
    }
    if (!hit) {
      dropped += 1; // 无对应（arrow-refresh/symbol-minus/陌生族）：丢弃并登记
      continue;
    }
    if (hit.group === 'other') {
      if (otherSeen.has(hit.value)) {
        dropped += 1; // 同值重复：首个胜 → 登记
      } else {
        otherSeen.add(hit.value);
        (icons.other ??= []).push(hit.value); // multi 组并存（input 顺序）
      }
    } else if (SINGLE_SELECT.has(hit.group) && singleSeen.has(hit.group)) {
      dropped += 1; // 单选组后续：首个胜，被吞掉 → 未映射丢弃并登记（M7a-R1 2.4）
    } else {
      singleSeen.add(hit.group);
      icons[hit.group] = [hit.value];
    }
  }
  return { icons, dropped };
}

/** 导出方向：八组制标记（各数组逐枚）→ XMind marker-id 列表（仅有原生对应的值）。 */
export function iconsToMarkerIds(icons: XmindIcons | undefined): string[] {
  if (!icons) return [];
  const out: string[] = [];
  for (const value of icons.priority ?? []) {
    const n = PRIORITY_EXPORT[value];
    if (n !== undefined) out.push(`priority-${n}`);
  }
  for (const value of icons.flag ?? []) {
    if (value === 'flag' || value === 'flagRect' || value === 'flagPennant') out.push('flag-red');
  }
  for (const value of icons.progress ?? []) {
    const id = PROGRESS_EXPORT[value]; // none 无键 → 不写
    if (id !== undefined) out.push(id);
  }
  for (const value of icons.mood ?? []) {
    const id = MOOD_EXPORT[value]; // sad/cry/love/kiss 无键 → 不写
    if (id !== undefined) out.push(id);
  }
  for (const value of icons.arrow ?? []) {
    const id = ARROW_EXPORT[value]; // leftright 无键 → 不写
    if (id !== undefined) out.push(id);
  }
  for (const value of icons.other ?? []) {
    if (value === 'important') out.push('star-red'); // 既有
    else {
      const id = OTHER_EXPORT[value] ?? PERSON_EXPORT[value];
      if (id !== undefined) out.push(id);
    }
  }
  // number/emoji 组与其余 other slug：无 XMind 原生 marker 对应，不导出
  // （不造不存在的 marker-id，保证产物在 XMind 中可打开）。
  return out;
}
