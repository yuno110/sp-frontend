// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 색 토큰의 대비 (WCAG AA 4.5:1, CLAUDE.md 「접근성과 반응형」). 브라우저 테스트의 axe 는 프로덕션 화면에 그려진 글자만 잰다 —
 * 개발 빌드에서만 그리는 화면(`warn` 을 쓰는 `/tokens` 와 요청 기록 패널)과 hover 는 재지 못한다. 그래서 값을 파일에서 읽어
 * 계산한다.
 *
 * 파일을 직접 읽는다 — vitest 는 CSS 를 비워서 싣는다(`./index.css?raw` 도 빈 문자열이었다).
 */
const SRC = path.join(import.meta.dirname, 'src');

/** `src/index.css` 의 `--color-*` 값. */
const COLORS: Record<string, string> = Object.fromEntries(
  [...readFileSync(path.join(SRC, 'index.css'), 'utf8').matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})\b/g)].map((m) => [m[1], m[2]]),
);

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};

/** WCAG 2.x 의 대비. */
const contrast = (a: string, b: string) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

const WHITE = '#ffffff';
const AA = 4.5;

/** 글자가 놓이는 면. */
const SURFACES = ['app', 'elev', 'subtle', 'accent-50', 'danger-50', 'success-50', 'warn-50'];

/** 어느 면 위에서나 글자로 쓸 수 있는 토큰 — 글자 토큰과 상태 색의 글자. */
const TEXT = ['default', 'muted', 'faint', 'accent-600', 'accent-700', 'danger-600', 'success-600', 'warn-600'];

/**
 * 정해진 면 위에서만 글자로 쓰는 토큰 — 다른 면 위에서는 4.5:1 에 모자라므로 쓰는 곳을 적는다. `accent-500` 은 글자로 쓰지 않는다
 * (입력칸의 포커스 선이다).
 */
const TEXT_ON_ONE_SURFACE = [['danger-500', 'elev', '댓글 삭제 버튼의 hover — 댓글 칸은 elev 다']] as const;

/** 버튼 — 흰 글자가 놓이는 면(components/ui.tsx 의 `BUTTON`). */
const BUTTON_SURFACES = ['accent-600', 'accent-700', 'danger-500', 'danger-600'];

describe('계산', () => {
  it('값을 파일에서 읽었다 — 위 목록의 토큰이 모두 있다', () => {
    const named = [...SURFACES, ...TEXT, ...BUTTON_SURFACES, ...TEXT_ON_ONE_SURFACE.map(([text]) => text)];
    expect(named.filter((name) => !COLORS[name])).toEqual([]);
  });

  it('양성 대조 — WCAG 의 알려진 값과 같고 4.5:1 에 모자라는 쌍을 가른다', () => {
    expect(contrast('#000000', WHITE)).toBeCloseTo(21, 5);
    expect(contrast(WHITE, WHITE)).toBeCloseTo(1, 5);
    expect(contrast('#777777', WHITE)).toBeLessThan(AA);
    expect(contrast('#767676', WHITE)).toBeGreaterThanOrEqual(AA);
    // 이 값을 고치기 전의 `warn-600` — `warn-50` 위에서 모자랐다.
    expect(contrast('#a56a0b', COLORS['warn-50'])).toBeLessThan(AA);
  });
});

describe('글자와 면', () => {
  it.each(TEXT.flatMap((text) => SURFACES.map((surface) => [text, surface])))('%s 글자 — %s 면 위에서 4.5:1 이상이다', (text, surface) => {
    expect(contrast(COLORS[text], COLORS[surface])).toBeGreaterThanOrEqual(AA);
  });

  it.each(TEXT_ON_ONE_SURFACE)('%s 글자 — %s 면 위에서 4.5:1 이상이다 (%s)', (text, surface) => {
    expect(contrast(COLORS[text], COLORS[surface])).toBeGreaterThanOrEqual(AA);
  });

  it.each(BUTTON_SURFACES)('흰 글자 — %s 면 위에서 4.5:1 이상이다', (surface) => {
    expect(contrast(WHITE, COLORS[surface])).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * 위 목록이 전수인가 — 화면 코드(개발 전용 화면 포함)의 `text-`·`bg-` 클래스에서 `src/index.css` 의 색 토큰과 흰색을 모아 위 목록에
 * 없는 것이 없는지 본다. 없으면 새 토큰이 계산을 지나지 않고 들어온다. 흰색을 뺀 Tailwind 기본 팔레트의 클래스(`text-red-500`)는 세지
 * 않는다.
 *
 * 조합은 문자열 하나에 함께 쓴 글자와 면만 잰다. 글자가 놓이는 면은 대개 조상 요소에 있어 소스에서 읽히지 않는다 — 면을 정해 둔
 * 글자(`TEXT_ON_ONE_SURFACE`, 흰 글자)를 다른 면의 조상 아래에 두는 것은 여기서 걸리지 않는다.
 */
describe('화면 코드가 쓰는 색 클래스', () => {
  const sources = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((file) => file.endsWith('.tsx') && !file.endsWith('.test.tsx'))
    .map((file) => readFileSync(path.join(SRC, file), 'utf8'));

  const tokensIn = (text: string, prefix: 'text' | 'bg') =>
    [...text.matchAll(new RegExp(`\\b${prefix}-([a-z]+(?:-\\d+)?)\\b`, 'g'))]
      .map((m) => m[1])
      .filter((token) => COLORS[token] || token === 'white');

  const used = (prefix: 'text' | 'bg') => [...new Set(sources.flatMap((source) => tokensIn(source, prefix)))].sort();

  /** 문자열 리터럴 하나에 함께 쓴 [글자, 면]. */
  const pairsIn = (source: string) =>
    [...source.matchAll(/(["'`])([^"'`\n]*)\1/g)].flatMap(([, , literal]) =>
      tokensIn(literal, 'text').flatMap((text) => tokensIn(literal, 'bg').map((surface) => [text, surface])),
    );

  const hexOf = (token: string) => (token === 'white' ? WHITE : COLORS[token]);
  const belowAA = (pairs: string[][]) => pairs.filter(([text, surface]) => contrast(hexOf(text), hexOf(surface)) < AA);

  it('화면 코드를 읽었다 — 양성 대조로 흔한 클래스가 잡힌다', () => {
    expect(sources.length).toBeGreaterThan(5);
    expect(used('text')).toEqual(expect.arrayContaining(['default', 'muted', 'faint', 'white']));
    expect(used('bg')).toEqual(expect.arrayContaining(['elev', 'subtle', 'danger-50']));
  });

  it('글자', () => {
    const known: string[] = [...TEXT, ...TEXT_ON_ONE_SURFACE.map(([text]) => text), 'white'];
    expect(used('text').filter((token) => !known.includes(token))).toEqual([]);
  });

  it('면', () => {
    const known = [...SURFACES, ...BUTTON_SURFACES];
    expect(used('bg').filter((token) => !known.includes(token))).toEqual([]);
  });

  it('조합 — 양성 대조로 화면 코드의 쌍이 잡히고, 모자라는 쌍을 가른다', () => {
    expect(sources.flatMap(pairsIn)).toEqual(
      expect.arrayContaining([
        ['white', 'accent-600'],
        ['white', 'danger-500'],
        ['default', 'elev'],
      ]),
    );
    expect(belowAA(pairsIn(`className="text-danger-500 bg-subtle"`))).toEqual([['danger-500', 'subtle']]);
    expect(belowAA(pairsIn(`'bg-elev text-white'`))).toEqual([['white', 'elev']]);
    expect(belowAA(pairsIn(`'bg-elev text-default hover:bg-subtle'`))).toEqual([]);
  });

  it('조합 — 문자열 하나에 함께 쓴 글자와 면은 4.5:1 이상이다', () => {
    expect(belowAA(sources.flatMap(pairsIn))).toEqual([]);
  });
});
