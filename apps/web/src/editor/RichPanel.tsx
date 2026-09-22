import { useEffect, useState, type ReactElement } from 'react';
import type * as Y from 'yjs';
import {
  getNode,
  ICON_GROUPS,
  MAX_NOTE_LENGTH,
  setHref,
  setImage,
  setIcon,
  setNote,
  type IconGroup,
} from '@gmind/core';
import { getToken } from '../api/client';
import './rich-panel.css';

/**
 * 富内容面板（M1b Task 12，FR-EDT-018~021）：选中节点的备注/链接/图片/图标编辑。
 * 写入一律经 @gmind/core 操作 API（调用方统一 origin 与 capUndoStack），画布刷新
 * 走既有 doc update → renderScene 管线。
 */

const FLAG_COLORS = ['红', '蓝', '绿', '黄', '紫', '橙'];
const STAR_COLORS = ['红', '蓝', '绿', '黄', '紫'];
const PROGRESS_STEPS = ['0%', '10%', '25%', '40%', '50%', '60%', '75%', '100%'];
const GROUP_LABELS: Record<(typeof ICON_GROUPS)[number], string> = {
  priority: '优先级',
  progress: '进度',
  flag: '旗帜',
  star: '星标',
};

export interface RichPanelProps {
  doc: Y.Doc;
  fileId: string;
  nodeId: string;
  afterUserWrite: () => void;
  showToast: (message: string) => void;
}

/** 读取图片自然尺寸（页面负责 ≤200px 等比钳制，服务端不解析像素）。 */
function readImageSize(file: File): Promise<{ w: number; h: number; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight, url });
    img.onerror = () => reject(new Error('图片解析失败'));
    img.src = url;
  });
}

/** multipart 上传（api client 只发 JSON，这里单独用原生 fetch + Bearer）。 */
async function uploadImage(fileId: string, file: File): Promise<{ key: string }> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`/api/files/${fileId}/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `上传失败（${res.status}）`);
  }
  return (await res.json()) as { key: string };
}

export function RichPanel(props: RichPanelProps): ReactElement {
  const { doc, fileId, nodeId, afterUserWrite, showToast } = props;
  const [note, setNoteValue] = useState('');
  const [href, setHrefValue] = useState('');
  const [uploading, setUploading] = useState(false);

  // 渲染期直读快照（tick 变更驱动重渲染；getNode 为纯读，无副作用）。
  const snap = getNode(doc, nodeId);

  // 输入框只在切换选中节点时从文档回灌（面板自身是这些字段的编辑源；
  // tick 驱动的快照刷新不得覆盖正在编辑的输入——M2 多端再按需细化）。
  useEffect(() => {
    const s = getNode(doc, nodeId);
    setNoteValue(s?.note ?? '');
    setHrefValue(s?.href ?? '');
  }, [doc, nodeId]);

  const write = (fn: () => void): void => {
    try {
      fn();
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败');
    }
  };

  const saveNote = (): void => {
    let value = note;
    if (value.length > MAX_NOTE_LENGTH) {
      value = value.slice(0, MAX_NOTE_LENGTH);
      setNoteValue(value);
      showToast('备注长度已达上限');
    }
    write(() => setNote(doc, nodeId, value));
  };

  const saveHref = (): void => {
    write(() => setHref(doc, nodeId, href.trim()));
  };

  const onPickImage = async (file: File): Promise<void> => {
    if (file.size > 10 * 1024 * 1024) {
      showToast('图片大小超出 10MB 限制');
      return;
    }
    setUploading(true);
    try {
      const { w: naturalW, h: naturalH, url } = await readImageSize(file);
      try {
        const { key } = await uploadImage(fileId, file);
        // ≤200px 等比钳制（FR-EDT-020）
        const ratio = Math.min(1, 200 / Math.max(naturalW, naturalH));
        write(() => setImage(doc, nodeId, { key, w: Math.max(1, Math.round(naturalW * ratio)), h: Math.max(1, Math.round(naturalH * ratio)) }));
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
        <p className="rich-empty">选中节点后编辑富内容</p>
      </aside>
    );
  }

  const iconButton = (group: IconGroup, value: string, label: string): ReactElement => {
    const active = snap.icons[group] === value;
    return (
      <button
        key={label}
        type="button"
        title={label}
        aria-pressed={active}
        className={active ? 'icon-btn active' : 'icon-btn'}
        onClick={() => write(() => setIcon(doc, nodeId, group, active ? null : value))}
      >
        {label}
      </button>
    );
  };

  return (
    <aside className="rich-panel" data-testid="rich-panel">
      <h3>节点</h3>

      <label className="field">
        <span>节点备注</span>
        <textarea
          aria-label="节点备注"
          value={note}
          maxLength={MAX_NOTE_LENGTH}
          onChange={(e) => setNoteValue(e.target.value)}
        />
      </label>
      <button type="button" className="primary" onClick={saveNote}>
        保存备注
      </button>

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

      <div className="field">
        <span>图标</span>
        {ICON_GROUPS.map((group) => (
          <div className="icon-group" key={group}>
            <em>{GROUP_LABELS[group]}</em>
            <div className="icon-row">
              {group === 'priority' &&
                Array.from({ length: 9 }, (_, i) => iconButton(group, `p${i + 1}`, `优先级 ${i + 1}`))}
              {group === 'progress' && PROGRESS_STEPS.map((s) => iconButton(group, s, `进度 ${s}`))}
              {group === 'flag' && FLAG_COLORS.map((c) => iconButton(group, c, `旗帜-${c}`))}
              {group === 'star' && STAR_COLORS.map((c) => iconButton(group, c, `星标-${c}`))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
