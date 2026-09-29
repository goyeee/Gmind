// markers.ts：XMind marker-id ⇄ Gmind 八组制标记的双向映射（M7b-W1 目录对齐）。
//
// 导入口径（M7a 口径沿用 + M7b 再入企微目录，映射表单源 @gmind/core 的
// PRIORITY_LEGACY_MAP/ICON_LEGACY_MAP/progressStageOf——本包零依赖 gmind/*，本地
// 等值镜像，注释标注「与 core 同步」）：priority-1..9 → M7a 档位（8/9 clamp 7）→
// 企微九档 slug；flag-*（任意颜色）→ flag 组 'flag'；star-* → other 'important'
// （颜色信息无对应位，丢弃）；task-*/smiley-*/people-*/symbol-* 等其余 marker 族、
// 无法解析的 id 一并计入 dropped（style 降级，FR-IO-002「未映射丢弃并登记」口径）。
// emoji 组不从 XMind 导入（XMind 表情 marker 族 id 与 Gmind 目录无稳定对应）。
// M7b 起.flag 与 star 落不同组、可并存（M7a 的「star 恒胜」冲突规则随三组制退役）。
//
// 导出口径（「各数组逐枚导出」）：priority 组各档 slug → priority-N（urgent→1 最高
// 档、low→9）；flag 组 → flag-red（代表性原生 id，形状/颜色不保真）；other
// 'important' → star-red；其余 slug 与 emoji 字符无 XMind 原生 marker 对应，不导出
// （不造不存在的 marker-id，保证产物在 XMind 中可打开）。

import type { XmindIcons } from './types';

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

/** 导入方向：marker-id 列表 → 八组制标记（组值数组）+ 丢弃计数（计入 style 降级）。 */
export function markersToIcons(ids: string[]): { icons: XmindIcons; dropped: number } {
  let dropped = 0;
  const icons: XmindIcons = {};
  let prioritySeen = false;
  let flagSeen = false;
  let starSeen = false;
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') {
      dropped += 1;
      continue;
    }
    const pr = /^priority-([1-9])$/.exec(id);
    if (pr) {
      if (prioritySeen) {
        dropped += 1; // 单选组后续：首个胜，被吞掉 → 未映射丢弃并登记（M7a-R1 2.4）
      } else {
        prioritySeen = true;
        const n = Number(pr[1]);
        const legacy = n >= 8 ? '7' : pr[1];
        icons.priority = [PRIORITY_LEGACY_MAP[legacy] as string];
      }
      continue;
    }
    if (/^flag-/.test(id)) {
      if (flagSeen) dropped += 1; // 单选组后续：被吞掉 → 登记
      else {
        flagSeen = true;
        icons.flag = ['flag'];
      }
      continue;
    }
    if (/^star-/.test(id)) {
      if (starSeen) dropped += 1; // 同组重复：首个胜 → 登记
      else {
        starSeen = true;
        icons.other = ['important'];
      }
      continue;
    }
    dropped += 1; // 无对应：丢弃并登记
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
  for (const value of icons.other ?? []) {
    if (value === 'important') out.push('star-red');
  }
  // mood/number/arrow/progress/emoji 与其余 other slug：无 XMind 原生 marker 对应，
  // 不导出（头注口径，M7a 沿用）。
  return out;
}
