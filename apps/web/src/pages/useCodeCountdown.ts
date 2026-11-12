import { useEffect, useState } from 'react';

/**
 * 验证码重发倒计时（2026-11-12 账号体系重做）：发码成功后 start()，归零前按钮禁用，
 * 与服务端发码 60s 冷却（EmailCodeService 重发等待键）同源。LoginPage（注册/忘记
 * 密码）与 SettingsPage（换绑邮箱）三处共用同一实现，防倒计时语义漂移。
 */
export function useCodeCountdown(): { left: number; start: (seconds?: number) => void } {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left === 0) return;
    const timer = setTimeout(() => setLeft(left - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const start = (seconds = 60) => setLeft(seconds);
  return { left, start };
}
