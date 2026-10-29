import type { Page } from '@playwright/test';
import { matchRoutes } from 'react-router-dom';
import { COMMENTS, EMAIL, LONG_WORD, MY_PROFILE, NICKNAME, NO_CONTENT, TITLE, WITHDRAWN_ID, fail, ok, pageOf, type Routes } from './api.ts';
import { brokenWords, horizontalOverflow, seriousAxe } from './checks.ts';
import { expect, test } from './fixtures.ts';
import { ROUTES, type RoutePattern } from './routes.ts';

/**
 * 라우트마다 화면을 열어 잰다 (sp-docs/plan/phase2.md §7.2 F-05).
 *
 * - axe-core 의 serious·critical 위반이 없다 — 기본 폭(1280px)과 360px 에서
 * - 360px 폭에서 문서와 스크롤 컨테이너에 가로 스크롤이 없다. 글 목록이 표로 바뀌는 폭(`sm`, 640px)에서도 본다
 * - 360px·640px 폭에서 라벨 자리(머리글·버튼·표 머리·입력칸 라벨)의 낱말이 줄에서 쪼개지지 않는다 — 가로 스크롤 없이도 읽을
 *   수 없게 되는 자리다. 표 머리는 640px 에서만 보인다
 * - CSP 위반이 없다(e2e/fixtures.ts 가 테스트마다 본다)
 *
 * 라우트 하나에 상태가 여럿이면 상태마다 잰다 — 빈 목록·오류 상자·필드 오류처럼 다른 것이 그려지는 상태다. 로그인이 필요한
 * 라우트는 로그인한 상태로 연다. `route` 는 연 라우트이고, 다른 라우트로 보내는 라우트는 도착한 화면을 잰다.
 */

interface Screen {
  route: RoutePattern;
  state: string;
  path: string;
  login?: boolean;
  api?: Routes;
  /** 연 뒤 이 상태로 만드는 조작. */
  act?: (page: Page) => Promise<void>;
  /** 이 상태가 다 그려졌다는 것. */
  ready: (page: Page) => Promise<void>;
  /** 도착하는 경로. 없으면 `path` 다. */
  lands?: string;
}

const main = (page: Page) => page.getByRole('main');
const shown = (page: Page, text: string) => expect(main(page).getByText(text, { exact: true }).first()).toBeVisible();
const codeShown = (page: Page, code: string) => expect(page.locator(`[data-error-code="${code}"]`).first()).toBeVisible();
const panel = (page: Page, title: string) =>
  main(page).locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

/** 가입 폼의 필드 오류 — 문장은 sp-docs/requirements/member.md §2 다. */
const SIGNUP_FIELD_ERRORS = [
  { field: 'email', message: '올바른 이메일 형식이 아닙니다.' },
  { field: 'password', message: '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.' },
];

const withdraw = async (page: Page) => {
  const section = panel(page, '탈퇴');
  await section.getByLabel(/^현재 비밀번호/).fill('Passw0rd!');
  await section.getByRole('button', { name: '탈퇴', exact: true }).click();
};

const SCREENS: Screen[] = [
  { route: '/', state: '목록으로 간다', path: '/', lands: '/posts', ready: (p) => shown(p, '짧은 글') },

  { route: '/login', state: '입력 전', path: '/login', ready: (p) => expect(main(p).getByRole('heading', { name: '로그인' })).toBeVisible() },
  {
    route: '/login',
    state: '로그인 실패',
    path: '/login',
    api: { 'POST /api/v1/auth/login': fail('AU003') },
    act: async (p) => {
      await main(p).getByLabel(/^이메일/).fill('user@example.com');
      await main(p).getByLabel(/^비밀번호/).fill('wrong-password');
      await main(p).getByRole('button', { name: '로그인' }).click();
    },
    ready: (p) => codeShown(p, 'AU003'),
  },

  { route: '/signup', state: '입력 전', path: '/signup', ready: (p) => expect(main(p).getByRole('heading', { name: '계정 만들기' })).toBeVisible() },
  {
    route: '/signup',
    state: '필드 오류',
    path: '/signup',
    api: { 'POST /api/v1/accounts': fail('C001', SIGNUP_FIELD_ERRORS) },
    act: (p) => main(p).getByRole('button', { name: '계정 만들기' }).click(),
    ready: (p) => shown(p, SIGNUP_FIELD_ERRORS[0].message),
  },
  {
    route: '/signup',
    state: '중복 확인 결과',
    path: '/signup',
    api: { 'GET /api/v1/accounts/check-email': ok({ available: true }) },
    act: async (p) => {
      await main(p).getByLabel(/^이메일/).fill('new@example.com');
      await main(p).getByRole('button', { name: '중복 확인' }).click();
    },
    ready: (p) => shown(p, '쓸 수 있는 이메일이다'),
  },

  {
    route: '/signup/profile',
    state: '프로필 등록 전',
    path: '/signup/profile',
    login: true,
    api: { 'GET /api/v1/members/me': fail('M001') },
    ready: (p) => expect(main(p).getByRole('heading', { name: '프로필 등록' })).toBeVisible(),
  },

  { route: '/posts', state: '목록', path: '/posts', ready: (p) => shown(p, '짧은 글') },
  {
    route: '/posts',
    state: '목록 — 로그인',
    path: '/posts',
    login: true,
    ready: (p) => expect(main(p).getByRole('button', { name: '새 글' })).toBeVisible(),
  },
  {
    route: '/posts',
    state: '빈 목록',
    path: '/posts',
    api: { 'GET /api/v1/posts': ok(pageOf([])) },
    ready: (p) => shown(p, '등록된 게시글이 없다'),
  },
  { route: '/posts', state: '오류 상자', path: '/posts', api: { 'GET /api/v1/posts': fail('C005') }, ready: (p) => codeShown(p, 'C005') },
  {
    // 검색어는 길이 상한이 없다 — 적용한 검색어를 다시 보이는 자리가 띄어쓰기 없는 검색어에 넘치지 않는지 본다.
    route: '/posts',
    state: '검색 적용 — 띄어쓰기 없는 검색어',
    path: '/posts',
    act: async (p) => {
      await main(p).getByLabel('검색어').fill(LONG_WORD);
      await main(p).getByRole('button', { name: '검색', exact: true }).click();
    },
    ready: (p) => shown(p, `적용: 제목 / ${LONG_WORD}`),
  },

  { route: '/posts/mine', state: '내 글', path: '/posts/mine', login: true, ready: (p) => shown(p, TITLE) },
  {
    route: '/posts/mine',
    state: '빈 목록',
    path: '/posts/mine',
    login: true,
    api: { 'GET /api/v1/posts/me': ok(pageOf([])) },
    ready: (p) => shown(p, '쓴 글이 없다'),
  },
  { route: '/posts/me', state: '내 글로 간다', path: '/posts/me', login: true, lands: '/posts/mine', ready: (p) => shown(p, TITLE) },

  {
    route: '/posts/new',
    state: '작성 폼',
    path: '/posts/new',
    login: true,
    ready: (p) => expect(main(p).getByRole('heading', { name: '새 글' })).toBeVisible(),
  },
  {
    route: '/posts/new',
    state: '필드 오류',
    path: '/posts/new',
    login: true,
    // 문장은 sp-docs/plan/phase2.md §7.2 F-03 의 예다.
    api: { 'POST /api/v1/posts': fail('C001', [{ field: 'title', message: '제목은 1~200자여야 합니다.' }]) },
    act: (p) => main(p).getByRole('button', { name: '등록' }).click(),
    ready: (p) => shown(p, '제목은 1~200자여야 합니다.'),
  },

  { route: '/posts/:id', state: '상세', path: '/posts/1', ready: (p) => shown(p, COMMENTS[1].content) },
  {
    route: '/posts/:id',
    state: '상세 — 내 글',
    path: '/posts/1',
    login: true,
    ready: (p) => expect(main(p).getByRole('button', { name: '등록' })).toBeVisible(),
  },
  {
    route: '/posts/:id',
    state: '댓글 수정 중',
    path: '/posts/1',
    login: true,
    act: (p) => main(p).getByRole('listitem').filter({ hasText: COMMENTS[0].content }).getByRole('button', { name: '수정' }).click(),
    ready: (p) => expect(main(p).getByRole('button', { name: '저장' })).toBeVisible(),
  },
  {
    route: '/posts/:id',
    state: '없는 글',
    path: '/posts/404',
    // 없는 게시글의 댓글 목록도 404 P001 이다(§4.5).
    api: { 'GET /api/v1/posts/404': fail('P001'), 'GET /api/v1/posts/404/comments': fail('P001') },
    ready: (p) => codeShown(p, 'P001'),
  },

  {
    route: '/posts/:id/edit',
    state: '수정 폼',
    path: '/posts/1/edit',
    login: true,
    ready: (p) => expect(main(p).getByLabel(/^제목/)).toHaveValue(TITLE),
  },
  {
    route: '/posts/:id/edit',
    state: '고칠 글을 받지 못함',
    path: '/posts/404/edit',
    login: true,
    api: { 'GET /api/v1/posts/404': fail('P001') },
    ready: (p) => codeShown(p, 'P001'),
  },

  { route: '/members/me', state: '마이페이지로 간다', path: '/members/me', login: true, lands: '/me', ready: (p) => shown(p, EMAIL) },
  { route: '/members/:accountId', state: '회원 프로필', path: `/members/${MY_PROFILE.accountId}`, ready: (p) => shown(p, NICKNAME) },
  { route: '/members/:accountId', state: '탈퇴한 회원', path: `/members/${WITHDRAWN_ID}`, ready: (p) => shown(p, '탈퇴한 회원') },
  {
    route: '/members/:accountId',
    state: '없는 회원',
    path: '/members/99',
    api: { 'GET /api/v1/members/99': fail('M001') },
    ready: (p) => codeShown(p, 'M001'),
  },

  { route: '/me', state: '마이페이지', path: '/me', login: true, ready: (p) => shown(p, EMAIL) },
  {
    route: '/me',
    state: '프로필 없음',
    path: '/me',
    login: true,
    api: { 'GET /api/v1/members/me': fail('M001') },
    ready: (p) => expect(main(p).getByRole('link', { name: '프로필 등록하기' })).toBeVisible(),
  },
  {
    route: '/me',
    state: '닉네임 수정 완료',
    path: '/me',
    login: true,
    api: { 'PATCH /api/v1/members/me': ok(MY_PROFILE) },
    act: async (p) => {
      const section = panel(p, '프로필');
      await section.getByLabel(/^새 닉네임/).fill('새닉네임');
      await section.getByRole('button', { name: '수정' }).click();
    },
    ready: (p) => shown(p, '닉네임 수정 완료'),
  },
  {
    route: '/me',
    state: '프로필 탈퇴를 마치지 못함',
    path: '/me',
    login: true,
    api: { 'DELETE /api/v1/accounts/me': NO_CONTENT, 'DELETE /api/v1/members/me': fail('C005') },
    act: withdraw,
    ready: (p) => expect(main(p).getByRole('button', { name: '다시 시도' })).toBeVisible(),
  },
  {
    route: '/me',
    state: '탈퇴를 마치면 로그인 화면이 알린다',
    path: '/me',
    login: true,
    api: { 'DELETE /api/v1/accounts/me': NO_CONTENT, 'DELETE /api/v1/members/me': NO_CONTENT },
    act: withdraw,
    lands: '/login',
    ready: (p) => shown(p, '탈퇴했습니다.'),
  },
  {
    route: '/me',
    state: '세션을 되살리지 못하면 로그인 화면이 알린다',
    path: '/me',
    login: true,
    api: { 'POST /api/v1/auth/reissue': fail('A002') },
    lands: '/login',
    ready: (p) => codeShown(p, 'A002'),
  },

  { route: '/*', state: '없는 주소', path: '/no-such-page', lands: '/posts', ready: (p) => shown(p, '짧은 글') },
  // 개발 빌드에서만 있는 라우트다. 프로덕션 빌드에서는 `*` 에 걸린다.
  { route: '/*', state: '개발 빌드의 주소', path: '/tokens', lands: '/posts', ready: (p) => shown(p, '짧은 글') },
];

test('라우트마다 잰 상태가 있다', () => {
  expect([...new Set(SCREENS.map((s) => s.route))].sort()).toEqual([...ROUTES].sort());
});

test('상태마다 연 주소가 그 라우트에 걸린다', () => {
  // `route` 는 이름표다 — 연 주소가 실제로 그 라우트에 걸리는지 라우터와 같은 규칙으로 맞춰 본다.
  const routes = ROUTES.map((path) => ({ path }));
  for (const screen of SCREENS) {
    expect(matchRoutes(routes, screen.path)?.at(-1)?.route.path, `${screen.route} — ${screen.state}`).toBe(screen.route);
  }
});

for (const screen of SCREENS) {
  test(`${screen.route} — ${screen.state}`, async ({ page, api }) => {
    if (screen.login) await api.login();
    api.use(screen.api ?? {});
    await page.goto(screen.path);
    await screen.act?.(page);
    await page.waitForURL((url) => url.pathname === (screen.lands ?? screen.path));
    await screen.ready(page);

    // 모두 잰다 — 하나가 걸려도 나머지를 본다.
    expect.soft(await seriousAxe(page), 'axe — 1280px').toEqual([]);

    await page.setViewportSize({ width: 640, height: 800 });
    expect.soft(await horizontalOverflow(page), '가로 스크롤 — 640px').toEqual([]);
    expect.soft(await brokenWords(page), '라벨 자리의 쪼개진 낱말 — 640px').toEqual([]);

    await page.setViewportSize({ width: 360, height: 800 });
    expect.soft(await horizontalOverflow(page), '가로 스크롤 — 360px').toEqual([]);
    expect.soft(await brokenWords(page), '라벨 자리의 쪼개진 낱말 — 360px').toEqual([]);
    expect.soft(await seriousAxe(page), 'axe — 360px').toEqual([]);
  });
}
