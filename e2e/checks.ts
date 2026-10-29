import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page } from '@playwright/test';

/**
 * F-05 의 검사들(sp-docs/plan/phase2.md §7.2 F-05). 검사마다 위반을 일부러 만든 화면에서 잡히는 것을 e2e/controls.spec.ts 가
 * 보인다 — 아무것도 잡지 못하는 검사는 "위반이 없다" 를 검사가 틀려도 낸다.
 */

export interface AxeFinding {
  id: string;
  impact: string;
  /** 걸린 요소 — 선택자와 마크업 앞부분. */
  nodes: string[];
}

/** axe-core 의 serious·critical 위반. 규칙은 axe 의 기본값 그대로이고 영향도로만 거른다. */
export async function seriousAxe(page: Page): Promise<AxeFinding[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? '',
      nodes: v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 100)}`),
    }));
}

export interface Overflow {
  where: string;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * 가로로 스크롤되는 자리 — 문서와 **스크롤 컨테이너**(가로 `overflow` 가 `auto`·`scroll` 인 요소)다. 본문을 감싼 `main` 이
 * 스크롤 컨테이너라 본문이 넘치면 문서가 아니라 그 안에서 스크롤된다(src/components/Layout.tsx) — 문서만 재면 놓친다.
 */
export function horizontalOverflow(page: Page): Promise<Overflow[]> {
  return page.evaluate(() => {
    const found: Overflow[] = [];
    const doc = document.scrollingElement ?? document.documentElement;
    if (doc.scrollWidth > doc.clientWidth) {
      found.push({ where: '문서', scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth });
    }
    for (const el of document.body.querySelectorAll('*')) {
      const { overflowX } = getComputedStyle(el);
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth) {
        const name = el.tagName.toLowerCase() + (el.className ? `.${String(el.className).split(' ').join('.')}` : '');
        found.push({ where: name, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      }
    }
    return found;
  });
}

/**
 * 라벨 자리 — 머리글, 버튼, 표 머리, 입력칸 라벨 — 에서 낱말 가운데서 줄이 바뀐 낱말. 한글은 음절 사이에서 줄을 바꿀 수 있어
 * 자리가 모자라면 "마이페이지" 가 한 글자씩 세로로 선다 — 가로 스크롤은 없어도 읽을 수 없다. 낱말마다 그 글자 범위가 몇 줄에
 * 걸쳤는지 센다. 사용자가 쓴 글(제목·본문)은 넣지 않는다 — 긴 낱말은 줄을 바꿔야 넘치지 않는다.
 */
export function brokenWords(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scopes = [document.querySelector('#root header'), ...document.querySelectorAll('button, th, label')];
    const broken = new Set<string>();
    for (const scope of scopes) {
      if (!scope) continue;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const word of (node.nodeValue ?? '').matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, word.index);
          range.setEnd(node, word.index + word[0].length);
          const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
          if (lines.size > 1) broken.add(word[0]);
        }
      }
    }
    return [...broken];
  });
}

/**
 * CSP 위반을 모은다 — 콘솔의 위반 메시지와 `securitypolicyviolation` 이벤트 둘로. 이벤트는 문서마다 따로 나므로 바인딩으로
 * 테스트 쪽에 모은다 — 화면을 옮겨도 남는다. 둘 다 CSP 가 막지 않는 길로 들어간다(초기화 스크립트와 바인딩은 브라우저가 넣는다).
 */
export class CspWatch {
  private readonly console: string[] = [];
  private readonly events: string[] = [];

  static async start(page: Page): Promise<CspWatch> {
    const watch = new CspWatch();
    page.on('console', (message) => {
      if (/Content Security Policy/.test(message.text())) watch.console.push(message.text());
    });
    await page.exposeBinding('__reportCspViolation', (_source, violation: string) => {
      watch.events.push(violation);
    });
    await page.addInitScript(() => {
      document.addEventListener(
        'securitypolicyviolation',
        (e) => {
          const report = (window as unknown as { __reportCspViolation: (v: string) => void }).__reportCspViolation;
          report(`${e.violatedDirective} ${e.blockedURI}`);
        },
        true,
      );
    });
    return watch;
  }

  /** 지금까지 모은 것. */
  seen(): { console: string[]; events: string[] } {
    return { console: [...this.console], events: [...this.events] };
  }

  /** 지금까지 모은 것을 꺼내고 비운다. */
  take(): { console: string[]; events: string[] } {
    const taken = this.seen();
    this.console.length = 0;
    this.events.length = 0;
    return taken;
  }
}

/** 그려지는 `outline`·`box-shadow`. */
export interface Ring {
  outline: string;
  boxShadow: string;
}

export interface FocusStep {
  element: string;
  before: Ring | null;
  after: Ring;
}

/**
 * 요소에 그려지는 `outline`·`box-shadow` 를 계산값에서 읽는 함수를 문서에 둔다. **그려지지 않는 값은 `none` 으로 읽는다** —
 * `outline-style` 이 `none` 이면 계산된 `outline` 의 색이 바뀌어도 보이는 것이 없다. 포커스될 때 `outline-style` 만 `none` 으로
 * 둔 입력칸(F-05 전 화면)은 브라우저의 포커스 색만 바뀌어 계산값 문자열이 달라졌다(F-05 측정) — 문자열을 그대로 견주면 그것을
 * 표시로 읽는다. 투명하거나 길이가 모두 0 인 그림자도 그려지지 않는다.
 */
function installRing(page: Page): Promise<void> {
  return page.evaluate(() => {
    const TRANSPARENT = 'rgba(0, 0, 0, 0)';
    const ring = (el: Element) => {
      const s = getComputedStyle(el);
      const outline =
        s.outlineStyle === 'none' || s.outlineWidth === '0px' || s.outlineColor === TRANSPARENT
          ? 'none'
          : `${s.outlineColor} ${s.outlineStyle} ${s.outlineWidth} ${s.outlineOffset}`;
      const shadows = s.boxShadow === 'none' ? [] : s.boxShadow.split(/,(?![^(]*\))/).map((shadow) => shadow.trim());
      const drawn = shadows.filter((shadow) => {
        const color = shadow.match(/^(?:rgba?\([^)]*\)|[a-z]+)/)?.[0] ?? '';
        return color !== TRANSPARENT && !/^0px 0px 0px 0px\b/.test(shadow.slice(color.length).trim());
      });
      return { outline, boxShadow: drawn.length > 0 ? drawn.join(', ') : 'none' };
    };
    (window as unknown as { __ring: typeof ring }).__ring = ring;
  });
}

/**
 * Tab 을 한 번 누르고 포커스가 옮겨 간 요소를 돌려준다. 누르기 전에 모든 요소의 그려지는 `outline`·`box-shadow` 를 적어 두고,
 * 옮겨 간 요소의 지금 값과 견줄 수 있게 한다. 마우스는 쓰지 않으므로 hover 가 섞이지 않는다.
 */
export async function pressTab(page: Page): Promise<FocusStep> {
  await installRing(page);
  await page.evaluate(() => {
    const w = window as unknown as { __ring: (el: Element) => Ring; __unfocused: Map<Element, Ring> };
    w.__unfocused = new Map([...document.querySelectorAll('*')].map((el) => [el, w.__ring(el)]));
  });
  await page.keyboard.press('Tab');
  return page.evaluate(() => {
    const w = window as unknown as { __ring: (el: Element) => Ring; __unfocused: Map<Element, Ring> };
    const el = document.activeElement ?? document.body;
    const label =
      el.getAttribute('aria-label') ??
      ((el as HTMLInputElement).labels?.[0]?.textContent || (el as HTMLElement).innerText || '').trim().slice(0, 30);
    return {
      element: `${el.tagName.toLowerCase()} "${label}"`,
      before: w.__unfocused.get(el) ?? null,
      after: w.__ring(el),
    };
  });
}

/** 포커스 표시가 보이는가 — 포커스된 요소의 `outline`·`box-shadow` 가 포커스 전과 다르다. */
export const focusVisible = (step: FocusStep): boolean =>
  step.before !== null &&
  (step.before.outline !== step.after.outline || step.before.boxShadow !== step.after.boxShadow);

/**
 * `target` 에 포커스가 갈 때까지 Tab 을 누른다. 지나는 요소마다 포커스 표시가 보여야 한다 — 하나라도 안 보이면 거기서 멈춘다.
 * 지난 요소들을 돌려준다.
 */
export async function tabTo(page: Page, target: Locator, limit = 30): Promise<FocusStep[]> {
  await expect(target, 'Tab 으로 닿을 요소').toBeAttached();
  const steps: FocusStep[] = [];
  for (let i = 0; i < limit; i++) {
    const step = await pressTab(page);
    steps.push(step);
    if (!focusVisible(step)) {
      throw new Error(`포커스 표시가 없다 — ${step.element}: ${JSON.stringify(step.before)} → ${JSON.stringify(step.after)}`);
    }
    if (await target.evaluate((el) => el === document.activeElement)) return steps;
  }
  throw new Error(`Tab 을 ${limit}번 눌러도 닿지 않았다 — 지난 요소: ${steps.map((s) => s.element).join(' → ')}`);
}
