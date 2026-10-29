import { test as base, expect } from '@playwright/test';
import { ApiStub } from './api.ts';
import { CspWatch } from './checks.ts';

/**
 * 모든 브라우저 테스트가 쓰는 준비 — API 스텁과 CSP 감시를 화면을 열기 전에 건다. 테스트가 끝나면 둘을 확인한다.
 *
 * - **CSP 위반이 없어야 한다**(sp-docs/plan/phase2.md §7.2 F-05 — F-02 가 넘긴 것). 일부러 위반을 만드는 테스트는 `csp.take()` 로
 *   꺼내 단언한다
 * - **스텁에 없는 요청이 없어야 한다.** 그런 요청은 끊기므로 화면이 그 실패를 그리고, 잰 것이 의도한 상태가 아니게 된다
 */
export const test = base.extend<{ csp: CspWatch; api: ApiStub }>({
  csp: [
    async ({ page }, use) => {
      const csp = await CspWatch.start(page);
      await use(csp);
      expect(csp.take(), 'CSP 위반').toEqual({ console: [], events: [] });
    },
    { auto: true },
  ],
  api: [
    async ({ page, baseURL }, use) => {
      if (!baseURL) throw new Error('baseURL 이 없다 — playwright.config.ts 의 use.baseURL');
      const api = await ApiStub.start(page, baseURL);
      await use(api);
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      expect(api.unexpected, '스텁에 없는 요청').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
