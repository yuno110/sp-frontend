import type { Locator } from '@playwright/test';
import { ADMIN, EMAIL } from './api.ts';
import { expect, test } from './fixtures.ts';

/**
 * 좁은 폭에서 자리를 어떻게 나누는가. 가로 스크롤과 쪼개진 낱말은 e2e/screens.spec.ts 가 라우트마다 보지만, **칸이 좁아져 제목을
 * 읽기 어려운 것은 둘 다 잡지 못한다** — 넘치지도 않고 라벨도 아니다.
 */

/** 글 목록이 표로 바뀌는 폭 — Tailwind 의 `md` 다(src/components/PostTable.tsx). */
const TABLE_FROM = 768;
/** 표의 번호 칸을 그리는 폭 — Tailwind 의 `lg` 다. 까닭은 src/components/PostTable.tsx 의 주석이 적는다. */
const NUMBER_FROM = 1024;
/** 표의 제목 칸이 이보다 좁으면 제목이 몇 글자씩 줄을 바꾼다. */
const TITLE_CELL_MIN = 200;

test('글 목록 — 표가 보이는 폭마다 제목 칸이 넓고, 그보다 좁으면 줄 목록이다. 표의 번호 칸은 1024px 부터다', async ({ page }) => {
  await page.goto('/posts');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: '짧은 글' }).first()).toBeVisible();
  const table = main.getByRole('table');
  // 최근 공지 영역도 줄 목록이고 폭과 상관없이 보인다 — 글 목록의 줄 목록은 공지가 아닌 글(짧은 글)을 담은 것이다.
  const list = main.getByRole('list').filter({ has: page.getByRole('link', { name: '짧은 글' }) });

  for (const width of [360, 640, 767, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const isTable = await table.isVisible();
    expect.soft(isTable, `${width}px — 표인가`).toBe(width >= TABLE_FROM);
    expect.soft(await list.isVisible(), `${width}px — 줄 목록인가`).toBe(width < TABLE_FROM);
    const number = table.getByRole('columnheader', { name: '번호', exact: true });
    expect.soft(await number.isVisible(), `${width}px — 번호 칸이 보이는가`).toBe(width >= NUMBER_FROM);
    if (isTable) {
      const cell = await table.getByRole('columnheader', { name: '제목' }).boundingBox();
      expect.soft(cell?.width ?? 0, `${width}px — 제목 칸의 폭`).toBeGreaterThanOrEqual(TITLE_CELL_MIN);
    }
  }
});

test('글 상세 — 좁은 폭에서 제목이 전체 폭을 쓰고 버튼은 그 아래다. 넓은 폭에서는 버튼이 옆에 온다', async ({ page, api }) => {
  await api.login();
  await page.goto('/posts/1');
  const heading = page.getByRole('main').getByRole('heading', { level: 1 });
  const row = heading.locator('xpath=ancestor::header[1]');
  const remove = row.getByRole('button', { name: '삭제' });
  // 버튼이 그려진 뒤에 잰다 — 비로그인으로 그린 때는 버튼이 없어 제목이 전체 폭을 쓴다.
  await expect(remove).toBeVisible();

  await page.setViewportSize({ width: 360, height: 800 });
  const [narrowTitle, narrowRow, narrowButton] = await Promise.all([heading.boundingBox(), row.boundingBox(), remove.boundingBox()]);
  expect(narrowTitle?.width, '360px — 제목의 폭은 제목 줄의 폭이다').toBeCloseTo(narrowRow?.width ?? 0, 0);
  expect(narrowButton?.y ?? 0, '360px — 버튼은 제목 아래다').toBeGreaterThanOrEqual((narrowTitle?.y ?? 0) + (narrowTitle?.height ?? 0));

  await page.setViewportSize({ width: 1280, height: 800 });
  const [wideTitle, wideButton] = await Promise.all([heading.boundingBox(), remove.boundingBox()]);
  expect(wideButton?.x ?? 0, '1280px — 버튼은 제목 옆이다').toBeGreaterThanOrEqual((wideTitle?.x ?? 0) + (wideTitle?.width ?? 0));
  expect(wideButton?.y ?? 0, '1280px — 버튼은 제목과 같은 높이에서 시작한다').toBeLessThan((wideTitle?.y ?? 0) + (wideTitle?.height ?? 0));
});

/** 요소 안의 글자가 몇 줄에 걸쳐 그려졌는가 — 글자의 줄 상자 위치를 센다. */
const linesOf = (target: Locator) =>
  target.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size;
  });

test('회원 목록 — 역할과 상태 배지가 낱말 안에서 줄을 바꾸지 않는다. 긴 이메일은 칸 안에서 줄을 바꾼다', async ({ page, api }) => {
  // 표 머리·버튼은 e2e/screens.spec.ts 의 쪼개진 낱말 검사가 보지만 표의 칸은 라벨 자리가 아니라 그 검사 밖이다.
  await api.login(ADMIN);
  await page.goto('/admin/members');
  const main = page.getByRole('main');
  await expect(main.getByText('프로필 없음').first()).toBeVisible();
  const table = main.getByRole('table');
  const list = main.getByRole('list');

  for (const width of [360, 640, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const view = width >= TABLE_FROM ? table : list;
    await expect(view).toBeVisible();
    // 상태 칸에 배지 셋(인증됨·잠김·탈퇴)이 모이는 줄과 「미인증」 이 있는 줄, 역할 「관리자」 다. 닉네임은 그 낱말과 겹치지 않게 둔다(e2e/api.ts).
    for (const word of ['관리자', '인증됨', '잠김', '탈퇴', '미인증']) {
      for (const target of await view.getByText(word, { exact: true }).all()) {
        expect.soft(await linesOf(target), `${width}px — 「${word}」 가 한 줄인가`).toBe(1);
      }
    }
    const email = view.getByText(EMAIL, { exact: true });
    const [box, cell] = await Promise.all([email.boundingBox(), main.boundingBox()]);
    expect.soft((box?.x ?? 0) + (box?.width ?? 0), `${width}px — 이메일이 본문 폭 안인가`).toBeLessThanOrEqual(
      (cell?.x ?? 0) + (cell?.width ?? 0) + 0.5,
    );
  }
});
