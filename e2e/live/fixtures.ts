import type { CDPSession, Page, Request } from '@playwright/test';
import { cspTest, expect } from '../fixtures.ts';

/**
 * 실제 서비스를 치는 브라우저 테스트(`pnpm test:e2e:live`)의 준비 (sp-docs/plan/phase2.md §7.2 F-06).
 *
 * e2e/fixtures.ts 의 CSP 감시를 그대로 받고 **API 를 가로채지 않는다.** 가로채기(`page.route`)를 켜면 preflight 에 Playwright 가
 * 직접 답하므로(playwright-core 의 crNetworkManager) CORS 를 재지 못한다 — 이 테스트의 요청은 빌드가 정한 세 서비스 주소로 그대로
 * 간다. 오가는 요청은 듣기만 한다.
 *
 * 테스트가 끝나면 둘을 본다.
 *
 * - **브라우저가 실패로 끝낸 API 요청(`requestfailed`)이 없다.** CORS 가 막은 요청도 여기 걸린다 — 브라우저가 그 응답을 화면에
 *   넘기지 않는다. 끝날 때 아직 응답을 기다리는 요청은 세지 않는다
 * - **서비스가 모든 preflight 를 허용했다** — 2xx 이고, 이 화면의 오리진과 원요청의 메서드를 허용한다고 답했다
 */

/** 브라우저가 비단순 요청 앞에 보낸 OPTIONS 와 그 답. */
export interface Preflight {
  /** 원요청의 메서드 — 브라우저가 `Access-Control-Request-Method` 로 묻는다. */
  method: string;
  url: string;
  status: number;
  /** `Access-Control-Allow-Origin` */
  allowOrigin: string | null;
  /** `Access-Control-Allow-Methods` */
  allowMethods: string[];
  /** `Access-Control-Allow-Credentials` */
  allowCredentials: string | null;
}

/** 응답을 받은 API 요청. `key` 는 `METHOD 경로`(쿼리를 뺀다)다. */
export interface Answered {
  key: string;
  status: number;
}

const isApi = (request: Request) => new URL(request.url()).pathname.startsWith('/api/');
const keyOf = (request: Request) => `${request.method()} ${new URL(request.url()).pathname}`;
const lowerKeys = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));

export class Traffic {
  /** preflight 를 뺀 API 요청의 응답 — 받은 순서대로. */
  readonly answered: Answered[] = [];
  readonly preflights: Preflight[] = [];
  /** 브라우저가 실패로 끝낸 API 요청(`requestfailed`)과 브라우저가 낸 이유. */
  readonly failed: string[] = [];

  /**
   * 화면을 열기 전에 건다. **preflight 는 Playwright 의 요청 이벤트에 나오지 않는다** — Chromium 이 preflight 에 frame 을 달지
   * 않고 Playwright 는 frame 없는 요청을 버린다(F-06 측정: 가입 흐름에서 요청 이벤트의 OPTIONS 0건, 같은 흐름의 DevTools 프로토콜
   * 이벤트에는 서비스마다 있었다). 그래서 preflight 는 DevTools 프로토콜의 Network 이벤트로 따로 듣는다 — 원요청을 낳은 쪽이
   * `initiator.type` 에 `preflight` 로 적힌다.
   */
  static async start(page: Page): Promise<Traffic> {
    const traffic = new Traffic();
    page.on('response', (response) => {
      if (isApi(response.request())) traffic.answered.push({ key: keyOf(response.request()), status: response.status() });
    });
    page.on('requestfailed', (request) => {
      if (isApi(request)) traffic.failed.push(`${keyOf(request)} — ${request.failure()?.errorText ?? '?'}`);
    });
    await traffic.listenForPreflights(await page.context().newCDPSession(page));
    return traffic;
  }

  private async listenForPreflights(cdp: CDPSession) {
    const asked = new Map<string, { method: string; url: string }>();
    cdp.on('Network.requestWillBeSent', ({ requestId, initiator, request }) => {
      if (initiator.type !== 'preflight') return;
      asked.set(requestId, { method: lowerKeys(request.headers)['access-control-request-method'] ?? '', url: request.url });
    });
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      const preflight = asked.get(requestId);
      if (!preflight) return;
      const headers = lowerKeys(response.headers);
      this.preflights.push({
        ...preflight,
        status: response.status,
        allowOrigin: headers['access-control-allow-origin'] ?? null,
        allowMethods: headers['access-control-allow-methods']?.split(',').map((m) => m.trim()) ?? [],
        allowCredentials: headers['access-control-allow-credentials'] ?? null,
      });
    });
    await cdp.send('Network.enable');
  }

  /** 그 경로로 간 preflight — 보낸 순서대로. */
  preflightsTo(path: string): Preflight[] {
    return this.preflights.filter((p) => new URL(p.url).pathname === path);
  }
}

/** 그 preflight 를 서비스가 허용했다 — 2xx 이고, 이 화면의 오리진과 원요청의 메서드를 허용한다고 답했다. */
export function allowed(preflight: Preflight, origin: string): boolean {
  return (
    preflight.status >= 200 &&
    preflight.status < 300 &&
    preflight.allowOrigin === origin &&
    preflight.allowMethods.includes(preflight.method)
  );
}

export const test = cspTest.extend<{ traffic: Traffic }>({
  traffic: [
    async ({ page, baseURL }, use) => {
      if (!baseURL) throw new Error('baseURL 이 없다 — playwright.live.config.ts 의 use.baseURL');
      const origin = new URL(baseURL).origin;
      const traffic = await Traffic.start(page);
      await use(traffic);
      // 한 번에 본다 — CORS 가 막은 요청은 `failed` 에 걸리고, preflight 가 있는 요청이면 그 preflight 도 `disallowed` 에
      // 걸린다. 막은 이유(상태·허용 오리진)는 그 preflight 에 있다. preflight 없이 가는 단순 요청은 `failed` 에만 걸린다.
      expect(
        { failed: traffic.failed, disallowed: traffic.preflights.filter((p) => !allowed(p, origin)) },
        '실패한 요청, 서비스가 허용하지 않은 preflight',
      ).toEqual({ failed: [], disallowed: [] });
    },
    { auto: true },
  ],
});

export { expect };
