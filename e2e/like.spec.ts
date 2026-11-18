import type { Page } from '@playwright/test';
import { LIKE, ME, OTHER_POST, POST, POST_DETAIL, UNLIKE, detailOf, fail, likeState, ok, pageOf, tokens, type ApiStub } from './api.ts';
import { expect, test } from './fixtures.ts';

/**
 * 좋아요 — sp-docs/plan/phase2-frontend-integration.md F-13 의 검증 표를 프로덕션 빌드에서 밟는다. 같은 표를 화면 테스트
 * (src/pages/postLike.test.tsx)도 덮는다. 상태마다의 접근성과 폭은 e2e/screens.spec.ts 가, 키보드는 e2e/keyboard.spec.ts 가 잰다.
 *
 * 로그인한 화면은 새로고침의 세션 복원으로 연다(e2e/api.ts 의 `login`) — 상세는 복원이 끝난 뒤 되살린 토큰으로 묻는다.
 */

const main = (page: Page) => page.getByRole('main');
/** 글의 패널 — 제목(h1)이 든 것이다. 댓글 패널은 뺀다. */
const postPanel = (page: Page) => main(page).locator('section').filter({ has: page.getByRole('heading', { level: 1 }) });
const likeButton = (page: Page) => postPanel(page).getByRole('button', { name: /^좋아요 \d+$/ });
const GUIDE = '좋아요를 누르려면';
/** 화면이 보낸 좋아요 요청 — 보낸 순서대로. */
const likeRequests = (api: ApiStub) => api.sent.filter((s) => s.key === LIKE || s.key === UNLIKE);

test('누르지 않은 글에서 누르면 PUT 이 본문 없이 나가고, 버튼의 상태와 수를 그 응답으로 바꾼다', async ({ page, api }) => {
  await api.login();
  // 화면이 받은 수는 4 다. 그 사이 다른 계정이 눌러 응답의 수는 6 이다 — 화면이 셈하면 5 다.
  api.use({ [LIKE]: likeState(true, 6) });
  await page.goto('/posts/1');
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(likeButton(page)).toHaveText(`좋아요 ${POST.likeCount}`);
  await expect(postPanel(page).getByText(GUIDE)).toHaveCount(0);

  await likeButton(page).click();

  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(likeButton(page)).toHaveText('좋아요 6');
  expect(likeRequests(api)).toEqual([{ key: LIKE, body: null }]);
});

test('누른 글에서 누르면 DELETE 가 본문 없이 나가고, 버튼의 상태와 수를 그 응답으로 바꾼다', async ({ page, api }) => {
  await api.login();
  // 화면이 받은 수는 4 다. 그 사이 다른 계정이 취소해 응답의 수는 2 다 — 화면이 셈하면 3 이다.
  api.use({ 'GET /api/v1/posts/1': detailOf({ ...POST_DETAIL, liked: true }), [UNLIKE]: likeState(false, 2) });
  await page.goto('/posts/1');
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'true');

  await likeButton(page).click();

  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(likeButton(page)).toHaveText('좋아요 2');
  expect(likeRequests(api)).toEqual([{ key: UNLIKE, body: null }]);
});

test('비로그인이면 누를 버튼 없이 수와 로그인 안내다 — 좋아요 요청이 나가지 않고, 안내는 로그인 화면으로 간다', async ({ page, api }) => {
  await page.goto('/posts/1');
  await expect(postPanel(page).getByText(GUIDE)).toBeVisible();
  const count = postPanel(page).getByText(`좋아요 ${POST.likeCount}`, { exact: true });
  await expect(count).toBeVisible();
  await expect(postPanel(page).getByRole('button', { name: /좋아요/ })).toHaveCount(0);

  await count.click();
  // 보냈으면 그 요청이 여기 남는다 — 스텁은 곧바로 기록한다.
  await page.waitForTimeout(300);
  expect(likeRequests(api)).toEqual([]);

  await postPanel(page).getByRole('link', { name: '로그인', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/login');
});

test('누른 글이 지워졌으면(404 P001) 그 안내와 코드를 보이고, 버튼의 상태와 수를 그대로 둔다', async ({ page, api }) => {
  await api.login();
  api.use({ [LIKE]: fail('P001') });
  await page.goto('/posts/1');
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');

  await likeButton(page).click();

  await expect(postPanel(page).getByText('게시글을 찾을 수 없습니다. 삭제되었을 수 있습니다.')).toBeVisible();
  await expect(postPanel(page).locator('[data-error-code="P001"]')).toBeVisible();
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(likeButton(page)).toHaveText(`좋아요 ${POST.likeCount}`);
  expect(likeRequests(api)).toEqual([{ key: LIKE, body: null }]);
});

test('응답을 기다리는 동안 두 번 눌러도 한 번만 보낸다 — 그동안 버튼은 aria-disabled 다', async ({ page, api }) => {
  await api.login();
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  api.use({
    [LIKE]: async () => {
      await answered;
      return likeState(true, 5);
    },
  });
  await page.goto('/posts/1');
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');

  await likeButton(page).dblclick();
  await expect(likeButton(page)).toHaveAttribute('aria-disabled', 'true');
  await page.waitForTimeout(300);
  // 기다리는 동안은 누르기 전의 상태와 수다 — 화면이 셈해 미리 바꾸지 않는다.
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(likeButton(page)).toHaveText(`좋아요 ${POST.likeCount}`);
  release();

  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(likeButton(page)).not.toHaveAttribute('aria-disabled');
  expect(likeRequests(api)).toEqual([{ key: LIKE, body: null }]);
});

test('같은 작업 안에서 두 번 눌러도 한 번만 보낸다 — 요청이 돈다는 것이 화면에 알려지기 전의 누르기다', async ({ page, api }) => {
  await api.login();
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  api.use({
    [LIKE]: async () => {
      await answered;
      return likeState(true, 5);
    },
  });
  await page.goto('/posts/1');
  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');

  // 화면은 요청이 돈다는 것을 다음 작업(setTimeout 0)에 그린다(TanStack Query 의 `notifyManager`) — 그 전에 온 두 번째 누르기는
  // 그린 상태(`isPending`)로 막지 못한다.
  await likeButton(page).evaluate((button: HTMLElement) => {
    button.click();
    button.click();
  });
  await expect(likeButton(page)).toHaveAttribute('aria-disabled', 'true');
  await page.waitForTimeout(300);
  release();

  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect(likeRequests(api)).toEqual([{ key: LIKE, body: null }]);
});

test('새로고침 — 세션 복원이 끝난 뒤 되살린 토큰으로 상세를 묻는다. 로그인한 화면에 로그인 안내가 나오지 않는다', async ({ page, api }) => {
  await api.login();
  let restore!: () => void;
  const restored = new Promise<void>((resolve) => (restore = resolve));
  const asked: Array<string | null> = [];
  api.use({
    'POST /api/v1/auth/reissue': async () => {
      await restored;
      return ok(tokens(ME));
    },
    'GET /api/v1/posts/1': (request) => {
      const authorization = request.headers().authorization ?? null;
      asked.push(authorization);
      return ok({ ...POST_DETAIL, liked: authorization ? POST_DETAIL.liked : null });
    },
  });
  await page.goto('/posts/1');
  await expect(main(page).getByText('불러오는 중…')).toBeVisible();
  await page.waitForTimeout(300);
  expect(asked).toEqual([]);

  restore();

  await expect(likeButton(page)).toHaveAttribute('aria-pressed', 'false');
  expect(asked).toEqual([expect.stringMatching(/^Bearer /)]);
  await expect(postPanel(page).getByText(GUIDE)).toHaveCount(0);
});

test('응답을 기다리는 사이 기록으로 다른 글의 상세에 가면 그 글은 새 화면이다 — 버튼이 막히지 않고, 늦게 온 응답이 그 글의 상태가 되지 않는다', async ({
  page,
  api,
}) => {
  await api.login();
  let release!: () => void;
  const answered = new Promise<void>((resolve) => (release = resolve));
  const otherLike = `PUT /api/v1/posts/${OTHER_POST.id}/like`;
  api.use({
    [`GET /api/v1/posts/${OTHER_POST.id}`]: detailOf({ ...POST_DETAIL, ...OTHER_POST, likeCount: 40 }),
    [`GET /api/v1/posts/${OTHER_POST.id}/comments`]: ok(pageOf([], 20)),
    [otherLike]: likeState(true, 41),
    [LIKE]: async () => {
      await answered;
      return likeState(true, 5);
    },
  });
  const likeOf = (title: string) =>
    main(page)
      .locator('section')
      .filter({ has: page.getByRole('heading', { level: 1, name: title, exact: true }) })
      .getByRole('button', { name: /^좋아요 \d+$/ });

  // 앱 안의 링크로 다른 글에서 목록을 거쳐 첫 글로 간다 — 기록은 [다른 글, 목록, 첫 글] 이다.
  await page.goto(`/posts/${OTHER_POST.id}`);
  await expect(likeOf(OTHER_POST.title)).toHaveText('좋아요 40');
  await page.getByRole('navigation').getByRole('link', { name: '게시판', exact: true }).click();
  await main(page).getByRole('link', { name: POST.title, exact: true }).click();
  await expect(likeOf(POST.title)).toHaveAttribute('aria-pressed', 'false');
  await likeOf(POST.title).click();
  await expect(likeOf(POST.title)).toHaveAttribute('aria-disabled', 'true');

  // 두 칸 뒤로 — 기록 이동 한 번에 첫 글의 상세에서 다른 글의 상세로 간다. 같은 라우트다.
  await page.evaluate(() => history.go(-2));
  await page.waitForURL((url) => url.pathname === `/posts/${OTHER_POST.id}`);
  const other = likeOf(OTHER_POST.title);
  await expect(other).toHaveText('좋아요 40');
  await expect(other).toHaveAttribute('aria-pressed', 'false');
  // 기다리는 것은 첫 글의 화면이다 — 이 글의 버튼은 막히지 않는다.
  await expect(other).not.toHaveAttribute('aria-disabled');
  await other.click();
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await expect(other).toHaveText('좋아요 41');

  // 첫 글의 응답이 와도 이 글의 상태가 되지 않는다.
  const answer = page.waitForResponse(
    (response) => `${response.request().method()} ${new URL(response.url()).pathname}` === LIKE,
  );
  release();
  await answer;
  await page.waitForTimeout(300);
  await expect(other).toHaveAttribute('aria-pressed', 'true');
  await expect(other).toHaveText('좋아요 41');
  expect(api.sent.filter((s) => s.key === LIKE || s.key === otherLike)).toEqual([
    { key: LIKE, body: null },
    { key: otherLike, body: null },
  ]);
});

test('글 목록 — 표의 좋아요 칸과 좁은 화면의 줄 목록에 그 글의 좋아요 수를 그린다', async ({ page }) => {
  await page.goto('/posts');
  const table = main(page).getByRole('table');
  const row = table.getByRole('row').filter({ has: page.getByRole('link', { name: POST.title, exact: true }) });
  await expect(row).toBeVisible();
  const headers = await table.getByRole('columnheader').allTextContents();
  const column = headers.indexOf('좋아요');
  expect(column, '좋아요 칸').toBeGreaterThan(-1);
  await expect(row.getByRole('cell').nth(column)).toHaveText(String(POST.likeCount));

  await page.setViewportSize({ width: 360, height: 800 });
  const line = main(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: POST.title, exact: true }) });
  await expect(line).toBeVisible();
  await expect(line.getByText(`좋아요 ${POST.likeCount}`, { exact: true })).toBeVisible();
});
