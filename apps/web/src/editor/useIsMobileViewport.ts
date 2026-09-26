import { useEffect, useState } from 'react';

/**
 * 移动端视口判定 — M5 Task 5（OPEN-T-005）。
 *
 * 口径（BINDING）：≤768px 视口 = 只读（客户端能力降级，非安全边界——服务端不
 * 拒绝移动端写请求）。matchMedia + change 监听：断点跨越（窗口缩放/旋转）即时
 * 推进，EditorPage 据此切换只读装配分支。
 *
 * 初始值惰性求值（useState initializer 只跑一次）；effect 挂载时再同步一次
 * matches，防御首渲染到监听挂载间的窗口变化；React18 StrictMode 双挂载下监听
 * 幂等移除。matchMedia 缺失（极端测试环境）恒 false——降级为桌面装配。
 */
const MOBILE_QUERY = '(max-width: 768px)';

export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(MOBILE_QUERY).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent): void => setIsMobile(e.matches);
    mql.addEventListener('change', onChange);
    setIsMobile(mql.matches); // 监听挂载前跨过断点的窗口变化补偿
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
