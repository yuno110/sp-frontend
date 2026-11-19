import {
  ACCOUNTS_LIST,
  ADMIN,
  CONFIRM_EMAIL,
  CONFIRM_PASSWORD_RESET,
  LIKE,
  LINK_TOKEN,
  ME,
  MY_PROFILE,
  NICKNAME,
  NOTICE_POST,
  NO_CONTENT,
  OTHER_POST,
  POST,
  REQUEST_PASSWORD_RESET,
  RESET_LINK,
  UNLIKE,
  VERIFY_LINK,
  fail,
  likeState,
  ok,
  pageOf,
  tokens,
} from './api.ts';
import { tabTo } from './checks.ts';
import { expect, test } from './fixtures.ts';

/**
 * 가입·로그인·글 작성을 키보드만으로 끝낸다 (sp-docs/plan/phase2.md §7.2 F-05). 글 목록의 카테고리 탭도 키보드로 고른다(F-12).
 * 비밀번호 재설정 — 찾기에서 메일을 요청하고 메일의 링크로 새 비밀번호를 내는 흐름도 키보드로 끝낸다(F-09). 글 상세의 좋아요도
 * 키보드로 누르고 취소한다(F-13). 회원 목록의
 * 정렬·거르기·검색·페이지 이동도 키보드로 한다(F-11).
 *
 * 포커스는 Tab 으로만 옮기고 제출은 Enter 로 한다. 탭 버튼과 좋아요 버튼은 Space 와 Enter 로 누른다. 입력칸은 라벨 이름으로 찾는다 —
 * 화면을 읽어 주는 도구가 그 이름을 읽는다.
 * Tab 으로 지나는 요소마다 `outline`·`box-shadow` 계산값이 포커스 전과 달라야 한다(e2e/checks.ts 의 `tabTo`).
 */

const PASSWORD = 'Passw0rd!';
const EMAIL = 'keyboard@example.com';

test('로그인', async ({ page, api }) => {
  api.use({ 'POST /api/v1/auth/login': () => ok(tokens(ME)) });
  await page.goto('/login');
  const main = page.getByRole('main');

  await tabTo(page, main.getByLabel('이메일', { exact: true }));
  await page.keyboard.type(EMAIL);
  await tabTo(page, main.getByLabel('비밀번호', { exact: true }));
  await page.keyboard.type(PASSWORD);
  await tabTo(page, main.getByRole('button', { name: '로그인', exact: true }));
  await page.keyboard.press('Enter');

  await page.waitForURL((url) => url.pathname === '/posts');
  await expect(page.getByRole('banner').getByText(NICKNAME)).toBeVisible();
  expect(api.sent.filter((s) => s.key === 'POST /api/v1/auth/login').map((s) => s.body)).toEqual([
    { email: EMAIL, password: PASSWORD },
  ]);
});

test('가입 — 계정을 만들고, 메일의 링크로 인증하고, 로그인해 프로필을 등록한다', async ({ page, api }) => {
  // 프로필을 등록하기 전에는 내 프로필 조회가 404 M001 이고 공개 조회도 없는 프로필이다(sp-docs/api-contract.md §3·§3.1).
  let registered = false;
  api.use({
    'POST /api/v1/accounts': ok({ accountId: ME.accountId, email: EMAIL }, 201),
    [CONFIRM_EMAIL]: NO_CONTENT,
    'POST /api/v1/auth/login': () => ok(tokens(ME)),
    'GET /api/v1/members/me': () => (registered ? ok(MY_PROFILE) : fail('M001')),
    [`GET /api/v1/members/${ME.accountId}`]: () =>
      registered ? ok({ ...MY_PROFILE, createdAt: '2026-10-28T09:00:00', deleted: false }) : fail('M001'),
    'POST /api/v1/members': () => {
      registered = true;
      return ok(MY_PROFILE, 201);
    },
  });
  await page.goto('/signup');
  const main = page.getByRole('main');

  // 계정을 만든다 — 화면은 로그인하지 않고 메일을 확인하라고 한다.
  await tabTo(page, main.getByLabel('이메일', { exact: true }));
  await page.keyboard.type(EMAIL);
  await tabTo(page, main.getByLabel('비밀번호', { exact: true }));
  await page.keyboard.type(PASSWORD);
  await tabTo(page, main.getByRole('button', { name: '계정 만들기', exact: true }));
  await page.keyboard.press('Enter');
  await expect(main.getByRole('heading', { name: '메일을 확인하세요' })).toBeVisible();
  expect(api.keys().filter((k) => k.startsWith('POST'))).toEqual(['POST /api/v1/accounts']);

  // 메일의 링크를 연다 — 주소창에서 토큰이 사라지고, 누르기 전에는 확인하지 않는다(sp-docs/security.md §12).
  await page.goto(VERIFY_LINK);
  const verify = main.getByRole('button', { name: '이메일 인증하기', exact: true });
  await expect(verify).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(LINK_TOKEN);
  expect(api.keys().filter((k) => k === CONFIRM_EMAIL)).toEqual([]);
  await tabTo(page, verify);
  await page.keyboard.press('Enter');
  await expect(main.getByText('이메일 인증을 마쳤습니다.')).toBeVisible();

  // 인증은 토큰을 주지 않는다 — 안내를 따라 로그인한다. 프로필이 없으므로 프로필 등록으로 간다.
  await tabTo(page, main.getByRole('link', { name: '로그인하기', exact: true }));
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/login');
  await tabTo(page, main.getByLabel('이메일', { exact: true }));
  await page.keyboard.type(EMAIL);
  await tabTo(page, main.getByLabel('비밀번호', { exact: true }));
  await page.keyboard.type(PASSWORD);
  await tabTo(page, main.getByRole('button', { name: '로그인', exact: true }));
  await page.keyboard.press('Enter');

  await page.waitForURL((url) => url.pathname === '/signup/profile');
  await tabTo(page, main.getByLabel('닉네임', { exact: true }));
  await page.keyboard.type(NICKNAME);
  await tabTo(page, main.getByRole('button', { name: '프로필 등록', exact: true }));
  await page.keyboard.press('Enter');

  await page.waitForURL((url) => url.pathname === '/posts');
  await expect(page.getByRole('banner').getByText(NICKNAME)).toBeVisible();
  expect(api.keys().filter((k) => k.startsWith('POST'))).toEqual([
    'POST /api/v1/accounts',
    CONFIRM_EMAIL,
    'POST /api/v1/auth/login',
    'POST /api/v1/members',
  ]);
  expect(api.sent.find((s) => s.key === CONFIRM_EMAIL)?.body).toEqual({ token: LINK_TOKEN });
  expect(api.sent.find((s) => s.key === 'POST /api/v1/members')?.body).toEqual({ nickname: NICKNAME });
});

test('비밀번호 재설정 — 로그인 화면에서 찾기로 가 메일을 요청하고, 메일의 링크로 새 비밀번호를 정해 로그인한다', async ({
  page,
  api,
}) => {
  const newPassword = 'NewPassw0rd!';
  api.use({
    [REQUEST_PASSWORD_RESET]: ok(null, 202),
    [CONFIRM_PASSWORD_RESET]: NO_CONTENT,
    'POST /api/v1/auth/login': () => ok(tokens(ME)),
  });
  await page.goto('/login');
  const main = page.getByRole('main');

  // 로그인 화면의 링크로 비밀번호 찾기에 가서 재설정 메일을 요청한다.
  await tabTo(page, main.getByRole('link', { name: '비밀번호 찾기', exact: true }));
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/reset-password/request');
  // 주소가 바뀐 뒤에도 로그인 화면이 잠깐 남는다 — 그 화면에도 「이메일」 입력칸이 있어 그것을 잡으면 포커스 전의 모습을 다른 요소에서
  // 찍는다(2026-11-19 F-11 의 전체 실행에서 두 번 났다). 이 화면에만 있는 버튼이 그려진 뒤에 간다.
  await expect(main.getByRole('button', { name: '재설정 메일 보내기', exact: true })).toBeVisible();
  await tabTo(page, main.getByLabel('이메일', { exact: true }));
  await page.keyboard.type(EMAIL);
  await tabTo(page, main.getByRole('button', { name: '재설정 메일 보내기', exact: true }));
  await page.keyboard.press('Enter');
  await expect(main.getByText('요청을 받았습니다.', { exact: false })).toBeVisible();

  // 메일의 링크를 연다 — 주소창에서 토큰이 사라지고, 새 비밀번호를 내기 전에는 확인하지 않는다(sp-docs/security.md §12).
  await page.goto(RESET_LINK);
  const input = main.getByLabel('새 비밀번호', { exact: true });
  await expect(input).toBeVisible();
  await expect.poll(() => new URL(page.url()).hash).toBe('');
  expect(page.url()).not.toContain(LINK_TOKEN);
  expect(api.keys().filter((k) => k === CONFIRM_PASSWORD_RESET)).toEqual([]);
  await tabTo(page, input);
  await page.keyboard.type(newPassword);
  await tabTo(page, main.getByRole('button', { name: '비밀번호 바꾸기', exact: true }));
  await page.keyboard.press('Enter');
  await expect(main.getByText('비밀번호를 바꿨습니다.')).toBeVisible();

  // 재설정은 토큰을 주지 않는다 — 안내를 따라 새 비밀번호로 로그인한다.
  await tabTo(page, main.getByRole('link', { name: '로그인하기', exact: true }));
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/login');
  await tabTo(page, main.getByLabel('이메일', { exact: true }));
  await page.keyboard.type(EMAIL);
  await tabTo(page, main.getByLabel('비밀번호', { exact: true }));
  await page.keyboard.type(newPassword);
  await tabTo(page, main.getByRole('button', { name: '로그인', exact: true }));
  await page.keyboard.press('Enter');

  await page.waitForURL((url) => url.pathname === '/posts');
  await expect(page.getByRole('banner').getByText(NICKNAME)).toBeVisible();
  expect(api.keys().filter((k) => k.startsWith('POST'))).toEqual([
    REQUEST_PASSWORD_RESET,
    CONFIRM_PASSWORD_RESET,
    'POST /api/v1/auth/login',
  ]);
  expect(api.sent.filter((s) => s.key.startsWith('POST')).map((s) => s.body)).toEqual([
    { email: EMAIL },
    { token: LINK_TOKEN, newPassword },
    { email: EMAIL, password: newPassword },
  ]);
});

test('글 작성', async ({ page, api }) => {
  const title = '키보드로 쓴 글';
  const content = '본문도 키보드로 썼다';
  const created = {
    id: 3,
    title,
    category: 'FREE',
    content,
    writerId: ME.accountId,
    writerNickname: NICKNAME,
    viewCount: 0,
    commentCount: 0,
    likeCount: 0,
    liked: false,
    attachments: [],
    createdAt: '2026-10-28T09:00:00',
  };
  await api.login();
  api.use({
    'POST /api/v1/posts': ok(created, 201),
    'GET /api/v1/posts/3': ok(created),
    'GET /api/v1/posts/3/comments': ok(pageOf([], 20)),
  });
  await page.goto('/posts');
  const main = page.getByRole('main');

  await tabTo(page, main.getByRole('button', { name: '새 글', exact: true }));
  await page.keyboard.press('Enter');
  await page.waitForURL((url) => url.pathname === '/posts/new');

  await tabTo(page, main.getByLabel('제목', { exact: true }));
  await page.keyboard.type(title);
  await tabTo(page, main.getByLabel('본문', { exact: true }));
  await page.keyboard.type(content);
  await tabTo(page, main.getByRole('button', { name: '등록', exact: true }));
  await page.keyboard.press('Enter');

  await page.waitForURL((url) => url.pathname === '/posts/3');
  await expect(main.getByRole('heading', { name: title })).toBeVisible();
  // 카테고리를 고르지 않았다 — 폼의 처음 값(자유)이 실린다.
  expect(api.sent.find((s) => s.key === 'POST /api/v1/posts')?.body).toEqual({ title, content, category: 'FREE' });
});

test('글 목록 — 카테고리 탭에 Tab 으로 닿고 Space·Enter 로 고른다', async ({ page }) => {
  await page.goto('/posts');
  const main = page.getByRole('main');
  const tab = (name: string) => main.getByRole('group', { name: '카테고리' }).getByRole('button', { name, exact: true });
  // 스텁은 카테고리로 거른다(e2e/api.ts 의 `listOf`) — 그려진 글이 어느 탭의 답인지 가른다.
  const rows = main.getByRole('table').getByRole('row');
  await expect(rows.filter({ hasText: OTHER_POST.title })).toBeVisible();

  await tabTo(page, tab('공지'));
  await page.keyboard.press('Space');
  await expect(tab('공지')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.filter({ hasText: NOTICE_POST.title })).toBeVisible();
  await expect(rows.filter({ hasText: OTHER_POST.title })).toHaveCount(0);

  await tabTo(page, tab('질문'));
  await page.keyboard.press('Enter');
  await expect(tab('질문')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.filter({ hasText: OTHER_POST.title })).toBeVisible();
  await expect(rows.filter({ hasText: NOTICE_POST.title })).toHaveCount(0);
});

test('글 상세 — 좋아요에 Tab 으로 닿고 Enter 로 누르고 Space 로 취소한다. 응답을 기다리는 동안과 그 뒤에도 포커스가 버튼에 남는다', async ({
  page,
  api,
}) => {
  await api.login();
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  api.use({
    [LIKE]: async () => {
      await answered;
      return likeState(true, 5);
    },
    [UNLIKE]: likeState(false, 4),
  });
  await page.goto('/posts/1');
  const like = page.getByRole('main').getByRole('button', { name: /^좋아요 \d+$/ });
  await expect(like).toHaveAttribute('aria-pressed', 'false');

  await tabTo(page, like);
  await page.keyboard.press('Enter');
  // 기다리는 동안 버튼은 aria-disabled 다 — `disabled` 면 포커스를 잃어 다음 키가 버튼에 닿지 않는다.
  await expect(like).toHaveAttribute('aria-disabled', 'true');
  await expect(like).toBeFocused();
  // 기다리는 동안은 누르기 전의 상태와 수다 — 화면이 셈해 미리 바꾸지 않는다.
  await page.waitForTimeout(300);
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(like).toHaveText(`좋아요 ${POST.likeCount}`);
  release();
  await expect(like).toHaveAttribute('aria-pressed', 'true');
  await expect(like).toHaveText('좋아요 5');
  await expect(like).toBeFocused();

  await page.keyboard.press('Space');
  await expect(like).toHaveAttribute('aria-pressed', 'false');
  await expect(like).toHaveText('좋아요 4');
  await expect(like).toBeFocused();
  expect(api.sent.filter((s) => s.key === LIKE || s.key === UNLIKE)).toEqual([
    { key: LIKE, body: null },
    { key: UNLIKE, body: null },
  ]);
});

test('회원 목록 — 정렬·역할을 화살표로 고르고, 이메일 검색을 Enter 로 걸고, 다음 페이지를 Enter 로 연다', async ({ page, api }) => {
  // 두 페이지가 되는 서버 — 요청의 `page` 로 자른다(sp-docs/api-contract.md §2.5·§7.1).
  const accounts = Array.from({ length: 25 }, (_, i) => ({
    id: 100 - i,
    email: `user${i}@example.com`,
    role: 'USER',
    deleted: false,
    createdAt: '2026-10-27T08:00:00',
    emailVerified: true,
    locked: false,
  }));
  api.use({
    [ACCOUNTS_LIST]: (request) => {
      const page = Number(new URL(request.url()).searchParams.get('page') ?? 0);
      return ok({
        ...pageOf(accounts.slice(page * 20, (page + 1) * 20), 20),
        page,
        totalElements: accounts.length,
        totalPages: 2,
        first: page === 0,
        last: page === 1,
      });
    },
  });
  await api.login(ADMIN);
  await page.goto('/admin/members');
  const main = page.getByRole('main');
  await expect(main.getByRole('table').getByText('user0@example.com')).toBeVisible();
  /** 다음에 나가는 계정 목록 요청의 쿼리. */
  const nextQuery = () =>
    page
      .waitForRequest((r) => new URL(r.url()).pathname === '/api/v1/accounts')
      .then((r) => Object.fromEntries(new URL(r.url()).searchParams));

  await tabTo(page, main.getByRole('combobox', { name: '정렬' }));
  let query = nextQuery();
  await page.keyboard.press('ArrowDown');
  expect(await query).toEqual({ page: '0', size: '20', sort: 'email' });

  await tabTo(page, main.getByRole('combobox', { name: '역할' }));
  query = nextQuery();
  await page.keyboard.press('ArrowDown');
  expect(await query).toEqual({ page: '0', size: '20', sort: 'email', role: 'ADMIN' });

  await tabTo(page, main.getByRole('textbox', { name: '이메일 검색어' }));
  await page.keyboard.type('example');
  query = nextQuery();
  await page.keyboard.press('Enter');
  expect(await query).toEqual({ page: '0', size: '20', sort: 'email', role: 'ADMIN', email: 'example' });

  await expect(main.getByRole('table').getByText('user0@example.com')).toBeVisible();
  await tabTo(page, main.getByRole('button', { name: /다음/ }));
  query = nextQuery();
  await page.keyboard.press('Enter');
  expect(await query).toEqual({ page: '1', size: '20', sort: 'email', role: 'ADMIN', email: 'example' });
  await expect(main.getByRole('table').getByText('user20@example.com')).toBeVisible();
});
