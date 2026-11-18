import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_SENTENCES } from '@/lib/api/errorCodes';

/**
 * 좋아요 (sp-docs/plan/phase2-frontend-integration.md F-13). 검증 표의 줄마다 화면을 연다 — 같은 표를 e2e/like.spec.ts 가 프로덕션
 * 빌드에서 밟는다.
 *
 * 스텁은 서버처럼 상태를 갖는다 — 누른 계정과 다른 계정들이 누른 수다. 상세의 `liked` 는 요청에 실린 토큰의 계정으로 정하고, 토큰이
 * 없으면 `null` 이다(sp-docs/api-contract.md §4.3·§4.8). 좋아요의 응답은 그 요청 뒤의 상태다(§4.6). 그래서 화면이 보낸 토큰·메서드와
 * 화면이 그린 상태가 함께 맞아야 통과한다. 화면은 프로덕션 모드와 StrictMode 로 그린다 — 흉내는 src/pages/postCategory.test.tsx 와
 * 같다.
 */

const EXP = Math.floor(Date.now() / 1000) + 1800;

interface Who {
  sub: number;
  role: 'USER' | 'ADMIN';
}
const USER: Who = { sub: 7, role: 'USER' };
const OTHER: Who = { sub: 8, role: 'USER' };

/** 서명은 검증하지 않으므로(lib/jwt.ts) payload 만 맞으면 된다. `issue` 는 재발급 전후의 토큰을 가른다. */
const tokenOf = (who: Who, issue = 1) =>
  [
    btoa(JSON.stringify({ alg: 'RS256' })),
    btoa(JSON.stringify({ sub: String(who.sub), role: who.role, exp: EXP, issue })),
    'signature',
  ].join('.');
const tokensOf = (who: Who, issue = 1) => ({
  grantType: 'Bearer',
  accessToken: tokenOf(who, issue),
  refreshToken: `RT-${who.sub}-${issue}`,
  accessTokenExpiresIn: 1800,
});

type Reply = { status: number; body: unknown };
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;
type Query = Record<string, unknown>;

const ok = (data: unknown, status = 200): Reply => ({ status, body: { success: true, data, error: null } });
const fail = (status: number, code: string, message: string): Reply => ({
  status,
  body: { success: false, data: null, error: { code, message, fieldErrors: [] } },
});
const NO_CONTENT: Reply = { status: 204, body: '' };

/** 요청에 실린 Access Token. 없으면 `null` 이다. */
const bearer = (config: InternalAxiosRequestConfig) => {
  const value = config.headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
};
const claimsOf = (token: string) => JSON.parse(atob(token.split('.')[1])) as { sub: string; issue: number };
const accountOf = (config: InternalAxiosRequestConfig) => {
  const token = bearer(config);
  return token === null ? null : Number(claimsOf(token).sub);
};

const TITLE = '좋아요를 받을 글';
const DETAIL = 'GET /api/v1/posts/1';
const LIKE = 'PUT /api/v1/posts/1/like';
const UNLIKE = 'DELETE /api/v1/posts/1/like';
const COMMENTS = 'GET /api/v1/posts/1/comments';
const ADD_COMMENT = 'POST /api/v1/posts/1/comments';
const LIST = 'GET /api/v1/posts';
const LOGIN = 'POST /api/v1/auth/login';
const LOGOUT = 'POST /api/v1/auth/logout';
const REISSUE = 'POST /api/v1/auth/reissue';

/** 서버의 그 글 — 눌러 둔 계정, 이 테스트가 로그인하지 않는 계정들이 누른 수, 댓글. */
let likers = new Set<number>();
let others = 0;
let comments: Array<{ id: number; writerId: number; writerNickname: string; content: string; createdAt: string }> = [];

const likeCount = () => others + likers.size;
/** 상세 — 목록 항목의 키에 `content`·`liked`·`attachments` 를 더한 것(§4.3). */
const detailFor = (account: number | null) => ({
  id: 1,
  title: TITLE,
  category: 'FREE',
  writerId: 9,
  writerNickname: '글쓴이',
  viewCount: 5,
  commentCount: comments.length,
  likeCount: likeCount(),
  createdAt: '2026-11-01T09:00:00',
  content: '본문 첫 줄',
  liked: account === null ? null : likers.has(account),
  attachments: [],
});
const pageOf = (content: unknown[], size = 10) => ({
  content,
  page: 0,
  size,
  totalElements: content.length,
  totalPages: content.length === 0 ? 0 : 1,
  first: true,
  last: true,
});
const A001 = () => fail(401, 'A001', '인증이 필요합니다.');

/** 서버의 기본 답. 테스트가 `extra` 로 바꾼다. */
const serverRoutes = (): Record<string, Handler> => ({
  'GET /api/v1/members/me': (config) =>
    ok(accountOf(config) === OTHER.sub ? { accountId: OTHER.sub, nickname: '다른닉' } : { accountId: USER.sub, nickname: '테스트닉' }),
  [DETAIL]: (config) => ok(detailFor(accountOf(config))),
  [COMMENTS]: () => ok(pageOf(comments, 20)),
  [ADD_COMMENT]: (config) => {
    const account = accountOf(config);
    if (account === null) return A001();
    const comment = {
      id: comments.length + 1,
      writerId: account,
      writerNickname: '테스트닉',
      content: (JSON.parse(config.data as string) as { content: string }).content,
      createdAt: '2026-11-17T09:00:00',
    };
    comments = [...comments, comment];
    return ok(comment, 201);
  },
  [LIKE]: (config) => {
    const account = accountOf(config);
    if (account === null) return A001();
    likers.add(account);
    return ok({ liked: true, likeCount: likeCount() });
  },
  [UNLIKE]: (config) => {
    const account = accountOf(config);
    if (account === null) return A001();
    likers.delete(account);
    return ok({ liked: false, likeCount: likeCount() });
  },
  // 글 목록과 최근 공지 — 공지는 없다.
  [LIST]: (config) => ok(pageOf((config.params as Query | undefined)?.category === 'NOTICE' ? [] : [listItem(1, TITLE, 12)])),
  [LOGIN]: (config) => {
    const { email } = JSON.parse(config.data as string) as { email: string };
    return ok(tokensOf(email === 'other@example.com' ? OTHER : USER));
  },
  [LOGOUT]: () => NO_CONTENT,
});

/** 목록 항목 — 키는 §4.3 의 목록 항목 줄이다. 조회·댓글·좋아요 수를 서로 다르게 두어 어느 값을 그렸는지 가른다. */
const listItem = (id: number, title: string, likes: number) => ({
  id,
  title,
  category: 'FREE',
  writerId: 9,
  writerNickname: '글쓴이',
  viewCount: 5,
  commentCount: 1,
  likeCount: likes,
  createdAt: '2026-11-01T09:00:00',
});

const OTHER_TITLE = '다른 글';
const OTHER_LIKE = 'PUT /api/v1/posts/2/like';
/** 다른 글(id 2)의 서버 — 이 테스트가 로그인하지 않는 계정들이 40 을 눌렀다. 화면의 계정이 누르면 41 이다. */
const otherPostRoutes = (): Record<string, Handler> => {
  const pressedBy = new Set<number>();
  return {
    'GET /api/v1/posts/2': (config) => {
      const account = accountOf(config);
      return ok({
        ...listItem(2, OTHER_TITLE, 40 + pressedBy.size),
        commentCount: 0,
        content: '다른 본문',
        liked: account === null ? null : pressedBy.has(account),
        attachments: [],
      });
    },
    'GET /api/v1/posts/2/comments': () => ok(pageOf([], 20)),
    [OTHER_LIKE]: (config) => {
      const account = accountOf(config);
      if (account === null) return A001();
      pressedBy.add(account);
      return ok({ liked: true, likeCount: 40 + pressedBy.size });
    },
  };
};

let routes: Record<string, Handler> = {};
const requests: Array<{ key: string; params: Query | null; body: unknown; token: string | null }> = [];
const sent = (key: string) => requests.filter((r) => r.key === key);

interface Gate {
  release: () => void;
}
/** 붙든 요청 — 그 키의 다음 요청 하나의 답을 `release` 까지 붙든다. 답은 요청이 닿은 때 정한다 — 서버는 그때 읽고 썼다. */
const holds = new Map<string, Promise<void>>();
function hold(key: string): Gate {
  let release!: () => void;
  holds.set(key, new Promise<void>((resolve) => (release = resolve)));
  return { release: () => act(() => release()) };
}

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push({
    key,
    params: (config.params as Query | undefined) ?? null,
    body: typeof config.data === 'string' ? JSON.parse(config.data) : (config.data ?? null),
    token: bearer(config),
  });
  const handler = routes[key];
  if (!handler) throw new Error(`스텁에 없는 요청: ${key}`);
  const reply = await handler(config);
  const held = holds.get(key);
  if (held) {
    holds.delete(key);
    await held;
  }
  const response = { data: reply.body, status: reply.status, statusText: '', headers: {}, config } as AxiosResponse;
  if (reply.status >= 400) throw new AxiosError(`status ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  return response;
}

let restoreAdapter: (() => void) | null = null;
let disposeRouter: (() => void) | null = null;

interface RenderOptions {
  as?: Who;
  extra?: Record<string, Handler>;
}

/** 프로덕션 모드로 모듈을 새로 읽을 준비 — 스텁의 답·주소·토큰. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function prepare(path: string, { as, extra = {} }: RenderOptions) {
  routes = { ...serverRoutes(), ...extra };
  vi.stubEnv('DEV', false);
  vi.stubEnv('PROD', true);
  vi.resetModules();
  window.history.replaceState(null, '', path);
  const { default: axios } = await import('axios');
  const original = axios.defaults.adapter;
  restoreAdapter ??= () => {
    axios.defaults.adapter = original;
  };
  axios.defaults.adapter = adapter as never;
  const { useAuthStore } = await import('@/stores/authStore');
  if (as) useAuthStore.getState().setTokens(tokensOf(as));
  // 조회 결과를 화면에 알리는 것을 미루지 않는다(src/pages/postEdit.test.tsx 와 같다).
  const { notifyManager } = await import('@tanstack/react-query');
  notifyManager.setScheduler((callback) => callback());
  return { useAuthStore };
}

/** 프로덕션 모드로 모듈을 새로 읽고 앱을 그린다. */
async function renderApp(path: string, options: RenderOptions = {}) {
  const { useAuthStore } = await prepare(path, options);
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  const { App } = await import('@/App');
  const { queryClient } = await import('@/lib/queryClient');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return { router, queryClient, useAuthStore };
}

/**
 * 글 상세만 key 없이 그린다 — 다른 글로 옮겨도 화면 하나가 이어진다. 앱의 라우터는 글마다 새로 그려(src/router.tsx) 이렇게 되지 않는다.
 * 응답을 보낸 글에 넣는 것은 화면의 몫이라 라우터를 빼고 본다. 머리글과 `main` 은 없다.
 */
async function renderDetailWithoutKey(path: string, options: RenderOptions = {}) {
  await prepare(path, options);
  const { RouterProvider, createMemoryRouter } = await import('react-router-dom');
  const { QueryClientProvider } = await import('@tanstack/react-query');
  const { PostDetailPage } = await import('@/pages/PostDetailPage');
  const { queryClient } = await import('@/lib/queryClient');
  const router = createMemoryRouter([{ path: '/posts/:id', element: <PostDetailPage /> }], { initialEntries: [path] });
  disposeRouter = () => router.dispose();
  render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
  return { router };
}

/** 앞 페이지에서 로그인해 둔다. 새로 읽은 모듈에는 영속 저장소(Refresh Token)만 남는다 — 새로고침이다(src/pages/userCopy.test.tsx). */
async function loggedInOnPreviousPage(who: Who) {
  vi.resetModules();
  const { useAuthStore } = await import('@/stores/authStore');
  useAuthStore.getState().setTokens(tokensOf(who));
}

beforeEach(() => {
  sessionStorage.clear();
  requests.length = 0;
  holds.clear();
  likers = new Set();
  others = 2;
  comments = [];
});

afterEach(() => {
  cleanup();
  disposeRouter?.();
  disposeRouter = null;
  restoreAdapter?.();
  restoreAdapter = null;
  vi.unstubAllEnvs();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

const main = () => document.querySelector('main')!;
/** 머리글 — 문서의 첫 `header` 다. */
const banner = () => document.querySelector('header')!;
const pathname = () => window.location.pathname;
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
/** 보낸 요청의 답이 화면까지 갔을 자리를 지난다 — 스텁은 곧바로 답한다. 그리지 않았다는 단언 앞에 둔다. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

/** 글 상세의 글 — 제목(h1)이 든 패널이다. 댓글 패널은 뺀다. */
const postPanel = (title = TITLE) => screen.getByRole('heading', { level: 1, name: title }).closest('section')!;
const likeButton = (title = TITLE) => within(postPanel(title)).getByRole('button', { name: /^좋아요 \d+$/ });
const pressed = (value: boolean, count: number, title = TITLE) =>
  waitFor(() => {
    expect(likeButton(title)).toHaveAttribute('aria-pressed', String(value));
    expect(likeButton(title)).toHaveTextContent(new RegExp(`^좋아요 ${count}$`));
  });
const GUIDE = '좋아요를 누르려면 로그인';
const guideShown = () => waitFor(() => expect(postPanel()).toHaveTextContent(GUIDE));
/** 글 패널의 오류 상자. */
const likeError = () => postPanel().querySelector('.bg-danger-50');

describe('글 상세 — 좋아요의 검증 표', () => {
  it('누르지 않은 글(liked: false)에서 누르면 PUT 이 본문 없이 나가고, 버튼의 상태와 수를 그 응답으로 바꾼다 — 그 사이 다른 계정이 누른 것도 응답의 수에 있다', async () => {
    await renderApp('/posts/1', { as: USER });
    await pressed(false, 2);
    // `false` 를 「누구인지 모른다」 로 다루지 않는다 — 로그인 안내가 아니라 누를 버튼이다.
    expect(postPanel()).not.toHaveTextContent(GUIDE);
    const reads = sent(DETAIL).length;

    // 화면이 받은 뒤 다른 계정이 눌렀다 — 서버의 수는 3 이고, 이 계정이 누르면 4 다. 화면이 셈하면 3 이다.
    others += 1;
    fireEvent.click(likeButton());

    await pressed(true, 4);
    expect(sent(LIKE).map(({ body, token }) => ({ body, token }))).toEqual([{ body: null, token: tokenOf(USER) }]);
    expect(sent(UNLIKE)).toEqual([]);
    // 상세를 다시 읽지 않았다 — 그린 상태와 수는 응답의 것이다.
    expect(sent(DETAIL)).toHaveLength(reads);
  });

  it('누른 글(liked: true)에서 누르면 DELETE 가 본문 없이 나가고 그 응답의 상태와 수다 — 그다음 누르기는 다시 PUT 이다', async () => {
    likers.add(USER.sub);
    await renderApp('/posts/1', { as: USER });
    await pressed(true, 3);

    // 다른 계정이 취소했다 — 이 계정이 취소하면 1 이다. 화면이 셈하면 2 다.
    others -= 1;
    fireEvent.click(likeButton());
    await pressed(false, 1);
    expect(sent(UNLIKE).map(({ body, token }) => ({ body, token }))).toEqual([{ body: null, token: tokenOf(USER) }]);
    expect(sent(LIKE)).toEqual([]);

    fireEvent.click(likeButton());
    await pressed(true, 2);
    expect(sent(LIKE)).toHaveLength(1);
    expect(sent(UNLIKE)).toHaveLength(1);
  });

  it('비로그인(liked: null)이면 누를 버튼 없이 수와 로그인 안내다 — 좋아요 요청이 나가지 않고, 안내는 로그인 화면으로 간다', async () => {
    likers.add(USER.sub);
    await renderApp('/posts/1');
    await guideShown();
    // 상세는 토큰 없이 받았다 — 그래서 `null` 이다.
    expect(sent(DETAIL).map((r) => r.token)).toEqual([null]);
    expect(postPanel()).toHaveTextContent('좋아요 3');
    // `null` 을 `false` 로 다루지 않는다 — 누르지 않은 버튼도 그리지 않는다.
    expect(within(postPanel()).queryByRole('button', { name: /좋아요/ })).toBeNull();
    expect(postPanel().querySelector('[aria-pressed]')).toBeNull();

    fireEvent.click(within(postPanel()).getByText(/^좋아요 3$/));
    await settle();
    expect(sent(LIKE)).toEqual([]);
    expect(sent(UNLIKE)).toEqual([]);

    fireEvent.click(within(postPanel()).getByRole('link', { name: '로그인' }));
    await waitFor(() => expect(pathname()).toBe('/login'));
  });

  it('누른 글이 지워졌으면(404 P001) 그 안내와 코드를 글 패널에 보이고, 버튼의 상태와 수를 그대로 둔다', async () => {
    await renderApp('/posts/1', {
      as: USER,
      extra: { [LIKE]: () => fail(404, 'P001', '게시글을 찾을 수 없습니다.') },
    });
    await pressed(false, 2);

    fireEvent.click(likeButton());

    await waitFor(() => expect(likeError()).toHaveTextContent(ERROR_SENTENCES.P001.text));
    expect(likeError()!.querySelector('[data-error-code]')).toHaveTextContent('P001');
    expect(sent(LIKE)).toHaveLength(1);
    await pressed(false, 2);
  });
});

describe('글 상세 — 좋아요의 실패와 다시 누르기', () => {
  it('실패하면 상태와 수를 그대로 두고 그 실패를 보인다 — 다시 누르면 실패를 지우고 다시 보내 그 응답을 그린다', async () => {
    let failing = true;
    const press = serverRoutes()[LIKE];
    await renderApp('/posts/1', {
      as: USER,
      extra: { [LIKE]: (config) => (failing ? fail(500, 'C005', '서버 오류') : press(config)) },
    });
    await pressed(false, 2);

    fireEvent.click(likeButton());
    await waitFor(() => expect(likeError()).toHaveTextContent(ERROR_SENTENCES.C005.text));
    await pressed(false, 2);

    failing = false;
    const gate = hold(LIKE);
    fireEvent.click(likeButton());
    await waitFor(() => expect(sent(LIKE)).toHaveLength(2));
    // 응답을 기다리는 동안 앞의 실패가 남아 지금 누른 것의 결과처럼 보이지 않는다.
    expect(likeError()).toBeNull();

    gate.release();
    await pressed(true, 3);
    expect(likeError()).toBeNull();
  });

  it('응답을 기다리는 동안 다시 눌러도 보내지 않는다 — 그동안 버튼은 aria-disabled 이고, 응답이 오면 다시 누를 수 있다', async () => {
    await renderApp('/posts/1', { as: USER });
    await pressed(false, 2);

    const gate = hold(LIKE);
    fireEvent.click(likeButton());
    fireEvent.click(likeButton());
    await settle();
    expect(sent(LIKE)).toHaveLength(1);
    expect(sent(UNLIKE)).toEqual([]);
    expect(likeButton()).toHaveAttribute('aria-disabled', 'true');
    // 기다리는 동안은 누르기 전의 상태와 수다 — 화면이 셈해 미리 바꾸지 않는다.
    expect(likeButton()).toHaveAttribute('aria-pressed', 'false');
    expect(likeButton()).toHaveTextContent(/^좋아요 2$/);

    gate.release();
    await pressed(true, 3);
    expect(likeButton()).not.toHaveAttribute('aria-disabled');

    fireEvent.click(likeButton());
    await pressed(false, 2);
    expect(sent(LIKE)).toHaveLength(1);
    expect(sent(UNLIKE)).toHaveLength(1);
  });

  it('토큰이 만료됐으면(401 A003) 재발급 뒤 같은 메서드를 받은 토큰으로 다시 보내고 그 응답을 그린다', async () => {
    const press = serverRoutes()[LIKE];
    await renderApp('/posts/1', {
      as: USER,
      extra: {
        [LIKE]: (config) =>
          claimsOf(bearer(config)!).issue === 1 ? fail(401, 'A003', '만료된 토큰입니다.') : press(config),
        [REISSUE]: () => ok(tokensOf(USER, 2)),
      },
    });
    await pressed(false, 2);

    fireEvent.click(likeButton());

    await pressed(true, 3);
    expect(sent(LIKE).map((r) => r.token)).toEqual([tokenOf(USER), tokenOf(USER, 2)]);
    expect(sent(REISSUE)).toHaveLength(1);
    expect(sent(UNLIKE)).toEqual([]);
    expect(likeError()).toBeNull();
  });

  it('그 401 로 세션이 끝나면(재발급 거부) 글은 로그인 안내로 바뀌고, 누르기의 실패는 문장·코드·로그인 링크와 함께 글 패널에 남는다', async () => {
    await renderApp('/posts/1', {
      as: USER,
      extra: {
        [LIKE]: () => fail(401, 'A003', '만료된 토큰입니다.'),
        [REISSUE]: () => fail(401, 'A003', '만료된 토큰입니다.'),
      },
    });
    await pressed(false, 2);

    fireEvent.click(likeButton());

    // 세션이 끝나 상세를 토큰 없이 다시 받았다 — 누를 버튼 대신 안내다.
    await guideShown();
    expect(sent(DETAIL).at(-1)?.token).toBeNull();
    expect(within(postPanel()).queryByRole('button', { name: /좋아요/ })).toBeNull();
    // 무엇이 났고 어디로 가면 되는지가 남는다.
    expect(likeError()).toHaveTextContent(ERROR_SENTENCES.A003.text);
    expect(within(likeError() as HTMLElement).getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    expect(likeError()!.querySelector('[data-error-code]')).toHaveTextContent('A003');
    expect(sent(LIKE)).toHaveLength(1);
  });
});

describe('글 상세 — 좋아요와 세션', () => {
  it('로그인·로그아웃 뒤 같은 글의 상태는 그 세션의 값이다 — 앞 세션이 받아 둔 상태를 그리지 않는다', async () => {
    likers.add(USER.sub);
    const { router } = await renderApp('/posts/1');
    await guideShown();

    const logIn = async (email: string) => {
      await act(() => router.navigate('/login'));
      type(await screen.findByLabelText('이메일'), email);
      type(screen.getByLabelText('비밀번호'), 'password1!');
      fireEvent.click(within(main()).getByRole('button', { name: '로그인' }));
      await waitFor(() => expect(pathname()).toBe('/posts'));
    };
    /** 상세로 간다 — 받는 동안 그리는 것을 본 뒤 답을 놓는다. */
    const openDetail = async () => {
      const gate = hold(DETAIL);
      const before = sent(DETAIL).length;
      await act(() => router.navigate('/posts/1'));
      await waitFor(() => expect(sent(DETAIL)).toHaveLength(before + 1));
      // 앞 세션이 받아 둔 글을 그리지 않는다 — 받는 동안은 불러오는 중이다.
      expect(main()).toHaveTextContent('불러오는 중…');
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      gate.release();
      await waitFor(() => screen.getByRole('heading', { level: 1, name: TITLE }));
      return sent(DETAIL).at(-1)!;
    };

    await logIn('user@example.com');
    expect((await openDetail()).token).toBe(tokenOf(USER));
    await pressed(true, 3);
    expect(postPanel()).not.toHaveTextContent(GUIDE);

    fireEvent.click(within(banner()).getByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(pathname()).toBe('/login'));
    expect((await openDetail()).token).toBeNull();
    await guideShown();
    expect(within(postPanel()).queryByRole('button', { name: /좋아요/ })).toBeNull();

    await logIn('other@example.com');
    expect((await openDetail()).token).toBe(tokenOf(OTHER));
    await pressed(false, 3);
  });

  it('새로고침하면 세션 복원이 끝난 뒤에 상세를 묻는다 — 되살린 토큰으로 받아 그 계정의 상태를 그린다. 댓글 목록은 기다리지 않는다', async () => {
    likers.add(USER.sub);
    await loggedInOnPreviousPage(USER);
    const gate = hold(REISSUE);
    await renderApp('/posts/1', { extra: { [REISSUE]: () => ok(tokensOf(USER, 2)) } });

    await waitFor(() => expect(sent(REISSUE)).toHaveLength(1));
    await settle();
    // 복원을 기다리는 동안 토큰 없이 묻지 않는다 — 그 답의 `null` 이 되살린 세션의 화면에 남는다.
    expect(sent(DETAIL)).toEqual([]);
    expect(main()).toHaveTextContent('불러오는 중…');
    // 복원을 기다리는 것은 응답이 실린 토큰에 따라 달라지는 상세 조회다(sp-docs/api-contract.md §4.8) — 댓글 목록은 기다리지 않고
    // 토큰 없이 나갔다.
    expect(sent(COMMENTS).map((r) => r.token)).toEqual([null]);

    gate.release();
    await pressed(true, 3);
    expect(sent(DETAIL).map((r) => r.token)).toEqual([tokenOf(USER, 2)]);
    expect(postPanel()).not.toHaveTextContent(GUIDE);
  });

  it('새로고침의 복원이 거부되면 토큰 없이 묻고 로그인 안내다', async () => {
    await loggedInOnPreviousPage(USER);
    await renderApp('/posts/1', { extra: { [REISSUE]: () => fail(401, 'A002', '유효하지 않은 토큰입니다.') } });

    await guideShown();
    expect(sent(REISSUE)).toHaveLength(1);
    expect(sent(DETAIL).map((r) => r.token)).toEqual([null]);
  });

  it('누르기의 응답을 기다리는 사이에 세션이 끝났으면 그 응답을 그리지 않는다 — 토큰 없이 다시 받은 상태가 남는다', async () => {
    await renderApp('/posts/1', {
      as: USER,
      extra: {
        // 댓글을 쓰는 사이 토큰이 만료됐고 재발급도 거부된다 — 세션이 끝난다(lib/api/client.ts).
        [ADD_COMMENT]: () => fail(401, 'A003', '만료된 토큰입니다.'),
        [REISSUE]: () => fail(401, 'A003', '만료된 토큰입니다.'),
      },
    });
    await pressed(false, 2);

    const gate = hold(LIKE);
    fireEvent.click(likeButton());
    await waitFor(() => expect(sent(LIKE)).toHaveLength(1));
    type(screen.getByPlaceholderText(/^댓글/), '댓글');
    fireEvent.click(within(main()).getByRole('button', { name: '등록' }));
    await guideShown();
    expect(sent(DETAIL).at(-1)?.token).toBeNull();

    // 서버는 앞 세션의 계정으로 눌렀다 — 그 답이 지금 화면의 상태가 되지 않는다.
    gate.release();
    await settle();
    expect(postPanel()).toHaveTextContent(GUIDE);
    expect(within(postPanel()).queryByRole('button', { name: /좋아요/ })).toBeNull();
    expect(postPanel().querySelector('[aria-pressed]')).toBeNull();
  });
});

describe('글 상세 — 좋아요와 상세의 재조회', () => {
  it('누르기보다 먼저 보낸 상세 조회가 늦게 와도 누른 응답을 덮지 않는다 — 그 조회 대신 다시 읽어 그 사이 바뀐 값도 그린다', async () => {
    await renderApp('/posts/1', { as: USER });
    await pressed(false, 2);
    const header = () => postPanel().querySelector('header')!;
    expect(header()).toHaveTextContent('댓글 0');

    // 댓글을 쓰면 상세를 다시 받는다 — 그 조회는 누르기 전의 상태를 읽고 늦게 온다.
    const stale = hold(DETAIL);
    const before = sent(DETAIL).length;
    type(screen.getByPlaceholderText(/^댓글/), '첫 댓글');
    fireEvent.click(within(main()).getByRole('button', { name: '등록' }));
    await waitFor(() => expect(sent(DETAIL)).toHaveLength(before + 1));

    fireEvent.click(likeButton());
    await pressed(true, 3);
    // 늦을 조회를 버리고 다시 읽었다 — 누른 뒤의 서버를 읽은 값이다.
    await waitFor(() => expect(sent(DETAIL)).toHaveLength(before + 2));
    await waitFor(() => expect(header()).toHaveTextContent('댓글 1'));

    stale.release();
    await settle();
    await pressed(true, 3);
    expect(header()).toHaveTextContent('댓글 1');
  });

  it('응답을 기다리는 사이 다른 조회가 누른 뒤의 상세를 받아 왔어도 응답이 오면 응답의 상태다 — 받아 둔 상태를 뒤집지 않는다', async () => {
    await renderApp('/posts/1', { as: USER });
    await pressed(false, 2);

    // 서버는 누르기를 받아 처리했고 답만 늦다(스텁은 요청이 닿은 때 쓴다).
    const gate = hold(LIKE);
    fireEvent.click(likeButton());
    await waitFor(() => expect(sent(LIKE)).toHaveLength(1));
    // 그 사이 댓글을 써 상세를 다시 받는다 — 누른 뒤의 서버를 읽어 이미 눌린 상태다.
    const before = sent(DETAIL).length;
    type(screen.getByPlaceholderText(/^댓글/), '댓글');
    fireEvent.click(within(main()).getByRole('button', { name: '등록' }));
    await waitFor(() => expect(sent(DETAIL)).toHaveLength(before + 1));
    await pressed(true, 3);

    gate.release();
    // 버튼이 풀리면 응답을 처리한 뒤다.
    await waitFor(() => expect(likeButton()).not.toHaveAttribute('aria-disabled'));
    await pressed(true, 3);
  });
});

describe('글 상세 — 좋아요와 다른 글', () => {
  it('응답을 기다리는 사이 다른 글의 상세로 가면 그 글은 새 화면이다 — 버튼이 막히지 않고 그 글의 상태와 수이며, 늦게 온 응답은 보낸 글에 들어간다', async () => {
    const { router } = await renderApp('/posts/1', { as: USER, extra: otherPostRoutes() });
    await pressed(false, 2);
    const gate = hold(LIKE);
    fireEvent.click(likeButton());
    await waitFor(() => expect(sent(LIKE)).toHaveLength(1));

    // 같은 라우트의 다른 글로 바로 간다 — 앱에서 기록으로 두 칸 뒤로 가는 것이 그 예다(e2e/like.spec.ts 가 그 길로 본다).
    await act(() => router.navigate('/posts/2'));
    await pressed(false, 40, OTHER_TITLE);
    // 기다리는 것은 앞 글의 화면이다 — 이 글의 버튼은 막히지 않는다.
    expect(likeButton(OTHER_TITLE)).not.toHaveAttribute('aria-disabled');
    fireEvent.click(likeButton(OTHER_TITLE));
    await pressed(true, 41, OTHER_TITLE);
    expect(sent(OTHER_LIKE)).toHaveLength(1);

    // 앞 글의 응답이 와도 이 글의 상태가 되지 않는다.
    gate.release();
    await settle();
    await pressed(true, 41, OTHER_TITLE);

    // 그 응답은 보낸 글에 들어갔다 — 다시 열면 받아 둔 그 글이 응답의 상태다. 다시 받는 조회는 붙들었다.
    const reread = hold(DETAIL);
    await act(() => router.navigate('/posts/1'));
    await pressed(true, 3);
    reread.release();
    await settle();
  });

  it('화면 하나가 다른 글로 이어져도 늦게 온 응답은 보낸 글에 들어간다 — 그 화면이 지금 그리는 글에 넣지 않는다', async () => {
    const { router } = await renderDetailWithoutKey('/posts/1', { as: USER, extra: otherPostRoutes() });
    await pressed(false, 2);
    const gate = hold(LIKE);
    fireEvent.click(likeButton());
    await waitFor(() => expect(sent(LIKE)).toHaveLength(1));

    await act(() => router.navigate('/posts/2'));
    await pressed(false, 40, OTHER_TITLE);

    gate.release();
    // 화면 하나가 이어지므로 버튼이 풀리면 앞 글의 응답을 처리한 뒤다.
    await waitFor(() => expect(likeButton(OTHER_TITLE)).not.toHaveAttribute('aria-disabled'));
    await pressed(false, 40, OTHER_TITLE);

    const reread = hold(DETAIL);
    await act(() => router.navigate('/posts/1'));
    await pressed(true, 3);
    reread.release();
    await settle();
  });
});

describe('글 목록 — 좋아요 수', () => {
  it('표에는 좋아요 칸에, 좁은 화면의 줄 목록에는 「좋아요 N」 으로 그 글의 좋아요 수를 그린다', async () => {
    await renderApp('/posts', {
      extra: {
        [LIST]: (config) =>
          ok(
            pageOf(
              (config.params as Query | undefined)?.category === 'NOTICE'
                ? []
                : [listItem(2, '많이 받은 글', 12), listItem(1, '아무도 누르지 않은 글', 0)],
            ),
          ),
      },
    });
    const places = (title: string) =>
      within(main())
        .queryAllByRole('link', { name: title })
        .map((link) => link.closest('tr, li') as HTMLElement);
    await waitFor(() => expect(places('많이 받은 글')).toHaveLength(2));

    const headers = [...main().querySelectorAll('thead th')].map((th) => th.textContent);
    const column = headers.indexOf('좋아요');
    expect(column).toBeGreaterThan(-1);
    for (const [title, count] of [
      ['많이 받은 글', '12'],
      ['아무도 누르지 않은 글', '0'],
    ]) {
      const row = places(title).find((place) => place.tagName === 'TR') as HTMLTableRowElement;
      const line = places(title).find((place) => place.tagName === 'LI')!;
      expect(row.cells[column]).toHaveTextContent(new RegExp(`^${count}$`));
      expect(line).toHaveTextContent(`좋아요 ${count}`);
    }
  });
});
