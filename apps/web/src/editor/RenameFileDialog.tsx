import { useEffect, useId, useRef, useState } from 'react';
import './rename-file-dialog.css';

/** 原型 Prompt 的真实文件改名弹窗：本地草稿确认后才写文档，取消与组合输入不产生写入。 */
export function RenameFileDialog({ title, onCancel, onConfirm }: {
  title: string;
  onCancel(): void;
  onConfirm(title: string): void;
}) {
  const [draft, setDraft] = useState(title);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const composingRef = useRef(false);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const input = inputRef.current;
    input?.focus();
    input?.select();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...(boxRef.current?.querySelectorAll<HTMLElement>('input, button:not([disabled])') ?? [])]
        .filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previous?.focus();
    };
  }, []);

  const submit = (): void => {
    const value = draft.trim();
    if (value === '') return;
    onConfirm(value);
  };

  return (
    <div className="rename-dialog-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div ref={boxRef} className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid="rename-dialog">
        <h2 id={titleId}>重命名文件</h2>
        <input
          ref={inputRef}
          data-testid="title-input"
          aria-label="文档标题"
          maxLength={255}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (e.nativeEvent.isComposing || composingRef.current) return;
            submit();
          }}
        />
        <div className="rename-dialog-actions">
          <button type="button" data-testid="rename-cancel" className="rename-dialog-cancel" onClick={onCancel}>取消</button>
          <button type="button" data-testid="rename-confirm" className="rename-dialog-confirm" disabled={draft.trim() === ''} onClick={submit}>确定</button>
        </div>
      </div>
    </div>
  );
}
