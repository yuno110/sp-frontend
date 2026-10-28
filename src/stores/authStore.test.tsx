import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 토큰 보관과 새로고침 뒤의 세션 복원 (sp-docs/plan/phase2.md §7.2 F-02).
 *
 * **새로고침은 모듈을 새로 읽는 것으로 흉내낸다.** 스토어는 모듈을 읽을 때 영속 저장소를 읽으므로,
 * 앞 페이지에서 로그인한 뒤 `vi.resetModules()` 로 다시 읽으면 메모리(Access Token)는 사라지고
 * 영속 저장소만 남는다. 그래서 테스트가 영속 키의 이름을 알 필요가 없다.
 *
 * 요청은 axios 의 기본 어댑터를 바꿔 받는다. 재발급은 재시도 인터셉터가 없는 별도 인스턴스로 나가므로
 * (lib/api/client.ts) 인스턴스가 만들어지기 전에 기본값을 바꿔야 모든 인스턴스가 이 어댑터를 쓴다.
 * 화면은 `main.tsx` 처럼 StrictMode 로 그린다 — 효과가 두 번 실행된다.
 */

const EXP = Math.floor(Date.now() / 1000) + 1800;

/** 서명은 검증하지 않으므로(lib/jwt.ts) payload 만 맞으면 된다. `tag` 로 발급마다 다른 값을 만든다. */
const accessToken = (tag: string) =>
  [
    btoa(JSON.stringify({ alg: 'RS256' })),
    btoa(JSON.stringify({ sub: '7', role: 'USER', exp: EXP, tag })),
    'signature',
  ].join('.');

const tokens = (tag: string) => ({
  grantType: 'Bearer',
  accessToken: accessToken(tag),
  refreshToken: `RT-${tag}`,
  accessTokenExpiresIn: 1800,
});

const EMPTY_PAGE = {
  content: [],
  page: 0,
  size: 10,
  totalElements: 0,
  totalPages: 0,
  first: true,
  last: true,
};
const PROFILE = { accountId: 7, nickname: '테스트닉' };
const ACCOUNT = { email: 'user@example.com', createdAt: '2026-10-27T10:00:00' };

const ok = (data: unknown) => ({ success: true, data, error: null });

/** 인터셉터는 `error.response` 를 읽으므로 응답을 실은 AxiosError 로 던진다. */
function fail(config: InternalAxiosRequestConfig, status: number, code: string): never {
  const data = { success: false, data: null, error: { code, message: code, fieldErrors: [] } };
  const response = { data, status, statusText: '', headers: {}, config } as AxiosResponse;
  throw new AxiosError(`status ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
}

/** 응답이 없는 실패 — axios 가 연결 거부·타임아웃에 내는 모양이다(`response` 가 없다). */
function noResponse(config: InternalAxiosRequestConfig, code: string): never {
  throw new AxiosError('no response', code, config, {});
}

type Handler = (config: InternalAxiosRequestConfig) => unknown;

/** `METHOD 경로` → 응답 본문. 정해 두지 않은 요청은 조용히 넘기지 않는다. */
let routes: Record<string, Handler> = {};
const requests: Array<{ key: string; auth: unknown; body: unknown }> = [];
const REISSUE = 'POST /api/v1/auth/reissue';
const reissues = () => requests.filter((r) => r.key === REISSUE);

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push({
    key,
    auth: config.headers?.Authorization ?? null,
    body: typeof config.data === 'string' ? JSON.parse(config.data) : null,
  });
  const handler = routes[key];
  if (!handler) throw new Error(`스텁에 없는 요청: ${key}`);
  return { data: await handler(config), status: 200, statusText: 'OK', headers: {}, config };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** 영속 저장소에 남은 값 전부. */
const stored = () =>
  [sessionStorage, localStorage].flatMap((s) =>
    Array.from({ length: s.length }, (_, i) => s.getItem(s.key(i)!)),
  );

let restoreAdapter: (() => void) | null = null;
let disposeRouter: (() => void) | null = null;

/** 페이지 하나를 연다 — 모듈을 새로 읽는다. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function load(path = '/') {
  vi.resetModules();
  window.history.replaceState(null, '', path);
  const { default: axios } = await import('axios');
  const original = axios.defaults.adapter;
  restoreAdapter ??= () => {
    axios.defaults.adapter = original;
  };
  axios.defaults.adapter = adapter as never;
  const client = await import('@/lib/api/client');
  const { useAuthStore } = await import('@/stores/authStore');
  const { useApiLogStore } = await import('@/stores/apiLogStore');
  return {
    http: client.default,
    restoreSession: client.restoreSession,
    errorOf: client.errorOf,
    useAuthStore,
    useApiLogStore,
  };
}

/** 앞 페이지에서 로그인해 둔다. 새로고침 뒤에 남는 것은 영속 저장소뿐이다. */
async function loggedInOnPreviousPage() {
  const { useAuthStore } = await load();
  useAuthStore.getState().setTokens(tokens('0'));
}

async function renderApp(path: string, { loggedIn = false } = {}) {
  const page = await load(path);
  if (loggedIn) page.useAuthStore.getState().setTokens(tokens('1'));
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  const { App } = await import('@/App');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return page;
}

/** 같은 탭에서 다시 새로고침한다 — 앞 화면을 내리고 모듈을 새로 읽는다. */
async function reload(path: string) {
  cleanup();
  disposeRouter?.();
  disposeRouter = null;
  return renderApp(path);
}

const pathname = () => window.location.pathname;

beforeEach(() => {
  routes = {};
  requests.length = 0;
  sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  disposeRouter?.();
  disposeRouter = null;
  restoreAdapter?.();
  restoreAdapter = null;
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('영속 저장소', () => {
  it('로그인 뒤 — Refresh Token 만 있다', async () => {
    routes = {
      'POST /api/v1/auth/login': () => ok(tokens('1')),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/login');

    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await waitFor(() => expect(pathname()).toBe('/posts'));

    // 값이 하나뿐이고 그것이 Refresh Token 이다 — Access Token 은 어느 값에도 없다.
    expect(stored()).toEqual(['RT-1']);
  });

  it('로그아웃 뒤 — 빈다. null 을 담은 값도 남기지 않고 키를 지운다', async () => {
    routes = {
      'POST /api/v1/auth/logout': () => null,
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/posts', { loggedIn: true });
    expect(stored()).toEqual(['RT-1']);

    fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(pathname()).toBe('/login'));

    expect(sessionStorage.length).toBe(0);
    expect(localStorage.length).toBe(0);
  });
});

describe('새로고침', () => {
  it('재발급이 한 번 나가고 보호된 화면이 이어진다 — StrictMode 에서도 한 번이다', async () => {
    await loggedInOnPreviousPage();
    routes = {
      [REISSUE]: () => ok(tokens('1')),
      'GET /api/v1/accounts/me': () => ok(ACCOUNT),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/me');

    expect(await screen.findByRole('heading', { name: '마이페이지' })).toBeInTheDocument();
    expect(pathname()).toBe('/me');
    expect(reissues().map((r) => r.body)).toEqual([{ refreshToken: 'RT-0' }]);
    // 회전된 Refresh Token 이 영속된다.
    expect(stored()).toEqual(['RT-1']);
  });

  it('부트스트랩 재발급을 동시에 두 번 부르면 요청은 한 번이고 두 호출이 같은 결과를 받는다', async () => {
    await loggedInOnPreviousPage();
    let issued = 0;
    routes = { [REISSUE]: () => ok(tokens(String(++issued))) };
    const { restoreSession } = await load();

    const results = await Promise.all([restoreSession(), restoreSession()]);

    expect(reissues()).toHaveLength(1);
    expect(results).toEqual([accessToken('1'), accessToken('1')]);

    // 끝난 뒤에 다시 불러도 재발급하지 않는다.
    expect(await restoreSession()).toBe(accessToken('1'));
    expect(reissues()).toHaveLength(1);
  });

  it('재발급이 끝난 뒤의 401 은 두 번째 재발급을 실제로 보낸다 — 끝난 비행을 다시 쓰지 않는다', async () => {
    await loggedInOnPreviousPage();
    let issued = 0;
    routes = {
      [REISSUE]: () => ok(tokens(String(++issued))),
      'GET /api/v1/posts/me': (config) =>
        config.headers.Authorization === `Bearer ${accessToken('2')}`
          ? ok(EMPTY_PAGE)
          : fail(config, 401, 'A003'),
    };
    const { http, restoreSession } = await load();

    expect(await restoreSession()).toBe(accessToken('1'));
    await http.get('/api/v1/posts/me');

    expect(reissues().map((r) => r.body)).toEqual([
      { refreshToken: 'RT-0' },
      { refreshToken: 'RT-1' },
    ]);
    expect(requests.filter((r) => r.key === 'GET /api/v1/posts/me').map((r) => r.auth)).toEqual([
      `Bearer ${accessToken('1')}`,
      `Bearer ${accessToken('2')}`,
    ]);
    expect(stored()).toEqual(['RT-2']);
  });

  it('실패로 끝난 재발급도 다시 쓰지 않는다 — auth 가 돌아오면 다음 401 이 새로고침 없이 회복한다', async () => {
    await loggedInOnPreviousPage();
    let calls = 0;
    routes = {
      [REISSUE]: (config) => (++calls === 1 ? fail(config, 500, 'C005') : ok(tokens('1'))),
      'GET /api/v1/posts/me': (config) =>
        config.headers.Authorization === `Bearer ${accessToken('1')}`
          ? ok(EMPTY_PAGE)
          : fail(config, 401, 'A003'),
    };
    const { http, useAuthStore, errorOf } = await load();
    useAuthStore.setState({ accessToken: accessToken('expired') });

    const first = await http.get('/api/v1/posts/me').catch((e: unknown) => e);
    expect(errorOf(first)?.code).toBe('A003');
    expect(stored()).toEqual(['RT-0']);

    await http.get('/api/v1/posts/me');

    expect(reissues().map((r) => r.body)).toEqual([
      { refreshToken: 'RT-0' },
      { refreshToken: 'RT-0' },
    ]);
    expect(stored()).toEqual(['RT-1']);
  });

  it('되살리는 중에 난 401 복구는 새로 재발급하지 않고 같은 재발급을 기다린다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async () => {
        await gate.promise;
        return ok(tokens('1'));
      },
      'GET /api/v1/posts/me': (config) =>
        config.headers.Authorization === `Bearer ${accessToken('1')}`
          ? ok(EMPTY_PAGE)
          : fail(config, 401, 'A003'),
    };
    const { http, restoreSession, useAuthStore } = await load();
    // 401 복구는 만료된 Access Token 을 보낸 요청에서 일어난다. 그 상태를 직접 쥐여서 되살리기와
    // 겹치게 하고, 두 경로가 한 재발급을 탄다는 것을 본다.
    useAuthStore.setState({ accessToken: accessToken('expired') });

    const restoring = restoreSession();
    const request = http.get('/api/v1/posts/me');
    // 401 이 인터셉터를 지나 재발급을 기다리는 자리까지 가게 한다 — 그 사슬은 마이크로태스크다.
    await new Promise((r) => setTimeout(r, 0));
    gate.resolve();
    await Promise.all([restoring, request]);

    expect(reissues()).toHaveLength(1);
    expect(requests.filter((r) => r.key === 'GET /api/v1/posts/me').map((r) => r.auth)).toEqual([
      `Bearer ${accessToken('expired')}`,
      `Bearer ${accessToken('1')}`,
    ]);
  });
});

describe('보호된 경로', () => {
  it('Refresh Token 이 없으면 그리지 않고 로그인으로 간다', async () => {
    await renderApp('/me');

    await waitFor(() => expect(pathname()).toBe('/login'));
    expect(screen.queryByRole('heading', { name: '마이페이지' })).toBeNull();
    // 재발급도, 마이페이지의 조회도 나가지 않았다.
    expect(requests).toEqual([]);
  });

  it('재발급이 거부되면 그리지 않고 로그인으로 간다 — 끝나기 전에는 판정하지 않는다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 401, 'A002');
      },
    };
    await renderApp('/me');

    // 재발급이 끝나기 전: 머리글은 그려졌지만 보호된 화면도, 로그인으로의 이동도 없다.
    expect(await screen.findByRole('link', { name: '로그인' })).toBeInTheDocument();
    expect(reissues()).toHaveLength(1);
    expect(pathname()).toBe('/me');
    expect(screen.queryByRole('heading', { name: '마이페이지' })).toBeNull();

    gate.resolve();
    await waitFor(() => expect(pathname()).toBe('/login'));

    // 마이페이지의 조회가 한 번도 나가지 않았다 — 보호된 화면이 그려진 적이 없다.
    expect(requests.map((r) => r.key)).toEqual([REISSUE]);
    expect(stored()).toEqual([]);
  });
});

describe('공개 경로', () => {
  it('Refresh Token 이 없으면 비로그인으로 보인다', async () => {
    routes = { 'GET /api/v1/posts': () => ok(EMPTY_PAGE) };
    await renderApp('/posts');

    expect(await screen.findByText('등록된 게시글이 없다')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '로그인' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
    expect(pathname()).toBe('/posts');
  });

  it('재발급이 거부되면 비로그인으로 보인다 — 되살리는 동안에도 기다리지 않고 그린다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 401, 'A002');
      },
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
    };
    await renderApp('/posts');

    expect(await screen.findByText('등록된 게시글이 없다')).toBeInTheDocument();
    expect(reissues()).toHaveLength(1);

    gate.resolve();
    await waitFor(() => expect(stored()).toEqual([]));

    expect(pathname()).toBe('/posts');
    expect(screen.getByText('등록된 게시글이 없다')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '로그인' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
  });
});

/**
 * 재발급 실패가 토큰을 비우는 것은 거부(4xx)와 accessToken 이 없는 응답뿐이다. 새로고침이 auth 를
 * 거치므로, 5xx·응답 없음에도 지우면 auth 의 장애가 로그아웃이 된다.
 */
describe('재발급 실패', () => {
  it.each([
    [
      '연결 거부',
      (config: InternalAxiosRequestConfig) => noResponse(config, AxiosError.ERR_NETWORK),
    ],
    [
      '타임아웃',
      (config: InternalAxiosRequestConfig) => noResponse(config, AxiosError.ECONNABORTED),
    ],
    ['서버 오류 500 C005', (config: InternalAxiosRequestConfig) => fail(config, 500, 'C005')],
  ])(
    '%s — Refresh Token 이 남고 보호된 경로는 로그인으로 간다. 다음 새로고침이 다시 묻는다',
    async (_, reply) => {
      await loggedInOnPreviousPage();
      routes = { [REISSUE]: reply };
      await renderApp('/me');

      await waitFor(() => expect(pathname()).toBe('/login'));
      expect(stored()).toEqual(['RT-0']);
      expect(requests.map((r) => r.key)).toEqual([REISSUE]);

      routes = {
        [REISSUE]: () => ok(tokens('1')),
        'GET /api/v1/accounts/me': () => ok(ACCOUNT),
        'GET /api/v1/members/me': () => ok(PROFILE),
      };
      await reload('/me');

      expect(await screen.findByRole('heading', { name: '마이페이지' })).toBeInTheDocument();
      expect(reissues().map((r) => r.body)).toEqual([
        { refreshToken: 'RT-0' },
        { refreshToken: 'RT-0' },
      ]);
      expect(stored()).toEqual(['RT-1']);
    },
  );

  it.each([
    ['거부 401 A002', (config: InternalAxiosRequestConfig) => fail(config, 401, 'A002')],
    ['거부 400 C001', (config: InternalAxiosRequestConfig) => fail(config, 400, 'C001')],
    ['응답에 accessToken 이 없음', () => ok(null)],
  ])('%s — 토큰을 비운다', async (_, reply) => {
    await loggedInOnPreviousPage();
    routes = { [REISSUE]: reply };
    const { restoreSession, useAuthStore } = await load();

    expect(await restoreSession()).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(stored()).toEqual([]);
  });

  it('401 복구의 재발급에 응답이 없으면 원요청의 401 이 그대로 전해지고 한 번 기록된다. 토큰은 남는다', async () => {
    routes = {
      [REISSUE]: (config) => noResponse(config, AxiosError.ERR_NETWORK),
      'GET /api/v1/posts/me': (config) => fail(config, 401, 'A003'),
    };
    const { http, errorOf, useAuthStore, useApiLogStore } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    const error = await http.get('/api/v1/posts/me').then(
      () => null,
      (e: unknown) => e,
    );

    expect(errorOf(error)?.code).toBe('A003');
    // 기록은 새것이 앞이다 — 원요청의 401 이 먼저 남고, 재발급은 응답 없음으로 남는다.
    expect(
      useApiLogStore.getState().entries.map((e) => [e.path, e.status, e.code, e.transportError]),
    ).toEqual([
      ['/api/v1/auth/reissue', null, null, 'no response'],
      ['/api/v1/posts/me', 401, 'A003', null],
    ]);
    expect(stored()).toEqual(['RT-1']);
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
  });
});

/**
 * 되살리는 동안 공개 경로의 로그인 화면에서 로그인할 수 있다. 그때 늦게 끝난 재발급은 보낸 토큰이
 * 스토어의 값이 아니므로 결과를 반영하지 않는다 — 실패여도 지우지 않고 성공이어도 덮지 않는다.
 */
describe('되살리는 창의 로그인', () => {
  it.each([
    ['거부되어도', (config: InternalAxiosRequestConfig) => fail(config, 401, 'A002')],
    ['응답에 accessToken 이 없어도', () => ok(null)],
    ['성공해도', () => ok(tokens('B'))],
  ])('늦게 끝난 재발급이 %s 새 로그인의 토큰이 남는다', async (_, reply) => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return reply(config);
      },
      'POST /api/v1/auth/login': () => ok(tokens('L')),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await renderApp('/login');

    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await waitFor(() => expect(pathname()).toBe('/posts'));
    expect(reissues()).toHaveLength(1);

    gate.resolve();
    await waitFor(() => expect(useAuthStore.getState().restoring).toBe(false));

    expect(stored()).toEqual(['RT-L']);
    expect(useAuthStore.getState().accessToken).toBe(accessToken('L'));
    expect(screen.getByRole('button', { name: '로그아웃' })).toBeInTheDocument();
  });
});

/**
 * 영속 저장소에 접근하면 던지는 환경이 있다(예: 저장소 접근이 SecurityError). 걷어낸 zustand `persist`
 * 처럼 던지지 않고 경고를 남긴 채 메모리로 동작해야 한다 — 저장소 접근 자체를 던지게 흉내낸다.
 */
describe('영속 저장소에 접근할 수 없는 환경', () => {
  it('모듈이 실리고 영속 없이 메모리로 동작한다 — 읽기·쓰기·삭제마다 경고를 남긴다', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });
    try {
      const { restoreSession, useAuthStore } = await load();
      expect(useAuthStore.getState().restoring).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);

      useAuthStore.getState().setTokens(tokens('1'));
      expect(useAuthStore.getState()).toMatchObject({
        accessToken: accessToken('1'),
        refreshToken: 'RT-1',
      });
      expect(warn).toHaveBeenCalledTimes(2);

      useAuthStore.getState().clear();
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
      expect(warn).toHaveBeenCalledTimes(3);

      expect(await restoreSession()).toBeNull();
      expect(requests).toEqual([]);
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      warn.mockRestore();
    }
  });
});

/**
 * 세션을 끝낸 실패의 이유 (sp-docs/plan/phase2.md §7.2 F-03). 보호된 화면은 토큰이 비면 로그인으로 가며 그 오류를
 * 잃으므로 실패를 저장소에 남기고 로그인 화면이 이어 보인다(src/pages/userCopy.test.tsx). 토큰을 지우고 남기는 판단은
 * 위의 describe 들이 잠그고, 여기는 **끝난 세션이 있을 때만** 이유가 남는지를 본다.
 */
describe('세션을 끝낸 실패의 이유', () => {
  it('새로고침 복원이 거부되면 그 실패를 남긴다', async () => {
    await loggedInOnPreviousPage();
    routes = { [REISSUE]: (config) => fail(config, 401, 'A002') };
    const { restoreSession, useAuthStore, errorOf } = await load();

    expect(await restoreSession()).toBeNull();
    expect(errorOf(useAuthStore.getState().sessionFailure)?.code).toBe('A002');
  });

  it('401 복구의 재발급이 거부되어 세션이 끝나면 — 원요청의 401 을 남긴다', async () => {
    routes = {
      [REISSUE]: (config) => fail(config, 401, 'A002'),
      'GET /api/v1/posts/me': (config) => fail(config, 401, 'A003'),
    };
    const { http, errorOf, useAuthStore } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    await http.get('/api/v1/posts/me').catch(() => null);

    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(errorOf(useAuthStore.getState().sessionFailure)?.code).toBe('A003');
  });

  it('401 복구의 재발급에 응답이 없으면 — 세션이 끝나지 않았으므로 남기지 않는다', async () => {
    routes = {
      [REISSUE]: (config) => noResponse(config, AxiosError.ERR_NETWORK),
      'GET /api/v1/posts/me': (config) => fail(config, 401, 'A003'),
    };
    const { http, useAuthStore } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    await http.get('/api/v1/posts/me').catch(() => null);

    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    expect(useAuthStore.getState().sessionFailure).toBeNull();
  });

  it('되살리는 창에서 로그인했으면 — 늦게 끝난 재발급의 실패를 남기지 않는다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 401, 'A002');
      },
      'POST /api/v1/auth/login': () => ok(tokens('L')),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await renderApp('/login');

    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    await waitFor(() => expect(pathname()).toBe('/posts'));

    gate.resolve();
    await waitFor(() => expect(useAuthStore.getState().restoring).toBe(false));

    expect(useAuthStore.getState().accessToken).toBe(accessToken('L'));
    expect(useAuthStore.getState().sessionFailure).toBeNull();
  });

  it('복구 전에 로그아웃했으면 — 늦게 온 401 을 남기지 않는다', async () => {
    const gate = deferred();
    routes = {
      'GET /api/v1/posts/me': async (config) => {
        await gate.promise;
        return fail(config, 401, 'A003');
      },
    };
    const { http, useAuthStore } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    const request = http.get('/api/v1/posts/me').catch(() => null);
    useAuthStore.getState().clear();
    gate.resolve();
    await request;

    expect(reissues()).toHaveLength(0);
    expect(useAuthStore.getState().sessionFailure).toBeNull();
  });

  it('다시 로그인하면 지운다', async () => {
    const { useAuthStore } = await load();
    useAuthStore.getState().setSessionFailure(new Error('끝난 세션'));

    useAuthStore.getState().setTokens(tokens('1'));

    expect(useAuthStore.getState().sessionFailure).toBeNull();
  });
});
