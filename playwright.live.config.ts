import { defineConfig, devices } from '@playwright/test';

/**
 * 실제 서비스와의 브라우저 테스트(`pnpm test:e2e:live`) — sp-docs/plan/phase2.md §7.2 F-06. 테스트는 `e2e/live/` 에 있다.
 *
 * - **세 서비스를 `local` 프로파일로 먼저 띄운다**(README 「띄우기」). 이 설정은 서비스를 띄우지도 내리지도 않는다
 * - 화면은 스텁 테스트(playwright.config.ts)와 같이 띄운다 — 프로덕션 빌드를 3000 번에, 빌드부터 하고, 이미 떠 있는 서버를 쓰지
 *   않는다. 3000 번은 세 서비스의 CORS 오리진이다
 * - **직접 모드로 빌드한다.** 브라우저가 세 서비스에 직접 요청해야 preflight 가 날아간다 — 프록시 모드는 같은 오리진이라
 *   preflight 가 없다(CLAUDE.md 「서비스 주소와 CORS」). `.env.local` 이 모드를 바꿔 두어도 이 실행은 직접 모드다 — Vite 는
 *   프로세스에 주어진 환경변수를 `.env` 파일의 값보다 앞세운다. 서비스 주소는 건드리지 않는다
 * - 흐름이 서비스의 상태를 바꾸므로 하나씩 돈다
 */
export default defineConfig({
  testDir: './e2e/live',
  forbidOnly: true,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    env: { VITE_API_MODE: 'direct' },
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
