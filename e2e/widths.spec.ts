import { expect, test } from './fixtures.ts';

/**
 * 좁은 폭에서 자리를 어떻게 나누는가. 가로 스크롤과 쪼개진 낱말은 e2e/screens.spec.ts 가 라우트마다 보지만, **칸이 좁아져 제목을
 * 읽기 어려운 것은 둘 다 잡지 못한다** — 넘치지도 않고 라벨도 아니다.
 */

/** 글 목록이 표로 바뀌는 폭 — Tailwind 의 `md` 다(src/components/PostTable.tsx). */
const TABLE_FROM = 768;
/** 표의 제목 칸이 이보다 좁으면 제목이 몇 글자씩 줄을 바꾼다. */
const TITLE_CELL_MIN = 200;

test('글 목록 — 표가 보이는 폭마다 제목 칸이 넓고, 그보다 좁으면 줄 목록이다', async ({ page }) => {
  await page.goto('/posts');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: '짧은 글' }).first()).toBeVisible();
  const table = main.getByRole('table');
  const list = main.getByRole('list');

  for (const width of [360, 640, 767, 768, 1024, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    const isTable = await table.isVisible();
    expect.soft(isTable, `${width}px — 표인가`).toBe(width >= TABLE_FROM);
    expect.soft(await list.isVisible(), `${width}px — 줄 목록인가`).toBe(width < TABLE_FROM);
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
