import { useEffect, useRef, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import { getNode, ORIGIN_USER, ROOT_NODE_ID, setText, withTransaction } from '@gmind/core';
import './find-replace.css';

/**
 * 查找替换条（M6 Task 3，企微对标）— 画布顶部浮层。
 *
 * 契约（testid 冻结，e2e/find-replace.e2e.spec.ts 同源）：find-bar / find-input /
 * find-next / find-prev / find-replace-input / find-replace-btn / find-replace-all /
 * find-close / find-count（`n/m` 式：n=当前第几个（1 起），m=匹配总数；空查询与
 * 无匹配均 `0/0`，动作钮随 0 匹配禁用）。
 *
 * 职责边界（组件纯交互/展示，写路径复用页面装配）：
 * - 匹配集 = 全部存活可达节点 text 的大小写不敏感包含（root 计入，先序文档序）——
 *   遍历与 xmind-export.ts 同款读路径（getNode/childIds + 环防护），折叠只影响
 *   可见性不影响匹配（数据层全量）；
 * - 定位复用 EditorPage locateNode（M3b 评论面板同款：selectOnly + 展开折叠祖先）；
 * - 替换当前 = 当前定位节点 text 内**首个**匹配替换（ setText ORIGIN_USER）；
 * - 全部替换 = 每节点全部出现替换，整体包**一个**用户事务（单次 Ctrl+Z 全回）；
 * - 替换后重算匹配集并推进定位（当前节点仍在匹配集 → 停留，已移出 → 同下标滑到
 *   下一匹配，即「替换后跳下一个」的标准编辑器语义）；
 * - Esc/关闭清空定位（matches/activeIndex 归零，查询串保留供重开复用）。
 *
 * 开关与键位绑定在 EditorPage（Ctrl/Cmd+F / Esc / find-toggle），本组件只消费 open。
 */
export interface FindReplaceProps {
  doc: Y.Doc | null;
  open: boolean;
  onClose(): void;
  /** 画布定位（selectOnly + 展开折叠祖先；EditorPage locateNode 直传）。 */
  onLocate(nodeId: string): void;
  /** 用户写统一收尾（capUndoStack + markEditing），EditorPage 装配。 */
  afterUserWrite(): void;
  showToast(message: string): void;
}

/**
 * 存活可达树先序匹配收集：root 计入（本周计划 查「周」命中 root 即此口径）。
 * 环防护与 xmind-export 同款：visited 防回边，墓碑/悬空 id 不入集。
 */
function collectMatchIds(doc: Y.Doc, needle: string): string[] {
  if (needle === '') return [];
  const lower = needle.toLowerCase();
  const out: string[] = [];
  const visited = new Set<string>([ROOT_NODE_ID]);
  const walk = (id: string): void => {
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    if (snap.text.toLowerCase().includes(lower)) out.push(id);
    for (const childId of snap.childIds) {
      if (visited.has(childId)) continue; // 环防护：已访问 id 不再下降（含指回 root）
      const child = getNode(doc, childId);
      if (!child || child.deleted) continue; // 防御：悬空 id / 墓碑不入树
      visited.add(childId);
      walk(childId);
    }
  };
  walk(ROOT_NODE_ID);
  return out;
}

/** 大小写不敏感替换第一处出现；未命中原样返回（调用方据此判 no-op）。 */
function replaceFirstCI(text: string, needle: string, replacement: string): string {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return text;
  return text.slice(0, idx) + replacement + text.slice(idx + needle.length);
}

/** 大小写不敏感替换全部出现（一次遍历拼接，无正则转义问题）。 */
function replaceAllCI(text: string, needle: string, replacement: string): string {
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  let out = '';
  let consumed = 0;
  for (let idx = lowerText.indexOf(lowerNeedle); idx >= 0; idx = lowerText.indexOf(lowerNeedle, consumed)) {
    out += text.slice(consumed, idx) + replacement;
    consumed = idx + needle.length;
  }
  return consumed === 0 ? text : out + text.slice(consumed);
}

export function FindReplace({
  doc,
  open,
  onClose,
  onLocate,
  afterUserWrite,
  showToast,
}: FindReplaceProps): ReactElement | null {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matches, setMatches] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // onLocate 是 EditorPage 每渲染重建的内联函数：ref 持有最新实现，避免 effect
  // 依赖抖动（matches state 写入 + 依赖数组含不稳定引用会互喂成渲染循环）。
  const onLocateRef = useRef(onLocate);
  onLocateRef.current = onLocate;

  // 开关沿：打开聚焦查询输入（全选便于直接覆盖）；关闭清空定位（匹配集与下标归零，
  // 查询/替换串保留——重开免重输，重算定位由下方 open 依赖的 effect 兜住）。
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setMatches([]);
      setActiveIndex(0);
    }
  }, [open]);

  // 查询串变化（含打开沿）→ 全量重算 + 回到第 1 个并定位（键入即定位的查找惯例）。
  useEffect(() => {
    if (!open) return;
    const next = doc ? collectMatchIds(doc, query) : [];
    setMatches(next);
    setActiveIndex(0);
    if (next.length > 0) onLocateRef.current(next[0]);
  }, [open, query, doc]);

  // 文档更新（本地替换事务 / 远端协同 / 撤销重做）→ 重算匹配并钳制定位下标：
  // 替换写后「定位状态刷新」与远端文本变化不残留陈旧计数均走这一条通道。
  useEffect(() => {
    if (!doc || !open) return;
    const onUpdate = (): void => {
      const next = collectMatchIds(doc, query);
      setMatches(next);
      setActiveIndex((i) => Math.min(i, Math.max(next.length - 1, 0)));
    };
    doc.on('update', onUpdate);
    return () => {
      doc.off('update', onUpdate);
    };
  }, [doc, open, query]);

  /** 循环定位：±1 取模回绕；matches 为空（禁用态）不可达。 */
  const go = (delta: 1 | -1): void => {
    if (matches.length === 0) return;
    const next = (activeIndex + delta + matches.length) % matches.length;
    setActiveIndex(next);
    onLocateRef.current(matches[next]);
  };

  /** 替换当前：当前定位节点 text 首个匹配 → setText（ORIGIN_USER 单事务）。
   *  推进语义：重算后同下标——节点仍有其余匹配则停留（连续替换逐个吃掉），
   *  已移出则下一匹配滑入该下标（即「替换后到下一个」）。 */
  const replaceCurrent = (): void => {
    if (!doc || matches.length === 0) return;
    const id = matches[Math.min(activeIndex, matches.length - 1)];
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    const nextText = replaceFirstCI(snap.text, query, replacement);
    if (nextText === snap.text) return;
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        setText(doc, id, nextText, ORIGIN_USER);
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '替换失败');
      return;
    }
    afterUserWrite();
    const nextMatches = collectMatchIds(doc, query);
    const idx = Math.min(activeIndex, Math.max(nextMatches.length - 1, 0));
    setMatches(nextMatches);
    setActiveIndex(idx);
    if (nextMatches.length > 0) onLocateRef.current(nextMatches[idx]);
  };

  /** 全部替换：每个匹配节点 text 内全部出现替换，整体包一个用户事务（单次撤销全回）。 */
  const replaceAllMatches = (): void => {
    if (!doc || matches.length === 0) return;
    const changes: Array<{ id: string; text: string }> = [];
    for (const id of matches) {
      const snap = getNode(doc, id);
      if (!snap || snap.deleted) continue;
      const nextText = replaceAllCI(snap.text, query, replacement);
      if (nextText !== snap.text) changes.push({ id, text: nextText });
    }
    if (changes.length === 0) return;
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        for (const change of changes) setText(doc, change.id, change.text, ORIGIN_USER);
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '替换失败');
      return;
    }
    afterUserWrite();
    const nextMatches = collectMatchIds(doc, query);
    setMatches(nextMatches);
    setActiveIndex(0);
    if (nextMatches.length > 0) onLocateRef.current(nextMatches[0]);
  };

  if (!open) return null;

  const count = matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : '0/0';
  const none = matches.length === 0;

  return (
    <div className="find-bar" data-testid="find-bar" role="search" aria-label="查找替换">
      <input
        ref={inputRef}
        data-testid="find-input"
        className="find-input"
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="查找内容"
        aria-label="查找内容"
      />
      <span className="find-count" data-testid="find-count">
        {count}
      </span>
      <button
        data-testid="find-prev"
        type="button"
        className="find-btn"
        disabled={none}
        onClick={() => go(-1)}
        title="上一个匹配"
        aria-label="上一个匹配"
      >
        ↑
      </button>
      <button
        data-testid="find-next"
        type="button"
        className="find-btn"
        disabled={none}
        onClick={() => go(1)}
        title="下一个匹配"
        aria-label="下一个匹配"
      >
        ↓
      </button>
      <input
        data-testid="find-replace-input"
        className="find-input"
        type="text"
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        placeholder="替换为"
        aria-label="替换为"
      />
      <button
        data-testid="find-replace-btn"
        type="button"
        className="find-btn"
        disabled={none}
        onClick={replaceCurrent}
      >
        替换
      </button>
      <button
        data-testid="find-replace-all"
        type="button"
        className="find-btn"
        disabled={none}
        onClick={replaceAllMatches}
      >
        全部替换
      </button>
      <button
        data-testid="find-close"
        type="button"
        className="find-btn find-close-btn"
        onClick={onClose}
        title="关闭 (Esc)"
        aria-label="关闭查找"
      >
        ×
      </button>
    </div>
  );
}
