import { MY_PROFILE, ME, NICKNAME, ok, fail, pageOf, tokens } from './api.ts';
import { tabTo } from './checks.ts';
import { expect, test } from './fixtures.ts';

/**
 * 가입·로그인·글 작성을 키보드만으로 끝낸다 (sp-docs/plan/phase2.md §7.2 F-05).
 *
 * 포커스는 Tab 으로만 옮기고 제출은 Enter 로 한다. 입력칸은 라벨 이름으로 찾는다 — 화면을 읽어 주는 도구가 그 이름을 읽는다.
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

test('가입 — 계정을 만들고 프로필을 등록한다', async ({ page, api }) => {
  // 프로필을 등록하기 전에는 내 프로필 조회가 404 M001 이다(sp-docs/api-contract.md §3).
  let registered = false;
  api.use({
    'POST /api/v1/accounts': ok({ accountId: ME.accountId, email: EMAIL }, 201),
    'POST /api/v1/auth/login': () => ok(tokens(ME)),
    'GET /api/v1/members/me': () => (registered ? ok(MY_PROFILE) : fail('M001')),
    'POST /api/v1/members': () => {
      registered = true;
      return ok(MY_PROFILE, 201);
    },
  });
  await page.goto('/signup');
  const main = page.getByRole('main');

  await tabTo(page, main.getByLabel('이메일', { exact: true }));
  await page.keyboard.type(EMAIL);
  await tabTo(page, main.getByLabel('비밀번호', { exact: true }));
  await page.keyboard.type(PASSWORD);
  await tabTo(page, main.getByRole('button', { name: '계정 만들기', exact: true }));
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
    'POST /api/v1/auth/login',
    'POST /api/v1/members',
  ]);
  expect(api.sent.find((s) => s.key === 'POST /api/v1/members')?.body).toEqual({ nickname: NICKNAME });
});

test('글 작성', async ({ page, api }) => {
  const title = '키보드로 쓴 글';
  const content = '본문도 키보드로 썼다';
  const created = {
    id: 3,
    title,
    writerId: ME.accountId,
    writerNickname: NICKNAME,
    viewCount: 0,
    commentCount: 0,
    createdAt: '2026-10-28T09:00:00',
    content,
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
  expect(api.sent.find((s) => s.key === 'POST /api/v1/posts')?.body).toEqual({ title, content });
});
