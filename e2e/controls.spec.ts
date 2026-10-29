import { MY_PROFILE, NICKNAME } from './api.ts';
import { brokenWords, focusVisible, horizontalOverflow, pressTab, seriousAxe, tabTo } from './checks.ts';
import { expect, test } from './fixtures.ts';

/**
 * 양성 대조 — 검사마다 위반을 일부러 만든 화면에서 그 위반이 잡히는 것을 보인다(sp-docs/process/review-policy.md §4.1 의
 * "0 을 믿기 전에 패턴의 양성 대조를 세운다"). 위반은 화면을 연 뒤 DOM·CSSOM 으로 넣는다 — 빌드의 CSP 는 그 길을 막지 않는다.
 * 넣기 전에는 그 검사가 깨끗한 것을 먼저 보인다 — 잡힌 것이 넣은 위반이라는 뜻이다.
 */

test.beforeEach(async ({ page }) => {
  await page.goto(`/members/${MY_PROFILE.accountId}`);
  await expect(page.getByRole('main').getByText(NICKNAME)).toBeVisible();
});

test('axe — 라벨 없는 입력칸(critical)과 대비가 낮은 글자(serious)를 잡는다', async ({ page }) => {
  expect(await seriousAxe(page)).toEqual([]);
  await page.evaluate(() => {
    const where = document.querySelector('main')!;
    where.append(document.createElement('input'));
    const faint = document.createElement('p');
    faint.textContent = '거의 보이지 않는 글자';
    faint.style.color = '#dddddd';
    where.append(faint);
  });
  const found = await seriousAxe(page);
  expect(found.map((f) => [f.id, f.impact])).toEqual(
    expect.arrayContaining([
      ['label', 'critical'],
      ['color-contrast', 'serious'],
    ]),
  );
});

test('가로 스크롤 — 본문 안의 넓은 요소는 문서가 아니라 스크롤 컨테이너에서 잡힌다', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await horizontalOverflow(page)).toEqual([]);
  await page.evaluate(() => {
    const wide = document.createElement('div');
    wide.style.width = '600px';
    wide.textContent = '넓은 요소';
    document.querySelector('main')!.firstElementChild!.append(wide);
  });
  const found = await horizontalOverflow(page);
  expect(found.map((f) => f.where.split('.')[0])).toEqual(['main']);
});

test('가로 스크롤 — 본문 밖의 넓은 요소는 문서에서 잡힌다', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await horizontalOverflow(page)).toEqual([]);
  await page.evaluate(() => {
    const wide = document.createElement('div');
    wide.style.width = '600px';
    wide.textContent = '넓은 요소';
    document.body.append(wide);
  });
  const found = await horizontalOverflow(page);
  expect(found.map((f) => f.where)).toEqual(['문서']);
});

test('쪼개진 낱말 — 좁은 버튼에서 줄이 바뀐 낱말을 잡는다', async ({ page }) => {
  expect(await brokenWords(page)).toEqual([]);
  await page.evaluate(() => {
    const narrow = document.createElement('button');
    narrow.style.width = '40px';
    narrow.textContent = '마이페이지 로그아웃';
    document.querySelector('main')!.append(narrow);
  });
  expect(await brokenWords(page)).toEqual(['마이페이지', '로그아웃']);
});

test('포커스 — 포커스 표시를 지운 스타일에서는 실패한다', async ({ page }) => {
  expect(focusVisible(await pressTab(page))).toBe(true);

  // `outline-style` 만 지운다 — F-05 전 입력칸의 모양이다. 브라우저의 포커스 색은 남아 계산값 문자열이 바뀐다.
  await page.evaluate(() => {
    const sheet = document.styleSheets[0];
    sheet.insertRule('*:focus { outline-style: none !important; box-shadow: none !important; }', sheet.cssRules.length);
  });
  expect(focusVisible(await pressTab(page))).toBe(false);
  await expect(tabTo(page, page.getByRole('main').getByRole('link', { name: '목록으로' }))).rejects.toThrow(
    /포커스 표시가 없다/,
  );
});

test('CSP — 인라인 스크립트와 허용하지 않은 주소로의 연결을 콘솔과 이벤트로 잡는다', async ({ page, csp }) => {
  // 프로덕션 빌드를 재고 있다는 것 — CSP 는 빌드의 index.html 에만 있다(csp.ts).
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1);
  expect(csp.seen()).toEqual({ console: [], events: [] });

  const ran = await page.evaluate(async () => {
    const script = document.createElement('script');
    script.textContent = 'window.__inlineRan = true';
    document.head.append(script);
    await fetch('http://localhost:9/').catch(() => null);
    return (window as unknown as { __inlineRan?: boolean }).__inlineRan ?? false;
  });
  expect(ran).toBe(false);

  await expect.poll(() => csp.seen().events.length).toBe(2);
  const { console: messages, events } = csp.take();
  expect(messages).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/inline script.*script-src/i),
      expect.stringMatching(/connect.*localhost:9.*connect-src/i),
    ]),
  );
  expect(events).toEqual([expect.stringMatching(/^script-src.* inline$/), expect.stringMatching(/^connect-src http:\/\/localhost:9/)]);
});
