import { useEffect, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import {
  applyStyle,
  getNode,
  MAX_DESCRIPTION_LENGTH,
  setDescription,
  setHref,
  setImage,
  type NodeSnapshot,
  type StyleScope,
} from '@gmind/core';
import { clampImageSize, MAX_IMAGE_BYTES, readImageSize, uploadImage } from './imageUpload';
import './rich-panel.css';

/**
 * 富内容面板（M1b Task 12，FR-EDT-018~021）+ 样式区（Task 15，FR-EDT-015；
 * M6 Task 2 企微对标：样式区随选中节点联动回显）：
 * 选中节点的样式/描述/链接/图片编辑。写入一律经 @gmind/core 操作 API
 * （applyStyle 作用域 subtree/single；调用方统一 origin 与 capUndoStack），画布刷新
 * 走既有 doc update → renderScene 管线。
 *
 * 2026-09-28 标记面板迁移：原「图标」区（优先级/进度/旗帜/星标/表情）整体搬至
 * 工具栏「插入」菜单的右侧层标记面板（MarkerPanel，企微对标）；本面板只保留
 * 样式区 + 描述/链接/图片区，数据模型与写链路零改动。
 *
 * 2026-09-30 需求方四条 UI 反馈：① 头部加 × 关闭钮（rich-panel-close）；
 * ② 「描述」区块（description，M7c-C1）受控草稿、失焦提交（未变更零写入，
 * TaskPanel 同语义），字数沿用上限常量。
 *
 * 2026-10-01 需求方反馈任务 2（「简介」回退）：M7c-I 曾把备注（note）以「简介
 * （备注）」区块放回本面板并在插入菜单挂「简介」项——现按 M7b #3 裁定恢复隐藏态：
 * 面板不再渲染任何 note 编辑 UI（textarea/字数/保存钮全撤）。note 的 core 数据
 * 模型与画布 'N' 角标渲染不动（XMind 导入的 note 仍显示角标），仅 UI 入口隐藏。
 */

/** 样式色板（Task 15，8 色）：填充与文字色共用。 */
const STYLE_PALETTE: { name: string; value: string }[] = [
  { name: '红', value: '#f53f3f' },
  { name: '橙', value: '#ff8800' },
  { name: '黄', value: '#f7ba1e' },
  { name: '绿', value: '#00b42a' },
  { name: '青', value: '#14c9c9' },
  { name: '蓝', value: '#3370ff' },
  { name: '紫', value: '#722ed1' },
  { name: '黑', value: '#1f2329' },
];

/** 字号档位（PRD FR-EDT-015 10–36px 内取常用档）。 */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 36];

export interface RichPanelProps {
  doc: Y.Doc;
  fileId: string;
  /** 选中节点 id；无选中（空选区/多选）为空串——此时样式区置灰，节点区隐藏。 */
  nodeId: string;
  /** 选中节点快照（M6 Task 2 企微对标）：样式区回显数据源；无选中为 null。 */
  selected: NodeSnapshot | null;
  afterUserWrite: () => void;
  showToast: (message: string) => void;
  /** 关闭面板（2026-09-30 需求方反馈）：EditorPage 传 setFormatOpen(false)。 */
  onClose: () => void;
}

export function RichPanel(props: RichPanelProps): ReactElement {
  const { doc, fileId, nodeId, selected, afterUserWrite, showToast, onClose } = props;
  const [href, setHrefValue] = useState('');
  // 描述草稿（受控本地态，TaskPanel 同款裁决）：仅切换选中节点时回灌，失焦提交
  const [desc, setDescValue] = useState('');
  const [uploading, setUploading] = useState(false);
  // 样式作用域（FR-EDT-015）：默认含子树，可切仅当前节点
  const [styleScope, setStyleScope] = useState<StyleScope>('subtree');

  // 渲染期快照改为 props 注入（M6 Task 2）：EditorPage 每 tick 用 getNode 计算
  // selected 传入——面板与画布同帧同源；无选中/已删时为 null（样式区置灰）。
  const snap = selected;

  // 输入框只在切换选中节点时从文档回灌（面板自身是这些字段的编辑源；
  // tick 驱动的快照刷新不得覆盖正在编辑的输入——M2 多端再按需细化）。
  useEffect(() => {
    const s = getNode(doc, nodeId);
    setHrefValue(s?.href ?? '');
    setDescValue(s?.description ?? '');
  }, [doc, nodeId]);

  const write = (fn: () => void): void => {
    try {
      fn();
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败');
    }
  };

  /** 描述提交（TaskPanel 同语义）：trim 后与现值一致零写入，失焦触发。 */
  const commitDescription = (): void => {
    if (!snap) return;
    const next = desc.trim();
    if ((snap.description ?? '') === next) return;
    write(() => setDescription(doc, nodeId, next));
  };

  /** 头部（2026-09-30 需求方反馈）：面板标题 + × 关闭钮（task-panel-head 同款）。 */
  const panelHead = (
    <div className="rich-panel-head">
      <h3>格式</h3>
      <button
        type="button"
        className="rich-panel-close"
        data-testid="rich-panel-close"
        title="关闭"
        aria-label="关闭格式面板"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );

  const saveHref = (): void => {
    write(() => setHref(doc, nodeId, href.trim()));
  };

  /** 样式 patch（FR-EDT-015）：applyStyle subtree/single 作用域 + 统一 capUndoStack。
   *  清除项写 null 删键（writeStylePatch 语义）。 */
  const applyStylePatch = (patch: Record<string, string | number | null>): void => {
    write(() => applyStyle(doc, [nodeId], patch, styleScope));
  };

  /**
   * 样式区（FR-EDT-015 + M6 Task 2 随选中联动回显）：填充/文字色色钮按
   * node.style.fill/color 回显 aria-pressed；字号 select 回显 style.fontSize；
   * 作用域 select 为面板级偏好（不随节点）。无选中（node=null）→ fieldset
   * disabled 整区置灰 + 提示「选中节点后设置样式」。
   */
  const styleSection = (node: NodeSnapshot | null): ReactElement => {
    const style = node?.style ?? {};
    const swatch = (kind: 'fill' | 'color', c: { name: string; value: string }): ReactElement => {
      const active = style[kind] === c.value;
      return (
        <button
          key={`${kind}-${c.value}`}
          type="button"
          title={`${kind === 'fill' ? '填充' : '文字'}-${c.name}`}
          aria-label={`${kind === 'fill' ? '填充' : '文字'}-${c.name}`}
          aria-pressed={active}
          className={active ? 'swatch active' : 'swatch'}
          style={{ background: c.value }}
          onClick={() => applyStylePatch({ [kind]: c.value })}
        />
      );
    };
    return (
      <fieldset className="field" data-testid="style-section" disabled={!node}>
        {!node && (
          <p className="style-hint" data-testid="style-hint">
            选中节点后设置样式
          </p>
        )}
        <em className="style-label">填充</em>
        <div className="swatch-row">{STYLE_PALETTE.map((c) => swatch('fill', c))}</div>
        <button type="button" title="默认填充" onClick={() => applyStylePatch({ fill: null })}>
          默认
        </button>
        <em className="style-label">文字色</em>
        <div className="swatch-row">{STYLE_PALETTE.map((c) => swatch('color', c))}</div>
        <button type="button" title="默认文字色" onClick={() => applyStylePatch({ color: null })}>
          默认
        </button>
        <em className="style-label">字号</em>
        <select
          data-testid="font-size-select"
          aria-label="字号"
          value={style.fontSize ?? ''}
          onChange={(e) => {
            const v = e.target.value;
            applyStylePatch({ fontSize: v === '' ? null : Number(v) });
          }}
        >
          <option value="">默认</option>
          {FONT_SIZES.map((s) => (
            <option key={s} value={String(s)}>
              {s}
            </option>
          ))}
        </select>
        <em className="style-label">作用域</em>
        <select
          data-testid="style-scope-select"
          aria-label="样式作用域"
          value={styleScope}
          onChange={(e) => setStyleScope(e.target.value === 'single' ? 'single' : 'subtree')}
        >
          <option value="subtree">含子树</option>
          <option value="single">仅当前节点</option>
        </select>
      </fieldset>
    );
  };

  const onPickImage = async (file: File): Promise<void> => {
    if (file.size > MAX_IMAGE_BYTES) {
      showToast('图片大小超出 10MB 限制，请压缩后重试');
      return;
    }
    setUploading(true);
    try {
      const { w: naturalW, h: naturalH, url } = await readImageSize(file);
      try {
        const { key } = await uploadImage(fileId, file);
        // ≤200px 等比钳制（FR-EDT-020）
        const { w, h } = clampImageSize(naturalW, naturalH);
        write(() => setImage(doc, nodeId, { key, w, h }));
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '图片上传失败');
    } finally {
      setUploading(false);
    }
  };

  if (!snap || snap.deleted) {
    return (
      <aside className="rich-panel" data-testid="rich-panel">
        {panelHead}
        <h3>样式</h3>
        {styleSection(null)}
        <h3>描述</h3>
        <p className="rich-empty">选中节点后编辑富内容</p>
      </aside>
    );
  }

  return (
    <aside className="rich-panel" data-testid="rich-panel">
      {panelHead}
      <h3>样式</h3>
      {styleSection(snap)}

      {/* 描述（M7c-C1）：受控草稿 + 失焦提交（未变更零写入），字数沿用
          MAX_DESCRIPTION_LENGTH 上限。画布上的第二编辑入口见编辑浮层双框形态
          （标题框下方描述框，2026-10-01 需求方反馈二批）。 */}
      <h3>描述</h3>
      <label className="field">
        <span>描述</span>
        <textarea
          aria-label="节点描述"
          value={desc}
          maxLength={MAX_DESCRIPTION_LENGTH}
          placeholder="一句话说明节点内容"
          onChange={(e) => setDescValue(e.target.value)}
          onBlur={commitDescription}
        />
        <span className="field-count">
          {desc.length}/{MAX_DESCRIPTION_LENGTH}
        </span>
      </label>

      <h3>链接与图片</h3>

      <label className="field">
        <span>节点链接</span>
        <input
          aria-label="节点链接"
          value={href}
          placeholder="https://…"
          onChange={(e) => setHrefValue(e.target.value)}
        />
      </label>
      <button type="button" className="primary" onClick={saveHref}>
        保存链接
      </button>

      <div className="field">
        <span>图片</span>
        {snap.image ? (
          <div className="image-preview">
            <img src={`/api/images/${snap.image.key}`} alt="节点图片" />
            <button type="button" title="移除图片" onClick={() => write(() => setImage(doc, nodeId, null))}>
              移除图片
            </button>
          </div>
        ) : (
          <input
            type="file"
            data-testid="image-input"
            accept="image/png,image/jpeg,image/gif,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onPickImage(f);
              e.target.value = '';
            }}
          />
        )}
        {uploading && <span className="uploading">上传中…</span>}
      </div>
    </aside>
  );
}
