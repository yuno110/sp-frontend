import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AFTER_WITHDRAWAL, ERROR_SENTENCES, MY_PROFILE, NO_RESPONSE } from '@/lib/api/errorCodes';
import { holds } from '@/test/holds';

/**
 * 가입과 탈퇴를 사용자 흐름으로 합친다 (sp-docs/plan/phase2.md §7.2 F-04). 서버 계약은 그대로다 — 가입은 계정 → 로그인 →
 * 프로필, 탈퇴는 계정 → 프로필이다(api-contract.md §9.1·§9.1.1). **요청 순서는 어댑터가 받은 요청의 기록으로 단언한다.**
 *
 * 화면은 프로덕션 모드와 StrictMode 로 그린다 — 흉내는 src/pages/userCopy.test.tsx 와 같다. 요청은 axios 의 기본 어댑터로
 * 받는다. 재발급은 재시도 인터셉터가 없는 별도 인스턴스로 나가므로 인스턴스가 만들어지기 전에 기본값을 바꾼다.
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

type Reply = { status: number; body: unknown } | 'no-response';
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;
type Routes = Record<string, Handler>;
type FieldErrors = Array<{ field: string; message: string }>;

const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data, error: null } });
const NO_CONTENT: Reply = { status: 204, body: '' };
const fail = (status: number, code: string, fieldErrors: FieldErrors = []): Reply => ({
  status,
  body: { success: false, data: null, error: { code, message: code, fieldErrors } },
});

const CREATE_ACCOUNT = 'POST /api/v1/accounts';
const LOGIN = 'POST /api/v1/auth/login';
const CREATE_PROFILE = 'POST /api/v1/members';
const REISSUE = 'POST /api/v1/auth/reissue';
const LOGOUT = 'POST /api/v1/auth/logout';
const WITHDRAW_ACCOUNT = 'DELETE /api/v1/accounts/me';
const WITHDRAW_PROFILE = 'DELETE /api/v1/members/me';

const EMAIL = 'new@example.com';
/** 가입에서 입력하는 비밀번호. 어디에 남는지 문자열로 찾으므로 다른 값과 겹치지 않게 둔다. */
const PASSWORD = 'Signup-Passw0rd!';

const PROFILE = { accountId: 7, nickname: '테스트닉' };
const ACCOUNT = { email: 'user@example.com', createdAt: '2026-10-27T10:00:00' };
const EMPTY_PAGE = { content: [], page: 0, size: 10, totalElements: 0, totalPages: 0, first: true, last: true };

const BASE: Routes = {
  'GET /api/v1/members/me': () => ok(PROFILE),
  'GET /api/v1/accounts/me': () => ok(ACCOUNT),
  'GET /api/v1/posts': () => ok(EMPTY_PAGE),
};

let routes: Routes = {};
const requests: Array<{ key: string; auth: unknown; body: unknown; config: InternalAxiosRequestConfig }> = [];
/** 조회를 뺀 요청 — 머리글과 화면의 조회는 순서 단언의 대상이 아니다. */
const writes = () => requests.map((r) => r.key).filter((key) => !key.startsWith('GET '));
const sent = (key: string) => requests.filter((r) => r.key === key);

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push({
    key,
    auth: config.headers?.Authorization ?? null,
    body: typeof config.data === 'string' ? JSON.parse(config.data) : null,
    config,
  });
  const handler = routes[key];
  if (!handler) throw new Error(`스텁에 없는 요청: ${key}`);
  const reply = await handler(config);
  // 응답이 없는 실패 — axios 가 연결 거부·CORS 거부에 내는 모양이다(`response` 가 없다).
  if (reply === 'no-response') throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {});
  const response = { data: reply.body, status: reply.status, statusText: '', headers: {}, config } as AxiosResponse;
  if (reply.status >= 400) {
    throw new AxiosError(`status ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  }
  return response;
}

type Stores = Awaited<ReturnType<typeof renderApp>>;

let restoreAdapter: (() => void) | null = null;
let disposeRouter: (() => void) | null = null;

/** 프로덕션 모드로 모듈을 새로 읽고 그린다. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function renderApp(path: string, { loggedIn = false, extra = {} }: { loggedIn?: boolean; extra?: Routes } = {}) {
  routes = { ...BASE, ...extra };
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
  const { useApiLogStore } = await import('@/stores/apiLogStore');
  if (loggedIn) useAuthStore.getState().setTokens(tokens('1'));
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  const { App } = await import('@/App');
  const { queryClient } = await import('@/lib/queryClient');
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return { useAuthStore, useApiLogStore, router, queryClient };
}

/** 앞 페이지에서 로그인해 둔다. 새로 읽은 모듈에는 영속 저장소(Refresh Token)만 남는다 — 새로고침이다. */
async function loggedInOnPreviousPage() {
  vi.resetModules();
  const { useAuthStore } = await import('@/stores/authStore');
  useAuthStore.getState().setTokens(tokens('0'));
}

function unmount() {
  cleanup();
  disposeRouter?.();
  disposeRouter = null;
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  requests.length = 0;
});

afterEach(() => {
  unmount();
  restoreAdapter?.();
  restoreAdapter = null;
  vi.unstubAllEnvs();
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

/** 머리글 — 문서의 첫 `header` 다. 패널 제목도 `header` 지만 본문 안에 있어 뒤에 온다. */
const banner = () => document.querySelector('header')!;
const main = () => document.querySelector('main')!;
const pathname = () => window.location.pathname;
const atPath = (path: string) => waitFor(() => expect(pathname()).toBe(path));
const until = (texts: string[], el: () => Element = () => document.body) =>
  waitFor(() => {
    for (const text of texts) expect(el()).toHaveTextContent(text);
  });
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const codeShown = (code: string) => document.querySelector(`[data-error-code="${code}"]`);
/** 입력칸 옆 — 그 입력칸을 감싼 `Field`. */
const beside = (input: Element) => input.closest('label')!.parentElement!;

/* ───────── 가입 ───────── */

const SIGNUP: Routes = {
  [CREATE_ACCOUNT]: () => ({ status: 201, body: { success: true, data: { accountId: 7, email: EMAIL }, error: null } }),
  [LOGIN]: () => ok(tokens('L')),
  [CREATE_PROFILE]: () => ({ status: 201, body: { success: true, data: PROFILE, error: null } }),
  // 프로필 등록 전이다 — 머리글의 조회가 404 M001 이다(api-contract.md §3).
  'GET /api/v1/members/me': () => fail(404, 'M001'),
};

/** 계정 정보를 낸다 — 사용자의 첫 제출이다. */
function submitAccount() {
  type(screen.getByLabelText(/^이메일/), EMAIL);
  type(screen.getByLabelText(/^비밀번호/), PASSWORD);
  fireEvent.submit(main().querySelector('form')!);
}

describe('가입', () => {
  it('세 요청 모두 성공 — 사용자는 계정 정보와 닉네임을 내고, 그 사이에 화면이 로그인한다. 로그인 상태로 끝난다', async () => {
    const { useAuthStore } = await renderApp('/signup', { extra: SIGNUP });

    submitAccount();
    // 다음 제출은 닉네임이다 — 사이에 사용자가 누를 로그인 단계가 없다.
    const nickname = await screen.findByLabelText(/^닉네임/);
    expect(pathname()).toBe('/signup/profile');
    expect(writes()).toEqual([CREATE_ACCOUNT, LOGIN]);
    expect(sent(LOGIN)[0].body).toEqual({ email: EMAIL, password: PASSWORD });

    type(nickname, '새닉');
    fireEvent.submit(nickname.closest('form')!);
    await atPath('/posts');

    expect(writes()).toEqual([CREATE_ACCOUNT, LOGIN, CREATE_PROFILE]);
    expect(sent(CREATE_PROFILE)[0].auth).toBe(`Bearer ${accessToken('L')}`);
    expect(useAuthStore.getState().accessToken).toBe(accessToken('L'));
    expect(within(banner()).getByRole('button', { name: /로그아웃/ })).toBeInTheDocument();
  });

  it('프로필을 등록하면 — 머리글이 그 닉네임을 보인다. 등록 전에 받은 「프로필 없음」이 남지 않는다', async () => {
    let registered = false;
    await renderApp('/signup', {
      extra: {
        ...SIGNUP,
        [CREATE_PROFILE]: () => {
          registered = true;
          return { status: 201, body: { success: true, data: PROFILE, error: null } };
        },
        'GET /api/v1/members/me': () => (registered ? ok(PROFILE) : fail(404, 'M001')),
      },
    });
    submitAccount();
    const nickname = await screen.findByLabelText(/^닉네임/);
    await until([MY_PROFILE.M001.text], banner);

    type(nickname, PROFILE.nickname);
    fireEvent.submit(nickname.closest('form')!);

    await atPath('/posts');
    await until([PROFILE.nickname], banner);
    expect(banner()).not.toHaveTextContent(MY_PROFILE.M001.text);
  });

  it.each([
    ['서버 오류 500 C005', (): Reply => fail(500, 'C005'), ERROR_SENTENCES.C005.text, 'C005'],
    ['응답 없음', (): Reply => 'no-response', NO_RESPONSE, null],
  ])('계정을 만든 뒤 로그인이 실패하면(%s) — 로그인 화면으로 가고 계정을 만들었다는 것과 그 실패가 보인다', async (_, reply, sentence, code) => {
    const { useAuthStore } = await renderApp('/signup', { extra: { ...SIGNUP, [LOGIN]: reply } });

    submitAccount();

    await atPath('/login');
    await until(['계정을 만들었습니다.', sentence], main);
    if (code) expect(codeShown(code)).toBeVisible();
    else expect(document.querySelector('[data-error-code]')).toBeNull();
    expect(writes()).toEqual([CREATE_ACCOUNT, LOGIN]);
    expect(useAuthStore.getState().accessToken).toBeNull();
  });

  it('계정 생성이 실패하면 — 그 화면에 남고 로그인하지 않는다. 필드 오류는 입력칸 옆이다', async () => {
    const message = '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.';
    await renderApp('/signup', {
      extra: { ...SIGNUP, [CREATE_ACCOUNT]: () => fail(400, 'C001', [{ field: 'password', message }]) },
    });

    submitAccount();

    await until([message], main);
    expect(within(beside(screen.getByLabelText(/^비밀번호/))).getByText(message)).toBeInTheDocument();
    expect(writes()).toEqual([CREATE_ACCOUNT]);
    expect(pathname()).toBe('/signup');
  });
});

const entriesOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => [s.key(i), s.getItem(s.key(i)!)]);

interface Fiber {
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  memoizedProps: unknown;
  stateNode: { current?: Fiber } | null;
}

/**
 * 지금 그려진 컴포넌트가 받은 props — React 가 DOM 노드에 붙이는 fiber 를 따라 커밋된 트리에서 모은다. **React 의 내부
 * 구조이고 공개 API 가 아니다.** 화면이 쥔 오류 상태는 오류 상자(`ErrorBox`·`ErrorLine`)의 `error` props 로만 밖에서
 * 보인다. 이 걸음이 실제 트리를 읽는지는 쓰는 쪽이 입력칸의 `value` 로 양성 대조를 둔다.
 */
function renderedProps(): Array<Record<string, unknown>> {
  const host = document.querySelector('main');
  const key = host && Object.keys(host).find((k) => k.startsWith('__reactFiber$'));
  if (!host || !key) return [];
  let fiber = (host as unknown as Record<string, Fiber>)[key];
  while (fiber.return) fiber = fiber.return;
  const props: Array<Record<string, unknown>> = [];
  const walk = (first: Fiber | null) => {
    for (let node = first; node; node = node.sibling) {
      if (node.memoizedProps && typeof node.memoizedProps === 'object') {
        props.push(node.memoizedProps as Record<string, unknown>);
      }
      walk(node.child);
    }
  };
  walk((fiber.stateNode?.current ?? fiber).child);
  return props;
}

/** 화면이 쥐고 보이는 오류 — 오류 상자가 받은 `error`. */
const screenErrors = () => renderedProps().flatMap((p) => (p.error == null ? [] : [p.error]));

/** 비밀번호를 들고 있으면 안 되는 자리 가운데 그것을 든 자리의 이름. */
function holding({ useAuthStore, useApiLogStore, queryClient }: Stores): string[] {
  const places: Record<string, unknown> = {
    sessionStorage: entriesOf(sessionStorage),
    localStorage: entriesOf(localStorage),
    'history.state': window.history.state,
    cookie: document.cookie,
    authStore: useAuthStore.getState(),
    apiLogStore: useApiLogStore.getState(),
    queryCache: queryClient.getQueryCache().getAll().map((q) => [q.queryKey, q.state]),
    mutationCache: queryClient.getMutationCache().getAll().map((m) => [m.options.mutationKey, m.state]),
    screenErrors: screenErrors(),
  };
  return Object.keys(places).filter((name) => holds(places[name], PASSWORD));
}

/**
 * 비밀번호는 계정을 만드는 화면의 입력값에만 둔다. 로그인 요청이 끝나면 그 화면이 내려가고, 저장소·스토어·캐시·다음 화면에
 * 넘기는 값에는 어느 때에도 두지 않는다 — 화면과 스토어가 쥐는 오류에도 요청 본문이 없다.
 */
describe('가입의 비밀번호', () => {
  it.each([
    ['로그인 성공 — 프로필 등록으로', (): Reply => ok(tokens('L')), '/signup/profile'],
    ['로그인 실패 — 로그인 화면으로', (): Reply => fail(500, 'C005'), '/login'],
  ])('%s: 로그인 요청 뒤에 비밀번호를 든 자리가 없다', async (_, loginReply, landing) => {
    let stores!: Stores;
    let configHeld = false;
    let inputSeen = false;
    const duringLogin: string[][] = [];
    const onChange: string[] = [];
    stores = await renderApp('/signup', {
      extra: {
        ...SIGNUP,
        [LOGIN]: (config) => {
          // 보낸 때의 요청 설정 — 실패하면 axios 가 이 객체를 오류에 싣는다.
          configHeld = holds(config, PASSWORD);
          // 로그인하는 동안은 입력칸이 그려져 있다 — 화면을 읽는 걸음이 그 값을 찾는다.
          inputSeen = renderedProps().some((p) => p.value === PASSWORD);
          duringLogin.push(holding(stores));
          return loginReply();
        },
      },
    });

    // 양성 대조 — 캐시 자리를 실제로 들여다본다. 비밀번호를 든 query 데이터와 mutation 변수가 있으면 잡히고, 치우면 없다.
    const { MutationObserver } = await import('@tanstack/react-query');
    stores.queryClient.setQueryData(['probe'], PASSWORD);
    await new MutationObserver(stores.queryClient, { mutationFn: async (_variables: string) => null }).mutate(PASSWORD);
    expect(holding(stores)).toEqual(['queryCache', 'mutationCache']);
    stores.queryClient.removeQueries({ queryKey: ['probe'] });
    stores.queryClient.getMutationCache().clear();
    expect(holding(stores)).toEqual([]);

    const watch = () => onChange.push(...holding(stores));
    const unsubscribe = [stores.useAuthStore.subscribe(watch), stores.useApiLogStore.subscribe(watch)];

    submitAccount();
    await atPath(landing);
    // 도착한 화면이 다 그려진 뒤에 본다.
    await (landing === '/login' ? until(['계정을 만들었습니다.'], main) : screen.findByLabelText(/^닉네임/));
    unsubscribe.forEach((u) => u());

    // 양성 대조 — 로그인 요청의 설정은 비밀번호를 실었고, 이 검사는 그 모양을 들여다본다.
    expect(configHeld).toBe(true);
    expect(inputSeen).toBe(true);
    expect(duringLogin).toEqual([[]]);
    expect(onChange).toEqual([]);
    expect(holding(stores)).toEqual([]);
    // 화면에도 없다 — 비밀번호 입력칸을 가진 화면이 내려갔다.
    expect([...document.querySelectorAll('input')].map((input) => input.value)).not.toContain(PASSWORD);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });
});

/**
 * 비밀번호를 싣는 요청이 실패하면 그 화면에 남아 오류를 보인다. 입력칸은 고쳐 다시 내도록 값을 남기지만, 화면이 쥐는 오류는
 * 요청 본문을 비운 사본이다(lib/api/withoutRequestBody.ts).
 */
describe('비밀번호를 싣는 요청이 실패한 화면', () => {
  const changePasswordPanel = () => screen.getByRole('heading', { name: '비밀번호 변경' }).closest('section')!;

  it.each([
    {
      name: '가입 — 계정 생성',
      key: CREATE_ACCOUNT,
      open: () => renderApp('/signup', { extra: { ...SIGNUP, [CREATE_ACCOUNT]: () => fail(409, 'AU002') } }),
      act: submitAccount,
    },
    {
      name: '로그인',
      key: LOGIN,
      open: () => renderApp('/login', { extra: { [LOGIN]: () => fail(401, 'AU003') } }),
      act: () => {
        type(screen.getByLabelText(/^이메일/), EMAIL);
        type(screen.getByLabelText(/^비밀번호/), PASSWORD);
        fireEvent.submit(main().querySelector('form')!);
      },
    },
    {
      name: '마이페이지 — 비밀번호 변경',
      key: 'PATCH /api/v1/accounts/me/password',
      open: () => openMyPage({ 'PATCH /api/v1/accounts/me/password': () => fail(400, 'AU004') }),
      act: () => {
        type(within(changePasswordPanel()).getByLabelText(/^현재 비밀번호/), PASSWORD);
        type(within(changePasswordPanel()).getByLabelText(/^새 비밀번호/), `${PASSWORD}-new`);
        fireEvent.submit(changePasswordPanel().querySelector('form')!);
      },
    },
    {
      name: '마이페이지 — 탈퇴',
      key: WITHDRAW_ACCOUNT,
      open: () => openMyPage({ [WITHDRAW_ACCOUNT]: () => fail(400, 'AU004') }),
      act: () => submitWithdrawal(PASSWORD),
    },
  ])('$name — 화면이 보이는 오류에 비밀번호가 없다. 코드는 보인다', async ({ key, open, act }) => {
    await open();

    act();
    await waitFor(() => expect(screenErrors()).not.toEqual([]));

    // 양성 대조 — 요청은 비밀번호를 실었고, 같은 걸음이 그려진 입력칸에서 그 값을 찾는다.
    expect(holds(sent(key)[0].config, PASSWORD)).toBe(true);
    expect(renderedProps().some((p) => p.value === PASSWORD)).toBe(true);
    expect(holds(screenErrors(), PASSWORD)).toBe(false);
    expect(document.querySelector('[data-error-code]')).toBeVisible();
  });
});

/**
 * 프로필 등록은 인증 요청이다. 공개 경로였을 때는 새로고침 복원이 끝나기 전에 제출해 401 A001 이 날 수 있었다 —
 * 보호된 경로라 복원이 끝날 때까지 그리지 않는다.
 */
describe('프로필 등록 화면과 새로고침 복원', () => {
  it('복원이 끝날 때까지 그리지 않는다 — 끝나면 그리고, 제출이 되살린 Access Token 을 싣는다', async () => {
    await loggedInOnPreviousPage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await renderApp('/signup/profile', {
      extra: {
        ...SIGNUP,
        [REISSUE]: async () => {
          await gate;
          return ok(tokens('1'));
        },
      },
    });
    await until(['게시판'], banner);
    await waitFor(() => expect(writes()).toEqual([REISSUE]));
    expect(screen.queryByLabelText(/^닉네임/)).toBeNull();

    release();
    const nickname = await screen.findByLabelText(/^닉네임/);
    type(nickname, '새닉');
    fireEvent.submit(nickname.closest('form')!);
    await atPath('/posts');

    expect(writes()).toEqual([REISSUE, CREATE_PROFILE]);
    expect(sent(CREATE_PROFILE)[0].auth).toBe(`Bearer ${accessToken('1')}`);
  });

  it('복원이 거부되면 — 그리지 않고 로그인으로 간다', async () => {
    await loggedInOnPreviousPage();
    await renderApp('/signup/profile', { extra: { ...SIGNUP, [REISSUE]: () => fail(401, 'A002') } });

    await atPath('/login');
    expect(screen.queryByLabelText(/^닉네임/)).toBeNull();
    expect(writes()).toEqual([REISSUE]);
  });
});

/* ───────── 탈퇴 ───────── */

const WITHDRAWN: Routes = {
  [WITHDRAW_ACCOUNT]: () => NO_CONTENT,
  [WITHDRAW_PROFILE]: () => NO_CONTENT,
};

/** 마이페이지에서 탈퇴가 남았다는 안내와 로그인 화면에서 다시 시도할 수 없다는 안내. */
const UNFINISHED = '계정은 탈퇴했지만 프로필 탈퇴를 마치지 못했습니다.';
/** 마이페이지가 미리 하는 안내 — 탭의 메모리가 사라지면 그 뒤에는 알릴 수 없다. */
const FOREWARNED = '로그인 상태가 끝나면 다시 시도할 수 없습니다 — 창을 닫거나 새로고침해도 끝납니다.';
const CANNOT_RETRY = '로그인 상태가 끝나 다시 시도할 수 없습니다.';
const DONE = '탈퇴했습니다.';

const withdrawalPanel = () => screen.getByRole('heading', { name: '탈퇴' }).closest('section')!;

async function openMyPage(extra: Routes) {
  const stores = await renderApp('/me', { loggedIn: true, extra });
  await until([ACCOUNT.email, PROFILE.nickname], main);
  return stores;
}

/** 탈퇴 칸에 비밀번호를 넣고 낸다 — 사용자의 한 동작이다. */
function submitWithdrawal(password = 'Passw0rd!') {
  const panel = withdrawalPanel();
  type(within(panel).getByLabelText(/^현재 비밀번호/), password);
  fireEvent.submit(panel.querySelector('form')!);
}

describe('탈퇴', () => {
  it('두 단계 모두 204 — 한 동작이 계정 → 프로필 순서로 같은 Access Token 을 싣고, 끝난 뒤 토큰이 없다', async () => {
    const { useAuthStore } = await openMyPage(WITHDRAWN);

    submitWithdrawal('Passw0rd!');

    await atPath('/login');
    await until([DONE], main);
    expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE]);
    expect(sent(WITHDRAW_ACCOUNT)[0].body).toEqual({ password: 'Passw0rd!' });
    // 프로필 탈퇴는 계정 탈퇴에서 쓰던 Access Token 으로 나갔다 — 토큰은 그 뒤에 지운다.
    expect(sent(WITHDRAW_PROFILE)[0].auth).toBe(`Bearer ${accessToken('1')}`);
    expect(sent(WITHDRAW_PROFILE)[0].auth).toBe(sent(WITHDRAW_ACCOUNT)[0].auth);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(sessionStorage.length).toBe(0);
    expect(within(banner()).getByRole('link', { name: '로그인' })).toBeInTheDocument();
  });

  it.each([
    ['비밀번호가 틀림 — 400 AU004', 'wrong', (): Reply => fail(400, 'AU004'), ERROR_SENTENCES.AU004.text],
    [
      '비밀번호가 비었음 — 400 C001',
      '',
      (): Reply => fail(400, 'C001', [{ field: 'password', message: '비밀번호를 입력해주세요.' }]),
      '비밀번호를 입력해주세요.',
    ],
  ])('첫 단계가 실패하면(%s) — 둘째 요청이 없고 토큰이 남는다', async (_, password, reply, shown) => {
    const { useAuthStore } = await openMyPage({ ...WITHDRAWN, [WITHDRAW_ACCOUNT]: reply });

    submitWithdrawal(password);
    await until([shown], withdrawalPanel);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writes()).toEqual([WITHDRAW_ACCOUNT]);
    expect(pathname()).toBe('/me');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    // 계정은 탈퇴하지 않았다 — 마치지 못했다는 안내가 없다.
    expect(withdrawalPanel()).not.toHaveTextContent(UNFINISHED);
    expect(useAuthStore.getState().withdrawal).toBeNull();
  });

  it('둘째 단계가 404 M001 이면 — 지울 프로필이 없는 것이다. 끝난 것으로 처리한다', async () => {
    const { useAuthStore } = await openMyPage({ ...WITHDRAWN, [WITHDRAW_PROFILE]: () => fail(404, 'M001') });

    submitWithdrawal();

    await atPath('/login');
    await until([DONE], main);
    expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(sessionStorage.length).toBe(0);
    expect(document.querySelector('[data-error-code]')).toBeNull();
  });

  it.each([
    ['서버 오류 500 C005', (): Reply => fail(500, 'C005'), ERROR_SENTENCES.C005.text, 'C005'],
    ['응답 없음', (): Reply => 'no-response', NO_RESPONSE, null],
  ])('둘째 단계가 그 밖의 이유로 실패하면(%s) — 알리고, Access Token 이 남아 있어 다시 시도할 수 있다', async (_, reply, sentence, code) => {
    const { useAuthStore } = await openMyPage({ ...WITHDRAWN, [WITHDRAW_PROFILE]: reply });

    submitWithdrawal();

    await until([UNFINISHED, sentence], withdrawalPanel);
    // 다시 시도할 수 없게 되는 경우를 미리 알린다 — 창을 닫거나 새로고침하면 그 뒤에는 알릴 수 없다.
    expect(withdrawalPanel()).toHaveTextContent(FOREWARNED);
    if (code) expect(codeShown(code)).toBeVisible();
    expect(pathname()).toBe('/me');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    // 비밀번호는 다시 받는다 — 첫 단계에 쓴 값을 입력칸에 남기지 않는다.
    expect(within(withdrawalPanel()).getByLabelText(/^현재 비밀번호/)).toHaveValue('');
    expect(within(withdrawalPanel()).getByRole('button', { name: '다시 시도' })).toBeEnabled();
  });

  it('다시 시도는 첫 단계부터 부르고 다시 받은 비밀번호를 싣는다', async () => {
    let profileCalls = 0;
    await openMyPage({
      ...WITHDRAWN,
      [WITHDRAW_PROFILE]: () => (++profileCalls === 1 ? fail(500, 'C005') : NO_CONTENT),
    });

    submitWithdrawal('first-try');
    await screen.findByRole('button', { name: '다시 시도' });
    submitWithdrawal('second-try');

    await atPath('/login');
    await until([DONE], main);
    expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE, WITHDRAW_ACCOUNT, WITHDRAW_PROFILE]);
    expect(sent(WITHDRAW_ACCOUNT).map((r) => r.body)).toEqual([{ password: 'first-try' }, { password: 'second-try' }]);
  });

  it('마이페이지를 떠났다 돌아와도 — 탈퇴가 남았다는 안내가 보이고 다시 시도할 수 있다', async () => {
    let profileCalls = 0;
    await openMyPage({
      ...WITHDRAWN,
      [WITHDRAW_PROFILE]: () => (++profileCalls === 1 ? fail(500, 'C005') : NO_CONTENT),
    });
    submitWithdrawal();
    await screen.findByRole('button', { name: '다시 시도' });

    fireEvent.click(within(banner()).getByRole('link', { name: '게시판' }));
    await until(['등록된 게시글이 없다'], main);
    fireEvent.click(within(banner()).getByRole('link', { name: '마이페이지' }));
    await until([UNFINISHED], withdrawalPanel);

    submitWithdrawal();
    await atPath('/login');
    expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE, WITHDRAW_ACCOUNT, WITHDRAW_PROFILE]);
  });
});

/**
 * 계정 탈퇴가 Refresh Token 을 지웠으므로 Access Token 을 잃으면 다시 시도할 수 없다(phase2.md F-04 의 블록인용). 둘째 단계가
 * 401 A003 이면 재발급이 실패해 토큰이 비는 것은 F-02 의 동작 그대로다 — 보호된 화면은 로그인으로 가고, 로그인 화면이 그 사실을
 * 보인다. 새로고침·창 닫기는 탭의 메모리가 사라지므로 마이페이지가 미리 알린다 — 그 안내는 위 「그 밖의 이유로 실패하면 —
 * 알리고」 테스트가 본다(`FOREWARNED`).
 */
describe('탈퇴 — 다시 시도할 수 없게 되면', () => {
  /** 로그인 화면의 안내 상자 — 그 안내 문장을 담은 줄의 부모다. */
  const cannotRetryBox = () => screen.getByText(new RegExp(CANNOT_RETRY)).parentElement!;

  it('둘째 단계가 401 A003 이고 재발급도 거부되면 — 토큰이 비고 로그인 화면이 그 사실과 코드를 보인다', async () => {
    const { useAuthStore } = await openMyPage({
      ...WITHDRAWN,
      [WITHDRAW_PROFILE]: () => fail(401, 'A003'),
      [REISSUE]: () => fail(401, 'A002'),
    });

    submitWithdrawal();

    await atPath('/login');
    await until([UNFINISHED, CANNOT_RETRY, AFTER_WITHDRAWAL.A003.text], main);
    expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE, REISSUE]);
    expect(within(cannotRetryBox()).getByText('A003')).toBeVisible();
    // 다시 로그인하라고 하지 않는다 — 탈퇴한 계정은 로그인할 수 없다. 세션이 끝났다는 일반 안내 대신 이 안내다.
    expect(main()).not.toHaveTextContent(ERROR_SENTENCES.A003.text);
    expect(main()).not.toHaveTextContent('로그인 상태를 이어가지 못했습니다.');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it('남은 채로 다시 시도한 첫 단계가 401 A003 이고 재발급도 거부되면 — 같다', async () => {
    let accountCalls = 0;
    await openMyPage({
      ...WITHDRAWN,
      [WITHDRAW_ACCOUNT]: () => (++accountCalls === 1 ? NO_CONTENT : fail(401, 'A003')),
      [WITHDRAW_PROFILE]: () => fail(500, 'C005'),
      [REISSUE]: () => fail(401, 'A002'),
    });
    submitWithdrawal();
    await screen.findByRole('button', { name: '다시 시도' });

    submitWithdrawal();

    await atPath('/login');
    await until([UNFINISHED, CANNOT_RETRY], main);
    expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE, WITHDRAW_ACCOUNT, REISSUE]);
    expect(within(cannotRetryBox()).getByText('A003')).toBeVisible();
  });

  it('남은 채로 로그아웃하면 — 로그인 화면이 그 사실을 보인다', async () => {
    await openMyPage({ ...WITHDRAWN, [WITHDRAW_PROFILE]: () => fail(500, 'C005'), [LOGOUT]: () => NO_CONTENT });
    submitWithdrawal();
    await screen.findByRole('button', { name: '다시 시도' });

    fireEvent.click(within(banner()).getByRole('button', { name: /로그아웃/ }));

    await atPath('/login');
    await until([UNFINISHED, CANNOT_RETRY], main);
    expect(document.querySelector('[data-error-code]')).toBeNull();
  });

  it('토큰이 남아 있는 동안 로그인 화면에 가면 — 다시 시도할 수 없다고 하지 않고, 남은 탈퇴의 표시도 지우지 않는다', async () => {
    const { useAuthStore, router } = await openMyPage({ ...WITHDRAWN, [WITHDRAW_PROFILE]: () => fail(500, 'C005') });
    submitWithdrawal();
    await screen.findByRole('button', { name: '다시 시도' });

    await act(() => router.navigate('/login'));
    await until(['계정이 없으면'], main);
    expect(main()).not.toHaveTextContent(CANNOT_RETRY);
    expect(useAuthStore.getState().withdrawal).toBe('account');

    await act(() => router.navigate('/me'));
    await until([UNFINISHED], withdrawalPanel);
  });

  /**
   * 재발급이 응답하지 못하면(5xx·응답 없음) 토큰이 남아 마이페이지에 머문다(F-02). 그 실패의 안내는 계정이 남아 있을 때만
   * 다시 로그인하라고 한다 — 탈퇴한 계정은 로그인할 수 없다.
   */
  it.each([
    ['계정 탈퇴 뒤의 둘째 단계 — 재발급 503', { [WITHDRAW_PROFILE]: () => fail(401, 'A003'), [REISSUE]: () => fail(503, 'C005') }, false],
    ['계정 탈퇴 뒤의 둘째 단계 — 재발급 응답 없음', { [WITHDRAW_PROFILE]: () => fail(401, 'A003'), [REISSUE]: (): Reply => 'no-response' }, false],
    ['첫 단계 — 계정은 그대로다', { [WITHDRAW_ACCOUNT]: () => fail(401, 'A003'), [REISSUE]: () => fail(503, 'C005') }, true],
  ] as const)('%s: 401 A003 이 남으면 — 다시 로그인하라는 안내는 계정이 남아 있을 때만이다', async (_, extra, accountRemains) => {
    const { useAuthStore } = await openMyPage({ ...WITHDRAWN, ...extra });

    submitWithdrawal();

    await waitFor(() => expect(within(withdrawalPanel()).getByText('A003')).toBeVisible());
    expect(writes()).toEqual(accountRemains ? [WITHDRAW_ACCOUNT, REISSUE] : [WITHDRAW_ACCOUNT, WITHDRAW_PROFILE, REISSUE]);
    expect(pathname()).toBe('/me');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
    if (accountRemains) {
      expect(withdrawalPanel()).toHaveTextContent(ERROR_SENTENCES.A003.text);
      expect(within(withdrawalPanel()).getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    } else {
      expect(withdrawalPanel()).toHaveTextContent(AFTER_WITHDRAWAL.A003.text);
      expect(withdrawalPanel()).not.toHaveTextContent(ERROR_SENTENCES.A003.text);
      expect(within(withdrawalPanel()).queryByRole('link')).toBeNull();
    }
  });

  it('다시 로그인하면 그 표시를 지운다 — 로그인과 재발급은 탈퇴한 계정에 토큰을 주지 않는다', async () => {
    vi.resetModules();
    const { useAuthStore } = await import('@/stores/authStore');
    useAuthStore.getState().setWithdrawal('account');

    useAuthStore.getState().setTokens(tokens('2'));

    expect(useAuthStore.getState().withdrawal).toBeNull();
  });
});

describe('로그인 화면이 이어 보이는 안내', () => {
  it.each([
    [
      '계정을 만든 뒤 로그인하지 못함',
      '계정을 만들었습니다.',
      async () => {
        await renderApp('/signup', { extra: { ...SIGNUP, [LOGIN]: () => fail(500, 'C005') } });
        submitAccount();
      },
    ],
    [
      '탈퇴를 마침',
      DONE,
      async () => {
        await openMyPage(WITHDRAWN);
        submitWithdrawal();
      },
    ],
  ])('%s — 한 번 보이고 나면 지운다. 다른 화면에 갔다 다시 와도 보이지 않는다', async (_, notice, act) => {
    await act();
    await atPath('/login');
    await until([notice], main);

    fireEvent.click(within(banner()).getByRole('link', { name: '게시판' }));
    await until(['등록된 게시글이 없다'], main);
    fireEvent.click(within(banner()).getByRole('link', { name: '로그인' }));
    await until(['계정이 없으면'], main);

    expect(main()).not.toHaveTextContent(notice);
  });
});

/**
 * 「토큰 비우기」는 서버에 알리지 않고 이 탭의 토큰만 지우던 버튼이다(F-03 이 라벨을 바꿨다). 라벨이 아니라 그 동작으로 찾는다 —
 * 마이페이지의 버튼을 하나씩 눌러 토큰이 비었으면 그 전에 서버로 나간 요청이 있었는지 본다. 서버를 부르는 동작은 실패하게
 * 두므로 토큰을 비우는 것은 로그아웃뿐이고, 그것이 이 검사의 양성 대조다.
 */
describe('토큰만 지우는 버튼', () => {
  const FAILING: Routes = {
    'PATCH /api/v1/members/me': () => fail(400, 'C001'),
    'PATCH /api/v1/accounts/me/password': () => fail(400, 'C001'),
    [WITHDRAW_ACCOUNT]: () => fail(400, 'C001'),
    [LOGOUT]: () => NO_CONTENT,
  };

  it('마이페이지의 어느 버튼도 서버에 알리지 않고 토큰을 지우지 않는다', async () => {
    await openMyPage(FAILING);
    const count = screen.getAllByRole('button').length;
    unmount();

    const pressed: Array<{ name: string; cleared: boolean; sent: string[] }> = [];
    for (let i = 0; i < count; i++) {
      requests.length = 0;
      const { useAuthStore } = await openMyPage(FAILING);
      const button = screen.getAllByRole('button')[i];
      const before = requests.length;
      fireEvent.click(button);
      await new Promise((resolve) => setTimeout(resolve, 20));
      pressed.push({
        name: button.textContent?.trim() ?? '',
        cleared: useAuthStore.getState().accessToken === null,
        sent: requests.slice(before).map((r) => r.key),
      });
      unmount();
    }

    // 누른 것이 처리기에 닿았다 — 탈퇴 버튼은 첫 단계를 보냈다.
    expect(pressed.find((p) => p.name === '탈퇴')?.sent).toEqual([WITHDRAW_ACCOUNT]);
    expect(pressed.filter((p) => p.cleared && p.sent.length === 0)).toEqual([]);
    expect(pressed.filter((p) => p.cleared)).toEqual([{ name: '로그아웃', cleared: true, sent: [LOGOUT] }]);
  });
});
