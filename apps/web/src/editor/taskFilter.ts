import type { CustomColumnType } from '@gmind/core';

/**
 * 任务筛选条件构建器（二期对齐轮 2026-10-24，原型 FilterBar/lib/tasks 对齐）：
 * 字段条件（conds）的求值单源——脑图淡化（EditorPage fadeOf）与表格行过滤
 * （TaskTable matchNode）共用同一份语义，避免两处口径漂移。
 *
 * 字段 = 内置（负责人/进度/开始日期/预期日期/完成日期）+ 自定义列（assignee→人员、
 * progress→数字、date→时间、text→文本）。操作符按类别给出（person 无大小比较、
 * time 标签为晚于/早于）。原型「更新时间」字段不入选：该值是表格会话内数据
 * （updatedRef），脑图侧无此信息，入选会造成两视图口径分裂。
 */

export type FilterKind = 'person' | 'number' | 'time' | 'text';

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'ge'
  | 'lt'
  | 'le'
  | 'contains'
  | 'notContains'
  | 'empty'
  | 'notEmpty';

export interface FilterCond {
  /** 条件实例 id（新建 crypto.randomUUID()）。 */
  id: string;
  /** 字段 key：内置 'owner' | 'progress' | 'startDate' | 'dueDate' | 'finishDate'，或自定义列 id。 */
  col: string;
  op: FilterOp;
  /** 值：person=逗号分隔 userId（'me' 代查看者）；其余为输入原文。 */
  val: string;
}

export interface CondField {
  key: string;
  label: string;
  kind: FilterKind;
  /** 自定义列（key = 列 id）。 */
  custom?: CustomColumnType;
}

export const OP_LABEL: Record<FilterOp, string> = {
  eq: '等于 =',
  ne: '不等于 ≠',
  gt: '大于 >',
  ge: '大于等于 ≥',
  lt: '小于 <',
  le: '小于等于 ≤',
  contains: '包含',
  notContains: '不包含',
  empty: '为空',
  notEmpty: '不为空',
};

export const OPS_BY_KIND: Record<FilterKind, FilterOp[]> = {
  text: ['contains', 'notContains', 'eq', 'ne', 'empty', 'notEmpty'],
  person: ['eq', 'ne', 'empty', 'notEmpty'],
  number: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'notEmpty'],
  time: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'empty', 'notEmpty'],
};

/** 按类别的操作符显示名（time 的比较语义 = 日期先后）。 */
export function opLabel(kind: FilterKind, op: FilterOp): string {
  if (kind === 'person') {
    return ({ eq: '包含', ne: '不包含', empty: '为空', notEmpty: '不为空' } as Record<string, string>)[op] ?? OP_LABEL[op];
  }
  if (kind === 'time') {
    return (
      ({ gt: '晚于 >', ge: '不早于 ≥', lt: '早于 <', le: '不晚于 ≤' } as Record<string, string>)[op] ?? OP_LABEL[op]
    );
  }
  return OP_LABEL[op];
}

export const needsVal = (op: FilterOp): boolean => op !== 'empty' && op !== 'notEmpty';

/** 内置条件字段（colLabels 改名由调用方覆盖 label）。
 *  负责人经字段条件行筛选（需求方 2026-11-16 拍板「保留负责人字段筛选，删更多条件·人员」）；
 *  「更多条件·人员」下拉已删除（此前与字段条件行双入口导致两组标签）。 */
export const BUILTIN_COND_FIELDS: CondField[] = [
  { key: 'owner', label: '负责人', kind: 'person' },
  { key: 'progress', label: '进度', kind: 'number' },
  { key: 'startDate', label: '开始日期', kind: 'time' },
  { key: 'dueDate', label: '预期日期', kind: 'time' },
  { key: 'finishDate', label: '完成日期', kind: 'time' },
];

const CUSTOM_KIND: Record<CustomColumnType, FilterKind> = {
  assignee: 'person',
  progress: 'number',
  date: 'time',
  text: 'text',
};

/** 条件字段全集 = 内置 + 自定义列（调用方传列 schema）。 */
export function condFieldsOf(cols: Array<{ id: string; name: string; type: CustomColumnType }>): CondField[] {
  return [...BUILTIN_COND_FIELDS, ...cols.map((c) => ({ key: c.id, label: c.name, kind: CUSTOM_KIND[c.type], custom: c.type }))];
}

/** 条件求值的行上下文（两视图各自装配：表格=RowNode、脑图=文档快照）。 */
export interface CondCtx {
  owners: string[];
  /** 是否携带任务信息（纯脑图节点 = false；number/person 的 empty 判定用）。 */
  hasTask: boolean;
  /** 有效进度（叶=自身、父=Σ 子级——与画布任务行/表格进度列同口径）。 */
  progress: number;
  startDate: string | null;
  dueDate: string | null;
  finishDate: string | null;
  custom: Record<string, unknown>;
  /** 人员列条目拉平（assignee 列的 user 集合求值用）。 */
  assigneeUsers: (colId: string) => string[];
}

const asNum = (v: unknown): number | null => (typeof v === 'number' ? v : v === '' || v == null ? null : Number(v) || null);
const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

/** 单条件求值（needsVal 且 val 空 = 条件未设置，恒 true——与原型 condOk 同口径）。 */
export function evalCond(cond: FilterCond, field: CondField | undefined, ctx: CondCtx): boolean {
  if (needsVal(cond.op) && cond.val === '') return true;
  const kind = field?.kind ?? 'text';
  const customKey = field?.custom !== undefined ? cond.col : undefined;

  let values: string[] = [];
  let text = '';
  let num: number | null = null;
  if (kind === 'person') {
    values = customKey !== undefined ? ctx.assigneeUsers(cond.col) : ctx.owners;
  } else if (customKey !== undefined) {
    const v = ctx.custom[cond.col];
    if (kind === 'number') num = asNum(v);
    else text = asStr(v);
  } else if (cond.col === 'progress') {
    num = ctx.hasTask ? ctx.progress : null;
  } else if (cond.col === 'owner') {
    values = ctx.owners;
  } else {
    text = (cond.col === 'startDate' ? ctx.startDate : cond.col === 'dueDate' ? ctx.dueDate : ctx.finishDate) ?? '';
  }

  if (kind === 'person') {
    // cond.val 里的 'me' 已由调用方经 resolveCondVal 换成查看者 id
    const want = cond.val.split(',').filter(Boolean);
    const hitAny = want.some((x) => values.includes(x));
    return cond.op === 'empty' ? values.length === 0 : cond.op === 'notEmpty' ? values.length > 0 : cond.op === 'eq' ? hitAny : !hitAny;
  }
  if (kind === 'number') {
    const blank = num === null;
    const w = Number(cond.val);
    if (cond.op === 'empty') return blank;
    if (cond.op === 'notEmpty') return !blank;
    if (blank || num === null || Number.isNaN(w)) return true;
    return cond.op === 'eq' ? num === w : cond.op === 'ne' ? num !== w : cond.op === 'gt' ? num > w : cond.op === 'ge' ? num >= w : cond.op === 'lt' ? num < w : num <= w;
  }
  // text / time：字符串口径（time 为 ISO 日期，字典序=时间序）
  const blank = text === '';
  if (cond.op === 'empty') return blank;
  if (cond.op === 'notEmpty') return !blank;
  if (blank || cond.val === '') return true;
  return cond.op === 'contains'
    ? text.includes(cond.val)
    : cond.op === 'notContains'
      ? !text.includes(cond.val)
      : cond.op === 'eq'
        ? text === cond.val
        : cond.op === 'ne'
          ? text !== cond.val
          : cond.op === 'gt'
            ? text > cond.val
            : cond.op === 'ge'
              ? text >= cond.val
              : cond.op === 'lt'
                ? text < cond.val
                : text <= cond.val;
}

/** 「我」解析：把 cond.val 里的 'me' 替换为查看者 id（人员候选勾选即存 'me'，与原型同）。 */
export function resolveCondVal(val: string, meId: string): string {
  if (meId === '' || !val.includes('me')) return val;
  return val
    .split(',')
    .map((x) => (x === 'me' ? meId : x))
    .join(',');
}

/** 条件摘要（折叠行头文案）：未设置 / 包含 我 / 晚于 2026-10-01 … */
export function condSummary(field: CondField | undefined, cond: FilterCond, labelOf: (id: string) => string): string {
  const kind = field?.kind ?? 'text';
  if (!needsVal(cond.op) || cond.val === '') return needsVal(cond.op) ? '未设置' : opLabel(kind, cond.op);
  const shown =
    kind === 'person'
      ? cond.val
          .split(',')
          .filter(Boolean)
          .map((x) => (x === 'me' ? '我' : labelOf(x)))
          .join('、')
      : cond.val;
  return `${opLabel(kind, cond.op)} ${shown}`.trim();
}
