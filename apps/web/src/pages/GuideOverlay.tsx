import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { track } from '../api/events';

/**
 * 三步新手引导浮层（M5 Task 3，NFR-USE-001）。
 *
 * 形态（PRD 未规定高亮形态，验收=步骤可走可跳+埋点——裁定从简）：
 * 整页半透明遮罩（guide-overlay，fixed 挡交互）+ 目标元素描边圈（getBoundingClientRect
 * 定位，无 tether 库）+ 目标附近的浮动卡片（下方优先、放不下翻上方）。步骤内容与目标
 * 选择器由调用方（WorkspacePage）装配。
 */

/** 引导步配置：目标选择器（querySelector 取首个匹配）+ 标题/副文案。 */
export type GuideStep = { selector: string; title: string; sub: string };

/** 完成标记的 localStorage 键（触发口径=缺该键，浏览器本地、跨设备不重复——M5 登记）。 */
export const GUIDE_DONE_KEY = 'gmind.guide.done';

/** 目标矩形快照（getBoundingClientRect 是静态值，存纯对象避免持有 DOMRect）。 */
type Rect = { top: number; left: number; bottom: number; width: number; height: number };

/** guide_finish 埋点（M5 Task 3；Task 4 收口到公共 track()：公共参数
 *  clientVersion/sessionId 随 payload 合并上报）。fire-and-forget：失败静默，
 *  遥测不干扰引导收尾。 */
function trackGuideFinish(payload: { stepsDone: number; skipped: boolean; elapsedMs: number }): void {
  track('guide_finish', payload);
}

export function GuideOverlay({ steps, onClose }: { steps: GuideStep[]; onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const startedAt = useRef(Date.now());
  /** 收尾只走一次：完成/跳过共享，ref 防双发（埋点恰一条、onClose 幂等）。 */
  const finished = useRef(false);

  /** 重测当前步目标矩形：步骤切换、窗口 resize、任意滚动（fixed 定位需跟随）时调用。 */
  const measure = useCallback(() => {
    const el = document.querySelector(steps[stepIndex].selector);
    const r = el?.getBoundingClientRect();
    setRect(r ? { top: r.top, left: r.left, bottom: r.bottom, width: r.width, height: r.height } : null);
  }, [steps, stepIndex]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    // capture：页面滚动可能发生在任意可滚容器上
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  /** 收尾：完成（skipped=false，stepsDone=总步数）或跳过（stepsDone=当前步序）。
   *  写 localStorage + 埋点恰一次 + 通知宿主卸载浮层。 */
  const finish = useCallback(
    (skipped: boolean): void => {
      if (finished.current) return;
      finished.current = true;
      const stepsDone = skipped ? stepIndex + 1 : steps.length;
      localStorage.setItem(GUIDE_DONE_KEY, '1');
      trackGuideFinish({ stepsDone, skipped, elapsedMs: Date.now() - startedAt.current });
      onClose();
    },
    [stepIndex, steps.length, onClose],
  );

  const isLast = stepIndex === steps.length - 1;

  // 卡片定位：目标下方优先（三步目标都在页面上部，下方余量充足），放不下翻上方；
  // 水平钳制在视口内。目标缺失（异常态）退化为顶部居中、无描边圈。
  const CARD_W = 320;
  const GAP = 12;
  const cardStyle: CSSProperties = rect
    ? {
        top: rect.bottom + GAP + 160 < window.innerHeight ? rect.bottom + GAP : Math.max(12, rect.top - 160 - GAP),
        left: Math.min(Math.max(12, rect.left), window.innerWidth - CARD_W - 12),
      }
    : { top: 96, left: Math.max(12, (window.innerWidth - CARD_W) / 2) };
  const ringStyle: CSSProperties = rect
    ? { top: rect.top - 5, left: rect.left - 5, width: rect.width + 10, height: rect.height + 10 }
    : { display: 'none' };

  return (
    <>
      <div className="guide-overlay" data-testid="guide-overlay" />
      <div className="guide-ring" data-testid="guide-ring" style={ringStyle} />
      <div className="guide-card" data-testid={`guide-step-${stepIndex + 1}`} style={cardStyle}>
        <p className="guide-card-step">
          {stepIndex + 1} / {steps.length}
        </p>
        <h3>{steps[stepIndex].title}</h3>
        <p className="guide-card-sub">{steps[stepIndex].sub}</p>
        <div className="guide-card-actions">
          <button data-testid="guide-skip" onClick={() => finish(true)}>
            跳过
          </button>
          <button
            className="primary"
            data-testid="guide-next"
            onClick={() => (isLast ? finish(false) : setStepIndex(stepIndex + 1))}
          >
            {isLast ? '完成' : '下一步'}
          </button>
        </div>
      </div>
    </>
  );
}
