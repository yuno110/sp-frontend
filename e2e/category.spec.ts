import type { Page } from '@playwright/test';
import { ADMIN, NOTICE_POST, OTHER_POST, POST, POST_DETAIL, categoryOf, fail, ok, pageOf } from './api.ts';
import { expect, test } from './fixtures.ts';

/**
 * 카테고리와 공지 고정 — sp-docs/plan/phase2-frontend-integration.md F-12 의 검증 표를 프로덕션 빌드에서 밟는다. 같은 표를 화면
 * 테스트(src/pages/postCategory.test.tsx)도 덮는다. 상태마다의 접근성과 폭은 e2e/screens.spec.ts 가 잰다.
 */

const LIST = '/api/v1/posts';

const main = (page: Page) => page.getByRole('main');
const tab = (page: Page, name: string) => main(page).getByRole('group', { name: '카테고리' }).getByRole('button', { name });
const pinned = (page: Page) =>
  main(page).locator('section').filter({ has: page.getByRole('heading', { name: '최근 공지', exact: true }) });
const category = (page: Page) => main(page).getByLabel('카테고리', { exact: true });

/** 화면이 보낸 글 목록 요청의 쿼리 — 보낸 순서대로. 화면을 열기 전에 건다. */
function listQueries(page: Page) {
  const queries: Array<Record<string, string>> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === LIST) queries.push(Object.fromEntries(url.searchParams));
  });
  return queries;
}

test('탭 + 검색어 + 정렬 — 세 파라미터가 한 요청에 함께 나간다', async ({ page }) => {
  const queries = listQueries(page);
  await page.goto('/posts');
  await expect(main(page).getByRole('link', { name: '짧은 글' }).first()).toBeVisible();

  await main(page).getByLabel('정렬').selectOption({ label: '조회순' });
  await main(page).getByLabel('검색어').fill('안내');
  await main(page).getByRole('button', { name: '검색', exact: true }).click();
  await tab(page, '질문').click();

  await expect
    .poll(() => queries.at(-1))
    .toEqual({ page: '0', size: '10', sort: 'views', searchType: 'TITLE', keyword: '안내', category: 'QNA' });
  // 그 탭의 답을 그린다 — 스텁은 카테고리로 거른다(e2e/api.ts 의 `listOf`).
  const rows = main(page).getByRole('table').getByRole('row');
  await expect(rows.filter({ hasText: OTHER_POST.title })).toBeVisible();
  await expect(rows.filter({ hasText: POST.title })).toHaveCount(0);

  await tab(page, '자유').click();

  await expect.poll(() => queries.at(-1)).toMatchObject({ sort: 'views', keyword: '안내', category: 'FREE' });
  await expect(rows.filter({ hasText: POST.title })).toBeVisible();
  await expect(rows.filter({ hasText: OTHER_POST.title })).toHaveCount(0);
  await expect(tab(page, '자유')).toHaveAttribute('aria-pressed', 'true');
});

test('전체 목록 첫 페이지 — 고정 영역이 공지를 따로 받고, 아래 목록의 공지에 배지가 붙는다', async ({ page, api }) => {
  // 고정 영역의 답에는 아래 목록에 없는 공지가 있다 — 그 영역이 따로 받은 것을 그리는지 가른다.
  const older = { ...NOTICE_POST, id: 4, title: '지난 공지', createdAt: '2026-10-20T09:00:00' };
  api.use({
    'GET /api/v1/posts': (request) =>
      ok(pageOf(categoryOf(request) === 'NOTICE' ? [NOTICE_POST, older] : [NOTICE_POST, POST, OTHER_POST])),
  });
  const queries = listQueries(page);
  await page.goto('/posts');

  await expect(pinned(page).getByRole('link', { name: '지난 공지' })).toBeVisible();
  expect(queries).toContainEqual({ page: '0', size: '3', sort: 'latest', category: 'NOTICE' });
  const rows = main(page).getByRole('table').getByRole('row');
  await expect(rows.filter({ hasText: NOTICE_POST.title }).getByText('공지', { exact: true })).toBeVisible();
  await expect(rows.filter({ hasText: '짧은 글' })).toBeVisible();
  await expect(rows.filter({ hasText: '짧은 글' }).getByText('공지', { exact: true })).toHaveCount(0);
});

test('전체 목록 둘째 페이지 — 고정 영역이 없다', async ({ page, api }) => {
  api.use({
    'GET /api/v1/posts': (request) => {
      if (categoryOf(request) === 'NOTICE') return ok(pageOf([NOTICE_POST]));
      const second = new URL(request.url()).searchParams.get('page') === '1';
      return ok({
        ...pageOf(second ? [OTHER_POST] : [NOTICE_POST, POST]),
        page: second ? 1 : 0,
        totalElements: 3,
        totalPages: 2,
        first: !second,
        last: second,
      });
    },
  });
  await page.goto('/posts');
  await expect(pinned(page)).toBeVisible();

  await main(page).getByRole('button', { name: '다음' }).click();

  await expect(main(page).getByRole('link', { name: '짧은 글' }).first()).toBeVisible();
  await expect(pinned(page)).toHaveCount(0);
});

test('USER 로 폼을 연다 — 공지 선택지가 없다', async ({ page, api }) => {
  await api.login();
  await page.goto('/posts/new');

  await expect(category(page)).toHaveValue('FREE');
  await expect(category(page).locator('option')).toHaveText(['자유', '질문']);
});

test('ADMIN 으로 폼을 연다 — 공지 선택지가 있다', async ({ page, api }) => {
  await api.login(ADMIN);
  await page.goto('/posts/new');

  await expect(category(page)).toHaveValue('FREE');
  await expect(category(page).locator('option')).toHaveText(['공지', '자유', '질문']);
});

test('저장 → 403 P003 — 그 안내가 보이고 입력이 남는다', async ({ page, api }) => {
  await api.login(ADMIN);
  api.use({ 'POST /api/v1/posts': fail('P003') });
  await page.goto('/posts/new');

  await category(page).selectOption({ label: '공지' });
  await main(page).getByLabel('제목', { exact: true }).fill('점검 공지');
  await main(page).getByLabel('본문', { exact: true }).fill('점검 시간을 알립니다.');
  await main(page).getByRole('button', { name: '등록' }).click();

  await expect(main(page).getByText('공지를 작성하거나 변경할 권한이 없습니다.')).toBeVisible();
  await expect(main(page).locator('[data-error-code="P003"]')).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/posts/new');
  await expect(category(page)).toHaveValue('NOTICE');
  await expect(main(page).getByLabel('제목', { exact: true })).toHaveValue('점검 공지');
  await expect(main(page).getByLabel('본문', { exact: true })).toHaveValue('점검 시간을 알립니다.');
  expect(api.sent.find((s) => s.key === 'POST /api/v1/posts')?.body).toEqual({
    title: '점검 공지',
    content: '점검 시간을 알립니다.',
    category: 'NOTICE',
  });
});

test('수정 폼 — 지금 카테고리가 골라져 있고, 바꾸지 않고 저장하면 그 값을 보낸다', async ({ page, api }) => {
  // 폼의 처음 값(자유)과 다른 카테고리다 — 받은 값으로 골랐는지 가른다.
  const question = { ...POST_DETAIL, category: 'QNA' };
  await api.login();
  api.use({ 'GET /api/v1/posts/1': ok(question), 'PUT /api/v1/posts/1': ok(question) });
  await page.goto('/posts/1/edit');

  await expect(category(page)).toHaveValue('QNA');
  await main(page).getByRole('button', { name: '저장' }).click();

  await page.waitForURL((url) => url.pathname === '/posts/1');
  expect(api.sent.find((s) => s.key === 'PUT /api/v1/posts/1')?.body).toMatchObject({ category: 'QNA' });
});
