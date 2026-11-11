import { StrictMode, useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { UNEXPECTED } from '@/lib/api/errorCodes';
import { holds } from '@/test/holds';

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

/** 오류 본문이 없는 응답 — 서비스가 아니라 그 앞의 무엇이 답한 모양이다. */
function failWithoutBody(config: InternalAxiosRequestConfig, status: number): never {
  const response = { data: '', status, statusText: '', headers: {}, config } as AxiosResponse;
  throw new AxiosError(`status ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
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

/** 로그인 화면에서 로그인을 누른다. */
async function submitLogin() {
  fireEvent.change(await screen.findByLabelText('이메일'), { target: { value: 'user@example.com' } });
  fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'password' } });
  fireEvent.click(screen.getByRole('button', { name: '로그인' }));
}

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

  it('Refresh Token 이 undefined 로 와도 — 글자 "undefined" 를 적지 않는다', async () => {
    const { useAuthStore } = await load();

    useAuthStore.getState().setTokens({ ...tokens('1'), refreshToken: undefined as unknown as string });

    expect(stored()).toEqual([]);
  });
});

/**
 * 로그아웃의 본문은 **로그아웃을 시작한 세션의** Refresh Token 이다(sp-docs/api-contract.md §9.5). 서버는 그 값이 그 계정의 저장값이나
 * 직전 토큰일 때만 행을 지우고 아니면 204 로 아무것도 하지 않는다(sp-docs/requirements/member.md §6.4) — 본문이 없거나 다른 값이면
 * 화면은 로그아웃한 것처럼 보이는데 서버의 Refresh Token 이 남는다.
 */
describe('로그아웃 본문', () => {
  const LOGOUT = 'POST /api/v1/auth/logout';
  const logouts = () => requests.filter((r) => r.key === LOGOUT);
  const base = {
    'GET /api/v1/posts': () => ok(EMPTY_PAGE),
    'GET /api/v1/members/me': () => ok(PROFILE),
  };

  it('이 세션의 Refresh Token 을 싣는다', async () => {
    routes = { ...base, [LOGOUT]: () => null };
    await renderApp('/posts', { loggedIn: true });

    fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(pathname()).toBe('/login'));

    expect(logouts().map((r) => r.body)).toEqual([{ refreshToken: 'RT-1' }]);
  });

  it('재발급으로 회전한 뒤면 — 받은 Refresh Token 을 싣는다. 같은 세션이다', async () => {
    routes = { ...base, [LOGOUT]: () => null };
    const { useAuthStore } = await renderApp('/posts', { loggedIn: true });
    act(() => useAuthStore.getState().setReissuedTokens(tokens('2')));

    fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(pathname()).toBe('/login'));

    expect(logouts().map((r) => r.body)).toEqual([{ refreshToken: 'RT-2' }]);
  });

  it('401 A003 으로 재발급한 뒤 다시 보내도 — 본문은 처음 실은 값이다. 서버는 그것을 직전 토큰으로 지운다', async () => {
    routes = {
      ...base,
      [LOGOUT]: (config) =>
        config.headers.Authorization === `Bearer ${accessToken('1')}` ? fail(config, 401, 'A003') : null,
      [REISSUE]: () => ok(tokens('2')),
    };
    await renderApp('/posts', { loggedIn: true });

    fireEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(pathname()).toBe('/login'));

    expect(logouts().map((r) => [r.auth, r.body])).toEqual([
      [`Bearer ${accessToken('1')}`, { refreshToken: 'RT-1' }],
      [`Bearer ${accessToken('2')}`, { refreshToken: 'RT-1' }],
    ]);
    expect(reissues().map((r) => r.body)).toEqual([{ refreshToken: 'RT-1' }]);
    expect(stored()).toEqual([]);
  });
});

/**
 * 로그아웃 실패. **토큰을 지우지 않는다** — 서버의 Refresh Token 이 그대로인데 이 탭만 비우면 로그아웃된 것처럼 보이고(불변식 9)
 * 다시 알릴 토큰도 사라진다. 로그아웃은 멱등이라(sp-docs/api-contract.md §2.1) 다시 눌러도 된다.
 */
describe('로그아웃 실패', () => {
  const LOGOUT = 'POST /api/v1/auth/logout';
  const header = () => document.querySelector('header')!;
  const logoutButton = () => within(header()).findByRole('button', { name: /로그아웃/ });

  it.each([
    ['서버 오류 500 C005', (config: InternalAxiosRequestConfig) => fail(config, 500, 'C005'), 'C005'],
    ['응답 없음', (config: InternalAxiosRequestConfig) => noResponse(config, AxiosError.ERR_NETWORK), null],
  ])('%s — 토큰이 남고 그 자리에서 실패가 보인다. 다시 누르면 끝난다', async (_, reply, code) => {
    let answer: Handler = reply;
    routes = {
      [LOGOUT]: (config) => answer(config),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await renderApp('/posts', { loggedIn: true });

    fireEvent.click(await logoutButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다.'));
    expect(pathname()).toBe('/posts');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    expect(stored()).toEqual(['RT-1']);
    expect(await logoutButton()).toBeInTheDocument();
    if (code) expect(within(screen.getByRole('alert')).getByText(code)).toBeVisible();

    answer = () => null;
    fireEvent.click(await logoutButton());

    await waitFor(() => expect(pathname()).toBe('/login'));
    expect(requests.filter((r) => r.key === LOGOUT)).toHaveLength(2);
    expect(stored()).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('다른 화면으로 가면 안내가 사라진다 — 돌아와도 없다', async () => {
    routes = {
      [LOGOUT]: (config) => fail(config, 500, 'C005'),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/posts/me': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/posts', { loggedIn: true });
    fireEvent.click(await logoutButton());
    await screen.findByRole('alert');

    fireEvent.click(within(header()).getByRole('link', { name: '내 글' }));
    await waitFor(() => expect(pathname()).toBe('/posts/mine'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());

    fireEvent.click(within(header()).getByRole('link', { name: '게시판' }));
    await waitFor(() => expect(pathname()).toBe('/posts'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('다른 화면을 그리는 커밋에 — 앞 화면의 안내가 함께 그려지지 않는다. 지우는 효과는 그 커밋 뒤에 돈다', async () => {
    routes = {
      [LOGOUT]: (config) => fail(config, 500, 'C005'),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await load('/');
    useAuthStore.getState().setTokens(tokens('1'));
    const { Layout } = await import('@/components/Layout');
    const { createMemoryRouter, RouterProvider } = await import('react-router-dom');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { queryClient } = await import('@/lib/queryClient');
    const alertsAtCommit: Array<Element | null> = [];
    // 레이아웃 효과는 이 화면을 그린 커밋 안에서 돈다 — 그때 문서에 있는 것이 그 커밋의 결과다.
    function NextScreen() {
      useLayoutEffect(() => {
        alertsAtCommit.push(document.querySelector('[role="alert"]'));
      }, []);
      return <p>다음 화면</p>;
    }
    const router = createMemoryRouter(
      [
        {
          path: '/',
          element: <Layout />,
          children: [
            { path: 'here', element: <p>이 화면</p> },
            { path: 'next', element: <NextScreen /> },
          ],
        },
      ],
      { initialEntries: ['/here'] },
    );
    disposeRouter = () => router.dispose();
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(await logoutButton());
    await screen.findByRole('alert');

    await act(() => router.navigate('/next'));

    await screen.findByText('다음 화면');
    expect(alertsAtCommit).toEqual([null]);
  });

  it('다시 누르면 앞선 실패를 지우고 기다린다', async () => {
    const gate = deferred();
    let calls = 0;
    routes = {
      [LOGOUT]: async (config) => {
        if (++calls === 1) return fail(config, 500, 'C005');
        await gate.promise;
        return null;
      },
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/posts', { loggedIn: true });
    fireEvent.click(await logoutButton());
    await screen.findByRole('alert');

    fireEvent.click(await logoutButton());

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(pathname()).toBe('/posts');
    gate.resolve();
    await waitFor(() => expect(pathname()).toBe('/login'));
  });

  it('누른 뒤에 다른 화면으로 옮겼어도 — 옮겨 간 화면에서 보인다. 실패가 아무 데도 보이지 않으면 안 된다', async () => {
    const gate = deferred();
    routes = {
      [LOGOUT]: async (config) => {
        await gate.promise;
        return fail(config, 500, 'C005');
      },
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/posts/me': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/posts', { loggedIn: true });
    fireEvent.click(await logoutButton());
    fireEvent.click(within(header()).getByRole('link', { name: '내 글' }));
    await waitFor(() => expect(pathname()).toBe('/posts/mine'));

    gate.resolve();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다.'));
    expect(pathname()).toBe('/posts/mine');
  });

  it('401 A003 이고 재발급이 응답하지 못하면 — 세션이 끝나지 않았다. 토큰이 남고 그 자리에서 실패가 보인다', async () => {
    routes = {
      [LOGOUT]: (config) => fail(config, 401, 'A003'),
      [REISSUE]: (config) => fail(config, 503, 'C005'),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await renderApp('/posts', { loggedIn: true });

    fireEvent.click(await logoutButton());

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다.'));
    expect(within(screen.getByRole('alert')).getByText('A003')).toBeVisible();
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    expect(stored()).toEqual(['RT-1']);
  });

  /** 앞의 토큰으로 간 로그아웃이 401 `code` 로 실패한 화면. 토큰이 바뀌면 로그아웃이 끝난다. */
  async function logoutRejected(code: string) {
    routes = {
      [LOGOUT]: (config) =>
        config.headers.Authorization === `Bearer ${accessToken('1')}` ? fail(config, 401, code) : null,
      [REISSUE]: () => ok(tokens('2')),
      'POST /api/v1/auth/login': () => ok(tokens('2')),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    await renderApp('/posts', { loggedIn: true });
    fireEvent.click(await logoutButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다.'));
  }

  it.each(['A001', 'A002'])('401 %s — 재발급하지 않으므로 다시 눌러도 같은 답이다. 새로고침하면 토큰이 바뀌어 끝난다', async (code) => {
    await logoutRejected(code);
    expect(within(screen.getByRole('alert')).getByText(code)).toBeVisible();

    fireEvent.click(await logoutButton());

    await waitFor(() => expect(requests.filter((r) => r.key === LOGOUT)).toHaveLength(2));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다.'));
    expect(requests.filter((r) => r.key === LOGOUT).map((r) => r.auth)).toEqual([
      `Bearer ${accessToken('1')}`,
      `Bearer ${accessToken('1')}`,
    ]);
    expect(reissues()).toHaveLength(0);
    expect(stored()).toEqual(['RT-1']);

    await reload('/posts');
    fireEvent.click(await logoutButton());

    await waitFor(() => expect(pathname()).toBe('/login'));
    expect(reissues().map((r) => r.body)).toEqual([{ refreshToken: 'RT-1' }]);
    expect(stored()).toEqual([]);
  });

  it.each(['A001', 'A002'])('401 %s — 그 오류의 로그인 링크로 가서 다시 로그인하면 토큰이 바뀌어 끝난다', async (code) => {
    await logoutRejected(code);

    fireEvent.click(within(screen.getByRole('alert')).getByRole('link', { name: '로그인하기' }));
    await waitFor(() => expect(pathname()).toBe('/login'));
    await submitLogin();
    await waitFor(() => expect(pathname()).toBe('/posts'));
    fireEvent.click(await logoutButton());

    await waitFor(() => expect(pathname()).toBe('/login'));
    expect(stored()).toEqual([]);
  });

  it.each([
    ['공개 화면', '/posts', '/posts'],
    ['보호된 화면', '/posts/mine', '/login'],
  ])('401 A003 이고 재발급이 거부되면 — 세션이 이미 끝났다. %s 는 세션이 끝난 이유를 보인다', async (_, path, landing) => {
    routes = {
      [LOGOUT]: (config) => fail(config, 401, 'A003'),
      [REISSUE]: (config) => fail(config, 401, 'A002'),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/posts/me': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await renderApp(path, { loggedIn: true });

    fireEvent.click(await logoutButton());

    await waitFor(() => expect(pathname()).toBe(landing));
    await waitFor(() => expect(document.body).toHaveTextContent('로그인 상태를 이어가지 못했습니다.'));
    expect(document.body).not.toHaveTextContent('로그아웃하지 못했습니다.');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(stored()).toEqual([]);
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
    expect(await screen.findByRole('link', { name: '게시판' })).toBeInTheDocument();
    await waitFor(() => expect(reissues()).toHaveLength(1));
    expect(pathname()).toBe('/me');
    expect(screen.queryByRole('heading', { name: '마이페이지' })).toBeNull();

    gate.resolve();
    await waitFor(() => expect(pathname()).toBe('/login'));

    // 마이페이지의 조회가 한 번도 나가지 않았다 — 보호된 화면이 그려진 적이 없다.
    expect(requests.map((r) => r.key)).toEqual([REISSUE]);
    expect(stored()).toEqual([]);
  });
});

/**
 * 되살리는 동안은 세션이 되살아날지 알 수 없다. 그때 머리글이 「로그인」을 보이면 곧 로그인 상태가 될 사람에게 로그아웃된 것처럼
 * 보인다 — 판정이 나기 전에는 어느 쪽도 그리지 않는다.
 */
describe('되살리는 동안의 머리글', () => {
  const header = () => document.querySelector('header')!;
  const loginLinks = () => within(header()).queryAllByRole('link', { name: /^(로그인|가입)$/ });
  const logoutButton = () => within(header()).queryByRole('button', { name: /로그아웃/ });

  /** 판정 전 — 머리글은 그려졌고 재발급이 나갔는데 어느 쪽도 보이지 않는다. */
  async function undecided() {
    expect(await within(header()).findByRole('link', { name: '게시판' })).toBeInTheDocument();
    await waitFor(() => expect(reissues()).toHaveLength(1));
    expect(loginLinks()).toEqual([]);
    expect(logoutButton()).toBeNull();
  }

  const PAGES = {
    'GET /api/v1/posts': () => ok(EMPTY_PAGE),
    'GET /api/v1/members/me': () => ok(PROFILE),
    'GET /api/v1/accounts/me': () => ok(ACCOUNT),
  };

  it.each(['/posts', '/me'])('%s — 끝나기 전에는 어느 쪽도 없고, 성공하면 로그인 표시다', async (path) => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      ...PAGES,
      [REISSUE]: async () => {
        await gate.promise;
        return ok(tokens('1'));
      },
    };
    await renderApp(path);
    await undecided();

    gate.resolve();

    await waitFor(() => expect(logoutButton()).not.toBeNull());
    await waitFor(() => expect(header()).toHaveTextContent(PROFILE.nickname));
    expect(loginLinks()).toEqual([]);
  });

  it.each([
    ['거부 401 A002', (config: InternalAxiosRequestConfig) => fail(config, 401, 'A002')],
    ['서버 오류 503 C005', (config: InternalAxiosRequestConfig) => fail(config, 503, 'C005')],
    ['응답 없음', (config: InternalAxiosRequestConfig) => noResponse(config, AxiosError.ERR_NETWORK)],
  ])('%s — 끝나기 전에는 어느 쪽도 없고, 끝나면 비로그인 링크다', async (_, reply) => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      ...PAGES,
      [REISSUE]: async (config) => {
        await gate.promise;
        return reply(config);
      },
    };
    await renderApp('/posts');
    await undecided();

    gate.resolve();

    await waitFor(() => expect(loginLinks()).toHaveLength(2));
    expect(logoutButton()).toBeNull();
  });

  it('되살리는 창에 로그인하면 — 되살리기가 끝나기 전에도 로그인 표시다. 그 사람은 판정이 났다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      ...PAGES,
      [REISSUE]: async () => {
        await gate.promise;
        return ok(tokens('B'));
      },
      'POST /api/v1/auth/login': () => ok(tokens('L')),
    };
    const { useAuthStore } = await renderApp('/login');
    await undecided();

    fireEvent.change(screen.getByLabelText('이메일'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'password' } });
    fireEvent.click(within(document.querySelector('main')!).getByRole('button', { name: '로그인' }));

    await waitFor(() => expect(logoutButton()).not.toBeNull());
    expect(useAuthStore.getState().restoring).toBe(true);
    expect(loginLinks()).toEqual([]);

    gate.resolve();
    await waitFor(() => expect(useAuthStore.getState().restoring).toBe(false));
  });
});

describe('공개 경로', () => {
  it('Refresh Token 이 없으면 비로그인으로 보인다', async () => {
    routes = { 'GET /api/v1/posts': () => ok(EMPTY_PAGE) };
    await renderApp('/posts');

    expect(await screen.findByText('등록된 게시글이 없습니다')).toBeInTheDocument();
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

    expect(await screen.findByText('등록된 게시글이 없습니다')).toBeInTheDocument();
    expect(reissues()).toHaveLength(1);

    gate.resolve();
    await waitFor(() => expect(stored()).toEqual([]));

    expect(pathname()).toBe('/posts');
    expect(screen.getByText('등록된 게시글이 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '로그인' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '로그아웃' })).toBeNull();
  });
});

/**
 * 재발급 실패가 토큰을 비우는 것은 계약이 재발급의 거부로 정한 응답뿐이다 — 401 `A002`·`A003`(sp-docs/api-contract.md §2.1).
 * 새로고침이 auth 를 거치므로, 그 밖의 실패에도 지우면 auth 의 장애와 주소 오설정이 로그아웃이 된다.
 */
describe('재발급 실패', () => {
  const NOT_A_REJECTION: Array<[string, (config: InternalAxiosRequestConfig) => unknown]> = [
    ['연결 거부', (config) => noResponse(config, AxiosError.ERR_NETWORK)],
    ['타임아웃', (config) => noResponse(config, AxiosError.ECONNABORTED)],
    ['서버 오류 500 C005', (config) => fail(config, 500, 'C005')],
    ['없는 주소 404 C004', (config) => fail(config, 404, 'C004')],
    ['잘못된 요청 400 C001', (config) => fail(config, 400, 'C001')],
    ['오류 본문이 없는 401', (config) => failWithoutBody(config, 401)],
    ['오류 본문이 없는 404', (config) => failWithoutBody(config, 404)],
    ['거부로 정하지 않은 코드 401 A001', (config) => fail(config, 401, 'A001')],
    ['거부로 정하지 않은 상태 403 A002', (config) => fail(config, 403, 'A002')],
    ['응답에 accessToken 이 없음', () => ok(null)],
    ['응답에 refreshToken 이 없음', () => ok({ ...tokens('x'), refreshToken: undefined })],
  ];

  it.each(NOT_A_REJECTION)(
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
    ['만료 401 A003', (config: InternalAxiosRequestConfig) => fail(config, 401, 'A003')],
  ])('%s — 토큰을 비운다', async (_, reply) => {
    await loggedInOnPreviousPage();
    routes = { [REISSUE]: reply };
    const { restoreSession, useAuthStore } = await load();

    expect(await restoreSession()).toBeNull();
    expect(useAuthStore.getState().refreshToken).toBeNull();
    expect(stored()).toEqual([]);
  });

  it.each(NOT_A_REJECTION)('401 복구의 재발급이 %s 면 — 원요청의 401 이 그대로 전해지고 토큰이 남는다', async (_, reply) => {
    routes = {
      [REISSUE]: reply,
      'GET /api/v1/posts/me': (config) => fail(config, 401, 'A003'),
    };
    const { http, errorOf, useAuthStore } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    const error = await http.get('/api/v1/posts/me').catch((e: unknown) => e);

    expect(errorOf(error)?.code).toBe('A003');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    expect(stored()).toEqual(['RT-1']);
    expect(useAuthStore.getState().sessionFailure).toBeNull();
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

  it('새로고침 복원이 없는 주소(404 C004)를 만나면 — Refresh Token 은 남고 그 탭이 세션을 잇지 못한 이유를 남긴다', async () => {
    await loggedInOnPreviousPage();
    routes = { [REISSUE]: (config) => fail(config, 404, 'C004') };
    const { restoreSession, useAuthStore, errorOf } = await load();

    expect(await restoreSession()).toBeNull();

    expect(useAuthStore.getState().refreshToken).toBe('RT-0');
    expect(errorOf(useAuthStore.getState().sessionFailure)?.code).toBe('C004');
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

  it('비밀번호를 싣는 요청이 세션을 끝내면 — 남긴 실패에는 그 비밀번호가 없다. 코드·메시지·상태는 그대로다', async () => {
    const password = 'Withdraw-Passw0rd!';
    routes = {
      [REISSUE]: (config) => fail(config, 401, 'A002'),
      'DELETE /api/v1/accounts/me': (config) => fail(config, 401, 'A003'),
    };
    const { http, errorOf, useAuthStore } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    const received = await http.delete('/api/v1/accounts/me', { data: { password } }).catch((e: unknown) => e);

    // 양성 대조 — 요청은 비밀번호를 실었고, 요청한 쪽이 받는 원래 오류는 그것을 든 채다. 이 검사가 그 모양을 들여다본다.
    expect(requests.find((r) => r.key === 'DELETE /api/v1/accounts/me')?.body).toEqual({ password });
    expect(holds(received, password)).toBe(true);
    const failure = useAuthStore.getState().sessionFailure as AxiosError;
    expect(holds(failure, password)).toBe(false);
    expect(errorOf(failure)).toEqual(errorOf(received));
    expect(failure.message).toBe((received as AxiosError).message);
    expect([failure.status, failure.response?.status]).toEqual([401, 401]);
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

/** 재발급이 끝나는 모양. */
const LATE: Array<[string, (config: InternalAxiosRequestConfig) => unknown]> = [
  ['성공', () => ok(tokens('late'))],
  ['거부', (config) => fail(config, 401, 'A002')],
  ['서버 오류', (config) => fail(config, 500, 'C005')],
  ['accessToken 없는 응답', () => ok(null)],
  ['응답 없음', (config) => noResponse(config, AxiosError.ERR_NETWORK)],
];

/**
 * 재발급이 도는 사이에 세션이 끝났거나 바뀌었으면 그 재발급의 결과는 이 탭의 일이 아니다 — 성공이든 실패든 토큰을 건드리지 않고,
 * 이유를 남기지 않고, 그 토큰으로 원요청을 다시 보내지 않는다. 원요청의 401 이 그대로 전해진다. 탈퇴와 겹치는 순서는
 * src/pages/signupWithdrawal.test.tsx 가 본다.
 */
describe('늦게 끝난 재발급', () => {
  const POSTS_ME = 'GET /api/v1/posts/me';

  /** 401 복구를 시작해 재발급이 문 앞에서 기다리게 한다. */
  async function recoveryInFlight(reply: (config: InternalAxiosRequestConfig) => unknown) {
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return reply(config);
      },
      [POSTS_ME]: (config) => fail(config, 401, 'A003'),
    };
    const page = await load();
    page.useAuthStore.getState().setTokens(tokens('1'));
    const request = page.http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(reissues()).toHaveLength(1));
    return { ...page, gate, request };
  }

  it.each(LATE)('로그아웃한 뒤에 %s 로 끝나면 — 토큰이 되살아나지 않고 이유가 남지 않고 원요청이 다시 나가지 않는다', async (_, reply) => {
    const { useAuthStore, errorOf, gate, request } = await recoveryInFlight(reply);

    useAuthStore.getState().clear();
    gate.resolve();

    expect(errorOf(await request)?.code).toBe('A003');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionFailure: null });
    expect(stored()).toEqual([]);
    expect(requests.filter((r) => r.key === POSTS_ME)).toHaveLength(1);
  });

  it.each(LATE)('다시 로그인한 뒤에 %s 로 끝나면 — 새 로그인의 토큰이 남고 옛 세션의 토큰으로 원요청이 다시 나가지 않는다', async (_, reply) => {
    const { useAuthStore, errorOf, gate, request } = await recoveryInFlight(reply);

    useAuthStore.getState().setTokens(tokens('L'));
    gate.resolve();

    expect(errorOf(await request)?.code).toBe('A003');
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken('L'),
      refreshToken: 'RT-L',
      sessionFailure: null,
    });
    expect(stored()).toEqual(['RT-L']);
    expect(requests.filter((r) => r.key === POSTS_ME)).toHaveLength(1);
  });

  it('되살리는 창에서 로그인했다가 로그아웃했으면 — 늦게 끝난 복원의 실패를 남기지 않는다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 401, 'A002');
      },
    };
    const { restoreSession, useAuthStore } = await load();

    const restoring = restoreSession();
    useAuthStore.getState().setTokens(tokens('L'));
    useAuthStore.getState().clear();
    gate.resolve();

    expect(await restoring).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({ restoring: false, sessionFailure: null, refreshToken: null });
  });

  it('세션이 그대로면 재발급 성공을 반영한다 — 앞선 실패의 이유는 지우고 탈퇴가 어디까지 끝났는지는 지우지 않는다', async () => {
    const { useAuthStore, gate, request } = await recoveryInFlight(() => ok(tokens('2')));
    routes[POSTS_ME] = (config) =>
      config.headers.Authorization === `Bearer ${accessToken('2')}` ? ok(EMPTY_PAGE) : fail(config, 401, 'A003');
    useAuthStore.getState().setSessionFailure(new Error('앞선 실패'));
    useAuthStore.getState().setWithdrawal('account');

    gate.resolve();
    await request;

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken('2'),
      refreshToken: 'RT-2',
      sessionFailure: null,
      withdrawal: 'account',
    });
    expect(requests.filter((r) => r.key === POSTS_ME)).toHaveLength(2);
  });
});

/**
 * 요청을 보낸 뒤 세션이 바뀌었으면 그 요청의 401 은 지금 세션의 일이 아니다 — 재발급하지 않고, 이유를 남기지 않고, 다시 보내지
 * 않는다. 다시 보내면 앞 세션의 본문이 새 세션의 이름으로 들어간다. 재발급은 세션을 바꾸지 않는다 — 그 뒤의 401 은 복구한다.
 */
describe('요청을 보낸 뒤 바뀐 세션', () => {
  const POST = 'POST /api/v1/posts';
  const BODY = { title: 'A 의 글', content: 'A 의 본문' };
  const CREATED = { id: 1 };
  const bearer = (tag: string) => `Bearer ${accessToken(tag)}`;
  const posts = () => requests.filter((r) => r.key === POST);

  type Page = Awaited<ReturnType<typeof load>>;
  const send = (page: Page) => page.http.post('/api/v1/posts', BODY).catch((e: unknown) => e);
  /** 요청의 401 이 기록되었으면 그 요청은 재발급을 기다리는 줄까지 왔다 — 기록과 줄 서기 사이에 비는 틈이 없다. */
  const logged401s = (page: Page) =>
    page.useApiLogStore.getState().entries.filter((e) => e.path === '/api/v1/posts' && e.status === 401);
  const relogin = (auth: Page['useAuthStore'], tag: string) => {
    auth.getState().clear();
    auth.getState().setTokens(tokens(tag));
  };

  /** A 의 글 작성이 문 앞에서 기다린다. 문이 열리면 401 `A003` 이고 다시 오는 요청은 성공한다. */
  async function waitingForResponse() {
    const gate = deferred();
    let sent = 0;
    routes = {
      [POST]: async (config) => {
        if (++sent > 1) return ok(CREATED);
        await gate.promise;
        return fail(config, 401, 'A003');
      },
      [REISSUE]: () => ok(tokens('reissued')),
    };
    const page = await load();
    page.useAuthStore.getState().setTokens(tokens('A'));
    const request = send(page);
    await waitFor(() => expect(posts()).toHaveLength(1));
    return { ...page, gate, request };
  }

  it.each<[string, (auth: Page['useAuthStore']) => void, string]>([
    ['로그아웃하고 다른 계정으로 로그인했으면', (auth) => relogin(auth, 'B'), 'B'],
    ['로그아웃 없이 다른 계정으로 로그인했으면', (auth) => auth.getState().setTokens(tokens('B')), 'B'],
    // 같은 계정이 같은 초에 받은 토큰은 문자열이 같다(sp-docs/requirements/member.md §6.2) — 토큰을 비교해서는 가를 수 없다.
    ['같은 계정이 같은 초에 다시 로그인해 토큰 문자열이 같아도', (auth) => relogin(auth, 'A'), 'A'],
  ])('%s — 늦은 401 로 재발급하지 않고 다시 보내지 않는다. 지금 세션의 토큰이 남는다', async (_, change, now) => {
    const { useAuthStore, useApiLogStore, errorOf, gate, request } = await waitingForResponse();

    change(useAuthStore);
    gate.resolve();

    expect(errorOf(await request)?.code).toBe('A003');
    expect(posts().map((r) => r.auth)).toEqual([bearer('A')]);
    expect(reissues()).toHaveLength(0);
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken(now),
      refreshToken: `RT-${now}`,
      sessionFailure: null,
    });
    expect(stored()).toEqual([`RT-${now}`]);
    // 기록에는 그 401 이 남는다.
    expect(useApiLogStore.getState().entries.map((e) => [e.path, e.status, e.code])).toEqual([['/api/v1/posts', 401, 'A003']]);
  });

  it('로그아웃만 했으면 — 늦은 401 로 재발급하지 않고 다시 보내지 않는다. 토큰이 되살아나지 않는다', async () => {
    const { useAuthStore, errorOf, gate, request } = await waitingForResponse();

    useAuthStore.getState().clear();
    gate.resolve();

    expect(errorOf(await request)?.code).toBe('A003');
    expect(posts()).toHaveLength(1);
    expect(reissues()).toHaveLength(0);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionFailure: null });
    expect(stored()).toEqual([]);
  });

  it('재발급만으로 토큰이 바뀌었으면 — 같은 세션이다. 늦은 401 을 복구해 같은 본문을 다시 보낸다', async () => {
    const { useAuthStore, gate, request } = await waitingForResponse();

    useAuthStore.getState().setReissuedTokens(tokens('A2'));
    gate.resolve();
    await request;

    expect(reissues().map((r) => r.body)).toEqual([{ refreshToken: 'RT-A2' }]);
    expect(posts().map((r) => [r.auth, r.body])).toEqual([
      [bearer('A'), BODY],
      [bearer('reissued'), BODY],
    ]);
    expect(stored()).toEqual(['RT-reissued']);
  });

  /** A 의 두 요청이 401 을 받고 하나의 재발급을 함께 기다린다. 재발급은 문 앞에서 기다린다. */
  async function twoInQueue(reply: (config: InternalAxiosRequestConfig) => unknown) {
    const gate = deferred();
    routes = {
      [POST]: (config) => (config.headers.Authorization === bearer('A') ? fail(config, 401, 'A003') : ok(CREATED)),
      [REISSUE]: async (config) => {
        await gate.promise;
        return reply(config);
      },
    };
    const page = await load();
    page.useAuthStore.getState().setTokens(tokens('A'));
    const queued = [send(page), send(page)];
    await waitFor(() => expect(logged401s(page)).toHaveLength(2));
    expect(reissues()).toHaveLength(1);
    return { ...page, gate, queued };
  }

  it('줄에 선 요청 — 세션이 그대로면 재발급 하나로 둘 다 새 토큰으로 다시 나간다', async () => {
    const { gate, queued } = await twoInQueue(() => ok(tokens('reissued')));

    gate.resolve();
    await Promise.all(queued);

    expect(reissues()).toHaveLength(1);
    expect(posts().map((r) => r.auth)).toEqual([bearer('A'), bearer('A'), bearer('reissued'), bearer('reissued')]);
  });

  it.each(LATE)('줄에 선 요청 — 세션이 바뀐 뒤 재발급이 %s 로 끝나면 어느 쪽도 다시 나가지 않는다', async (_, reply) => {
    const { useAuthStore, errorOf, gate, queued } = await twoInQueue(reply);

    useAuthStore.getState().setTokens(tokens('B'));
    gate.resolve();

    expect((await Promise.all(queued)).map((e) => errorOf(e)?.code)).toEqual(['A003', 'A003']);
    expect(posts()).toHaveLength(2);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', sessionFailure: null });
    expect(stored()).toEqual(['RT-B']);
  });

  it('줄에 선 요청 — 재발급의 판단은 토큰 문자열을 본다. 같은 문자열로 다시 로그인했어도 줄에 선 요청은 다시 나가지 않는다', async () => {
    const { useAuthStore, errorOf, gate, queued } = await twoInQueue(() => ok(tokens('reissued')));

    relogin(useAuthStore, 'A');
    gate.resolve();

    expect((await Promise.all(queued)).map((e) => errorOf(e)?.code)).toEqual(['A003', 'A003']);
    expect(posts()).toHaveLength(2);
    // 서버는 그 Refresh Token 을 회전했다 — 받은 토큰을 버리면 다음 재발급이 거부된다.
    expect(useAuthStore.getState()).toMatchObject({ refreshToken: 'RT-reissued', sessionFailure: null });
  });

  it.each<[string, (auth: Page['useAuthStore']) => void, { accessToken: string | null; refreshToken: string | null }]>([
    ['다른 계정으로 로그인한', (auth) => auth.getState().setTokens(tokens('B')), { accessToken: accessToken('B'), refreshToken: 'RT-B' }],
    ['로그아웃한', (auth) => auth.getState().clear(), { accessToken: null, refreshToken: null }],
  ])('%s 뒤에 온 옛 요청의 401 은 줄에 서지 않는다 — 재발급이 끝나기를 기다리지 않고 그 401 이 전해진다', async (_, change, now) => {
    const reissueGate = deferred();
    const responseGate = deferred();
    let sent = 0;
    routes = {
      [POST]: async (config) => {
        if (++sent === 2) await responseGate.promise;
        return fail(config, 401, 'A003');
      },
      [REISSUE]: async () => {
        await reissueGate.promise;
        return ok(tokens('reissued'));
      },
    };
    const page = await load();
    const { useAuthStore, errorOf } = page;
    useAuthStore.getState().setTokens(tokens('A'));
    const queued = send(page);
    await waitFor(() => expect(reissues()).toHaveLength(1));
    const late = send(page);
    await waitFor(() => expect(posts()).toHaveLength(2));

    change(useAuthStore);
    responseGate.resolve();

    expect(errorOf(await late)?.code).toBe('A003');

    reissueGate.resolve();
    expect(errorOf(await queued)?.code).toBe('A003');
    expect(reissues()).toHaveLength(1);
    expect(posts()).toHaveLength(2);
    expect(useAuthStore.getState()).toMatchObject({ ...now, sessionFailure: null });
  });

  it('재시도도 401 A003 이면 — 더 보내지 않고 그 401 이 전해진다. 재시도는 한 번이다', async () => {
    let sent = 0;
    routes = {
      // 셋째가 나가면 성공해 끝난다 — 재시도가 끝없이 돌아 테스트가 멈추지 않게 한다.
      [POST]: (config) => (++sent < 3 ? fail(config, 401, 'A003') : ok(CREATED)),
      [REISSUE]: () => ok(tokens('reissued')),
    };
    const page = await load();
    page.useAuthStore.getState().setTokens(tokens('A'));

    expect(page.errorOf(await send(page))?.code).toBe('A003');

    expect(posts().map((r) => r.auth)).toEqual([bearer('A'), bearer('reissued')]);
    expect(reissues()).toHaveLength(1);
  });

  it('앞서 찍어 둔 세션으로 보낸 요청 — 세션이 바뀌었으면 그 토큰으로 나가고 401 로 재발급하지 않고 다시 보내지 않는다', async () => {
    routes = { [POST]: (config) => fail(config, 401, 'A003'), [REISSUE]: () => ok(tokens('reissued')) };
    const { http, useAuthStore, errorOf } = await load();
    const { inSession } = await import('@/lib/api/client');
    useAuthStore.getState().setTokens(tokens('A'));
    const started = useAuthStore.getState().sessionGeneration;
    useAuthStore.getState().setTokens(tokens('B'));

    const e = await http.post('/api/v1/posts', BODY, inSession(accessToken('A'), started)).catch((failure: unknown) => failure);

    expect(errorOf(e)?.code).toBe('A003');
    expect(posts().map((r) => r.auth)).toEqual([bearer('A')]);
    expect(reissues()).toHaveLength(0);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', sessionFailure: null });
  });

  it('앞서 찍어 둔 세션으로 보낸 요청 — 세션이 그대로면 401 을 복구해 받은 토큰으로 다시 보낸다', async () => {
    routes = {
      [POST]: (config) => (config.headers.Authorization === bearer('A') ? fail(config, 401, 'A003') : ok(CREATED)),
      [REISSUE]: () => ok(tokens('reissued')),
    };
    const { http, useAuthStore } = await load();
    const { inSession } = await import('@/lib/api/client');
    useAuthStore.getState().setTokens(tokens('A'));

    await http.post('/api/v1/posts', BODY, inSession(accessToken('A'), useAuthStore.getState().sessionGeneration));

    expect(posts().map((r) => r.auth)).toEqual([bearer('A'), bearer('reissued')]);
    expect(reissues()).toHaveLength(1);
  });

  it('앞서 찍어 둔 세션의 토큰이 없으면 — 헤더 없이 나간다. 지금 세션의 토큰을 붙이지 않는다', async () => {
    routes = { [POST]: () => ok(CREATED) };
    const { http, useAuthStore } = await load();
    const { inSession } = await import('@/lib/api/client');
    useAuthStore.getState().setTokens(tokens('B'));

    await http.post('/api/v1/posts', BODY, inSession(null, 0));

    expect(posts().map((r) => r.auth)).toEqual([null]);
  });

  it('재시도가 응답을 기다리는 사이에 세션이 바뀌었으면 — 그 재시도의 401 로 다시 나가지 않는다', async () => {
    const gate = deferred();
    let sent = 0;
    routes = {
      [POST]: async (config) => {
        if (++sent === 2) await gate.promise;
        return sent < 3 ? fail(config, 401, 'A003') : ok(CREATED);
      },
      [REISSUE]: () => ok(tokens('reissued')),
    };
    const page = await load();
    const { useAuthStore, errorOf } = page;
    useAuthStore.getState().setTokens(tokens('A'));
    const request = send(page);
    await waitFor(() => expect(posts()).toHaveLength(2));

    useAuthStore.getState().setTokens(tokens('B'));
    gate.resolve();

    expect(errorOf(await request)?.code).toBe('A003');
    expect(posts()).toHaveLength(2);
    expect(reissues()).toHaveLength(1);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', sessionFailure: null });
  });
});

/**
 * 재발급은 보낸 Refresh Token 하나에 하나만 돈다(lib/api/client.ts 의 `refreshAccessToken`) — 같은 값을 두 번 보내면 하나가 회전의
 * 조건부 UPDATE 에 진다(sp-docs/plan/phase2.md F-02). 값이 다르면 다른 세션의 재발급이라 기다리지 않는다.
 */
describe('다른 세션의 재발급', () => {
  const MINE = 'GET /api/v1/posts/me';
  const bearer = (tag: string) => `Bearer ${accessToken(tag)}`;
  const mine = () => requests.filter((r) => r.key === MINE);
  const sentTokens = () => reissues().map((r) => (r.body as { refreshToken: string }).refreshToken);

  /** A 의 재발급이 문 앞에서 기다리는 채로 B 가 로그인한다. 내 글 조회는 재발급한 B 의 토큰으로만 성공한다. */
  async function afterOtherSessionStartedReissue(replyToA: Handler = () => ok(tokens('late'))) {
    const gateA = deferred();
    const gateB = deferred();
    let holdsB = false;
    routes = {
      [REISSUE]: async (config) => {
        if (JSON.parse(config.data as string).refreshToken === 'RT-A') {
          await gateA.promise;
          return replyToA(config);
        }
        if (holdsB) await gateB.promise;
        return ok(tokens('B2'));
      },
      [MINE]: (config) => (config.headers.Authorization === bearer('B2') ? ok(EMPTY_PAGE) : fail(config, 401, 'A003')),
    };
    const page = await load();
    page.useAuthStore.getState().setTokens(tokens('A'));
    const requestOfA = page.http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(sentTokens()).toEqual(['RT-A']));
    page.useAuthStore.getState().setTokens(tokens('B'));
    return {
      ...page,
      gateA,
      gateB,
      holdReissueOfB: () => {
        holdsB = true;
      },
      requestOfA,
      sendAsB: () => page.http.get('/api/v1/posts/me'),
      logged401s: () => page.useApiLogStore.getState().entries.filter((e) => e.path === '/api/v1/posts/me' && e.status === 401),
    };
  }

  it.each(LATE)('앞 세션의 재발급을 기다리지 않고 제 재발급을 한다 — 앞 재발급이 뒤에 %s 로 끝나도 지금 세션은 그대로다', async (_, reply) => {
    const { useAuthStore, errorOf, gateA, requestOfA, sendAsB } = await afterOtherSessionStartedReissue(reply);

    // 앞 재발급이 문 앞에 있는 채로 끝난다.
    await sendAsB();

    expect(sentTokens()).toEqual(['RT-A', 'RT-B']);
    expect(mine().map((r) => r.auth)).toEqual([bearer('A'), bearer('B'), bearer('B2')]);

    gateA.resolve();

    expect(errorOf(await requestOfA)?.code).toBe('A003');
    expect(mine()).toHaveLength(3);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B2'), refreshToken: 'RT-B2', sessionFailure: null });
    expect(stored()).toEqual(['RT-B2']);
  });

  it('앞 재발급이 끝나도 지금 세션의 재발급은 하나다 — 같은 세션의 요청들이 그 하나를 함께 기다린다', async () => {
    const { useAuthStore, gateA, gateB, holdReissueOfB, requestOfA, sendAsB, logged401s } = await afterOtherSessionStartedReissue();
    holdReissueOfB();

    const first = sendAsB();
    await waitFor(() => expect(sentTokens()).toEqual(['RT-A', 'RT-B']));
    gateA.resolve();
    await requestOfA;
    const second = sendAsB();
    await waitFor(() => expect(logged401s()).toHaveLength(3));
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTokens()).toEqual(['RT-A', 'RT-B']);

    gateB.resolve();
    await Promise.all([first, second]);

    expect(sentTokens()).toEqual(['RT-A', 'RT-B']);
    expect(mine().filter((r) => r.auth === bearer('B2'))).toHaveLength(2);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B2'), refreshToken: 'RT-B2' });
  });

  it('같은 계정이 같은 초에 다시 로그인해 Refresh Token 이 같으면 — 도는 재발급을 함께 기다리고 같은 값을 두 번 보내지 않는다', async () => {
    const gate = deferred();
    routes = {
      [REISSUE]: async () => {
        await gate.promise;
        return ok(tokens('reissued'));
      },
      [MINE]: (config) => (config.headers.Authorization === bearer('reissued') ? ok(EMPTY_PAGE) : fail(config, 401, 'A003')),
    };
    const { useAuthStore, useApiLogStore, http, errorOf } = await load();
    useAuthStore.getState().setTokens(tokens('A'));
    const before = http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(sentTokens()).toEqual(['RT-A']));

    useAuthStore.getState().clear();
    useAuthStore.getState().setTokens(tokens('A'));
    const after = http.get('/api/v1/posts/me');
    await waitFor(() => expect(useApiLogStore.getState().entries).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 0));

    expect(sentTokens()).toEqual(['RT-A']);

    gate.resolve();
    await after;

    // 앞 세션의 요청은 다시 나가지 않고, 지금 세션의 요청만 받은 토큰으로 다시 나간다.
    expect(errorOf(await before)?.code).toBe('A003');
    expect(sentTokens()).toEqual(['RT-A']);
    expect(mine().map((r) => r.auth)).toEqual([bearer('A'), bearer('A'), bearer('reissued')]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('reissued'), refreshToken: 'RT-reissued' });
  });

  it.each([
    ['다르면', 'RT-B'],
    // 같은 계정이 같은 초에 받은 토큰은 문자열이 같다(sp-docs/requirements/member.md §6.2) — 문자열로는 앞 세션의 거부와 가르지 못한다.
    ['같아도', 'RT-A'],
  ])('앞 세션의 재발급이 거부로 끝나도 — 새 세션의 Refresh Token 이 보낸 값과 %s 그 세션을 지우지 않는다', async (_, refreshToken) => {
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 401, 'A002');
      },
      [MINE]: (config) => fail(config, 401, 'A003'),
    };
    const { useAuthStore, http, errorOf } = await load();
    useAuthStore.getState().setTokens(tokens('A'));
    const requestOfA = http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(sentTokens()).toEqual(['RT-A']));

    useAuthStore.getState().clear();
    useAuthStore.getState().setTokens({ ...tokens('B'), refreshToken });
    gate.resolve();

    expect(errorOf(await requestOfA)?.code).toBe('A003');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken, sessionFailure: null });
    expect(stored()).toEqual([refreshToken]);
  });

  it('같은 문자열로 다시 로그인한 세션이 앞 세션의 재발급을 함께 기다렸는데 거부로 끝나면 — 이 세션을 끝내지 않는다. 그 401 만 전해진다', async () => {
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 401, 'A002');
      },
      [MINE]: (config) => fail(config, 401, 'A003'),
    };
    const { useAuthStore, useApiLogStore, http, errorOf } = await load();
    useAuthStore.getState().setTokens(tokens('A'));
    const requestOfA = http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(sentTokens()).toEqual(['RT-A']));
    useAuthStore.getState().clear();
    useAuthStore.getState().setTokens(tokens('A'));
    const requestOfNext = http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(useApiLogStore.getState().entries).toHaveLength(2));

    gate.resolve();

    expect(errorOf(await requestOfA)?.code).toBe('A003');
    expect(errorOf(await requestOfNext)?.code).toBe('A003');
    expect(sentTokens()).toEqual(['RT-A']);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('A'), refreshToken: 'RT-A', sessionFailure: null });
  });

  it('되살리는 재발급이 서버 오류로 끝났는데 그 사이 같은 문자열로 로그인했으면 — 되살리지 못한 이유를 남기지 않는다. 그 세션을 놓치지 않았다', async () => {
    await loggedInOnPreviousPage();
    const gate = deferred();
    routes = {
      [REISSUE]: async (config) => {
        await gate.promise;
        return fail(config, 500, 'C005');
      },
    };
    const { useAuthStore, restoreSession } = await load();
    const restored = restoreSession();
    await waitFor(() => expect(sentTokens()).toEqual(['RT-0']));

    useAuthStore.getState().setTokens(tokens('0'));
    gate.resolve();

    expect(await restored).toBeNull();
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken('0'),
      refreshToken: 'RT-0',
      restoring: false,
      sessionFailure: null,
    });
  });

  it('끝난 재발급의 답을 다시 쓰지 않는다 — 같은 값이어도 그 다음 401 은 새로 보낸다', async () => {
    let sent = 0;
    routes = {
      [REISSUE]: (config) => (++sent === 1 ? fail(config, 500, 'C005') : ok(tokens('2'))),
      [MINE]: (config) => (config.headers.Authorization === bearer('2') ? ok(EMPTY_PAGE) : fail(config, 401, 'A003')),
    };
    const { http, useAuthStore, errorOf } = await load();
    useAuthStore.getState().setTokens(tokens('1'));

    expect(errorOf(await http.get('/api/v1/posts/me').catch((e: unknown) => e))?.code).toBe('A003');
    await http.get('/api/v1/posts/me');

    expect(sentTokens()).toEqual(['RT-1', 'RT-1']);
    expect(useAuthStore.getState().refreshToken).toBe('RT-2');
  });
});

/**
 * 쿼리 캐시의 수명은 세션이다(lib/queryClient.ts). 세션이 바뀌면 앞 세션이 받은 것이 뒤 세션의 화면에 나오지 않고, 도는 조회의 답이
 * 들어오지 않고, 화면의 조회는 새 쿼리로 옮겨 제 토큰으로 다시 묻는다. 재발급은 세션을 바꾸지 않는다 — 캐시도 입력도 그대로다.
 */
describe('세션과 쿼리 캐시', () => {
  const ME = 'GET /api/v1/members/me';
  const MINE = 'GET /api/v1/posts/me';
  const LIST = 'GET /api/v1/posts';
  const LOGIN = 'POST /api/v1/auth/login';
  const LOGOUT = 'POST /api/v1/auth/logout';
  const OTHER = 'GET /api/v1/members/9';
  const bearer = (tag: string) => `Bearer ${accessToken(tag)}`;
  const from = (config: InternalAxiosRequestConfig, tag: string) => config.headers.Authorization === bearer(tag);
  const sentBy = (key: string) => requests.filter((r) => r.key === key).map((r) => r.auth);
  const header = () => document.querySelector('header')!;
  const NICK_A = { accountId: 7, nickname: 'NICK-A' };
  const NICK_B = { accountId: 8, nickname: 'NICK-B' };
  const pageOf = (title: string) => ({
    ...EMPTY_PAGE,
    content: [{ id: 1, title, writerId: 7, writerNickname: '작성자', viewCount: 0, commentCount: 0, createdAt: '2026-10-27T10:00:00' }],
    totalElements: 1,
    totalPages: 1,
  });
  const someone = (nickname: string) => ({ accountId: 9, nickname, createdAt: '2026-10-27T10:00:00', deleted: false });
  const cache = async () => (await import('@/lib/queryClient')).queryClient;
  const cachedStates = async () => (await cache()).getQueryCache().getAll().map((q) => q.state);
  /** 쿼리의 알림은 다음 작업으로 미뤄진다(notifyManager). 늦은 답이 화면까지 갔을 자리를 지나게 한다. */
  const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

  /** 본문이 바뀔 때마다 글자를 적어 둔다 — 잠깐 보였다 사라진 것도 남는다. */
  function recordText() {
    const seen = [document.body.textContent ?? ''];
    const observer = new MutationObserver(() => seen.push(document.body.textContent ?? ''));
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    onTestFinished(() => observer.disconnect());
    return seen;
  }

  /** 처음에 보였다가 사라진 글자가 그 뒤에 다시 보인 자리들. */
  function shownAgain(seen: string[], text: string) {
    expect(seen[0]).toContain(text);
    const gone = seen.findIndex((t) => !t.includes(text));
    expect(gone).toBeGreaterThan(0);
    return seen.slice(gone).filter((t) => t.includes(text));
  }

  const logOutInHeader = async () => {
    fireEvent.click(await within(header()).findByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(pathname()).toBe('/login'));
  };

  it('본문의 기록은 잠깐 보였다 사라진 글자를 남긴다 — 아래 단언의 양성 대조', async () => {
    const flash = document.createElement('p');
    flash.textContent = '잠깐 보인 글자';
    document.body.append(flash);
    const seen = recordText();
    const nextTask = () => new Promise((r) => setTimeout(r, 0));

    flash.remove();
    await nextTask();
    document.body.append(flash);
    await nextTask();
    flash.remove();
    await nextTask();

    expect(shownAgain(seen, '잠깐 보인 글자')).toHaveLength(1);
  });

  it('로그아웃하고 다른 계정으로 로그인하면 — 앞 계정의 닉네임이 다시 보이지 않는다. 새 프로필 응답을 기다리는 동안도 그렇다', async () => {
    const profileB = deferred();
    routes = {
      [LIST]: () => ok(EMPTY_PAGE),
      [ME]: async (config) => {
        if (from(config, '1')) return ok(NICK_A);
        await profileB.promise;
        return ok(NICK_B);
      },
      [LOGOUT]: () => null,
      [LOGIN]: () => ok(tokens('B')),
    };
    await renderApp('/posts', { loggedIn: true });
    await within(header()).findByText('NICK-A');
    const seen = recordText();

    await logOutInHeader();
    await submitLogin();
    await waitFor(() => expect(sentBy(ME)).toEqual([bearer('1'), bearer('B')]));

    expect(pathname()).toBe('/posts');
    expect(header()).toHaveTextContent('…');
    expect(header()).not.toHaveTextContent('NICK-A');

    profileB.resolve();
    await within(header()).findByText('NICK-B');

    expect(shownAgain(seen, 'NICK-A')).toEqual([]);
  });

  it('로그아웃 없이 다른 계정으로 로그인해도 — 그 자리에서 앞 계정의 닉네임이 사라지고 다시 보이지 않는다', async () => {
    const profileB = deferred();
    routes = {
      [LIST]: () => ok(EMPTY_PAGE),
      [ME]: async (config) => {
        if (from(config, '1')) return ok(NICK_A);
        await profileB.promise;
        return ok(NICK_B);
      },
      [LOGIN]: () => ok(tokens('B')),
    };
    await renderApp('/login', { loggedIn: true });
    await within(header()).findByText('NICK-A');
    const seen = recordText();

    await submitLogin();
    await waitFor(() => expect(sentBy(ME)).toEqual([bearer('1'), bearer('B')]));

    expect(header()).toHaveTextContent('…');
    expect(header()).not.toHaveTextContent('NICK-A');

    profileB.resolve();
    await within(header()).findByText('NICK-B');

    expect(shownAgain(seen, 'NICK-A')).toEqual([]);
  });

  it('로그아웃만 했으면 — 앞 세션이 받은 것이 캐시에 남지 않는다', async () => {
    routes = {
      [ME]: () => ok(NICK_A),
      [MINE]: () => ok(pageOf('A 의 글')),
      [LOGOUT]: () => null,
    };
    await renderApp('/posts/mine', { loggedIn: true });
    await screen.findAllByText('A 의 글');
    await within(header()).findByText('NICK-A');
    // 양성 대조 — 이 검사가 캐시에 든 값을 찾아낸다.
    expect(holds(await cachedStates(), 'A 의 글')).toBe(true);
    expect(holds(await cachedStates(), 'NICK-A')).toBe(true);

    await logOutInHeader();

    expect(holds(await cachedStates(), 'A 의 글')).toBe(false);
    expect(holds(await cachedStates(), 'NICK-A')).toBe(false);
    expect((await cachedStates()).filter((state) => state.data !== undefined)).toEqual([]);
  });

  it('변경 요청의 기록도 세션과 함께 지운다', async () => {
    routes = { [LIST]: () => ok(EMPTY_PAGE), [ME]: () => ok(NICK_A) };
    const { useAuthStore } = await renderApp('/posts', { loggedIn: true });
    const client = await cache();
    client.getMutationCache().build(client, { mutationKey: ['앞 세션의 변경'] });
    expect(client.getMutationCache().getAll()).toHaveLength(1);

    act(() => useAuthStore.getState().clear());

    expect(client.getMutationCache().getAll()).toEqual([]);
  });

  it.each<[string, Handler]>([
    ['401 A003', (config) => fail(config, 401, 'A003')],
    ['성공', () => ok(NICK_A)],
    ['서버 오류', (config) => fail(config, 500, 'C005')],
  ])('앞 세션의 프로필 조회가 로그아웃과 새 로그인을 넘겨 %s 로 끝나도 — 그 답이 들어오지 않고 새 세션이 제 프로필을 다시 물어 그린다', async (_, late) => {
    const lateReply = deferred();
    const profileB = deferred();
    routes = {
      [LIST]: () => ok(EMPTY_PAGE),
      [ME]: async (config) => {
        if (!from(config, '1')) {
          await profileB.promise;
          return ok(NICK_B);
        }
        await lateReply.promise;
        return late(config);
      },
      [LOGOUT]: () => null,
      [LOGIN]: () => ok(tokens('B')),
    };
    const { useAuthStore, useApiLogStore } = await renderApp('/posts', { loggedIn: true });
    await waitFor(() => expect(sentBy(ME)).toEqual([bearer('1')]));

    await logOutInHeader();
    await submitLogin();
    await waitFor(() => expect(sentBy(ME)).toEqual([bearer('1'), bearer('B')]));

    const answered = () => useApiLogStore.getState().entries.filter((e) => e.path === '/api/v1/members/me');
    expect(answered()).toEqual([]);
    lateReply.resolve();
    await waitFor(() => expect(answered()).toHaveLength(1));
    await settle();

    // 머리글은 제 프로필을 기다린다 — 앞 세션의 답이 머리글에도 캐시에도 없다.
    expect(header()).toHaveTextContent('…');
    expect(header()).not.toHaveTextContent('NICK-A');
    expect(header().querySelector('[data-error-code]')).toBeNull();
    const query = (await cache()).getQueryCache().find({ queryKey: ['member', 'me'] });
    expect(query?.state).toMatchObject({ data: undefined, error: null, fetchStatus: 'fetching' });
    expect(query?.observers).toHaveLength(1);

    profileB.resolve();
    await within(header()).findByText('NICK-B');
    await settle();

    expect(header().querySelector('[data-error-code]')).toBeNull();
    expect(reissues()).toEqual([]);
    expect(sentBy(ME)).toEqual([bearer('1'), bearer('B')]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), sessionFailure: null });
  });

  it('내 글 목록 — 다른 계정으로 로그인하면 그 화면에 머문 채로도 같은 순간에 사라지고 제 목록을 다시 묻는다', async () => {
    const listB = deferred();
    routes = {
      [ME]: (config) => ok(from(config, '1') ? NICK_A : NICK_B),
      [MINE]: async (config) => {
        if (from(config, '1')) return ok(pageOf('A 의 글'));
        await listB.promise;
        return ok(pageOf('B 의 글'));
      },
    };
    const { useAuthStore } = await renderApp('/posts/mine', { loggedIn: true });
    await screen.findAllByText('A 의 글');
    const seen = recordText();

    act(() => useAuthStore.getState().setTokens(tokens('B')));

    // 이 화면은 스토어를 구독하지 않는다 — 그래도 알림을 기다리지 않고 같은 커밋에서 바뀐다.
    expect(screen.queryAllByText('A 의 글')).toEqual([]);
    expect(screen.getByText('불러오는 중…')).toBeInTheDocument();
    await waitFor(() => expect(sentBy(MINE)).toEqual([bearer('1'), bearer('B')]));

    listB.resolve();
    await screen.findAllByText('B 의 글');

    expect(shownAgain(seen, 'A 의 글')).toEqual([]);
    expect(holds(await cachedStates(), 'A 의 글')).toBe(false);
    expect(holds(await cachedStates(), 'B 의 글')).toBe(true);
  });

  it('내 글 목록의 응답이 세션이 바뀐 뒤에 와도 — 새 세션의 화면과 캐시에 들어가지 않는다', async () => {
    const listA = deferred();
    const listB = deferred();
    routes = {
      [ME]: (config) => ok(from(config, '1') ? NICK_A : NICK_B),
      [MINE]: async (config) => {
        if (from(config, '1')) {
          await listA.promise;
          return ok(pageOf('A 의 글'));
        }
        await listB.promise;
        return ok(pageOf('B 의 글'));
      },
    };
    const { useAuthStore } = await renderApp('/posts/mine', { loggedIn: true });
    await waitFor(() => expect(sentBy(MINE)).toEqual([bearer('1')]));

    act(() => useAuthStore.getState().setTokens(tokens('B')));
    await waitFor(() => expect(sentBy(MINE)).toEqual([bearer('1'), bearer('B')]));
    listA.resolve();
    await settle();

    expect(screen.queryAllByText('A 의 글')).toEqual([]);
    expect(holds(await cachedStates(), 'A 의 글')).toBe(false);
    expect(screen.getByText('불러오는 중…')).toBeInTheDocument();

    listB.resolve();
    await screen.findAllByText('B 의 글');

    expect(screen.queryAllByText('A 의 글')).toEqual([]);
    expect(holds(await cachedStates(), 'A 의 글')).toBe(false);
  });

  it('스토어를 읽지 않는 공개 화면 — 세션이 끝나면 화면의 조회가 새 쿼리로 옮겨 다시 묻는다. 지운 쿼리에 남아 끝나지 않는 일이 없다', async () => {
    const first = deferred();
    let sent = 0;
    routes = {
      [ME]: () => ok(NICK_A),
      [OTHER]: async () => {
        if (++sent === 1) {
          await first.promise;
          return ok(someone('옛 응답'));
        }
        return ok(someone('새 응답'));
      },
    };
    const { useAuthStore } = await renderApp('/members/9', { loggedIn: true });
    await waitFor(() => expect(sent).toBe(1));

    act(() => useAuthStore.getState().clear());
    await screen.findByText('새 응답');

    // 화면의 관찰자가 캐시에 있는 그 쿼리에 붙어 있다.
    const query = (await cache()).getQueryCache().find({ queryKey: ['member', 'profile', '9'] });
    expect(query?.observers).toHaveLength(1);
    expect(sentBy(OTHER)).toEqual([bearer('1'), null]);

    first.resolve();
    await settle();

    expect(screen.getByText('새 응답')).toBeInTheDocument();
    expect(screen.queryByText('옛 응답')).toBeNull();
    expect(sentBy(OTHER)).toEqual([bearer('1'), null]);
  });

  it('토큰 없이 받아 둔 것도 로그인하면 지운다 — 새 세션은 제 토큰으로 다시 묻는다', async () => {
    const listB = deferred();
    routes = {
      [LIST]: async (config) => {
        if (config.headers.Authorization === undefined) return ok(pageOf('토큰 없이 받은 글'));
        await listB.promise;
        return ok(pageOf('로그인하고 받은 글'));
      },
      [ME]: () => ok(NICK_B),
      [LOGIN]: () => ok(tokens('B')),
    };
    await renderApp('/posts');
    await screen.findAllByText('토큰 없이 받은 글');

    fireEvent.click(within(header()).getByRole('link', { name: '로그인' }));
    await submitLogin();
    await waitFor(() => expect(sentBy(LIST)).toEqual([null, bearer('B')]));

    expect(screen.queryAllByText('토큰 없이 받은 글')).toEqual([]);
    expect(holds(await cachedStates(), '토큰 없이 받은 글')).toBe(false);

    listB.resolve();
    await screen.findAllByText('로그인하고 받은 글');
  });

  it('토큰 없이 있던 세션이 끝나면 지우지 않는다 — 되살리지 못한 새로고침에 공개 화면이 같은 조회를 다시 보내지 않는다', async () => {
    await loggedInOnPreviousPage();
    const reply = deferred();
    routes = {
      [LIST]: () => ok(pageOf('공개 글')),
      [REISSUE]: async (config) => {
        await reply.promise;
        return fail(config, 401, 'A002');
      },
    };
    await renderApp('/posts');
    await screen.findAllByText('공개 글');

    reply.resolve();
    await within(header()).findByRole('link', { name: '가입' });
    await settle();

    expect(sentBy(LIST)).toEqual([null]);
    expect(screen.getAllByText('공개 글').length).toBeGreaterThan(0);
  });

  it('공개 화면의 조회가 도는 사이에 되살리기가 거부되어도 — 그 답이 화면에 그려진다', async () => {
    await loggedInOnPreviousPage();
    const list = deferred();
    routes = {
      [LIST]: async () => {
        await list.promise;
        return ok(pageOf('공개 글'));
      },
      [REISSUE]: (config) => fail(config, 401, 'A002'),
    };
    await renderApp('/posts');
    await within(header()).findByRole('link', { name: '가입' });

    list.resolve();
    await screen.findAllByText('공개 글');

    expect(sentBy(LIST)).toEqual([null]);
  });

  it('재발급만으로는 — 같은 세션이다. 캐시가 그대로이고 다시 묻지 않고 쓰던 입력이 그대로다', async () => {
    routes = {
      [ME]: () => ok(NICK_A),
      'GET /api/v1/accounts/me': (config) => (from(config, '1') ? fail(config, 401, 'A003') : ok(ACCOUNT)),
      [REISSUE]: () => ok(tokens('2')),
    };
    const { http, useAuthStore } = await renderApp('/posts/new', { loggedIn: true });
    await within(header()).findByText('NICK-A');
    const title = await screen.findByLabelText(/^제목/);
    const content = screen.getByLabelText(/^본문/);
    fireEvent.change(title, { target: { value: '쓰던 제목' } });
    fireEvent.change(content, { target: { value: '쓰던 본문' } });
    const client = await cache();
    client.getMutationCache().build(client, { mutationKey: ['같은 세션의 변경'] });
    const before = client.getQueryCache().getAll();
    const { sessionGeneration } = useAuthStore.getState();
    expect(before.length).toBeGreaterThan(0);

    await act(async () => {
      await http.get('/api/v1/accounts/me');
    });
    await settle();

    expect(reissues()).toHaveLength(1);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('2'), sessionGeneration });
    const after = client.getQueryCache().getAll();
    expect(after).toHaveLength(before.length);
    expect(after.every((query, i) => query === before[i])).toBe(true);
    expect(holds(await cachedStates(), 'NICK-A')).toBe(true);
    expect(client.getMutationCache().getAll()).toHaveLength(1);
    expect(sentBy(ME)).toEqual([bearer('1')]);
    expect(header()).toHaveTextContent('NICK-A');
    // 그 입력칸 그대로다 — 다시 만들어지지 않았다.
    expect(screen.getByLabelText(/^제목/)).toBe(title);
    expect(title).toHaveValue('쓰던 제목');
    expect(content).toHaveValue('쓰던 본문');
  });

  it('세션이 끝나도 화면을 다시 만들지 않는다 — 그 자리에 머무는 화면의 입력이 그대로다', async () => {
    routes = { [LIST]: () => ok(EMPTY_PAGE), [ME]: () => ok(NICK_A) };
    const { useAuthStore } = await renderApp('/posts', { loggedIn: true });
    const keyword = await screen.findByLabelText('검색어');
    fireEvent.change(keyword, { target: { value: '찾던 말' } });

    act(() => useAuthStore.getState().clear());
    await waitFor(() => expect(sentBy(LIST)).toEqual([bearer('1'), null]));
    await screen.findByText('등록된 게시글이 없습니다');

    expect(screen.getByLabelText('검색어')).toBe(keyword);
    expect(keyword).toHaveValue('찾던 말');
  });
});

/**
 * 2xx 인데 토큰이 빠진 로그인 응답은 계약에 없는 응답이다(sp-docs/api-contract.md §2.1) — 받아 두면 Access Token 없이 로그인한 듯한
 * 화면이 되거나 새로고침이 말없이 세션을 잃는다. 로그인 실패로 다룬다.
 */
describe('토큰이 빠진 로그인 응답', () => {
  const WITHOUT: Array<[string, unknown]> = [
    ['refreshToken 이 없다', { ...tokens('1'), refreshToken: undefined }],
    ['accessToken 이 없다', { ...tokens('1'), accessToken: undefined }],
    ['refreshToken 이 빈 값이다', { ...tokens('1'), refreshToken: '' }],
    ['accessToken 이 빈 값이다', { ...tokens('1'), accessToken: '' }],
    ['둘 다 없다', { grantType: 'Bearer' }],
  ];

  it.each(WITHOUT)('로그인 화면 — %s: 토큰을 저장하지 않고 그 자리에서 오류가 보인다', async (_, body) => {
    routes = { 'POST /api/v1/auth/login': () => ok(body) };
    const { useAuthStore } = await renderApp('/login');

    await submitLogin();

    expect(await screen.findByText(UNEXPECTED)).toBeInTheDocument();
    expect(pathname()).toBe('/login');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, accountId: null, sessionGeneration: 0 });
    expect(stored()).toEqual([]);
    expect(within(document.querySelector('header')!).getByRole('link', { name: '가입' })).toBeInTheDocument();
  });

  it.each(WITHOUT)('가입 — %s: 계정을 만든 뒤의 로그인 실패로 로그인 화면이 보인다. 토큰을 저장하지 않는다', async (_, body) => {
    routes = {
      'POST /api/v1/accounts': () => ok({ accountId: 7, email: 'user@example.com' }),
      'POST /api/v1/auth/login': () => ok(body),
    };
    const { useAuthStore } = await renderApp('/signup');

    fireEvent.change(await screen.findByLabelText('이메일'), { target: { value: 'user@example.com' } });
    fireEvent.change(screen.getByLabelText('비밀번호'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: '계정 만들기' }));

    await waitFor(() => expect(pathname()).toBe('/login'));
    expect(await screen.findByText(/계정을 만들었습니다/)).toBeInTheDocument();
    expect(screen.getByText(UNEXPECTED)).toBeInTheDocument();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionGeneration: 0 });
    expect(stored()).toEqual([]);
  });

  it('두 토큰이 다 있으면 — 로그인한다', async () => {
    routes = {
      'POST /api/v1/auth/login': () => ok(tokens('1')),
      'GET /api/v1/posts': () => ok(EMPTY_PAGE),
      'GET /api/v1/members/me': () => ok(PROFILE),
    };
    const { useAuthStore } = await renderApp('/login');

    await submitLogin();
    await waitFor(() => expect(pathname()).toBe('/posts'));

    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('1'), refreshToken: 'RT-1' });
    expect(stored()).toEqual(['RT-1']);
  });
});

/**
 * 개발 빌드의 토큰 실험 화면. 손으로 하는 재발급도 같은 세션이 이어지는 것이다 — 세션을 바꾸지 않는다. 그 사이 토큰이 바뀌었으면 받은
 * 토큰을 저장하지 않는다. 같은 초의 재로그인은 문자열이 같아 저장한다(sp-docs/requirements/member.md §6.2).
 */
describe('토큰 실험 화면의 수동 재발급', () => {
  const ME = 'GET /api/v1/members/me';
  const button = () => screen.findByRole('button', { name: /현재 토큰/ });

  it('같은 세션이 이어진다 — 세대가 그대로이고 캐시도 그대로라 머리글이 다시 묻지 않는다. 탈퇴가 어디까지 끝났는지도 그대로다', async () => {
    routes = {
      [ME]: () => ok(PROFILE),
      [REISSUE]: () => ok(tokens('2')),
    };
    const { useAuthStore } = await renderApp('/tokens', { loggedIn: true });
    await screen.findByText(PROFILE.nickname);
    act(() => useAuthStore.getState().setWithdrawal('account'));
    const { sessionGeneration } = useAuthStore.getState();

    fireEvent.click(await button());
    expect(await screen.findByText(/재발급 성공/)).toBeInTheDocument();

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken('2'),
      refreshToken: 'RT-2',
      sessionGeneration,
      withdrawal: 'account',
    });
    expect(stored()).toEqual(['RT-2']);
    expect(requests.filter((r) => r.key === ME)).toHaveLength(1);
    expect(screen.getByText(PROFILE.nickname)).toBeInTheDocument();
  });

  it('재발급이 도는 사이에 같은 문자열로 다시 로그인했으면 — 토큰이 바뀌지 않았으므로 받은 토큰을 저장한다', async () => {
    const gate = deferred();
    routes = {
      [ME]: () => ok(PROFILE),
      [REISSUE]: async () => {
        await gate.promise;
        return ok(tokens('late'));
      },
    };
    const { useAuthStore } = await renderApp('/tokens', { loggedIn: true });
    await screen.findByText(PROFILE.nickname);
    fireEvent.click(await button());
    await waitFor(() => expect(reissues()).toHaveLength(1));

    act(() => {
      useAuthStore.getState().clear();
      useAuthStore.getState().setTokens(tokens('1'));
    });
    gate.resolve();

    expect(await screen.findByText(/재발급 성공/)).not.toHaveTextContent('저장하지 않았다');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('late'), refreshToken: 'RT-late' });
    expect(stored()).toEqual(['RT-late']);
  });

  it('재발급이 도는 사이에 토큰이 바뀌었으면 — 받은 토큰을 저장하지 않고 그렇게 적는다', async () => {
    const gate = deferred();
    routes = {
      [ME]: () => ok(PROFILE),
      [REISSUE]: async () => {
        await gate.promise;
        return ok(tokens('late'));
      },
    };
    const { useAuthStore } = await renderApp('/tokens', { loggedIn: true });
    await screen.findByText(PROFILE.nickname);
    fireEvent.click(await button());
    await waitFor(() => expect(reissues()).toHaveLength(1));

    act(() => useAuthStore.getState().setTokens(tokens('B')));
    gate.resolve();

    expect(await screen.findByText(/저장하지 않았다/)).toBeInTheDocument();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
    expect(stored()).toEqual(['RT-B']);
  });

  it('응답에 토큰이 없으면 — 저장하지 않고 오류가 보인다', async () => {
    routes = {
      [ME]: () => ok(PROFILE),
      [REISSUE]: () => ok({ ...tokens('2'), refreshToken: undefined }),
    };
    const { useAuthStore } = await renderApp('/tokens', { loggedIn: true });
    await screen.findByText(PROFILE.nickname);

    fireEvent.click(await button());

    expect(await screen.findByText(UNEXPECTED)).toBeInTheDocument();
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('1'), refreshToken: 'RT-1' });
    expect(stored()).toEqual(['RT-1']);
  });
});
