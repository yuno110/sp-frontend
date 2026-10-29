import { defineConfig, devices } from '@playwright/test';

/**
 * 브라우저 테스트(`pnpm test:e2e`) — **프로덕션 빌드를 `vite preview` 로 띄워 잰다**(sp-docs/plan/phase2.md §7.2 F-05).
 * 개발 서버를 재면 개발 빌드에서만 그리는 것(CLAUDE.md)이 검사에 섞이고, CSP 는 프로덕션 빌드에만 있다(csp.ts).
 *
 * - 서버 명령이 빌드부터 한다 — 묵은 `dist/` 를 재지 않는다
 * - 주소는 3000 번이다(vite.config.ts 의 `preview`). **이미 떠 있는 서버를 쓰지 않는다** — 3000 번에 개발 서버가 떠 있으면
 *   그것을 재게 되므로, 3000 번이 쓰이고 있으면 시작하지 않는다. 끝나면 띄운 서버를 내린다
 * - API 는 테스트가 스텁으로 답한다(e2e/api.ts). 백엔드는 띄우지 않는다
 */
export default defineConfig({
  testDir: './e2e',
  forbidOnly: true,
  // 브라우저 하나가 수백 MB 를 쓴다 — 기본값(CPU 코어의 절반)만큼 띄우지 않는다.
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm build && pnpm preview',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
