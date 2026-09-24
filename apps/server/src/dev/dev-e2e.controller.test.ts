import { describe, expect, it } from 'vitest';
import { devE2eAllowed } from './dev-e2e.controller';

/**
 * dev-e2e 编排端点准入单测（fix round 1）。
 *
 * 绑定：准入必须 fail-closed——只有显式 development / test 放行。不能写
 * 「仅拒 production」：env.NODE_ENV 缺省即 'development'，生产部署漏配/错配
 * （staging、空串、未来新增值）时那种写法会把无鉴权的授权端点留在公网上。
 */

describe('devE2eAllowed（默认关闭）', () => {
  it('显式 development / test 放行（本地 dev 与 vitest/e2e 两类运行态）', () => {
    expect(devE2eAllowed('development')).toBe(true);
    expect(devE2eAllowed('test')).toBe(true);
  });

  it('production 拒绝', () => {
    expect(devE2eAllowed('production')).toBe(false);
  });

  it('未知/错配值一律拒绝（staging、空串、大小写差异等）——fail-closed 回归钉', () => {
    expect(devE2eAllowed('staging')).toBe(false);
    expect(devE2eAllowed('')).toBe(false);
    expect(devE2eAllowed('Production')).toBe(false);
    expect(devE2eAllowed('dev')).toBe(false);
    expect(devE2eAllowed(' prod ')).toBe(false);
  });
});
