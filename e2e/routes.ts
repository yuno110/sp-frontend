/**
 * 브라우저 테스트가 여는 라우트 — 프로덕션 빌드의 라우터(src/router.tsx)에 있는 경로다. 개발 빌드에서만 있는 라우트는
 * 넣지 않는다(sp-docs/plan/phase2.md §7.2 F-05 의 "개발 전용이 아닌 모든 라우트").
 *
 * 이 목록이 라우터와 같은지는 src/router.test.tsx 가 보고, 라우트마다 잰 상태가 있는지는 e2e/screens.spec.ts 가 본다.
 * 이 파일은 단위 테스트도 읽으므로 아무것도 import 하지 않는다.
 */
export const ROUTES = [
  '/',
  '/login',
  '/signup',
  '/signup/profile',
  '/posts/mine',
  '/posts/new',
  '/posts',
  '/posts/me',
  '/posts/:id',
  '/posts/:id/edit',
  '/members/me',
  '/members/:accountId',
  '/me',
  '/*',
] as const;

export type RoutePattern = (typeof ROUTES)[number];
