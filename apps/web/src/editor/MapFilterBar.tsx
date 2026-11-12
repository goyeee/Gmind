import { useEffect, useMemo, useRef, useState } from 'react';
import type { CustomColumnType } from '@gmind/core';
import type { TaskStatus } from '@gmind/shared';
import type { Filters } from './TaskTable';
import { EMPTY_FILTERS } from './TaskTable';
import {
  condFieldsOf,
  condSummary,
  needsVal,
  opLabel,
  OPS_BY_KIND,
  resolveCondVal,
  type CondField,
  type FilterCond,
  type FilterKind,
} from './taskFilter';
import './map-filter.css';

/**
 * 画布筛选栏（二期对齐轮 2026-10-24，原型 FilterBar 全量对齐）：
 * - 「筛选」下拉 = 条件构建器：字段条件行（负责人/进度/开始·预期·完成日期 + 自定义列，
 *   操作符按类别），**新增条件时既有条件自动收起**（需求方交互裁定）、行头摘要 +
 *   展开收起 + 删除；生效范围（对所有人生效/对本人生效，2026-10-25 原型文案）；更多条件（人员/分组/部门，
 *   分组部门经 org directory 求值）；待办状态 chips；仅逾期/仅未分配；重置。
 * - 「视图」下拉 = 预设视图（我的待办/全部逾期/未分配任务）+ 我保存的视图
 *   （localStorage 按文件存——视图级显示偏好不入文档，同简洁模式裁定）+ 保存当前筛选。
 * - 激活标签 chips + 清除 + 右侧命中计数。脑图非命中节点经引擎 fadeOf 淡化；
 *   表格视图的同状态筛选在 TaskTable 自带筛选条。
 */

const STATUS_ITEMS: Array<[TaskStatus, string]> = [
  ['todo', '未开始'],
  ['doing', '进行中'],
  ['done', '已完成'],
  ['blocked', '阻塞'],
];

const KIND_GLYPH: Record<FilterKind, string> = { person: '👤', number: '#', time: '📅', text: '≡' };

interface SavedView {
  id: string;
  name: string;
  filters: {
    owners: string[];
    statuses: TaskStatus[];
    overdueOnly: boolean;
    unassignedOnly: boolean;
    conds: FilterCond[];
    scope: 'all' | 'me';
    grp: string;
    dept: string;
  };
}

const viewsKey = (fileId: string): string => `gmind.filterViews:${fileId}`;

function loadViews(fileId: string): SavedView[] {
  try {
    return JSON.parse(localStorage.getItem(viewsKey(fileId)) ?? '[]') as SavedView[];
  } catch {
    return [];
  }
}

/** Filters ↔ 可序列化（owners Set ↔ array）。 */
function serialize(f: Filters): SavedView['filters'] {
  return {
    owners: [...f.owners],
    statuses: [...f.statuses],
    overdueOnly: f.overdueOnly,
    unassignedOnly: f.unassignedOnly,
    conds: f.conds,
    scope: f.scope,
    grp: f.grp,
    dept: f.dept,
  };
}

function deserialize(v: SavedView['filters']): Filters {
  return {
    keyword: '',
    owners: new Set(v.owners),
    statuses: new Set(v.statuses),
    overdueOnly: v.overdueOnly,
    unassignedOnly: v.unassignedOnly,
    conds: v.conds,
    scope: v.scope,
    grp: v.grp,
    dept: v.dept,
  };
}

export interface MapFilterBarProps {
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
  /** 当前视图（命中计数文案随视图：脑图=淡化未命中、表格=仅显示命中项）。 */
  view: 'mind' | 'table';
  /** 负责人候选（文档内负责人 ∪ 在线成员；label = 昵称回退）。 */
  candidates: Array<{ id: string; label: string }>;
  meId: string;
  totalTasks: number;
  hitCount: number;
  /** 自定义列 schema（条件字段 + 人员列求值）。 */
  customColumns: Array<{ id: string; name: string; type: CustomColumnType }>;
  /** 组织目录（分组/部门筛选下拉）。 */
  orgOptions: { depts: Array<{ id: string; name: string }>; groups: Array<{ id: string; name: string }> };
  /** 保存视图的存储键（按文件隔离）。 */
  fileId: string;
}

export function MapFilterBar(props: MapFilterBarProps): React.ReactElement {
  const { filters, onFiltersChange, candidates, meId, totalTasks, hitCount, customColumns, orgOptions, fileId, view } = props;
  const [pop, setPop] = useState<'' | 'filter' | 'views'>('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fields = useMemo(() => condFieldsOf(customColumns), [customColumns]);
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadViews(fileId));
  const [viewName, setViewName] = useState('');
  const [menu, setMenu] = useState<'' | 'add' | string>(''); // 'add' = 添加条件的字段菜单；其余 = 条件行字段菜单（cond id）
  const [folded, setFolded] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSavedViews(loadViews(fileId));
  }, [fileId]);

  // 外点关闭（弹层内不关）
  useEffect(() => {
    if (pop === '') return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPop('');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [pop]);

  const labelOf = (id: string): string => (id === meId ? '我' : (candidates.find((c) => c.id === id)?.label ?? `成员 ${id.slice(-4)}`));
  const filtering =
    filters.keyword.trim() !== '' ||
    filters.owners.size > 0 ||
    filters.statuses.size > 0 ||
    filters.overdueOnly ||
    filters.unassignedOnly ||
    filters.conds.length > 0 ||
    filters.scope === 'me' ||
    filters.grp !== '' ||
    filters.dept !== '';

  const set = (p: Partial<Filters>): void => onFiltersChange({ ...filters, ...p });
  const setCond = (id: string, p: Partial<FilterCond>): void =>
    set({ conds: filters.conds.map((c) => (c.id === id ? { ...c, ...p } : c)) });

  /** 添加条件（需求方交互裁定：新条件展开、既有条件全部收起）。 */
  const addCond = (field: CondField): void => {
    const kind = field.kind;
    const cond: FilterCond = { id: crypto.randomUUID(), col: field.key, op: OPS_BY_KIND[kind][0], val: '' };
    set({ conds: [...filters.conds, cond] });
    setFolded(new Set(filters.conds.map((c) => c.id)));
    setMenu('');
  };

  const removeCond = (id: string): void => set({ conds: filters.conds.filter((c) => c.id !== id) });
  const toggleFold = (id: string): void =>
    setFolded((f) => {
      const n = new Set(f);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const saveView = (): void => {
    const name = viewName.trim();
    if (name === '' || !filtering) return;
    const next: SavedView[] = [...savedViews, { id: `v${Date.now()}`, name, filters: serialize(filters) }];
    setSavedViews(next);
    localStorage.setItem(viewsKey(fileId), JSON.stringify(next));
    setViewName('');
  };
  const dropView = (id: string): void => {
    const next = savedViews.filter((v) => v.id !== id);
    setSavedViews(next);
    localStorage.setItem(viewsKey(fileId), JSON.stringify(next));
  };
  const applyView = (f: Filters): void => {
    onFiltersChange(f);
    setPop('');
  };

  const fieldMenu = (pick: (field: CondField) => void, posClass: string): React.ReactElement => (
    <>
      <div className="mf-menu-mask" onClick={() => setMenu('')} />
      <div role="menu" aria-label="选择字段" className={`mf-field-menu ${posClass}`}>
        <div className="mf-menu-title">选择字段</div>
        {fields.map((f) => (
          <button key={f.key} type="button" role="menuitem" onClick={() => pick(f)}>
            <i aria-hidden>{KIND_GLYPH[f.kind]}</i>
            {f.label}
          </button>
        ))}
      </div>
    </>
  );

  const tagList: Array<[string, string, () => void]> = [];
  if (filters.scope === 'me') tagList.push(['范围', '对本人生效', () => set({ scope: 'all' })]);
  if (filters.owners.size > 0)
    tagList.push([
      '负责人',
      [...filters.owners].map(labelOf).join('、'),
      () => set({ owners: new Set() }),
    ]);
  if (filters.grp !== '') tagList.push(['分组', orgOptions.groups.find((g) => g.id === filters.grp)?.name ?? '', () => set({ grp: '' })]);
  if (filters.dept !== '') tagList.push(['部门', orgOptions.depts.find((d) => d.id === filters.dept)?.name ?? '', () => set({ dept: '' })]);
  for (const c of filters.conds) {
    const field = fields.find((f) => f.key === c.col);
    if (!needsVal(c.op) || c.val !== '')
      tagList.push([
        field?.label ?? '条件',
        condSummary(field, c, labelOf),
        () => removeCond(c.id),
      ]);
  }
  if (filters.statuses.size > 0)
    tagList.push([
      '状态',
      [...filters.statuses]
        .map((s) => STATUS_ITEMS.find((i) => i[0] === s)?.[1] ?? s)
        .join('、'),
      () => set({ statuses: new Set() }),
    ]);
  if (filters.overdueOnly) tagList.push(['', '仅逾期', () => set({ overdueOnly: false })]);
  if (filters.unassignedOnly) tagList.push(['', '仅未分配', () => set({ unassignedOnly: false })]);

  const sel = (label: string, value: string, onChange: (v: string) => void, options: Array<[string, string]>, disabled = false): React.ReactElement => (
    <label className="mf-sel">
      <span>{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">不限</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="mf-bar" data-testid="map-filter-bar" role="search" aria-label="任务筛选" ref={wrapRef}>
      {/* 筛选（条件构建器） */}
      <div className="mf-anchor">
        <button
          type="button"
          data-testid="map-filter-toggle"
          aria-haspopup="dialog"
          aria-expanded={pop === 'filter'}
          className={filtering || pop === 'filter' ? 'mf-btn active' : 'mf-btn'}
          onClick={() => setPop(pop === 'filter' ? '' : 'filter')}
        >
          筛选
          {tagList.length > 0 && <b className="mf-badge">{tagList.length}</b>}
          <i className="mf-caret" aria-hidden />
        </button>
        {pop === 'filter' && (
          <div className="mf-pop mf-pop-wide" data-testid="map-filter-pop" role="dialog" aria-label="筛选条件">
            <div className="mf-pop-head">
              <b>筛选</b>
              <div className="mf-scope" role="group" aria-label="生效范围">
                <button
                  type="button"
                  className={filters.scope === 'all' ? 'active' : ''}
                  aria-pressed={filters.scope === 'all'}
                  onClick={() => set({ scope: 'all' })}
                >
                  对所有人生效
                </button>
                <button
                  type="button"
                  className={filters.scope === 'me' ? 'active' : ''}
                  aria-pressed={filters.scope === 'me'}
                  onClick={() => set({ scope: 'me' })}
                >
                  对本人生效
                </button>
              </div>
            </div>
            <div className="mf-conds">
              {filters.conds.map((c) => {
                const field = fields.find((f) => f.key === c.col);
                const kind: FilterKind = field?.kind ?? 'text';
                const open = !folded.has(c.id);
                const summary = condSummary(field, c, labelOf);
                const Glyph = KIND_GLYPH[kind];
                const selVals = resolveCondVal(c.val, meId)
                  .split(',')
                  .filter(Boolean);
                const toggleVal = (id: string): void => {
                  const next = selVals.includes(id) ? selVals.filter((x) => x !== id) : [...selVals, id];
                  setCond(c.id, { val: next.join(',') });
                };
                return (
                  <div key={c.id} className="mf-cond" data-testid="map-filter-cond">
                    <div className="mf-cond-head">
                      <button type="button" className="mf-cond-field" onClick={() => setMenu(menu === c.id ? '' : c.id)}>
                        <i aria-hidden>{Glyph}</i>
                        {field?.label ?? c.col}
                        <i className="mf-caret" aria-hidden />
                      </button>
                      {!open && <span className="mf-cond-summary">{summary}</span>}
                      {open && <span className="mf-cond-spacer" />}
                      <button type="button" aria-label="删除此条件" className="mf-cond-del" onClick={() => removeCond(c.id)}>
                        ⊖
                      </button>
                      <button
                        type="button"
                        aria-label={open ? '收起' : '展开'}
                        aria-expanded={open}
                        className="mf-cond-fold"
                        onClick={() => toggleFold(c.id)}
                      >
                        <i className={'mf-caret' + (open ? '' : ' up')} aria-hidden />
                      </button>
                      {menu === c.id &&
                        fieldMenu((f) => {
                          const nk = f.kind;
                          setCond(c.id, { col: f.key, ...(nk === kind ? {} : { op: OPS_BY_KIND[nk][0], val: '' }) });
                          setMenu('');
                        }, 'mf-field-menu-inrow')}
                    </div>
                    {open && (
                      <div className="mf-cond-body">
                        <label className="mf-op-wrap">
                          <select value={c.op} onChange={(e) => setCond(c.id, { op: e.target.value as FilterCond['op'] })}>
                            {OPS_BY_KIND[kind].map((o) => (
                              <option key={o} value={o}>
                                {opLabel(kind, o)}
                              </option>
                            ))}
                          </select>
                          <i className="mf-caret" aria-hidden />
                        </label>
                        {needsVal(c.op) && kind === 'person' && (
                          <ul className="mf-people" data-testid="map-filter-owners">
                            {meId !== '' && (
                              <li>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={selVals.includes('me')}
                                    onChange={() => toggleVal('me')}
                                  />
                                  我
                                </label>
                              </li>
                            )}
                            {candidates
                              .filter((x) => x.id !== meId)
                              .map((x) => (
                                <li key={x.id}>
                                  <label>
                                    <input type="checkbox" checked={selVals.includes(x.id)} onChange={() => toggleVal(x.id)} />
                                    {x.label}
                                  </label>
                                </li>
                              ))}
                          </ul>
                        )}
                        {needsVal(c.op) && kind === 'number' && (
                          <input
                            type="number"
                            className="mf-input"
                            value={c.val}
                            placeholder="请输入"
                            onChange={(e) => setCond(c.id, { val: e.target.value })}
                          />
                        )}
                        {needsVal(c.op) && kind === 'time' && (
                          <input type="date" className="mf-input" value={c.val} onChange={(e) => setCond(c.id, { val: e.target.value })} />
                        )}
                        {needsVal(c.op) && kind === 'text' && (
                          <input className="mf-input" value={c.val} placeholder="请输入" onChange={(e) => setCond(c.id, { val: e.target.value })} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mf-add-anchor">
              <button type="button" className="mf-add" onClick={() => setMenu(menu === 'add' ? '' : 'add')}>
                ＋ 添加筛选条件
              </button>
              {menu === 'add' && fieldMenu(addCond, 'mf-field-menu-add')}
            </div>
            <div className="mf-more-title">更多条件</div>
            <div className="mf-more">
              {sel('人员', filters.scope === 'me' ? '' : [...filters.owners][0] ?? '', (v) => set({ owners: v === '' ? new Set() : new Set([v]) }), candidates.map((c) => [c.id, c.label] as [string, string]), filters.scope === 'me')}
              {sel('分组', filters.grp, (v) => set({ grp: v }), orgOptions.groups.map((g) => [g.id, g.name] as [string, string]))}
              {sel('部门', filters.dept, (v) => set({ dept: v }), orgOptions.depts.map((d) => [d.id, d.name] as [string, string]))}
            </div>
            <div className="mf-more-title">待办状态</div>
            <div className="mf-statuses">
              {STATUS_ITEMS.map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={filters.statuses.has(k) ? 'mf-chip active' : 'mf-chip'}
                  onClick={() => {
                    const next = new Set(filters.statuses);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    set({ statuses: next });
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="mf-checks">
              <label>
                <input type="checkbox" checked={filters.overdueOnly} onChange={(e) => set({ overdueOnly: e.target.checked })} />
                仅逾期
              </label>
              <label>
                <input type="checkbox" checked={filters.unassignedOnly} onChange={(e) => set({ unassignedOnly: e.target.checked })} />
                仅未分配
              </label>
              <button type="button" className="mf-reset" disabled={!filtering} onClick={() => onFiltersChange(EMPTY_FILTERS)}>
                重置
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 视图（预设 + 保存的视图） */}
      <div className="mf-anchor">
        <button
          type="button"
          data-testid="map-views-toggle"
          aria-haspopup="dialog"
          aria-expanded={pop === 'views'}
          className={pop === 'views' ? 'mf-btn active' : 'mf-btn'}
          onClick={() => setPop(pop === 'views' ? '' : 'views')}
        >
          视图
          {savedViews.length > 0 && <span className="mf-views-num">{savedViews.length}</span>}
          <i className="mf-caret" aria-hidden />
        </button>
        {pop === 'views' && (
          <div className="mf-pop mf-views-pop" data-testid="map-views-pop" role="dialog" aria-label="筛选视图">
            <div className="mf-menu-title">常用视图</div>
            <button type="button" className="mf-view-item" onClick={() => applyView({ ...EMPTY_FILTERS, scope: 'me' })}>
              我的待办
            </button>
            <button type="button" className="mf-view-item" onClick={() => applyView({ ...EMPTY_FILTERS, overdueOnly: true })}>
              全部逾期
            </button>
            <button type="button" className="mf-view-item" onClick={() => applyView({ ...EMPTY_FILTERS, unassignedOnly: true })}>
              未分配任务
            </button>
            <div className="mf-menu-title mf-views-title">我保存的视图</div>
            {savedViews.length === 0 && <p className="mf-hint">暂无，设置筛选后可保存</p>}
            {savedViews.map((v) => (
              <div key={v.id} className="mf-view-row">
                <button type="button" className="mf-view-item" onClick={() => applyView(deserialize(v.filters))}>
                  {v.name}
                </button>
                <button type="button" aria-label={`删除视图 ${v.name}`} className="mf-view-del" onClick={() => dropView(v.id)}>
                  ×
                </button>
              </div>
            ))}
            <div className="mf-save-row">
              <input
                value={viewName}
                placeholder={filtering ? '为当前筛选命名' : '先设置筛选条件'}
                disabled={!filtering}
                onChange={(e) => setViewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveView()}
              />
              <button type="button" className="mf-btn mf-save-btn" disabled={!filtering || viewName.trim() === ''} onClick={saveView}>
                保存
              </button>
            </div>
          </div>
        )}
      </div>

      {tagList.map(([k, v, rm]) => (
        <span key={k + v} className="mf-tag">
          {k !== '' && <em>{k}：</em>}
          {v}
          <button type="button" aria-label={`移除筛选 ${k}${v}`} onClick={rm}>
            ×
          </button>
        </span>
      ))}
      {filtering && (
        <button type="button" className="mf-clear" onClick={() => onFiltersChange(EMPTY_FILTERS)}>
          清除
        </button>
      )}

      <span className="mf-count" aria-live="polite" data-testid="map-filter-count">
        {filtering ? (
          <>
            命中 <b>{hitCount}</b> 个任务 · {view === 'mind' ? '脑图淡化未命中' : '表格仅显示命中项'}
          </>
        ) : (
          <>共 {totalTasks} 个任务</>
        )}
      </span>
    </div>
  );
}
