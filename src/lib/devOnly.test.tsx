import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 개발 전용 표시는 개발 빌드에서만 그린다 (sp-docs/plan/phase2.md §7.2 F-01).
 *
 * **프로덕션 모드는 `vi.stubEnv` 로 흉내낸다.** `DEV_ONLY` 는 모듈을 읽을 때 정해지므로 흉내를
 * 건 뒤 `vi.resetModules()` 로 모듈을 새로 읽는다 — 정적 import 로 읽은 모듈은 흉내 전의 값을
 * 쥐고 있다. 흉내가 실제로 `DEV_ONLY` 에 닿는지는 첫 describe 가 본다.
 *
 * 프로덕션 빌드 산출물에서 문자열이 빠지는지는 여기서 보지 않는다 — 그것은 `dist/` 를 검색해 잰다.
 */

const ACCOUNT_ID = 7;
const ROLE = 'USER';
const WRITER_ID = 12;

/**
 * 검사 목록 — 정본 인용과 토큰 claim 을 **성질로** 잡는다(phase2.md §7.2 「범위는 성질로 정한다」).
 * 같은 목록이 개발 모드의 같은 화면에서 잡히는 것이 양성 대조다. 그것이 없으면 프로덕션 쪽의
 * "걸리는 것이 없다" 는 목록이 틀려도 나온다.
 */
const MARKS: RegExp[] = [
  /[\w-]+\.md\b/, // 정본 문서 (api-contract.md · security.md …)
  /\badr\/\d+/, // ADR
  /§\s*\d/, // 절
  /\b(sub|role|exp|iss)\b/, // claim 이름
  new RegExp(`\\b${ROLE}\\b`), // claim 값 — 아래 토큰의 role
];

const marksIn = (el: Element | null) =>
  MARKS.filter((re) => re.test(el?.textContent ?? '')).map(String);

/** 서명은 검증하지 않으므로(lib/jwt.ts) payload 만 맞으면 된다. */
const ACCESS_TOKEN = [
  btoa(JSON.stringify({ alg: 'RS256' })),
  btoa(
    JSON.stringify({
      sub: String(ACCOUNT_ID),
      role: ROLE,
      exp: Math.floor(Date.now() / 1000) + 1800,
    }),
  ),
  'signature',
].join('.');

const EMPTY_PAGE = {
  content: [],
  page: 0,
  size: 10,
  totalElements: 0,
  totalPages: 0,
  first: true,
  last: true,
};

const RESPONSES: Record<string, unknown> = {
  '/api/v1/members/me': { accountId: ACCOUNT_ID, nickname: '테스트닉' },
  '/api/v1/accounts/me': { email: 'user@example.com', createdAt: '2026-10-27T10:00:00' },
  '/api/v1/posts': EMPTY_PAGE,
  '/api/v1/posts/1': {
    id: 1,
    title: '첫 글',
    writerId: WRITER_ID,
    writerNickname: '작성자',
    viewCount: 3,
    commentCount: 0,
    createdAt: '2026-10-27T09:00:00',
    content: '본문',
  },
  '/api/v1/posts/1/comments': EMPTY_PAGE,
};

/** 실패 응답이 필요한 경로. 인터셉터는 `error.response` 를 읽으므로 응답을 실은 AxiosError 로 던진다. */
const MISSING_POST = '/api/v1/posts/404';

async function adapter(config: InternalAxiosRequestConfig) {
  const url = config.url ?? '';
  if (url === MISSING_POST) {
    const data = {
      success: false,
      data: null,
      error: { code: 'P001', message: '없다', fieldErrors: [] },
    };
    const response = { data, status: 404, statusText: 'Not Found', headers: {}, config };
    throw new AxiosError('status 404', AxiosError.ERR_BAD_REQUEST, config, null, response);
  }
  // 정해 두지 않은 경로는 조용히 넘기지 않는다 — 그 화면은 아래의 대기에서 멈춰 실패한다.
  if (!(url in RESPONSES)) throw new Error(`스텁에 없는 경로: ${url}`);
  return {
    data: { success: true, data: RESPONSES[url], error: null },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  };
}

type Mode = 'dev' | 'prod';

/** 모드를 흉내낸 뒤 모듈을 새로 읽는다. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function load(mode: Mode, path = '/') {
  vi.stubEnv('DEV', mode === 'dev');
  vi.stubEnv('PROD', mode === 'prod');
  vi.resetModules();
  window.history.replaceState(null, '', path);
  const { default: http } = await import('@/lib/api/client');
  http.defaults.adapter = adapter as never;
  const { useAuthStore } = await import('@/stores/authStore');
  const { useApiLogStore } = await import('@/stores/apiLogStore');
  return { http, useAuthStore, useApiLogStore };
}

let disposeRouter: (() => void) | null = null;

async function renderApp(mode: Mode, path: string, { loggedIn }: { loggedIn: boolean }) {
  const { useAuthStore } = await load(mode, path);
  if (loggedIn) {
    useAuthStore.getState().setTokens({
      grantType: 'Bearer',
      accessToken: ACCESS_TOKEN,
      refreshToken: 'RT-1',
      accessTokenExpiresIn: 1800,
    });
  }
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  const { App } = await import('@/App');
  render(<App />);
}

/** 머리글 — 상표 링크를 품은 `header`. 패널 제목도 `header` 라서 태그만으로 찾지 않는다. */
const banner = () => screen.getByRole('link', { name: 'sp-frontend' }).closest('header');
const main = () => document.querySelector('main');

/** 없다는 단언은 화면이 다 그려진 뒤에 한다. 그리기 전이면 무엇이든 없다. */
const until = (el: () => Element | null, texts: string[]) =>
  waitFor(() => {
    for (const text of texts) expect(el()).toHaveTextContent(text);
  });

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  disposeRouter?.();
  disposeRouter = null;
  vi.unstubAllEnvs();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('흉내가 DEV_ONLY 에 닿는다', () => {
  it.each([
    ['prod', false],
    ['dev', true],
  ] as const)('%s 모드 → %s', async (mode, expected) => {
    await load(mode);
    const { DEV_ONLY } = await import('@/lib/devOnly');
    expect(DEV_ONLY).toBe(expected);
  });
});

describe('머리글', () => {
  it('프로덕션 모드 — 확인용 배지·claim·토큰 실험 링크·요청 기록 패널이 없다', async () => {
    await renderApp('prod', '/posts', { loggedIn: true });
    await until(banner, ['테스트닉']);
    await until(main, ['등록된 게시글이 없다']);

    expect(screen.queryByText('백엔드 확인용 화면')).toBeNull();
    expect(marksIn(banner())).toEqual([]);
    expect(screen.queryByRole('link', { name: '토큰 실험' })).toBeNull();
    expect(document.querySelector('aside')).toBeNull();
    expect(screen.queryByText(/요청 기록/)).toBeNull();
  });

  it('개발 모드 — 배지만 없고 나머지는 있다', async () => {
    await renderApp('dev', '/posts', { loggedIn: true });
    await until(banner, ['테스트닉']);
    await until(main, ['등록된 게시글이 없다']);

    expect(screen.queryByText('백엔드 확인용 화면')).toBeNull();
    expect(marksIn(banner())).not.toEqual([]);
    expect(banner()).toHaveTextContent(`sub ${ACCOUNT_ID} · ${ROLE} · exp`);
    expect(screen.getByRole('link', { name: '토큰 실험' })).toBeInTheDocument();
    expect(document.querySelector('aside')).toHaveTextContent('요청 기록');
  });
});

/**
 * 정본 인용·claim 표시를 가진 화면. `ready` 는 그 화면이 응답까지 그린 뒤에야 보이는 문구이고,
 * `devOnly` 는 개발 모드에서 그 자리에 있어야 하는 표시다.
 */
describe.each([
  {
    screenName: '마이페이지',
    path: '/me',
    loggedIn: true,
    ready: ['user@example.com', '테스트닉'],
    devOnly: ['sub / role', `${ACCOUNT_ID} / ${ROLE}`, 'adr/0003', 'security.md §5.3'],
  },
  {
    screenName: '글 상세',
    path: '/posts/1',
    loggedIn: true,
    ready: ['첫 글', '댓글이 없다'],
    devOnly: [`· sub ${WRITER_ID} ·`],
  },
  {
    screenName: '로그인',
    path: '/login',
    loggedIn: false,
    ready: ['계정이 없으면 가입.'],
    devOnly: ['api-contract.md §9.1'],
  },
  {
    screenName: '가입 3단계',
    path: '/signup/profile',
    loggedIn: true,
    ready: ['3단계 — 프로필 등록'],
    devOnly: [`sub (= ${ACCOUNT_ID})`],
  },
])('$screenName', ({ path, loggedIn, ready, devOnly }) => {
  it('프로덕션 모드 — 정본 인용·claim 표시가 없다', async () => {
    await renderApp('prod', path, { loggedIn });
    await until(main, ready);

    expect(marksIn(main())).toEqual([]);
  });

  it('개발 모드 — 같은 검사 목록에 걸리고 표시가 그대로 있다', async () => {
    await renderApp('dev', path, { loggedIn });
    await until(main, ready);

    expect(marksIn(main())).not.toEqual([]);
    for (const text of devOnly) expect(main()).toHaveTextContent(text);
  });
});

describe('/tokens', () => {
  it('프로덕션 모드 — 목록으로 간다', async () => {
    await renderApp('prod', '/tokens', { loggedIn: true });

    await waitFor(() => expect(window.location.pathname).toBe('/posts'));
    expect(await screen.findByRole('heading', { name: '게시판' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '토큰 실험' })).toBeNull();
  });

  it('개발 모드 — 토큰 실험 화면이다', async () => {
    await renderApp('dev', '/tokens', { loggedIn: true });

    expect(await screen.findByRole('heading', { name: '토큰 실험' })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/tokens');
  });
});

describe('요청 기록', () => {
  it('프로덕션 모드 — 성공한 요청도 실패한 요청도 저장소에 쓰지 않는다', async () => {
    const { http, useApiLogStore } = await load('prod');

    await http.get('/api/v1/posts');
    await expect(http.get(MISSING_POST)).rejects.toThrow();

    expect(useApiLogStore.getState().entries).toEqual([]);
  });

  it('개발 모드 — 같은 두 요청이 기록된다', async () => {
    const { http, useApiLogStore } = await load('dev');

    await http.get('/api/v1/posts');
    await expect(http.get(MISSING_POST)).rejects.toThrow();

    expect(useApiLogStore.getState().entries.map((e) => [e.path, e.status, e.code])).toEqual([
      [MISSING_POST, 404, 'P001'],
      ['/api/v1/posts', 200, null],
    ]);
  });
});
