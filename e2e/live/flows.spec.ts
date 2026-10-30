import type { Page, Response } from '@playwright/test';
import { allowed, expect, test, type Traffic } from './fixtures.ts';

/**
 * 실제 서비스와의 화면 흐름 (sp-docs/plan/phase2.md §7.2 F-06 의 검증 표). 세 서비스를 `local` 프로파일로 띄운 뒤
 * `pnpm test:e2e:live` 로 돈다. 이 테스트는 서비스를 띄우거나 내리지 않고 DB 를 만지지 않는다.
 *
 * 흐름마다 계정을 화면으로 만들고(가입) 끝에 화면으로 탈퇴한다 — 탈퇴가 그 계정을 지우는 길이다. 이메일은 `EMAIL_PREFIX` 로
 * 시작하고 실행마다 다르므로 같은 스위트를 다시 돌릴 수 있다. 남는 행(탈퇴한 계정·프로필, 지운 글·댓글, 중간에 실패한 흐름의
 * 계정)은 그 접두어로 찾아 사람이 정리한다(README 「e2e 가 남긴 데이터」).
 *
 * 입력칸은 라벨 이름으로, 버튼과 링크는 보이는 이름으로 찾는다. 화면을 옮기는 것은 링크와 버튼이다 — 주소창(`page.goto`)은
 * 흐름의 첫 화면, 새로고침, 주소를 직접 여는 경우에만 쓴다.
 */

/** e2e 가 만든 계정의 이메일 접두어. README 의 정리 절차가 이것으로 찾는다 — 바꾸면 그 절차도 고친다. */
const EMAIL_PREFIX = 'e2e-live-';
/** 테스트 값이다. sp-docs/requirements/member.md §2 의 규칙(8~20자, 영문·숫자·특수문자)에 맞는다. */
const PASSWORD = 'Passw0rd!';

interface Account {
  email: string;
  nickname: string;
}

/** 영문 소문자·숫자 일곱 자 — 실행마다 다르다. */
const unique = () => Math.random().toString(36).slice(2, 9).padEnd(7, '0');

/** 닉네임은 2~10자, 한글·영문·숫자다(sp-docs/requirements/member.md §2). 다른 계정과 겹치지 않아야 한다(409). */
const newNickname = () => `e2e${unique()}`;

/** 이메일에 시각을 넣어 같은 실행의 계정이 이웃하게 한다. */
const newAccount = (): Account => ({
  email: `${EMAIL_PREFIX}${Date.now().toString(36)}${unique()}@example.com`,
  nickname: newNickname(),
});

const main = (page: Page) => page.getByRole('main');
const banner = (page: Page) => page.getByRole('banner');
const at = (page: Page, path: string | RegExp) =>
  page.waitForURL((url) => (typeof path === 'string' ? url.pathname === path : path.test(url.pathname)));
const panel = (page: Page, title: string) =>
  main(page).locator('section').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
/** 글 상세의 글 칸 — 제목(h1)이 있는 칸이다. 댓글 칸에도 「수정」·「삭제」가 있어 버튼을 이 안에서 찾는다. */
const postPanel = (page: Page) => main(page).locator('section').filter({ has: page.getByRole('heading', { level: 1 }) });
/** 그 경로의 다음 GET 응답 — 기다리기 시작한 뒤에 온 것이다. 쿼리는 보지 않는다. */
const nextGet = (page: Page, path: string) =>
  page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname === path);

/**
 * 상세가 그 응답을 그렸다. 상세는 받아 둔 것을 먼저 그리고 다시 받는다 — 상세 조회는 조회수를 올리므로 다시 받은 응답의
 * 조회수가 보이면 그 응답이 그려진 것이다.
 */
async function detailDrawn(page: Page, response: Response) {
  const { data } = (await response.json()) as { data: { viewCount: number } };
  await expect(postPanel(page).getByText(new RegExp(`조회 ${data.viewCount} `))).toBeVisible();
}

/** 로그인 상태 — 머리글이 닉네임과 로그아웃을 보인다. */
async function expectLoggedIn(page: Page, nickname: string) {
  await expect(banner(page).getByText(nickname, { exact: true })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: '로그아웃' })).toBeVisible();
}

/** 로그인 상태가 아니다 — 머리글이 로그인·가입 링크를 보이고 로그아웃이 없다. */
async function expectLoggedOut(page: Page) {
  await expect(banner(page).getByRole('link', { name: '로그인', exact: true })).toBeVisible();
  await expect(banner(page).getByRole('button', { name: '로그아웃' })).toHaveCount(0);
}

/** 목록이 다 그려졌다 — 글이 있으면 표, 없으면 빈 목록 문구다. */
const listShown = (page: Page) =>
  expect(main(page).getByRole('table').or(main(page).getByText('등록된 게시글이 없다', { exact: true }))).toBeVisible();

/** 가입 — 사용자가 내는 것은 계정 정보와 닉네임이다(sp-docs/plan/phase2.md §7.1). 목록이 다 그려지면 끝난다. */
async function signUp(page: Page, account: Account = newAccount()): Promise<Account> {
  await page.goto('/signup');
  await main(page).getByLabel('이메일', { exact: true }).fill(account.email);
  await main(page).getByLabel('비밀번호', { exact: true }).fill(PASSWORD);
  await main(page).getByRole('button', { name: '계정 만들기', exact: true }).click();
  await at(page, '/signup/profile');
  await main(page).getByLabel('닉네임', { exact: true }).fill(account.nickname);
  await main(page).getByRole('button', { name: '프로필 등록', exact: true }).click();
  await at(page, '/posts');
  await expectLoggedIn(page, account.nickname);
  await listShown(page);
  return account;
}

/**
 * 보호된 경로가 로그인으로 보낸다 — 머리글의 「마이페이지」를 누를 때와 주소로 「새 글」을 열 때. 목록에서 시작한다 — 로그인
 * 화면에서 누르면 처음부터 로그인 화면이라 옮겨 간 것을 볼 수 없다.
 */
async function openProtected(page: Page) {
  // 목록은 받아 둔 것을 먼저 그리고 다시 받는다 — 다시 받는 응답이 끝나기 전에 떠나면 그 요청이 끊겨 실패한 요청으로 남는다.
  const relisted = nextGet(page, '/api/v1/posts');
  await banner(page).getByRole('link', { name: '게시판', exact: true }).click();
  await at(page, '/posts');
  await (await relisted).finished();
  await listShown(page);
  await banner(page).getByRole('link', { name: '마이페이지', exact: true }).click();
  await at(page, '/login');
  await page.goto('/posts/new');
  await at(page, '/login');
  await expect(main(page).getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
}

async function logIn(page: Page, account: Account) {
  await banner(page).getByRole('link', { name: '로그인', exact: true }).click();
  await at(page, '/login');
  await main(page).getByLabel('이메일', { exact: true }).fill(account.email);
  await main(page).getByLabel('비밀번호', { exact: true }).fill(PASSWORD);
  await main(page).getByRole('button', { name: '로그인', exact: true }).click();
  await at(page, '/posts');
  await expectLoggedIn(page, account.nickname);
}

/** 탈퇴 — 마이페이지의 탈퇴 칸에서 비밀번호를 한 번 내는 한 동작이다. 로그인 화면이 끝났다고 알리면 끝난다. */
async function withdraw(page: Page) {
  await banner(page).getByRole('link', { name: '마이페이지', exact: true }).click();
  await at(page, '/me');
  const section = panel(page, '탈퇴');
  await section.getByLabel('현재 비밀번호', { exact: true }).fill(PASSWORD);
  await section.getByRole('button', { name: '탈퇴', exact: true }).click();
  await at(page, '/login');
  await expect(main(page).getByText('탈퇴했습니다.', { exact: true })).toBeVisible();
}

/** 글을 쓴다 — 목록의 「새 글」에서. 상세에 도착하면 그 글의 id 를 돌려준다. */
async function writePost(page: Page, title: string, content: string): Promise<string> {
  await banner(page).getByRole('link', { name: '게시판', exact: true }).click();
  await at(page, '/posts');
  await main(page).getByRole('button', { name: '새 글', exact: true }).click();
  await at(page, '/posts/new');
  await main(page).getByLabel('제목', { exact: true }).fill(title);
  await main(page).getByLabel('본문', { exact: true }).fill(content);
  await main(page).getByRole('button', { name: '등록', exact: true }).click();
  await at(page, /^\/posts\/\d+$/);
  await expect(main(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2];
}

/** 내 글에서 그 글을 열어 지운다 — 흐름이 쓴 글을 치운다. 목록에 도착하면 끝난다. */
async function removeMyPost(page: Page, title: string) {
  await banner(page).getByRole('link', { name: '내 글', exact: true }).click();
  await at(page, '/posts/mine');
  await main(page).getByRole('link', { name: title, exact: true }).click();
  await at(page, /^\/posts\/\d+$/);
  await postPanel(page).getByRole('button', { name: '삭제', exact: true }).click();
  await at(page, '/posts');
}

test('가입 — 한 흐름으로 프로필까지 만들어지고 로그인 상태다', async ({ page, traffic }) => {
  const account = await signUp(page);

  // 사용자가 낸 것은 두 번이고, 화면이 계정 → 로그인 → 프로필 순서로 불렀다(sp-docs/api-contract.md §9.1).
  expect(traffic.answered.filter((a) => a.key.startsWith('POST '))).toEqual([
    { key: 'POST /api/v1/accounts', status: 201 },
    { key: 'POST /api/v1/auth/login', status: 200 },
    { key: 'POST /api/v1/members', status: 201 },
  ]);
  // 마이페이지가 두 서비스에서 그 계정과 프로필을 읽는다 — 이메일은 auth, 닉네임은 member 다.
  await banner(page).getByRole('link', { name: '마이페이지', exact: true }).click();
  await at(page, '/me');
  await expect(panel(page, '계정').getByText(account.email, { exact: true })).toBeVisible();
  await expect(panel(page, '프로필').getByText(account.nickname, { exact: true })).toBeVisible();

  await withdraw(page);
});

test('새로고침 — 로그인 상태가 이어진다', async ({ page, traffic }) => {
  const account = await signUp(page);

  await page.reload();
  await expectLoggedIn(page, account.nickname);
  // Access Token 은 메모리에만 있으므로 이어 준 것은 Refresh Token 의 재발급이다(CLAUDE.md 「경계」).
  expect(traffic.answered.filter((a) => a.key === 'POST /api/v1/auth/reissue')).toEqual([
    { key: 'POST /api/v1/auth/reissue', status: 200 },
  ]);
  // 보호된 화면도 그대로 열린다.
  await banner(page).getByRole('link', { name: '마이페이지', exact: true }).click();
  await at(page, '/me');
  await expect(panel(page, '계정').getByText(account.email, { exact: true })).toBeVisible();

  await withdraw(page);
});

test('글 작성 → 상세 → 수정 → 삭제 — 각 단계가 반영되고 삭제 뒤 상세가 없다', async ({ page, traffic }) => {
  const account = await signUp(page);
  const title = `e2e 글 ${unique()}`;
  const content = `본문 ${unique()}`;

  const id = await writePost(page, title, content);
  const detail = `/posts/${id}`;
  await expect(main(page).getByText(content, { exact: true })).toBeVisible();

  // 목록에서 그 글을 찾아 연다. 상세가 다시 받은 것을 그릴 때까지 기다린다.
  await banner(page).getByRole('link', { name: '게시판', exact: true }).click();
  await at(page, '/posts');
  const reread = nextGet(page, `/api/v1${detail}`);
  await main(page).getByRole('link', { name: title, exact: true }).click();
  await at(page, detail);
  await detailDrawn(page, await reread);
  await expect(postPanel(page).getByRole('link', { name: account.nickname, exact: true })).toBeVisible();
  await expect(main(page).getByText(content, { exact: true })).toBeVisible();

  // 수정. 수정 화면은 고칠 글을 스스로 받아 그 값으로 입력칸을 한 번 채운다 — 채운 뒤에 온 응답이 입력을 덮으면 옛 값이
  // 저장된다. 그래서 채워진 것을 보고 입력한 다음, 수정 화면이 받은 응답을 기다려 입력이 그대로인지 본다. 상세가 다시 받은 것을
  // 그린 뒤에 기다리기 시작하므로 그 응답은 수정 화면의 것이다.
  const edited = { title: `${title} 고침`, content: `${content} 고침` };
  const titleBox = main(page).getByLabel('제목', { exact: true });
  const contentBox = main(page).getByLabel('본문', { exact: true });
  const loaded = nextGet(page, `/api/v1${detail}`);
  await postPanel(page).getByRole('button', { name: '수정', exact: true }).click();
  await at(page, `${detail}/edit`);
  await expect(titleBox).toHaveValue(title);
  await expect(contentBox).toHaveValue(content);
  await titleBox.fill(edited.title);
  await contentBox.fill(edited.content);
  await (await loaded).finished();
  await expect(titleBox).toHaveValue(edited.title);
  await expect(contentBox).toHaveValue(edited.content);
  await main(page).getByRole('button', { name: '저장', exact: true }).click();
  await at(page, detail);
  await expect(main(page).getByRole('heading', { name: edited.title, exact: true })).toBeVisible();
  await expect(main(page).getByText(edited.content, { exact: true })).toBeVisible();

  // 삭제. 목록은 받아 둔 것을 먼저 그리고 다시 받는다 — 받아 둔 목록에는 원래 제목이 있다. 그것이 사라지면 다시 받은 목록이고,
  // 거기에 고친 제목도 없어야 한다. 주소로 열면 없는 글이다.
  const relisted = nextGet(page, '/api/v1/posts');
  await postPanel(page).getByRole('button', { name: '삭제', exact: true }).click();
  await at(page, '/posts');
  await relisted;
  await listShown(page);
  await expect(main(page).getByRole('link', { name: title, exact: true })).toHaveCount(0);
  await expect(main(page).getByRole('link', { name: edited.title, exact: true })).toHaveCount(0);
  await page.goto(detail);
  await expect(page.locator('[data-error-code="P001"]')).toBeVisible();
  await expect(main(page).getByRole('heading', { name: edited.title, exact: true })).toHaveCount(0);

  expectPreflights(traffic, page, id);
  await withdraw(page);
});

test('댓글 작성 → 수정 → 삭제 — 각 단계가 반영된다', async ({ page }) => {
  const account = await signUp(page);
  const title = `e2e 댓글을 받는 글 ${unique()}`;
  await writePost(page, title, `본문 ${unique()}`);
  const comments = panel(page, '댓글 0');
  await expect(comments.getByText('댓글이 없다', { exact: true })).toBeVisible();

  const written = `댓글 ${unique()}`;
  await main(page).getByPlaceholder(/^댓글/).fill(written);
  await main(page).getByRole('button', { name: '등록', exact: true }).click();
  const item = main(page).getByRole('listitem').filter({ hasText: account.nickname });
  await expect(item.getByText(written, { exact: true })).toBeVisible();
  await expect(panel(page, '댓글 1')).toBeVisible();

  const edited = `${written} 고침`;
  await item.getByRole('button', { name: '수정', exact: true }).click();
  await expect(item.getByLabel('댓글 수정')).toHaveValue(written);
  await item.getByLabel('댓글 수정').fill(edited);
  await item.getByRole('button', { name: '저장', exact: true }).click();
  await expect(item.getByText(edited, { exact: true })).toBeVisible();
  await expect(item.getByText(written, { exact: true })).toHaveCount(0);

  await item.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(panel(page, '댓글 0').getByText('댓글이 없다', { exact: true })).toBeVisible();
  await expect(main(page).getByText(edited, { exact: true })).toHaveCount(0);

  await removeMyPost(page, title);
  await withdraw(page);
});

test('내 글 — 방금 쓴 글이 보인다', async ({ page }) => {
  await signUp(page);
  const title = `e2e 내 글 ${unique()}`;
  await writePost(page, title, `본문 ${unique()}`);

  await banner(page).getByRole('link', { name: '내 글', exact: true }).click();
  await at(page, '/posts/mine');
  await expect(main(page).getByRole('link', { name: title, exact: true })).toBeVisible();

  await removeMyPost(page, title);
  await withdraw(page);
});

test('닉네임 수정 — 과거 글의 작성자 이름이 그대로다(스냅샷)', async ({ page }) => {
  const account = await signUp(page);
  const title = `e2e 스냅샷 ${unique()}`;
  const id = await writePost(page, title, `본문 ${unique()}`);

  const renamed = newNickname();
  await banner(page).getByRole('link', { name: '마이페이지', exact: true }).click();
  await at(page, '/me');
  const profile = panel(page, '프로필');
  await profile.getByLabel('새 닉네임', { exact: true }).fill(renamed);
  await profile.getByRole('button', { name: '수정', exact: true }).click();
  await expect(main(page).getByText('닉네임 수정 완료', { exact: true })).toBeVisible();
  await expect(profile.getByText(renamed, { exact: true })).toBeVisible();
  await expectLoggedIn(page, renamed);

  // 글은 작성 당시의 닉네임을 갖는다(sp-docs/adr/0003) — 목록과 상세 둘 다, 개명 뒤에 서버에서 다시 받은 것으로 본다. 받아 둔
  // 목록은 글을 쓰기 전에 받은 것이라 그 행이 없다. 상세는 개명 전에 받아 둔 것을 먼저 그리므로 다시 받은 응답이 그려지기를
  // 기다린다.
  await banner(page).getByRole('link', { name: '게시판', exact: true }).click();
  await at(page, '/posts');
  const row = main(page).getByRole('row').filter({ hasText: title });
  await expect(row.getByRole('link', { name: account.nickname, exact: true })).toBeVisible();
  const reread = nextGet(page, `/api/v1/posts/${id}`);
  await row.getByRole('link', { name: title, exact: true }).click();
  await at(page, `/posts/${id}`);
  await detailDrawn(page, await reread);
  await expect(postPanel(page).getByRole('link', { name: account.nickname, exact: true })).toBeVisible();
  await expect(postPanel(page).getByText(renamed)).toHaveCount(0);

  await removeMyPost(page, title);
  await withdraw(page);
});

test('탈퇴 — 한 동작으로 끝나고 로그인 상태가 아니다', async ({ page, traffic }) => {
  await signUp(page);

  await withdraw(page);
  // 한 번 누른 탈퇴가 계정 → 프로필 순서로 둘 다 끝냈다(sp-docs/api-contract.md §9.1.1).
  expect(traffic.answered.filter((a) => a.key.startsWith('DELETE '))).toEqual([
    { key: 'DELETE /api/v1/accounts/me', status: 204 },
    { key: 'DELETE /api/v1/members/me', status: 204 },
  ]);
  await expectLoggedOut(page);
  await openProtected(page);
});

test('로그아웃 뒤 보호된 경로 — 로그인으로 간다', async ({ page }) => {
  const account = await signUp(page);

  await banner(page).getByRole('button', { name: '로그아웃' }).click();
  await at(page, '/login');
  await expectLoggedOut(page);
  await openProtected(page);

  // 치운다 — 다시 로그인해 탈퇴한다.
  await logIn(page, account);
  await withdraw(page);
});

/**
 * preflight 가 실제로 오갔다 — 브라우저가 세 서비스에 OPTIONS 를 보냈고 **그 서비스가** 이 화면의 오리진과 원요청의 메서드를
 * 허용한다고 답했다. 본 주소는 흐름이 처음 부른 주소들이라 브라우저에 그 주소의 preflight 결과가 없었다 — 계정 생성은 JSON
 * 본문이, 프로필 등록은 토큰과 JSON 본문이, 글 상세는 토큰이 preflight 를 부른다.
 *
 * - 서비스의 답에는 `Access-Control-Allow-Credentials` 가 없다(sp-docs/security.md §1.1 의 `allowCredentials = false`).
 *   가로채기를 켜면 Playwright 가 대신 답하는데 그 답은 `true` 를 싣는다 — 이 검사가 그 답을 서비스의 답으로 읽지 않는다
 * - 프록시 모드는 같은 오리진이라 preflight 가 없다 — 여기서 빈 자리가 된다
 * - 글 수정은 `PUT` 이다 — board 만 쓰고 sp-docs/security.md §1.1 이 허용 메서드에서 빠졌던 것으로 적은 메서드다. 수정은 JSON
 *   본문의 `Content-Type` 을 실어 보내고, 그 주소에 앞서 받아 둔 조회의 preflight 결과는 그 헤더를 허용하지 않았으므로 브라우저가
 *   `PUT` 을 따로 묻는다(F-06 측정). 그 preflight 를 board 가 허용했는지와 수정이 성공했는지를 본다
 */
function expectPreflights(traffic: Traffic, page: Page, postId: string) {
  const origin = new URL(page.url()).origin;
  const firstAnswer = (path: string) => {
    const [first] = traffic.preflightsTo(path);
    return first && { path, method: first.method, allowed: allowed(first, origin), allowCredentials: first.allowCredentials };
  };
  expect(['/api/v1/accounts', '/api/v1/members', `/api/v1/posts/${postId}`].map(firstAnswer)).toEqual([
    { path: '/api/v1/accounts', method: 'POST', allowed: true, allowCredentials: null },
    { path: '/api/v1/members', method: 'POST', allowed: true, allowCredentials: null },
    { path: `/api/v1/posts/${postId}`, method: 'GET', allowed: true, allowCredentials: null },
  ]);
  const puts = traffic.preflightsTo(`/api/v1/posts/${postId}`).filter((p) => p.method === 'PUT');
  expect(puts.map((p) => ({ allowed: allowed(p, origin), allowCredentials: p.allowCredentials }))).toEqual([
    { allowed: true, allowCredentials: null },
  ]);
  expect(traffic.answered).toContainEqual({ key: `PUT /api/v1/posts/${postId}`, status: 200 });
}
