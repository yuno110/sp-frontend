import type { Page } from '@playwright/test';
import { ME, NICKNAME, NO_CONTENT, ok, tokens } from './api.ts';
import { expect, test } from './fixtures.ts';

/**
 * 로그아웃은 로그인 화면으로 `flushSync` 로 옮겨 떠나는 화면을 캐시를 비우는 커밋 뒤에 남기지 않는다(CLAUDE.md 「경계」). 없으면 옮기기가
 * 전환으로 미뤄져 떠나는 화면이 비운 캐시로 다시 묻고(src/lib/queryClient.ts) 글 상세는 조회할 때마다 조회수가 오른다. 실제 서비스에 저장된
 * 조회수는 e2e/live/flows.spec.ts 가 본다.
 *
 * 본문에는 그 세션의 Refresh Token 을 싣는다(sp-docs/api-contract.md §9.5) — 새로고침 복원의 재발급이 회전시켜 준 값이고, 영속 키에 두었던
 * 회전 전의 값이 아니다.
 */

const banner = (page: Page) => page.getByRole('banner');
const main = (page: Page) => page.getByRole('main');

const SCREENS: Array<[string, string, (page: Page) => Promise<void>]> = [
  [
    '글 상세',
    '/posts/1',
    async (page) => {
      await expect(main(page).getByText('본문 첫 줄')).toBeVisible();
      await expect(main(page).getByText('짧은 댓글', { exact: true })).toBeVisible();
    },
  ],
  ['글 목록', '/posts', (page) => expect(main(page).getByRole('link', { name: '짧은 글', exact: true })).toBeVisible()],
  ['마이페이지', '/me', (page) => expect(main(page).getByRole('heading', { name: '마이페이지', exact: true })).toBeVisible()],
];

for (const [name, path, drawn] of SCREENS) {
  test(`${name} 에서 로그아웃 — 로그아웃 요청만 나간다. 떠나는 화면이 다시 묻지 않는다`, async ({ page, api }) => {
    api.use({ 'POST /api/v1/auth/logout': NO_CONTENT });
    await api.login();
    const session = tokens(ME);
    api.use({ 'POST /api/v1/auth/reissue': ok(session) });
    await page.goto(path);
    await drawn(page);
    await expect(banner(page).getByText(NICKNAME, { exact: true })).toBeVisible();
    const before = api.keys().length;

    await banner(page).getByRole('button', { name: '로그아웃' }).click();

    await page.waitForURL('**/login');
    await expect(banner(page).getByRole('link', { name: '로그인', exact: true })).toBeVisible();
    await expect(main(page).getByRole('heading', { name: '로그인', exact: true })).toBeVisible();
    // 다시 물었으면 그 요청이 여기 남는다 — 화면이 토큰을 지운 커밋에서 묻고 스텁이 바로 답한다.
    await page.waitForTimeout(300);
    expect(api.sent.slice(before)).toEqual([{ key: 'POST /api/v1/auth/logout', body: { refreshToken: session.refreshToken } }]);
  });
}
