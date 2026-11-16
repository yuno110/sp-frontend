import { StrictMode, useLayoutEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AFTER_WITHDRAWAL,
  EMAIL_VERIFICATION,
  ERROR_SENTENCES,
  MY_PROFILE,
  NO_RESPONSE,
  PASSWORD_RESET,
  WITHDRAWN_PROFILE,
} from '@/lib/api/errorCodes';
import { holds } from '@/test/holds';

/**
 * 가입과 탈퇴를 사용자 흐름으로 합친다 (sp-docs/plan/phase2.md §7.2 F-04). 서버 계약은 그대로다 — 가입은 계정 → (메일의 링크로
 * 인증) → 로그인 → 프로필, 탈퇴는 계정 → 프로필이다(api-contract.md §9.1·§9.1.1·§9.10). 계정을 만든 화면은 로그인하지 않는다 — 인증
 * 전의 로그인은 403 `AU006` 이다(F-08). **요청 순서는 어댑터가 받은 요청의 기록으로 단언한다.** 메일의 링크로 비밀번호를 다시 정하는
 * 화면(§9.11, F-09)도 여기서 본다 — 비밀번호를 싣는 화면의 검사가 이 파일에 있다.
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
let shownErrors: { mock: { calls: Array<[unknown, ...unknown[]]> } } | null = null;

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
  const client = await import('@/lib/api/client');
  // 화면이 보이는 오류를 모은다 — 아래 `screenErrors`.
  shownErrors = vi.spyOn(client, 'describeError');
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
  return { http: client.default, useAuthStore, useApiLogStore, router, queryClient };
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
  shownErrors = null;
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
/** 입력칸 옆 — 그 입력칸을 감싼 `Field`(그 입력칸을 가리키는 label 의 부모). */
const beside = (input: Element) => (input as HTMLInputElement).labels![0].parentElement!;

/* ───────── 가입 ───────── */

const CONFIRM = 'POST /api/v1/accounts/email-verification/confirm';
const RESEND = 'POST /api/v1/accounts/email-verification';
/** 프로필이 탈퇴한 것인지 가르는 공개 조회(api-contract.md §3.1) — 로그인 뒤 내 프로필 조회가 `M001` 일 때 묻는다. */
const MY_PUBLIC_PROFILE = 'GET /api/v1/members/7';

const SIGNUP: Routes = {
  [CREATE_ACCOUNT]: () => ({ status: 201, body: { success: true, data: { accountId: 7, email: EMAIL }, error: null } }),
  [LOGIN]: () => ok(tokens('L')),
  [CREATE_PROFILE]: () => ({ status: 201, body: { success: true, data: PROFILE, error: null } }),
  // 프로필 등록 전이다 — 머리글의 조회가 404 M001 이고(api-contract.md §3) 공개 조회도 없는 프로필이다(§3.1).
  'GET /api/v1/members/me': () => fail(404, 'M001'),
  [MY_PUBLIC_PROFILE]: () => fail(404, 'M001'),
};

/** 계정을 만든 화면의 안내 — 이 말로 끝난다(sp-docs/requirements/member.md §4). */
const CHECK_MAIL = '메일을 확인하세요';

/** 계정 정보를 낸다 — 사용자의 첫 제출이다. */
function submitAccount() {
  type(screen.getByLabelText(/^이메일/), EMAIL);
  type(screen.getByLabelText(/^비밀번호/), PASSWORD);
  fireEvent.submit(main().querySelector('form')!);
}

/** 로그인 화면의 폼을 낸다 — 인증을 마친 계정의 첫 로그인이다. */
function submitFirstLogin() {
  type(screen.getByLabelText(/^이메일/), EMAIL);
  type(screen.getByLabelText(/^비밀번호/), PASSWORD);
  fireEvent.submit(main().querySelector('form')!);
}

describe('가입', () => {
  it('계정을 만들면 — 로그인하지 않고 「메일을 확인하세요」 와 재발송 안내를 보인다. 비밀번호 입력칸이 내려간다', async () => {
    // 응답의 email 을 입력과 다르게 준다 — 안내가 입력이 아니라 서버가 돌려준 값을 싣는지 가른다.
    const serverEmail = `stored-${EMAIL}`;
    const { useAuthStore } = await renderApp('/signup', {
      extra: {
        ...SIGNUP,
        [CREATE_ACCOUNT]: () => ({ status: 201, body: { success: true, data: { accountId: 7, email: serverEmail }, error: null } }),
      },
    });

    submitAccount();

    await until([CHECK_MAIL, `${serverEmail} 계정을 만들었습니다.`], main);
    expect(within(main()).getByRole('link', { name: '인증 메일 다시 받기' })).toHaveAttribute('href', '/verify-email/resend');
    expect(screen.queryByLabelText(/^비밀번호/)).toBeNull();
    await settled();
    expect(writes()).toEqual([CREATE_ACCOUNT]);
    expect(sent(LOGIN)).toEqual([]);
    expect(pathname()).toBe('/signup');
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionGeneration: 0 });
  });

  it('인증한 뒤 첫 로그인 — 프로필이 없으면 프로필 등록으로 가고, 닉네임을 내면 로그인 상태로 끝난다', async () => {
    const { useAuthStore } = await renderApp('/login', { extra: SIGNUP });

    submitFirstLogin();
    const nickname = await screen.findByLabelText(/^닉네임/);
    expect(pathname()).toBe('/signup/profile');
    expect(writes()).toEqual([LOGIN]);
    expect(sent(LOGIN)[0].body).toEqual({ email: EMAIL, password: PASSWORD });
    // 로그인 화면과 머리글이 내 프로필 조회를 함께 기다렸다 — 한 번 나갔다.
    expect(sent('GET /api/v1/members/me')).toHaveLength(1);

    type(nickname, '새닉');
    fireEvent.submit(nickname.closest('form')!);
    await atPath('/posts');

    expect(writes()).toEqual([LOGIN, CREATE_PROFILE]);
    expect(sent(CREATE_PROFILE)[0].auth).toBe(`Bearer ${accessToken('L')}`);
    expect(useAuthStore.getState().accessToken).toBe(accessToken('L'));
    expect(within(banner()).getByRole('button', { name: /로그아웃/ })).toBeInTheDocument();
  });

  it('프로필이 이미 있으면 — 로그인이 그대로 목록으로 간다. 공개 조회를 더 묻지 않는다', async () => {
    await renderApp('/login', { extra: { ...SIGNUP, 'GET /api/v1/members/me': () => ok(PROFILE) } });

    submitFirstLogin();

    await atPath('/posts');
    await until([PROFILE.nickname], banner);
    expect(sent('GET /api/v1/members/me')).toHaveLength(1);
    expect(sent(MY_PUBLIC_PROFILE)).toEqual([]);
  });

  it('내 프로필이 탈퇴한 것이면 — 프로필 등록으로 보내지 않는다(등록이 M007 이다). 목록으로 간다', async () => {
    await renderApp('/login', {
      extra: {
        ...SIGNUP,
        [MY_PUBLIC_PROFILE]: () => ok({ accountId: 7, nickname: '탈퇴한 회원', createdAt: '2026-10-01T09:00:00', deleted: true }),
      },
    });

    submitFirstLogin();

    await atPath('/posts');
    await until(['등록된 게시글이 없습니다'], main);
    // 머리글도 탈퇴한 프로필로 안내한다 — 같은 조회의 답이다.
    await until([WITHDRAWN_PROFILE.M001.text], banner);
  });

  it.each([
    ['응답 없음', (): Reply => 'no-response'],
    ['서버 오류', (): Reply => fail(500, 'C005')],
  ])('내 프로필 조회가 M001 이 아닌 실패(%s)면 — 로그인은 끝났으므로 목록으로 간다', async (_, reply) => {
    const { useAuthStore } = await renderApp('/login', { extra: { ...SIGNUP, 'GET /api/v1/members/me': reply } });

    submitFirstLogin();

    await atPath('/posts');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('L'));
    expect(sent(MY_PUBLIC_PROFILE)).toEqual([]);
  });

  it('공개 조회가 실패하면 — 미등록으로 보고 프로필 등록으로 간다', async () => {
    await renderApp('/login', { extra: { ...SIGNUP, [MY_PUBLIC_PROFILE]: () => 'no-response' } });

    submitFirstLogin();

    await atPath('/signup/profile');
    await screen.findByLabelText(/^닉네임/);
  });

  it('프로필을 등록하면 — 머리글이 그 닉네임을 보인다. 등록 전에 받은 「프로필 없음」이 남지 않는다', async () => {
    let registered = false;
    await renderApp('/login', {
      extra: {
        ...SIGNUP,
        [CREATE_PROFILE]: () => {
          registered = true;
          return { status: 201, body: { success: true, data: PROFILE, error: null } };
        },
        'GET /api/v1/members/me': () => (registered ? ok(PROFILE) : fail(404, 'M001')),
      },
    });
    submitFirstLogin();
    const nickname = await screen.findByLabelText(/^닉네임/);
    await until([MY_PROFILE.M001.text], banner);

    type(nickname, PROFILE.nickname);
    fireEvent.submit(nickname.closest('form')!);

    await atPath('/posts');
    await until([PROFILE.nickname], banner);
    expect(banner()).not.toHaveTextContent(MY_PROFILE.M001.text);
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

  it('로그인한 채로 계정을 만들어도 — 지금 세션이 그대로다. 만든 계정으로 로그인하지 않는다', async () => {
    const { useAuthStore } = await renderApp('/signup', {
      loggedIn: true,
      extra: { ...SIGNUP, 'GET /api/v1/members/me': () => ok(PROFILE) },
    });
    const before = useAuthStore.getState().sessionGeneration;

    submitAccount();

    await until([CHECK_MAIL], main);
    await settled();
    expect(writes()).toEqual([CREATE_ACCOUNT]);
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken('1'),
      refreshToken: 'RT-1',
      sessionGeneration: before,
    });
    expect(within(banner()).getByRole('button', { name: /로그아웃/ })).toBeInTheDocument();
  });
});

/* ───────── 이메일 인증 ───────── */

/** 메일의 링크가 싣는 토큰. 서버는 base64url 로 만든다(sp-auth `AccountTokens`) — `-`·`_` 가 들어간다. */
const LINK_TOKEN = 'Zm9v-YmFy_YmF6-link';
const VERIFY_LINK = `/verify-email#token=${LINK_TOKEN}`;
const CONFIRMED: Routes = { [CONFIRM]: () => NO_CONTENT };
const verifyButton = () => within(main()).queryByRole('button', { name: /이메일 인증하기|확인 중/ });

describe('이메일 인증', () => {
  it('링크를 열면 — 주소창에서 토큰을 지우고 아무 요청도 보내지 않는다. 기록을 하나 더 쌓지 않는다', async () => {
    const entries = window.history.length;
    const { router } = await renderApp(VERIFY_LINK, { extra: CONFIRMED });

    await until(['아래 버튼을 누르면 이메일 인증을 마칩니다.'], main);
    await waitFor(() => expect(window.location.hash).toBe(''));
    await settled();

    expect(pathname()).toBe('/verify-email');
    expect(window.location.href).not.toContain(LINK_TOKEN);
    expect(router.state.location.hash).toBe('');
    expect(window.history.length).toBe(entries);
    expect(verifyButton()).toBeEnabled();
    expect(sent(CONFIRM)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('버튼을 누르면 — 그 토큰으로 한 번 확인하고 마쳤다고 보인다. 토큰을 주지 않으므로 로그인으로 안내한다', async () => {
    const { useAuthStore } = await renderApp(VERIFY_LINK, { extra: CONFIRMED });
    await waitFor(() => expect(window.location.hash).toBe(''));

    fireEvent.click(verifyButton()!);

    await until(['이메일 인증을 마쳤습니다.', '이제 로그인할 수 있습니다.'], main);
    expect(within(main()).getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    expect(verifyButton()).toBeNull();
    expect(within(main()).queryByRole('link', { name: '인증 메일 다시 받기' })).toBeNull();
    expect(sent(CONFIRM).map((r) => r.body)).toEqual([{ token: LINK_TOKEN }]);
    expect(writes()).toEqual([CONFIRM]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it('로그인한 탭에서 눌러도 — 확인 요청에 Access Token 을 싣지 않는다. 세션은 그대로다', async () => {
    const { useAuthStore } = await renderApp(VERIFY_LINK, { loggedIn: true, extra: CONFIRMED });
    await until(['아래 버튼을 누르면'], main);

    fireEvent.click(verifyButton()!);

    await until(['이메일 인증을 마쳤습니다.'], main);
    expect(sent(CONFIRM).map((r) => r.auth)).toEqual([null]);
    // 양성 대조 — 같은 탭의 머리글 조회는 그 토큰을 싣는다.
    expect(sent('GET /api/v1/members/me')[0].auth).toBe(`Bearer ${accessToken('1')}`);
    expect(useAuthStore.getState().accessToken).toBe(accessToken('1'));
  });

  it('쓸 수 없는 링크(AU007)면 — 이미 인증했다면 로그인하라고 하고 로그인과 다시 받기로 안내한다. 같은 토큰으로 다시 보낼 버튼이 없다', async () => {
    await renderApp(VERIFY_LINK, { extra: { [CONFIRM]: () => fail(400, 'AU007') } });
    await until(['아래 버튼을 누르면'], main);

    fireEvent.click(verifyButton()!);

    await until([EMAIL_VERIFICATION.AU007.text], main);
    expect(main()).toHaveTextContent('이미 인증했다면 로그인해 주세요');
    expect(codeShown('AU007')).toBeVisible();
    expect(within(main()).getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    expect(within(main()).getByRole('link', { name: '인증 메일 다시 받기' })).toHaveAttribute('href', '/verify-email/resend');
    expect(verifyButton()).toBeNull();
    expect(main()).not.toHaveTextContent('아래 버튼을 누르면');
    expect(sent(CONFIRM)).toHaveLength(1);
  });

  it('확인이 실패해도 — 화면이 쥐는 오류에 링크의 토큰이 없다. 코드는 보인다', async () => {
    await renderApp(VERIFY_LINK, { extra: { [CONFIRM]: () => fail(400, 'AU007') } });
    await until(['아래 버튼을 누르면'], main);

    fireEvent.click(verifyButton()!);
    await waitFor(() => expect(screenErrors()).not.toEqual([]));

    // 양성 대조 — 요청은 토큰을 실었다. 실패하면 axios 가 그 설정을 오류에 싣는다(lib/api/withoutRequestBody.ts).
    expect(holds(sent(CONFIRM)[0].config, LINK_TOKEN)).toBe(true);
    expect(holds(screenErrors(), LINK_TOKEN)).toBe(false);
    expect(document.body.innerHTML).not.toContain(LINK_TOKEN);
    expect(codeShown('AU007')).toBeVisible();
  });

  it.each([
    ['응답 없음', (): Reply => 'no-response', NO_RESPONSE],
    ['서버 오류', (): Reply => fail(500, 'C005'), ERROR_SENTENCES.C005.text],
  ])('확인이 %s 로 실패하면 — 그 실패를 보이고 버튼이 남는다. 주소창의 토큰을 지운 뒤에도 같은 토큰으로 다시 보낸다', async (_, reply, sentence) => {
    const replies = [reply, (): Reply => NO_CONTENT];
    await renderApp(VERIFY_LINK, { extra: { [CONFIRM]: () => replies.shift()!() } });
    await waitFor(() => expect(window.location.hash).toBe(''));

    fireEvent.click(verifyButton()!);
    await until([sentence], main);
    expect(verifyButton()).toBeEnabled();

    fireEvent.click(verifyButton()!);
    await until(['이메일 인증을 마쳤습니다.'], main);
    expect(sent(CONFIRM).map((r) => r.body)).toEqual([{ token: LINK_TOKEN }, { token: LINK_TOKEN }]);
  });

  it.each([
    ['fragment 가 없다', '/verify-email'],
    ['토큰이 비었다', '/verify-email#token='],
    ['토큰이 아닌 값이다', '/verify-email#code=abc'],
    ['토큰이 쿼리에만 있다 — 읽는 것은 fragment 뿐이다', `/verify-email?token=${LINK_TOKEN}`],
  ])('링크에 토큰이 없으면(%s) — 확인 버튼이 없고 아무 요청도 보내지 않는다. 다시 받기로 안내한다', async (_, path) => {
    await renderApp(path, { extra: CONFIRMED });

    await until(['인증 링크를 찾지 못했습니다.'], main);
    await settled();
    expect(within(main()).queryByRole('button')).toBeNull();
    expect(within(main()).getByRole('link', { name: '인증 메일 다시 받기' })).toHaveAttribute('href', '/verify-email/resend');
    expect(window.location.hash).toBe('');
    expect(writes()).toEqual([]);
  });
});

/* ───────── 인증 메일 다시 받기 ───────── */

const ACCEPTED: Reply = { status: 202, body: { success: true, data: null, error: null } };
/** 202 의 문장 — 메일이 나갔다고 단정하지 않는다. */
const REQUESTED = '요청을 받았습니다.';

/** 이메일을 넣어 낸다. */
function submitResend(email: string) {
  type(within(main()).getByLabelText(/^이메일/), email);
  fireEvent.submit(main().querySelector('form')!);
}

describe('인증 메일 다시 받기', () => {
  it('202 — 계정이 있든 없든 같은 문장이다. 입력한 이메일만 싣는다', async () => {
    // 서버는 계정의 유무와 상태에 상관없이 202 다(api-contract.md §2.4) — 두 이메일 모두 그 답이다.
    await renderApp('/verify-email/resend', { extra: { [RESEND]: () => ACCEPTED } });

    const shown: string[] = [];
    for (const [i, email] of ['unverified@example.com', 'nobody@example.com'].entries()) {
      submitResend(email);
      await waitFor(() => expect(sent(RESEND)).toHaveLength(i + 1));
      await until([REQUESTED], main);
      shown.push(main().textContent ?? '');
    }

    expect(shown[1]).toBe(shown[0]);
    expect(shown[0]).not.toContain('@');
    expect(sent(RESEND).map((r) => r.body)).toEqual([{ email: 'unverified@example.com' }, { email: 'nobody@example.com' }]);
    expect(writes()).toEqual([RESEND, RESEND]);
  });

  it('로그인한 탭에서 내도 — 재발송 요청에 Access Token 을 싣지 않는다', async () => {
    await renderApp('/verify-email/resend', { loggedIn: true, extra: { [RESEND]: () => ACCEPTED } });

    submitResend('unverified@example.com');

    await until([REQUESTED], main);
    expect(sent(RESEND).map((r) => r.auth)).toEqual([null]);
    expect(sent('GET /api/v1/members/me')[0].auth).toBe(`Bearer ${accessToken('1')}`);
  });

  it('이메일 형식이 틀리면(C001) — 입력칸 옆에 보이고 요청을 받았다는 문장이 없다', async () => {
    const message = '올바른 이메일 형식이 아닙니다.';
    await renderApp('/verify-email/resend', {
      extra: { [RESEND]: () => fail(400, 'C001', [{ field: 'email', message }]) },
    });

    submitResend('not-an-email');

    await until([message], main);
    expect(within(beside(within(main()).getByLabelText(/^이메일/))).getByText(message)).toBeInTheDocument();
    expect(codeShown('C001')).toBeVisible();
    // 요약에는 다시 적지 않는다 — 한 번만 보인다.
    expect(within(main()).getAllByText(message)).toHaveLength(1);
    expect(main()).not.toHaveTextContent(REQUESTED);
  });

  it('요청을 받았다고 보인 뒤에 다시 낸 것이 실패하면 — 앞의 문장을 남기지 않는다', async () => {
    const replies = [(): Reply => ACCEPTED, (): Reply => fail(500, 'C005')];
    await renderApp('/verify-email/resend', { extra: { [RESEND]: () => replies.shift()!() } });

    submitResend('unverified@example.com');
    await until([REQUESTED], main);
    submitResend('unverified@example.com');

    await until([ERROR_SENTENCES.C005.text], main);
    expect(main()).not.toHaveTextContent(REQUESTED);
  });
});

/* ───────── 인증 전의 로그인 ───────── */

describe('인증 전의 로그인', () => {
  it('403 AU006 — 인증을 마쳐야 한다고 하고 인증 메일을 다시 받는 화면으로 안내한다. 세션이 되지 않는다', async () => {
    const { useAuthStore } = await renderApp('/login', { extra: { ...SIGNUP, [LOGIN]: () => fail(403, 'AU006') } });

    submitFirstLogin();

    await until([ERROR_SENTENCES.AU006.text], main);
    expect(codeShown('AU006')).toBeVisible();
    const resend = within(main()).getByRole('link', { name: '인증 메일 다시 받기' });
    expect(resend).toHaveAttribute('href', '/verify-email/resend');
    expect(pathname()).toBe('/login');
    expect(writes()).toEqual([LOGIN]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionGeneration: 0 });
    // 프로필을 묻지 않았다 — 로그인이 끝나지 않았다.
    expect(sent('GET /api/v1/members/me')).toEqual([]);

    fireEvent.click(resend);
    await atPath('/verify-email/resend');
    await screen.findByRole('heading', { name: '인증 메일 다시 받기' });
  });
});

/* ───────── 비밀번호 찾기 ───────── */

const REQUEST_RESET = 'POST /api/v1/accounts/password-reset';

/** 이메일을 넣어 낸다 — 비밀번호 찾기 화면의 한 동작이다. */
function submitResetRequest(email: string) {
  type(within(main()).getByLabelText(/^이메일/), email);
  fireEvent.submit(main().querySelector('form')!);
}

describe('비밀번호 찾기', () => {
  it('로그인 화면의 링크로 간다', async () => {
    await renderApp('/login');
    const link = within(main()).getByRole('link', { name: '비밀번호 찾기' });
    expect(link).toHaveAttribute('href', '/reset-password/request');

    fireEvent.click(link);

    await atPath('/reset-password/request');
    await screen.findByRole('heading', { name: '비밀번호 찾기' });
    expect(writes()).toEqual([]);
  });

  it('202 — 계정이 있든 없든 같은 문장이다. 메일이 나갔다고 단정하지 않는다. 입력한 이메일만 싣는다', async () => {
    // 서버는 계정의 유무와 상태에 상관없이 202 다(api-contract.md §2.4) — 두 이메일 모두 그 답이다.
    await renderApp('/reset-password/request', { extra: { [REQUEST_RESET]: () => ACCEPTED } });

    const shown: string[] = [];
    for (const [i, email] of ['user@example.com', 'nobody@example.com'].entries()) {
      submitResetRequest(email);
      await waitFor(() => expect(sent(REQUEST_RESET)).toHaveLength(i + 1));
      await until([REQUESTED], main);
      shown.push(main().textContent ?? '');
    }

    expect(shown[1]).toBe(shown[0]);
    expect(shown[0]).not.toContain('@');
    // 문장 전체를 본다 — 조건부 문장 곁에 「보냈다」 는 단정이 붙어도 걸린다.
    expect(within(main()).getByText(/^요청을 받았습니다\./).textContent).toBe(
      '요청을 받았습니다. 이 이메일로 가입한 계정이 있다면 비밀번호 재설정 메일이 갑니다. 메일함을 확인해 주세요.',
    );
    expect(sent(REQUEST_RESET).map((r) => r.body)).toEqual([{ email: 'user@example.com' }, { email: 'nobody@example.com' }]);
    expect(writes()).toEqual([REQUEST_RESET, REQUEST_RESET]);
  });

  it('로그인한 탭에서 내도 — 재설정 요청에 Access Token 을 싣지 않는다', async () => {
    await renderApp('/reset-password/request', { loggedIn: true, extra: { [REQUEST_RESET]: () => ACCEPTED } });

    submitResetRequest('user@example.com');

    await until([REQUESTED], main);
    expect(sent(REQUEST_RESET).map((r) => r.auth)).toEqual([null]);
    // 양성 대조 — 같은 탭의 머리글 조회는 그 토큰을 싣는다.
    expect(sent('GET /api/v1/members/me')[0].auth).toBe(`Bearer ${accessToken('1')}`);
  });

  it('이메일 형식이 틀리면(C001) — 입력칸 옆에 보이고 요청을 받았다는 문장이 없다', async () => {
    const message = '올바른 이메일 형식이 아닙니다.';
    await renderApp('/reset-password/request', {
      extra: { [REQUEST_RESET]: () => fail(400, 'C001', [{ field: 'email', message }]) },
    });

    submitResetRequest('not-an-email');

    await until([message], main);
    expect(within(beside(within(main()).getByLabelText(/^이메일/))).getByText(message)).toBeInTheDocument();
    expect(codeShown('C001')).toBeVisible();
    // 요약에는 다시 적지 않는다 — 한 번만 보인다.
    expect(within(main()).getAllByText(message)).toHaveLength(1);
    expect(main()).not.toHaveTextContent(REQUESTED);
  });

  it('이메일 형식 오류(C001) 뒤에 고쳐 다시 내 202 면 — 앞의 오류를 남기지 않는다', async () => {
    const message = '올바른 이메일 형식이 아닙니다.';
    const replies = [(): Reply => fail(400, 'C001', [{ field: 'email', message }]), (): Reply => ACCEPTED];
    await renderApp('/reset-password/request', { extra: { [REQUEST_RESET]: () => replies.shift()!() } });

    submitResetRequest('not-an-email');
    await until([message], main);
    submitResetRequest('user@example.com');

    await until([REQUESTED], main);
    expect(codeShown('C001')).toBeNull();
    expect(main()).not.toHaveTextContent(message);
    expect(sent(REQUEST_RESET).map((r) => r.body)).toEqual([{ email: 'not-an-email' }, { email: 'user@example.com' }]);
  });

  it('요청을 받았다고 보인 뒤에 다시 낸 것이 실패하면 — 앞의 문장을 남기지 않는다', async () => {
    const replies = [(): Reply => ACCEPTED, (): Reply => fail(500, 'C005')];
    await renderApp('/reset-password/request', { extra: { [REQUEST_RESET]: () => replies.shift()!() } });

    submitResetRequest('user@example.com');
    await until([REQUESTED], main);
    submitResetRequest('user@example.com');

    await until([ERROR_SENTENCES.C005.text], main);
    expect(main()).not.toHaveTextContent(REQUESTED);
  });
});

/* ───────── 비밀번호 재설정 ───────── */

const CONFIRM_RESET = 'POST /api/v1/accounts/password-reset/confirm';
/** 재설정 메일의 링크 — 인증 메일과 같이 토큰을 fragment 에 싣는다(sp-docs/requirements/member.md §11.5). */
const RESET_LINK = `/reset-password#token=${LINK_TOKEN}`;
const RESET: Routes = { [CONFIRM_RESET]: () => NO_CONTENT };
const resetButton = () => within(main()).queryByRole('button', { name: /비밀번호 바꾸기|바꾸는 중/ });
const newPasswordInput = () => screen.getByLabelText(/^새 비밀번호/);
/** 새 비밀번호의 규칙 위반 — 문장은 sp-docs/requirements/member.md §2 의 비밀번호 규칙의 것이다. */
const NEW_PASSWORD_RULE = '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.';

/** 재설정 화면에 새 비밀번호를 넣고 낸다 — 사용자의 한 동작이다. */
function submitNewPassword(value: string) {
  type(newPasswordInput(), value);
  fireEvent.submit(main().querySelector('form')!);
}

describe('비밀번호 재설정', () => {
  it('링크를 열면 — 주소창에서 토큰을 지우고 아무 요청도 보내지 않는다. 기록을 하나 더 쌓지 않는다', async () => {
    const entries = window.history.length;
    const stores = await renderApp(RESET_LINK, { extra: RESET });

    await screen.findByLabelText(/^새 비밀번호/);
    await waitFor(() => expect(window.location.hash).toBe(''));
    await settled();

    expect(pathname()).toBe('/reset-password');
    expect(window.location.href).not.toContain(LINK_TOKEN);
    expect(stores.router.state.location.hash).toBe('');
    expect(window.history.length).toBe(entries);
    // 토큰은 화면의 상태에만 있다 — 저장소·스토어·캐시·기록의 상태에 옮겨 두지 않는다.
    expect(holding(stores, LINK_TOKEN)).toEqual([]);
    expect(resetButton()).toBeEnabled();
    expect(sent(CONFIRM_RESET)).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('새 비밀번호를 내면 — 링크의 토큰과 함께 한 번 보내고, 토큰을 주지 않으므로 로그인으로 안내한다. 입력칸이 내려간다', async () => {
    const stores = await renderApp(RESET_LINK, { extra: RESET });
    await waitFor(() => expect(window.location.hash).toBe(''));

    submitNewPassword(PASSWORD);

    await until(['비밀번호를 바꿨습니다.', '새 비밀번호로 로그인해 주세요.'], main);
    expect(within(main()).getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText(/^새 비밀번호/)).toBeNull();
    expect(resetButton()).toBeNull();
    expect(within(main()).queryByRole('link', { name: '비밀번호 찾기' })).toBeNull();
    expect(sent(CONFIRM_RESET).map((r) => r.body)).toEqual([{ token: LINK_TOKEN, newPassword: PASSWORD }]);
    expect(writes()).toEqual([CONFIRM_RESET]);
    expect(stores.useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionGeneration: 0 });
    // 새 비밀번호를 든 자리가 없다. 양성 대조 — 요청의 설정은 그것을 실었다.
    expect(holds(sent(CONFIRM_RESET)[0].config, PASSWORD)).toBe(true);
    expect(holding(stores)).toEqual([]);
    expect(document.body.innerHTML).not.toContain(PASSWORD);
  });

  it('로그인한 탭에서 내도 — 확인 요청에 Access Token 을 싣지 않는다. 세션은 그대로다', async () => {
    const { useAuthStore } = await renderApp(RESET_LINK, { loggedIn: true, extra: RESET });
    const before = useAuthStore.getState().sessionGeneration;
    await screen.findByLabelText(/^새 비밀번호/);

    submitNewPassword(PASSWORD);

    await until(['비밀번호를 바꿨습니다.'], main);
    expect(sent(CONFIRM_RESET).map((r) => r.auth)).toEqual([null]);
    // 양성 대조 — 같은 탭의 머리글 조회는 그 토큰을 싣는다.
    expect(sent('GET /api/v1/members/me')[0].auth).toBe(`Bearer ${accessToken('1')}`);
    expect(useAuthStore.getState()).toMatchObject({
      accessToken: accessToken('1'),
      refreshToken: 'RT-1',
      sessionGeneration: before,
    });
  });

  it('새 비밀번호가 규칙에 맞지 않으면(C001) — 입력칸 옆에 보이고, 고쳐서 다시 내면 같은 토큰으로 보내 마친다', async () => {
    const replies = [
      (): Reply => fail(400, 'C001', [{ field: 'newPassword', message: NEW_PASSWORD_RULE }]),
      (): Reply => NO_CONTENT,
    ];
    const stores = await renderApp(RESET_LINK, { extra: { [CONFIRM_RESET]: () => replies.shift()!() } });
    await waitFor(() => expect(window.location.hash).toBe(''));

    submitNewPassword('short');

    await until([NEW_PASSWORD_RULE], main);
    expect(within(beside(newPasswordInput())).getByText(NEW_PASSWORD_RULE)).toBeInTheDocument();
    // 요약에는 다시 적지 않는다 — 한 번만 보인다.
    expect(within(main()).getAllByText(NEW_PASSWORD_RULE)).toHaveLength(1);
    expect(codeShown('C001')).toBeVisible();
    expect(resetButton()).toBeEnabled();
    // 고쳐 다시 내도록 입력값이 남는다. 토큰은 화면의 상태에만 있다 — 쥔 오류에도 다른 자리에도 없다.
    expect(newPasswordInput()).toHaveValue('short');
    expect(holding(stores, LINK_TOKEN)).toEqual([]);

    submitNewPassword(PASSWORD);

    await until(['비밀번호를 바꿨습니다.'], main);
    const bodies = sent(CONFIRM_RESET).map((r) => r.body as { token: string; newPassword: string });
    expect(bodies.map((b) => b.newPassword)).toEqual(['short', PASSWORD]);
    // 두 요청이 같은 토큰을 싣는다 — 주소창의 fragment 는 첫 요청 전에 지웠다. 그 위반은 토큰을 쓰지 않았다(requirements/member.md §11.4).
    expect(bodies[1].token).toBe(bodies[0].token);
    expect(bodies[0].token).toBe(LINK_TOKEN);
    expect(codeShown('C001')).toBeNull();
    expect(main()).not.toHaveTextContent(NEW_PASSWORD_RULE);
  });

  it('쓸 수 없는 링크(AU007)면 — 폼을 내리고 비밀번호 찾기로 안내한다. 같은 토큰으로 다시 낼 수 없다', async () => {
    await renderApp(RESET_LINK, { extra: { [CONFIRM_RESET]: () => fail(400, 'AU007') } });
    await screen.findByLabelText(/^새 비밀번호/);

    submitNewPassword(PASSWORD);

    await until([PASSWORD_RESET.AU007.text], main);
    expect(codeShown('AU007')).toBeVisible();
    // 안내는 오류 상자의 링크다 — 같은 곳으로 가는 링크를 겹쳐 두지 않는다.
    const box = codeShown('AU007')!.closest<HTMLElement>('.bg-danger-50')!;
    const find = within(box).getByRole('link', { name: '비밀번호 찾기' });
    expect(find).toHaveAttribute('href', '/reset-password/request');
    const links = within(main()).getAllByRole('link', { name: '비밀번호 찾기' });
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(find);
    expect(screen.queryByLabelText(/^새 비밀번호/)).toBeNull();
    expect(resetButton()).toBeNull();
    expect(sent(CONFIRM_RESET)).toHaveLength(1);

    fireEvent.click(find);
    await atPath('/reset-password/request');
    await screen.findByRole('heading', { name: '비밀번호 찾기' });
  });

  it('확인이 실패해도 — 화면이 쥐는 오류에 링크의 토큰이 없다. 코드는 보인다', async () => {
    await renderApp(RESET_LINK, { extra: { [CONFIRM_RESET]: () => fail(400, 'AU007') } });
    await screen.findByLabelText(/^새 비밀번호/);

    submitNewPassword(PASSWORD);
    await waitFor(() => expect(screenErrors()).not.toEqual([]));

    // 양성 대조 — 요청은 토큰을 실었다. 실패하면 axios 가 그 설정을 오류에 싣는다(lib/api/withoutRequestBody.ts).
    expect(holds(sent(CONFIRM_RESET)[0].config, LINK_TOKEN)).toBe(true);
    expect(holds(screenErrors(), LINK_TOKEN)).toBe(false);
    expect(document.body.innerHTML).not.toContain(LINK_TOKEN);
    expect(codeShown('AU007')).toBeVisible();
  });

  it.each([
    ['응답 없음', (): Reply => 'no-response', NO_RESPONSE],
    ['서버 오류', (): Reply => fail(500, 'C005'), ERROR_SENTENCES.C005.text],
  ])('확인이 %s 로 실패하면 — 그 실패를 보이고 폼이 남는다. 주소창의 토큰을 지운 뒤에도 같은 토큰으로 다시 보낸다', async (_, reply, sentence) => {
    const replies = [reply, (): Reply => NO_CONTENT];
    await renderApp(RESET_LINK, { extra: { [CONFIRM_RESET]: () => replies.shift()!() } });
    await waitFor(() => expect(window.location.hash).toBe(''));

    submitNewPassword(PASSWORD);
    await until([sentence], main);
    expect(resetButton()).toBeEnabled();
    expect(newPasswordInput()).toHaveValue(PASSWORD);

    fireEvent.submit(main().querySelector('form')!);
    await until(['비밀번호를 바꿨습니다.'], main);
    expect(sent(CONFIRM_RESET).map((r) => r.body)).toEqual([
      { token: LINK_TOKEN, newPassword: PASSWORD },
      { token: LINK_TOKEN, newPassword: PASSWORD },
    ]);
  });

  it.each([
    ['fragment 가 없다', '/reset-password'],
    ['토큰이 비었다', '/reset-password#token='],
    ['토큰이 아닌 값이다', '/reset-password#code=abc'],
    ['토큰이 쿼리에만 있다 — 읽는 것은 fragment 뿐이다', `/reset-password?token=${LINK_TOKEN}`],
  ])('링크에 토큰이 없으면(%s) — 새 비밀번호를 받지 않고 아무 요청도 보내지 않는다. 비밀번호 찾기로 안내한다', async (_, path) => {
    await renderApp(path, { extra: RESET });

    await until(['재설정 링크를 찾지 못했습니다.'], main);
    await settled();
    expect(screen.queryByLabelText(/^새 비밀번호/)).toBeNull();
    expect(within(main()).queryByRole('button')).toBeNull();
    expect(within(main()).getByRole('link', { name: '비밀번호 찾기' })).toHaveAttribute('href', '/reset-password/request');
    expect(window.location.hash).toBe('');
    expect(writes()).toEqual([]);
  });
});

const entriesOf = (s: Storage) => Array.from({ length: s.length }, (_, i) => [s.key(i), s.getItem(s.key(i)!)]);

/**
 * 화면이 쥐고 보인 오류 — 그려진 뒤로 오류 표시가 받은 모든 값이다. 화면의 오류 상태는 오류 표시(`ErrorBox`·`ErrorLine`)로만
 * 밖에서 보이고 둘 다 그것을 `describeError` 에 넘긴다(components/ui.tsx). 지금 그려진 것만이 아니라 **한 번이라도 보인 것을**
 * 본다 — 다음 화면으로 넘어가며 사라진 오류도 잡힌다. 이 자리가 비밀번호를 찾을 수 있는지는 아래 양성 대조가 본다.
 */
const screenErrors = () => (shownErrors?.mock.calls ?? []).map(([error]) => error);

/** 그려진 입력칸이 지금 그 값을 쥐었는가. */
const inputHolds = (value: string) => [...document.querySelectorAll('input')].some((input) => input.value === value);

/** 비밀번호(또는 `needle` — 예: 링크의 토큰)를 들고 있으면 안 되는 자리 가운데 그것을 든 자리의 이름. */
function holding({ useAuthStore, useApiLogStore, queryClient }: Stores, needle = PASSWORD): string[] {
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
  return Object.keys(places).filter((name) => holds(places[name], needle));
}

/**
 * 비밀번호는 그것을 받는 화면의 입력값에만 둔다. 계정을 만들면 가입 화면이 입력값을 비우고 폼 대신 메일 안내를 그리고, 로그인하면 다음
 * 화면으로 가며 그 화면과 함께 사라진다. 저장소·스토어·캐시·다음 화면에 넘기는 값에는 어느 때에도 두지 않는다 — 화면과 스토어가 쥐는
 * 오류에도 요청 본문이 없다.
 */
describe('가입의 비밀번호', () => {
  it.each([
    {
      name: '계정 생성 — 메일 안내로',
      key: CREATE_ACCOUNT,
      path: '/signup',
      submit: submitAccount,
      landing: '/signup',
      arrived: () => until([CHECK_MAIL], main),
    },
    {
      name: '인증한 뒤 첫 로그인 — 프로필 등록으로',
      key: LOGIN,
      path: '/login',
      submit: submitFirstLogin,
      landing: '/signup/profile',
      arrived: () => screen.findByLabelText(/^닉네임/),
    },
  ])('$name: 비밀번호를 싣는 요청 뒤에 비밀번호를 든 자리가 없다', async ({ key, path, submit, landing, arrived }) => {
    let stores!: Stores;
    let configHeld = false;
    let inputSeen = false;
    const duringRequest: string[][] = [];
    const onChange: string[] = [];
    stores = await renderApp(path, {
      extra: {
        ...SIGNUP,
        [key]: (config) => {
          // 보낸 때의 요청 설정 — 실패하면 axios 가 이 객체를 오류에 싣는다.
          configHeld = holds(config, PASSWORD);
          // 요청을 기다리는 동안은 입력칸이 그려져 있다 — 비밀번호는 거기에만 있다.
          inputSeen = inputHolds(PASSWORD);
          duringRequest.push(holding(stores));
          return SIGNUP[key](config);
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

    submit();
    // 도착한 화면이 다 그려진 뒤에 본다.
    await arrived();
    expect(pathname()).toBe(landing);
    unsubscribe.forEach((u) => u());

    // 양성 대조 — 요청의 설정은 비밀번호를 실었고, 이 검사는 그 모양을 들여다본다.
    expect(configHeld).toBe(true);
    expect(inputSeen).toBe(true);
    expect(duringRequest).toEqual([[]]);
    expect(onChange).toEqual([]);
    expect(holding(stores)).toEqual([]);
    // 화면에도 없다 — 비밀번호 입력칸이 내려갔다.
    expect(screen.queryByLabelText(/^비밀번호/)).toBeNull();
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
    {
      // 입력칸이 남는 실패다 — 규칙 위반은 고쳐 같은 토큰으로 다시 낸다.
      name: '비밀번호 재설정',
      key: CONFIRM_RESET,
      open: () =>
        renderApp(RESET_LINK, {
          extra: { [CONFIRM_RESET]: () => fail(400, 'C001', [{ field: 'newPassword', message: NEW_PASSWORD_RULE }]) },
        }),
      act: () => submitNewPassword(PASSWORD),
    },
  ])('$name — 화면이 보이는 오류에 비밀번호가 없다. 코드는 보인다', async ({ key, open, act }) => {
    await open();

    act();
    await waitFor(() => expect(screenErrors()).not.toEqual([]));

    // 양성 대조 — 요청은 비밀번호를 실었고, 입력칸은 고쳐 다시 내도록 그 값을 남겼다.
    expect(holds(sent(key)[0].config, PASSWORD)).toBe(true);
    expect(inputHolds(PASSWORD)).toBe(true);
    expect(holds(screenErrors(), PASSWORD)).toBe(false);
    expect(document.querySelector('[data-error-code]')).toBeVisible();
  });

  it('양성 대조 — 오류 표시가 요청 본문을 비우지 않은 오류를 받으면 이 검사가 그것을 찾는다', async () => {
    await renderApp('/login', { extra: { [LOGIN]: () => fail(401, 'AU003') } });
    expect(screenErrors()).toEqual([]);
    type(screen.getByLabelText(/^이메일/), EMAIL);
    type(screen.getByLabelText(/^비밀번호/), PASSWORD);
    fireEvent.submit(main().querySelector('form')!);
    await waitFor(() => expect(screenErrors()).not.toEqual([]));
    expect(holds(screenErrors(), PASSWORD)).toBe(false);

    // 그 요청의 원래 오류 — 보낸 설정을 그대로 싣는다(lib/api/withoutRequestBody.ts).
    const { config } = sent(LOGIN)[0];
    const raw = new AxiosError('status 401', AxiosError.ERR_BAD_REQUEST, config, null, {
      data: { success: false, data: null, error: { code: 'AU003', message: 'AU003', fieldErrors: [] } },
      status: 401,
      statusText: '',
      headers: {},
      config,
    });
    const { ErrorBox } = await import('@/components/ui');
    render(<ErrorBox error={raw} />);

    expect(holds(screenErrors(), PASSWORD)).toBe(true);
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
    await until(['등록된 게시글이 없습니다'], main);
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

  it('다시 로그인하면 그 표시를 지운다 — 로그인은 탈퇴한 계정에 토큰을 주지 않는다', async () => {
    vi.resetModules();
    const { useAuthStore } = await import('@/stores/authStore');
    useAuthStore.getState().setWithdrawal('account');

    useAuthStore.getState().setTokens(tokens('2'));

    expect(useAuthStore.getState().withdrawal).toBeNull();
  });
});

/**
 * 재발급이 계정 탈퇴보다 먼저 서버에서 끝났는데 응답이 늦게 오면, 탈퇴가 진행 중이거나 끝난 탭이 재발급 결과를 받는다 — 자동
 * 재발급은 머리글과 화면의 어느 요청의 401 `A003` 에서든 시작한다. 그 요청을 테스트가 보내 순서를 고정한다. 탈퇴가 어디까지
 * 끝났는지(`withdrawal`)는 사실이고 재발급의 결과로 바뀌지 않는다. 끝난 탭에는 재발급의 결과가 닿지 않는다.
 */
describe('탈퇴와 겹친 재발급', () => {
  const POSTS_ME = 'GET /api/v1/posts/me';
  const ENDED = '로그인 상태를 이어가지 못했습니다.';

  function gate() {
    let open!: () => void;
    const closed = new Promise<void>((resolve) => (open = resolve));
    return { closed, open };
  }

  /** 마이페이지를 열고 재발급 하나를 띄워 둔다 — 문을 열 때까지 끝나지 않는다. */
  async function openWithReissueInFlight(reissued: () => Reply, extra: Routes = {}) {
    const reissue = gate();
    const stores = await openMyPage({
      ...WITHDRAWN,
      [POSTS_ME]: () => fail(401, 'A003'),
      [REISSUE]: async () => {
        await reissue.closed;
        return reissued();
      },
      ...extra,
    });
    const background = stores.http.get('/api/v1/posts/me').catch((e: unknown) => e);
    await waitFor(() => expect(sent(REISSUE)).toHaveLength(1));
    return { ...stores, reissue, background };
  }

  /** 둘째 단계가 문 앞에서 기다린다 — 첫 단계가 끝난 상태다. */
  function stepTwoHeld(reply: () => Reply) {
    const stepTwo = gate();
    return {
      stepTwo,
      routes: {
        [WITHDRAW_PROFILE]: async () => {
          await stepTwo.closed;
          return reply();
        },
      },
    };
  }

  const atStepTwo = () => waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));

  it('두 단계 사이에 재발급이 성공하면 — 탈퇴가 어디까지 끝났는지는 남고, 끝나면 토큰이 없고 탈퇴했다고 보인다', async () => {
    const { stepTwo, routes: held } = stepTwoHeld(() => NO_CONTENT);
    const { useAuthStore, reissue, background } = await openWithReissueInFlight(() => ok(tokens('2')), held);

    submitWithdrawal();
    await atStepTwo();
    expect(useAuthStore.getState().withdrawal).toBe('account');

    reissue.open();
    await background;
    expect(useAuthStore.getState().withdrawal).toBe('account');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('2'));

    stepTwo.open();
    await atPath('/login');
    await until([DONE], main);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(sessionStorage.length).toBe(0);
    expect(main()).not.toHaveTextContent(ENDED);
  });

  it('두 단계 사이에 재발급이 성공하고 둘째 단계가 실패하면 — 다시 시도 안내가 남고 받은 토큰으로 다시 시도한다', async () => {
    let stepTwoCalls = 0;
    const { stepTwo, routes: held } = stepTwoHeld(() => (++stepTwoCalls === 1 ? fail(500, 'C005') : NO_CONTENT));
    const { useAuthStore, reissue, background } = await openWithReissueInFlight(() => ok(tokens('2')), held);

    submitWithdrawal();
    await atStepTwo();
    reissue.open();
    await background;
    stepTwo.open();

    await until([UNFINISHED, FOREWARNED, ERROR_SENTENCES.C005.text], withdrawalPanel);
    expect(within(withdrawalPanel()).getByRole('button', { name: '다시 시도' })).toBeEnabled();
    expect(useAuthStore.getState().withdrawal).toBe('account');

    submitWithdrawal('second-try');
    await atPath('/login');
    await until([DONE], main);
    expect(sent(WITHDRAW_ACCOUNT).at(-1)?.auth).toBe(`Bearer ${accessToken('2')}`);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });

  it.each([
    ['성공', (): Reply => ok(tokens('late'))],
    ['거부', (): Reply => fail(401, 'A002')],
    ['서버 오류', (): Reply => fail(500, 'C005')],
    ['응답 없음', (): Reply => 'no-response'],
  ])('탈퇴가 끝난 뒤에 재발급이 %s 로 끝나면 — 토큰이 되살아나지 않고 세션 실패도 없고 원요청이 다시 나가지 않는다', async (_, reissued) => {
    const { useAuthStore, reissue, background } = await openWithReissueInFlight(reissued);

    submitWithdrawal();
    await atPath('/login');
    await until([DONE], main);

    reissue.open();
    await background;
    // 재발급의 끝이 화면까지 닿을 시간을 준다.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useAuthStore.getState()).toMatchObject({
      accessToken: null,
      refreshToken: null,
      sessionFailure: null,
      withdrawal: null,
    });
    expect(sessionStorage.length).toBe(0);
    expect(sent(POSTS_ME)).toHaveLength(1);
    expect(main()).toHaveTextContent(DONE);
    expect(main()).not.toHaveTextContent(ENDED);
    expect(document.querySelector('[data-error-code]')).toBeNull();
    expect(within(banner()).getByRole('link', { name: '로그인' })).toBeInTheDocument();
    expect(within(banner()).queryByRole('button', { name: /로그아웃/ })).toBeNull();
  });

  it('두 단계 사이에 재발급이 거부되어 토큰이 비어도 둘째 단계가 성공하면 — 끝났다고 보인다. 다시 시도할 수 없다는 안내와 세션 실패가 남지 않는다', async () => {
    const { stepTwo, routes: held } = stepTwoHeld(() => NO_CONTENT);
    const { useAuthStore, reissue, background } = await openWithReissueInFlight(() => fail(401, 'A002'), held);

    submitWithdrawal();
    await atStepTwo();
    reissue.open();
    await background;

    // 토큰이 비어 로그인 화면으로 갔다 — 둘째 단계가 어떻게 끝날지 모르는 동안은 지금 아는 사실을 보인다.
    await atPath('/login');
    await until([UNFINISHED, CANNOT_RETRY, AFTER_WITHDRAWAL.A003.text], main);

    stepTwo.open();
    await until([DONE], main);

    expect(main()).not.toHaveTextContent(CANNOT_RETRY);
    expect(main()).not.toHaveTextContent(ENDED);
    expect(main()).not.toHaveTextContent(ERROR_SENTENCES.A003.text);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, withdrawal: null });
  });

  it('첫 단계를 기다리는 사이에 재발급이 거부되어 토큰이 비어도 — 첫 단계가 보낸 토큰으로 둘째 단계를 보내 끝낸다. 끝났다고만 보인다', async () => {
    const stepOne = gate();
    const { useAuthStore, reissue, background } = await openWithReissueInFlight(() => fail(401, 'A002'), {
      [WITHDRAW_ACCOUNT]: async () => {
        await stepOne.closed;
        return NO_CONTENT;
      },
    });
    submitWithdrawal();
    await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
    reissue.open();
    await background;
    await atPath('/login');
    await until([ENDED], main);

    stepOne.open();

    await until([DONE], main);
    expect(sent(WITHDRAW_PROFILE).map((r) => r.auth)).toEqual([`Bearer ${accessToken('1')}`]);
    expect(main()).not.toHaveTextContent(ENDED);
    expect(main()).not.toHaveTextContent(CANNOT_RETRY);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, withdrawal: null });
  });

  it('첫 단계를 기다리는 사이에 재발급이 거부되어 토큰이 비고 첫 단계가 보낸 토큰도 만료됐으면 — 다시 재발급하지 않는다. 다시 시도할 수 없다는 안내가 남는다', async () => {
    const stepOne = gate();
    const { reissue, background } = await openWithReissueInFlight(() => fail(401, 'A002'), {
      [WITHDRAW_ACCOUNT]: async () => {
        await stepOne.closed;
        return NO_CONTENT;
      },
      [WITHDRAW_PROFILE]: () => fail(401, 'A003'),
    });
    submitWithdrawal();
    await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
    reissue.open();
    await background;
    await atPath('/login');
    await until([ENDED], main);

    stepOne.open();

    await until([UNFINISHED, CANNOT_RETRY, AFTER_WITHDRAWAL.A003.text], main);
    await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
    await settled();
    expect(sent(REISSUE)).toHaveLength(1);
    expect(sent(WITHDRAW_PROFILE)).toHaveLength(1);
    expect(main()).toHaveTextContent(CANNOT_RETRY);
    expect(main()).not.toHaveTextContent(DONE);
  });

  it('로그인 화면이 그려지고 그 효과가 돌기 전에 둘째 단계가 끝나도 — 끝났다고 보인다. 끝났다는 사실을 앞선 값으로 지우지 않는다', async () => {
    vi.resetModules();
    const { useAuthStore } = await import('@/stores/authStore');
    const { LoginPage } = await import('@/pages/LoginPage');
    const { MemoryRouter } = await import('react-router-dom');
    useAuthStore.getState().setWithdrawal('account');
    // 커밋과 효과 사이에 끼어든다 — 레이아웃 효과는 효과보다 먼저 돈다. 실제로는 그 사이가 벌어질 때만 일어나는 순서다.
    function EndsBeforeEffects() {
      useLayoutEffect(() => useAuthStore.getState().setWithdrawal('done'), []);
      return null;
    }

    // 로그인 화면은 로그인한 뒤 갈 곳을 묻는 데 쿼리 클라이언트를 쓴다 — 앱처럼 감싼다(App.tsx).
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { newQueryClient } = await import('@/lib/queryClient');
    render(
      <QueryClientProvider client={newQueryClient()}>
        <MemoryRouter>
          <LoginPage />
          <EndsBeforeEffects />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(DONE)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(CANNOT_RETRY))).toBeNull();
    expect(useAuthStore.getState().withdrawal).toBeNull();
  });

  it('두 단계 사이에 재발급이 거부되어 토큰이 비고 둘째 단계도 실패하면 — 다시 시도할 수 없다는 안내가 남는다', async () => {
    const { stepTwo, routes: held } = stepTwoHeld(() => fail(500, 'C005'));
    const { reissue, background } = await openWithReissueInFlight(() => fail(401, 'A002'), held);

    submitWithdrawal();
    await atStepTwo();
    reissue.open();
    await background;
    await atPath('/login');
    await until([CANNOT_RETRY], main);

    stepTwo.open();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(main()).toHaveTextContent(CANNOT_RETRY);
    expect(main()).toHaveTextContent(AFTER_WITHDRAWAL.A003.text);
    expect(main()).not.toHaveTextContent(DONE);
  });

  it.each([
    ['거부', (): Reply => fail(401, 'A002')],
    ['성공', (): Reply => ok(tokens('late'))],
  ])('로그아웃이 끝난 뒤에 재발급이 %s 로 끝나면 — 로그인 화면에 세션 실패가 보이지 않는다', async (_, reissued) => {
    const { useAuthStore, reissue, background } = await openWithReissueInFlight(reissued, { [LOGOUT]: () => NO_CONTENT });

    fireEvent.click(within(banner()).getByRole('button', { name: /로그아웃/ }));
    await atPath('/login');
    await until(['계정이 없으면'], main);

    reissue.open();
    await background;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionFailure: null });
    expect(main()).not.toHaveTextContent(ENDED);
    expect(sent(POSTS_ME)).toHaveLength(1);
  });

  it('프로필 탈퇴가 남은 채로 공개 화면에 있을 때 세션이 끝나면 — 그 자리에서 다시 시도할 수 없다고 보이고 다시 로그인하라고 하지 않는다', async () => {
    const { http } = await openMyPage({
      ...WITHDRAWN,
      [WITHDRAW_PROFILE]: () => fail(500, 'C005'),
      [POSTS_ME]: () => fail(401, 'A003'),
      [REISSUE]: () => fail(401, 'A002'),
    });
    submitWithdrawal();
    await screen.findByRole('button', { name: '다시 시도' });
    fireEvent.click(within(banner()).getByRole('link', { name: '게시판' }));
    await until(['등록된 게시글이 없습니다'], main);

    await http.get('/api/v1/posts/me').catch(() => null);

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(CANNOT_RETRY));
    expect(screen.getByRole('alert')).toHaveTextContent(UNFINISHED);
    expect(screen.getByRole('alert')).toHaveTextContent(AFTER_WITHDRAWAL.A003.text);
    expect(screen.getByRole('alert')).not.toHaveTextContent(ERROR_SENTENCES.A003.text);
    expect(within(screen.getByRole('alert')).queryByRole('link')).toBeNull();
    expect(pathname()).toBe('/posts');

    // 한 번 보였으니 로그인 화면에서 다시 보이지 않는다.
    fireEvent.click(within(banner()).getByRole('link', { name: '로그인' }));
    await until(['계정이 없으면'], main);
    expect(main()).not.toHaveTextContent(CANNOT_RETRY);
  });

  it('프로필 탈퇴가 남은 채로 로그아웃이 실패하면 — 토큰이 남아 다시 시도할 수 있고 다시 로그인하라고 하지 않는다', async () => {
    const { useAuthStore } = await openMyPage({
      ...WITHDRAWN,
      [WITHDRAW_PROFILE]: () => fail(500, 'C005'),
      [LOGOUT]: () => fail(401, 'A003'),
      [REISSUE]: () => fail(503, 'C005'),
    });
    submitWithdrawal();
    await screen.findByRole('button', { name: '다시 시도' });

    fireEvent.click(within(banner()).getByRole('button', { name: /로그아웃/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('로그아웃하지 못했습니다.'));
    expect(screen.getByRole('alert')).toHaveTextContent(AFTER_WITHDRAWAL.A003.text);
    expect(screen.getByRole('alert')).not.toHaveTextContent(ERROR_SENTENCES.A003.text);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('1'), withdrawal: 'account' });
    expect(within(withdrawalPanel()).getByRole('button', { name: '다시 시도' })).toBeEnabled();
  });
});

describe('로그인 화면이 이어 보이는 안내', () => {
  it('탈퇴를 마침 — 한 번 보이고 나면 지운다. 다른 화면에 갔다 다시 와도 보이지 않는다', async () => {
    await openMyPage(WITHDRAWN);
    submitWithdrawal();
    await atPath('/login');
    await until([DONE], main);

    fireEvent.click(within(banner()).getByRole('link', { name: '게시판' }));
    await until(['등록된 게시글이 없습니다'], main);
    fireEvent.click(within(banner()).getByRole('link', { name: '로그인' }));
    await until(['계정이 없으면'], main);

    expect(main()).not.toHaveTextContent(DONE);
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

/** 문을 열 때까지 답하지 않는다. */
function held(reply: () => Reply) {
  let open!: () => void;
  const closed = new Promise<void>((resolve) => (open = resolve));
  return {
    open,
    handler: async (): Promise<Reply> => {
      await closed;
      return reply();
    },
  };
}

/** 끝난 요청의 뒤처리가 화면까지 닿을 시간을 준다. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
const clickLogout = () => fireEvent.click(within(banner()).getByRole('button', { name: /로그아웃/ }));

/**
 * 요청을 기다리는 사이에 세션이 바뀐다. 로그인 화면에는 머리글의 로그아웃과 로그인 폼이 함께 있고, 요청을 기다리는 동안에도 화면을
 * 옮길 수 있다. 끝난 요청이 지금 세션을 끝내거나 덮거나 지금 세션의 토큰으로 다음 단계를 보내면 안 된다.
 */
describe('요청을 기다리는 사이에 바뀐 세션', () => {
  const OTHER_EMAIL = 'other@example.com';
  const ENDED = '로그인 상태를 이어가지 못했습니다.';
  const LOGOUT_FAILED = '로그아웃하지 못했습니다.';

  const emailOf = (config: InternalAxiosRequestConfig) => (JSON.parse(config.data as string) as { email: string }).email;
  const loginEmails = () => sent(LOGIN).map((r) => (r.body as { email: string }).email);
  const storedTokens = () => entriesOf(sessionStorage).map(([, value]) => value);

  /** 로그인 화면의 폼을 낸다. */
  function submitLogin(email = OTHER_EMAIL) {
    type(screen.getByLabelText(/^이메일/), email);
    type(screen.getByLabelText(/^비밀번호/), 'Passw0rd!');
    fireEvent.submit(main().querySelector('form')!);
  }

  /** 로그인 화면으로 옮긴다 — 머리글의 링크는 세션이 있으면 없지만 앞으로 가기·뒤로 가기로 올 수 있다. */
  async function toLoginScreen(router: Stores['router']) {
    await act(() => router.navigate('/login'));
    await until(['계정이 없으면'], main);
  }

  /** 글 목록이 그려질 때까지 기다린다 — 주소는 화면보다 먼저 바뀐다. 그 사이에 문을 열면 앞 화면에 대고 단언하게 된다. */
  async function atPostList() {
    await atPath('/posts');
    await until(['등록된 게시글이 없습니다'], main);
  }

  async function loginAsOther(router: Stores['router']) {
    await toLoginScreen(router);
    submitLogin();
    await atPostList();
  }

  /** 로그인 화면에 닿는 바로 그때 다른 세션이 시작된다 — 옮기기를 기다리는 동안의 일이다. */
  function startsSessionOnArrival({ router, useAuthStore }: Stores) {
    const stop = router.subscribe((state) => {
      if (state.location.pathname !== '/login') return;
      stop();
      useAuthStore.getState().setTokens(tokens('B'));
    });
  }

  describe('로그아웃', () => {
    it.each([
      ['다른 계정으로', 'B'],
      // 같은 계정이 같은 초에 받은 토큰은 문자열이 같다(sp-docs/requirements/member.md §6.2) — 토큰을 비교해서는 가를 수 없다.
      ['같은 계정이 같은 초에 같은 토큰 문자열로', '1'],
    ])('%s 로그인한 뒤에 로그아웃의 응답이 오면 — 새 세션이 그대로이고 로그인 화면으로 옮기지 않는다', async (_, tag) => {
      const logout = held(() => NO_CONTENT);
      const { useAuthStore } = await renderApp('/login', {
        loggedIn: true,
        extra: { [LOGOUT]: logout.handler, [LOGIN]: () => ok(tokens(tag)) },
      });
      clickLogout();
      await waitFor(() => expect(sent(LOGOUT)).toHaveLength(1));
      submitLogin();
      await atPostList();

      logout.open();
      await settled();

      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken(tag), refreshToken: `RT-${tag}` });
      expect(storedTokens()).toEqual([`RT-${tag}`]);
      // 로그아웃의 본문은 누른 세션의 Refresh Token 이다 — 새 세션의 것이면 서버가 새 세션의 행을 지운다(sp-docs/requirements/member.md §6.4).
      expect(sent(LOGOUT).map((r) => r.body)).toEqual([{ refreshToken: 'RT-1' }]);
      expect(pathname()).toBe('/posts');
      expect(within(banner()).getByRole('button', { name: /로그아웃/ })).toBeInTheDocument();
    });

    it.each([
      ['서버 오류 500 C005', (): Reply => fail(500, 'C005')],
      ['응답 없음', (): Reply => 'no-response'],
      ['401 A003', (): Reply => fail(401, 'A003')],
    ])('다른 계정으로 로그인한 뒤에 로그아웃이 %s 로 실패하면 — 앞 세션의 실패를 보이지 않는다. 재발급도 없다', async (_, reply) => {
      const logout = held(reply);
      const { useAuthStore } = await renderApp('/login', {
        loggedIn: true,
        extra: { [LOGOUT]: logout.handler, [LOGIN]: () => ok(tokens('B')) },
      });
      clickLogout();
      await waitFor(() => expect(sent(LOGOUT)).toHaveLength(1));
      submitLogin();
      await atPostList();

      logout.open();
      await settled();

      expect(document.body).not.toHaveTextContent(LOGOUT_FAILED);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(writes()).toEqual([LOGOUT, LOGIN]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', sessionFailure: null });
    });

    it('기다리는 사이에 재발급만 됐으면 — 같은 세션이다. 로그아웃이 끝나면 토큰이 비고 로그인 화면으로 간다', async () => {
      const logout = held(() => NO_CONTENT);
      const { useAuthStore } = await renderApp('/posts', { loggedIn: true, extra: { [LOGOUT]: logout.handler } });
      clickLogout();
      await waitFor(() => expect(sent(LOGOUT)).toHaveLength(1));
      act(() => useAuthStore.getState().setReissuedTokens(tokens('2')));

      logout.open();

      await atPath('/login');
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
      expect(storedTokens()).toEqual([]);
    });

    it('기다리는 사이에 재발급만 됐고 로그아웃이 실패하면 — 실패가 그 자리에 보이고 받은 토큰이 남는다', async () => {
      const logout = held(() => fail(500, 'C005'));
      const { useAuthStore } = await renderApp('/posts', { loggedIn: true, extra: { [LOGOUT]: logout.handler } });
      clickLogout();
      await waitFor(() => expect(sent(LOGOUT)).toHaveLength(1));
      act(() => useAuthStore.getState().setReissuedTokens(tokens('2')));

      logout.open();

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(LOGOUT_FAILED));
      expect(pathname()).toBe('/posts');
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('2'), refreshToken: 'RT-2' });
    });

    it('기다리는 사이에 세션이 끝나기만 했으면 — 그 자리에 머물고 세션이 끝난 이유가 남는다', async () => {
      const logout = held(() => NO_CONTENT);
      const { http, useAuthStore } = await renderApp('/posts', {
        loggedIn: true,
        extra: {
          [LOGOUT]: logout.handler,
          'GET /api/v1/posts/me': () => fail(401, 'A003'),
          [REISSUE]: () => fail(401, 'A002'),
        },
      });
      clickLogout();
      await waitFor(() => expect(sent(LOGOUT)).toHaveLength(1));
      await http.get('/api/v1/posts/me').catch(() => null);
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(ENDED));

      logout.open();
      await settled();

      expect(pathname()).toBe('/posts');
      expect(screen.getByRole('alert')).toHaveTextContent(ENDED);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    });

    it('로그인 화면으로 옮기는 사이에 다른 세션이 시작되면 — 그 세션을 지우지 않는다', async () => {
      const stores = await renderApp('/posts', { loggedIn: true, extra: { [LOGOUT]: () => NO_CONTENT } });
      startsSessionOnArrival(stores);

      clickLogout();
      await atPath('/login');
      await settled();

      expect(stores.useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
      expect(storedTokens()).toEqual(['RT-B']);
    });
  });

  describe('탈퇴', () => {
    /** 탈퇴를 시작한 세션의 토큰이다 — `openMyPage` 가 이 토큰으로 로그인한다. */
    const HELD = `Bearer ${accessToken('1')}`;
    const profileTokens = () => sent(WITHDRAW_PROFILE).map((r) => r.auth);
    /** 둘째 단계의 답. 첫 단계를 기다리는 사이에 세션이 바뀐 뒤에 첫 단계가 보낸 토큰으로 보낸 요청이 이렇게 끝난다. */
    const STEP_TWO_ANSWERS: Array<[string, () => Reply]> = [
      ['204', () => NO_CONTENT],
      ['404 M001', () => fail(404, 'M001')],
      // 그 토큰이 만료됐다.
      ['401 A003', () => fail(401, 'A003')],
      ['서버 오류 500 C005', () => fail(500, 'C005')],
      ['응답 없음', () => 'no-response'],
    ];
    const STEP_TWO_FAILURES = STEP_TWO_ANSWERS.slice(2);

    it.each(STEP_TWO_ANSWERS)('첫 단계를 기다리는 사이에 다른 계정으로 로그인하고 첫 단계가 보낸 토큰으로 보낸 둘째 단계가 %s 면 — 지금 세션의 토큰을 쓰지 않는다. 재발급도 재시도도 없고 새 세션이 그대로다', async (_, reply) => {
      const stepOne = held(() => NO_CONTENT);
      const { router, useAuthStore, useApiLogStore } = await openMyPage({
        ...WITHDRAWN,
        [WITHDRAW_ACCOUNT]: stepOne.handler,
        [WITHDRAW_PROFILE]: reply,
        [LOGIN]: () => ok(tokens('B')),
      });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      await loginAsOther(router);

      stepOne.open();
      await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
      await settled();

      expect(writes()).toEqual([WITHDRAW_ACCOUNT, LOGIN, WITHDRAW_PROFILE]);
      expect(profileTokens()).toEqual([HELD]);
      expect(useAuthStore.getState()).toMatchObject({
        accessToken: accessToken('B'),
        refreshToken: 'RT-B',
        withdrawal: null,
        sessionFailure: null,
      });
      expect(storedTokens()).toEqual(['RT-B']);
      expect(pathname()).toBe('/posts');
      expect(document.body).not.toHaveTextContent(DONE);
      expect(screen.queryByRole('alert')).toBeNull();
      // 첫 단계가 보낸 토큰은 그 함수 안에만 있다 — 스토어에도, 화면에도, 요청 기록에도 남지 않는다.
      expect(JSON.stringify(useAuthStore.getState())).not.toContain(accessToken('1'));
      expect(document.documentElement.outerHTML).not.toContain(accessToken('1'));
      expect(JSON.stringify(useApiLogStore.getState())).not.toContain(accessToken('1'));
    });

    it('첫 단계를 기다리는 사이에 재발급을 받은 뒤 다른 계정으로 로그인했으면 — 첫 단계가 보낸 토큰으로 나간다. 그 뒤에 받은 토큰이 아니다', async () => {
      const stepOne = held(() => NO_CONTENT);
      const { router, useAuthStore } = await openMyPage({
        ...WITHDRAWN,
        [WITHDRAW_ACCOUNT]: stepOne.handler,
        [LOGIN]: () => ok(tokens('B')),
      });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      act(() => useAuthStore.getState().setReissuedTokens(tokens('2')));
      await loginAsOther(router);

      stepOne.open();
      await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
      await settled();

      expect(profileTokens()).toEqual([HELD]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', withdrawal: null });
    });

    it('둘째 단계의 재발급을 기다리는 사이에 다른 계정으로 로그인했으면 — 둘째 단계를 다시 보내지 않는다', async () => {
      const reissue = held(() => ok(tokens('late')));
      const { router, useAuthStore } = await openMyPage({
        ...WITHDRAWN,
        [WITHDRAW_PROFILE]: () => fail(401, 'A003'),
        [REISSUE]: reissue.handler,
        [LOGIN]: () => ok(tokens('B')),
      });
      submitWithdrawal();
      await waitFor(() => expect(sent(REISSUE)).toHaveLength(1));
      await loginAsOther(router);

      reissue.open();
      await settled();

      expect(profileTokens()).toEqual([HELD]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', withdrawal: null, sessionFailure: null });
      expect(pathname()).toBe('/posts');
    });

    it('둘째 단계가 401 A003 이고 세션이 그대로면 — 재발급해 받은 토큰으로 다시 보내고 끝낸다', async () => {
      const { useAuthStore } = await openMyPage({
        ...WITHDRAWN,
        [WITHDRAW_PROFILE]: (config) => (config.headers.Authorization === HELD ? fail(401, 'A003') : NO_CONTENT),
        [REISSUE]: () => ok(tokens('2')),
      });

      submitWithdrawal();

      await atPath('/login');
      await until([DONE], main);
      expect(profileTokens()).toEqual([HELD, `Bearer ${accessToken('2')}`]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    });

    it.each([
      ['204', (): Reply => NO_CONTENT],
      ['404 M001', (): Reply => fail(404, 'M001')],
      ['서버 오류 500 C005', (): Reply => fail(500, 'C005')],
      ['401 A003', (): Reply => fail(401, 'A003')],
    ])('둘째 단계를 기다리는 사이에 다른 계정으로 로그인한 뒤 그 응답이 %s 면 — 새 세션이 그대로이고 끝났다는 표시도 옮김도 없다', async (_, reply) => {
      const stepTwo = held(reply);
      const { router, useAuthStore } = await openMyPage({
        ...WITHDRAWN,
        [WITHDRAW_PROFILE]: stepTwo.handler,
        [LOGIN]: () => ok(tokens('B')),
      });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
      await loginAsOther(router);

      stepTwo.open();
      await settled();

      expect(writes()).toEqual([WITHDRAW_ACCOUNT, WITHDRAW_PROFILE, LOGIN]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', withdrawal: null });
      expect(pathname()).toBe('/posts');
      expect(document.body).not.toHaveTextContent(DONE);
    });

    it('첫 단계를 기다리는 사이에 로그아웃했으면 — 첫 단계가 보낸 토큰으로 둘째 단계를 보내 끝낸다. 로그인 화면이 탈퇴했다고 보인다', async () => {
      const stepOne = held(() => NO_CONTENT);
      const { useAuthStore } = await openMyPage({
        [WITHDRAW_ACCOUNT]: stepOne.handler,
        // 실제 서비스가 토큰 없는 요청에 내는 답이다.
        [WITHDRAW_PROFILE]: (config) => (config.headers.Authorization ? NO_CONTENT : fail(401, 'A001')),
        [LOGOUT]: () => NO_CONTENT,
      });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      clickLogout();
      await atPath('/login');

      stepOne.open();

      await until([DONE], main);
      expect(writes()).toEqual([WITHDRAW_ACCOUNT, LOGOUT, WITHDRAW_PROFILE]);
      expect(profileTokens()).toEqual([HELD]);
      expect(main()).not.toHaveTextContent(CANNOT_RETRY);
      expect(document.querySelector('[data-error-code]')).toBeNull();
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, withdrawal: null });
      expect(storedTokens()).toEqual([]);
      expect(pathname()).toBe('/login');
    });

    it.each(STEP_TWO_FAILURES)('첫 단계를 기다리는 사이에 로그아웃했고 첫 단계가 보낸 토큰으로 보낸 둘째 단계가 %s 면 — 재발급하지 않는다. 로그인 화면이 다시 시도할 수 없다고 보인다', async (_, reply) => {
      const stepOne = held(() => NO_CONTENT);
      const { useAuthStore } = await openMyPage({
        [WITHDRAW_ACCOUNT]: stepOne.handler,
        [WITHDRAW_PROFILE]: reply,
        [LOGOUT]: () => NO_CONTENT,
      });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      clickLogout();
      await atPath('/login');

      stepOne.open();

      await until([UNFINISHED, CANNOT_RETRY], main);
      await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
      await settled();
      expect(writes()).toEqual([WITHDRAW_ACCOUNT, LOGOUT, WITHDRAW_PROFILE]);
      expect(profileTokens()).toEqual([HELD]);
      expect(main()).toHaveTextContent(CANNOT_RETRY);
      expect(main()).not.toHaveTextContent(DONE);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionFailure: null });
    });

    it('첫 단계를 기다리는 사이에 재발급만 됐으면 — 같은 세션이다. 둘째 단계가 받은 토큰으로 나가고 끝까지 간다', async () => {
      const stepOne = held(() => NO_CONTENT);
      const { useAuthStore } = await openMyPage({ ...WITHDRAWN, [WITHDRAW_ACCOUNT]: stepOne.handler });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      act(() => useAuthStore.getState().setReissuedTokens(tokens('2')));

      stepOne.open();

      await atPath('/login');
      await until([DONE], main);
      expect(sent(WITHDRAW_PROFILE).map((r) => r.auth)).toEqual([`Bearer ${accessToken('2')}`]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    });

    /** 재발급으로 받은 토큰. 시작할 때의 토큰(`HELD`)은 만료됐다. */
    const RECEIVED = `Bearer ${accessToken('2')}`;

    /**
     * 첫 단계가 시작할 때의 토큰으로 나가 401 A003 을 받고, 재발급을 받아 받은 토큰으로 다시 나간다 — 그 재시도는 문을 열 때까지 답하지
     * 않는다. 시작할 때의 토큰에는 실제 서비스가 만료 토큰에 내는 답(401 A003)을 낸다.
     */
    function stepOneRecovered(retry: { handler: () => Promise<Reply> }): Routes {
      return {
        [WITHDRAW_ACCOUNT]: (config) => (config.headers.Authorization === HELD ? fail(401, 'A003') : retry.handler()),
        [REISSUE]: () => ok(tokens('2')),
        [WITHDRAW_PROFILE]: (config) => (config.headers.Authorization === HELD ? fail(401, 'A003') : NO_CONTENT),
        [LOGOUT]: () => NO_CONTENT,
        [LOGIN]: () => ok(tokens('B')),
      };
    }

    it.each([
      {
        how: '끝나면(로그아웃)',
        change: async ({ useAuthStore }: Stores) => {
          clickLogout();
          await atPath('/login');
          await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());
        },
        expected: [WITHDRAW_ACCOUNT, REISSUE, WITHDRAW_ACCOUNT, LOGOUT, WITHDRAW_PROFILE],
        after: async ({ useAuthStore }: Stores) => {
          // 탈퇴가 끝났다 — 로그인 화면이 그렇게 보인다.
          await until([DONE], main);
          expect(main()).not.toHaveTextContent(CANNOT_RETRY);
          expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, withdrawal: null });
          expect(storedTokens()).toEqual([]);
          expect(pathname()).toBe('/login');
        },
      },
      {
        how: '바뀌면(다른 계정으로 로그인)',
        change: ({ router }: Stores) => loginAsOther(router),
        expected: [WITHDRAW_ACCOUNT, REISSUE, WITHDRAW_ACCOUNT, LOGIN, WITHDRAW_PROFILE],
        after: async ({ useAuthStore }: Stores) => {
          // 앞 계정의 프로필은 지워졌다(둘째 단계가 204). 새 세션은 그대로이고 그 화면에 탈퇴의 표시가 없다.
          expect(useAuthStore.getState()).toMatchObject({
            accessToken: accessToken('B'),
            refreshToken: 'RT-B',
            withdrawal: null,
            sessionFailure: null,
          });
          expect(storedTokens()).toEqual(['RT-B']);
          expect(pathname()).toBe('/posts');
          expect(document.body).not.toHaveTextContent(DONE);
          expect(screen.queryByRole('alert')).toBeNull();
        },
      },
    ])('첫 단계가 401 복구로 받은 토큰으로 다시 나간 뒤 그 응답을 기다리는 사이에 세션이 $how — 둘째 단계가 첫 단계가 실제로 보낸 토큰(받은 토큰)으로 나간다', async ({ change, expected, after }) => {
      const retry = held(() => NO_CONTENT);
      const stores = await openMyPage(stepOneRecovered(retry));
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(2));
      expect(sent(WITHDRAW_ACCOUNT).map((r) => r.auth)).toEqual([HELD, RECEIVED]);
      await change(stores);

      retry.open();
      await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
      await settled();

      expect(profileTokens()).toEqual([RECEIVED]);
      expect(profileTokens()).not.toContain(`Bearer ${accessToken('B')}`);
      expect(writes()).toEqual(expected);
      await after(stores);
    });

    /** 첫 단계의 응답에서 보낸 토큰을 읽을 수 없게 한다 — 답하기 전에 그 요청 설정의 헤더를 바꾼다. 응답은 그 설정을 싣는다. */
    const UNREADABLE: Array<[string, (config: InternalAxiosRequestConfig) => void]> = [
      ['헤더가 없음', (config) => void config.headers.delete('Authorization')],
      ['Bearer 형태가 아님', (config) => void (config.headers.Authorization = accessToken('1'))],
      ['토큰이 비었음', (config) => void (config.headers.Authorization = 'Bearer ')],
    ];

    /** 첫 단계가 문 앞에서 기다리고, 답할 때 보낸 토큰을 읽을 수 없게 한다. */
    function stepOneUnreadable(unreadable: (config: InternalAxiosRequestConfig) => void) {
      const stepOne = held(() => NO_CONTENT);
      return {
        open: stepOne.open,
        routes: {
          [WITHDRAW_ACCOUNT]: async (config: InternalAxiosRequestConfig) => {
            const reply = await stepOne.handler();
            unreadable(config);
            return reply;
          },
        },
      };
    }

    it.each(UNREADABLE)('첫 단계를 기다리는 사이에 로그아웃했고 첫 단계의 응답에서 보낸 토큰을 읽지 못하면(%s) — 둘째 단계를 보내지 않는다. 로그인 화면이 다시 시도할 수 없다고 보인다', async (_, unreadable) => {
      const stepOne = stepOneUnreadable(unreadable);
      const { useAuthStore } = await openMyPage({ ...WITHDRAWN, ...stepOne.routes, [LOGOUT]: () => NO_CONTENT });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      clickLogout();
      await atPath('/login');
      await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());

      stepOne.open();

      await until([UNFINISHED, CANNOT_RETRY], main);
      await settled();
      expect(writes()).toEqual([WITHDRAW_ACCOUNT, LOGOUT]);
      expect(main()).not.toHaveTextContent(DONE);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null, sessionFailure: null });
    });

    it.each(UNREADABLE)('첫 단계를 기다리는 사이에 다른 계정으로 로그인했고 첫 단계의 응답에서 보낸 토큰을 읽지 못하면(%s) — 둘째 단계를 보내지 않는다. 새 세션이 그대로다', async (_, unreadable) => {
      const stepOne = stepOneUnreadable(unreadable);
      const { router, useAuthStore } = await openMyPage({ ...WITHDRAWN, ...stepOne.routes, [LOGIN]: () => ok(tokens('B')) });
      submitWithdrawal();
      await waitFor(() => expect(sent(WITHDRAW_ACCOUNT)).toHaveLength(1));
      await loginAsOther(router);

      stepOne.open();
      await settled();
      await settled();

      expect(writes()).toEqual([WITHDRAW_ACCOUNT, LOGIN]);
      expect(useAuthStore.getState()).toMatchObject({
        accessToken: accessToken('B'),
        refreshToken: 'RT-B',
        withdrawal: null,
        sessionFailure: null,
      });
      expect(storedTokens()).toEqual(['RT-B']);
      expect(pathname()).toBe('/posts');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('로그인 화면으로 옮기는 사이에 다른 세션이 시작되면 — 그 세션을 지우지 않는다', async () => {
      const stores = await openMyPage(WITHDRAWN);
      startsSessionOnArrival(stores);

      submitWithdrawal();
      await atPath('/login');
      await settled();

      expect(stores.useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B', withdrawal: null });
      expect(storedTokens()).toEqual(['RT-B']);
    });
  });

  describe('로그인', () => {
    it('로그인을 낸 뒤에 누른 로그아웃이 끝나면 — 늦은 로그인 응답이 세션이 되지 않고 화면을 옮기지 않는다', async () => {
      const login = held(() => ok(tokens('B')));
      const { useAuthStore } = await renderApp('/login', {
        loggedIn: true,
        extra: { [LOGIN]: login.handler, [LOGOUT]: () => NO_CONTENT },
      });
      submitLogin();
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(1));
      clickLogout();
      await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());

      login.open();
      await settled();

      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
      expect(storedTokens()).toEqual([]);
      expect(pathname()).toBe('/login');
      expect(within(banner()).getByRole('link', { name: '로그인' })).toBeInTheDocument();
    });

    it('로그인을 낸 뒤에 누른 로그아웃이 실패해도 — 늦은 로그인 응답은 세션이 되지 않는다. 앞 세션과 그 안내가 그대로다', async () => {
      const login = held(() => ok(tokens('B')));
      const { useAuthStore } = await renderApp('/login', {
        loggedIn: true,
        extra: { [LOGIN]: login.handler, [LOGOUT]: () => fail(500, 'C005') },
      });
      submitLogin();
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(1));
      clickLogout();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(LOGOUT_FAILED));

      login.open();
      await settled();

      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('1'), refreshToken: 'RT-1' });
      expect(storedTokens()).toEqual(['RT-1']);
      expect(pathname()).toBe('/login');
      expect(screen.getByRole('alert')).toHaveTextContent(LOGOUT_FAILED);
    });

    it('기다리는 사이에 로그인 화면을 다시 열어 다른 계정으로 로그인했으면 — 늦은 응답이 그 세션을 덮지 않고 화면을 옮기지 않는다', async () => {
      const first = held(() => ok(tokens('A')));
      const { router, useAuthStore } = await renderApp('/login', {
        extra: { [LOGIN]: (config) => (emailOf(config) === OTHER_EMAIL ? ok(tokens('B')) : first.handler()) },
      });
      submitLogin('first@example.com');
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(1));
      await act(() => router.navigate('/posts'));
      await loginAsOther(router);
      await act(() => router.navigate('/me'));
      await until([ACCOUNT.email], main);

      first.open();
      await settled();

      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
      expect(pathname()).toBe('/me');
    });

    it('앞서 낸 로그인의 응답이 먼저 와도 — 버린다. 나중에 낸 로그인이 세션이 된다', async () => {
      const first = held(() => ok(tokens('A')));
      const second = held(() => ok(tokens('B')));
      const { router, useAuthStore } = await renderApp('/login', {
        extra: { [LOGIN]: (config) => (emailOf(config) === OTHER_EMAIL ? second.handler() : first.handler()) },
      });
      submitLogin('first@example.com');
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(1));
      await act(() => router.navigate('/posts'));
      await toLoginScreen(router);
      submitLogin();
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(2));

      first.open();
      await settled();
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
      expect(pathname()).toBe('/login');

      second.open();
      await atPath('/posts');
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
    });

    it('로그아웃을 기다리는 동안 낸 로그인은 — 로그아웃이 먼저 끝나도 세션이 된다. 세대가 올랐다고 버리지 않는다', async () => {
      const logout = held(() => NO_CONTENT);
      const login = held(() => ok(tokens('B')));
      const { useAuthStore } = await renderApp('/login', {
        loggedIn: true,
        extra: { [LOGOUT]: logout.handler, [LOGIN]: login.handler },
      });
      clickLogout();
      await waitFor(() => expect(sent(LOGOUT)).toHaveLength(1));
      submitLogin();
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(1));

      logout.open();
      await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());
      login.open();

      await atPath('/posts');
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
      expect(storedTokens()).toEqual(['RT-B']);
      expect(sent(LOGOUT).map((r) => r.body)).toEqual([{ refreshToken: 'RT-1' }]);
    });

    /**
     * 로그인은 토큰을 받은 뒤 갈 곳을 정하려고 내 프로필을 묻는다(pages/LoginPage.tsx 의 `landing`). 그 답을 기다리는 사이에 로그아웃하거나
     * 다른 로그인을 시작했으면 이 세션은 지나갔다 — 답이 무엇이든 옮겨 가지 않는다. 지나간 곳을 라우터에서 모은다 — 프로필 등록은 보호된
     * 경로라 토큰이 없으면 로그인으로 되돌아오므로 마지막 주소만으로는 들렀는지 알 수 없다.
     */
    it.each([
      ['내 프로필 조회', 'GET /api/v1/members/me'],
      ['공개 조회', MY_PUBLIC_PROFILE],
    ])('로그인한 뒤 %s 를 기다리는 사이에 로그아웃했으면 — 그 답이 와도 옮겨 가지 않는다', async (_, key) => {
      const answer = held(() => fail(404, 'M001'));
      const { router, useAuthStore } = await renderApp('/login', {
        extra: { ...SIGNUP, [key]: answer.handler, [LOGOUT]: () => NO_CONTENT },
      });
      submitFirstLogin();
      await waitFor(() => expect(sent(key)).toHaveLength(1));
      const visited: string[] = [];
      const stop = router.subscribe((state) => visited.push(state.location.pathname));

      clickLogout();
      await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());
      answer.open();
      await settled();
      stop();

      // 로그아웃이 로그인 화면으로 옮긴 것뿐이다.
      expect([...new Set(visited)]).toEqual(['/login']);
      expect(pathname()).toBe('/login');
      expect(writes()).toEqual([LOGIN, LOGOUT]);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
    });

    it('로그인한 뒤 내 프로필을 기다리는 사이에 다른 계정으로 로그인했으면 — 앞 로그인은 옮겨 가지 않는다. 나중 로그인이 갈 곳으로 간다', async () => {
      const me = held(() => fail(404, 'M001'));
      const { router, useAuthStore } = await renderApp('/login', {
        extra: {
          ...SIGNUP,
          [LOGIN]: (config) => ok(tokens(emailOf(config) === EMAIL ? 'L' : 'B')),
          // 앞 로그인의 조회만 붙잡는다. 나중 로그인의 계정도 프로필이 없다 — 프로필 등록으로 간다.
          'GET /api/v1/members/me': (config) =>
            config.headers?.Authorization === `Bearer ${accessToken('L')}` ? me.handler() : fail(404, 'M001'),
        },
      });
      submitFirstLogin();
      await waitFor(() => expect(sent('GET /api/v1/members/me')).toHaveLength(1));
      await act(() => router.navigate('/posts'));
      await toLoginScreen(router);
      const visited: string[] = [];
      const stop = router.subscribe((state) => visited.push(state.location.pathname));

      submitLogin();
      await atPath('/signup/profile');
      me.open();
      await settled();
      stop();

      expect([...new Set(visited)]).toEqual(['/signup/profile']);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
    });
  });

  /**
   * 가입은 로그인하지 않는다(F-08) — 계정 생성의 응답은 세션에 손대지 않고, 기다리는 사이에 시작된 로그인이나 로그아웃을 버리지 않는다.
   * 가입 화면이 아직 떠 있으면 그 자리에 메일 안내를 그리고, 떠났으면 그릴 화면이 없다.
   */
  describe('가입', () => {
    /** 다른 계정으로 로그인한 뒤의 화면은 프로필이 있다 — 머리글의 조회가 성공한다. */
    const SIGNED_IN_ELSEWHERE: Routes = { 'GET /api/v1/members/me': () => ok(PROFILE) };
    const ACCOUNT_CREATED = (): Reply => ({ status: 201, body: { success: true, data: { accountId: 8, email: EMAIL }, error: null } });
    /** 계정을 만들었다는 안내 — 메일 안내가 이 말로 시작한다. */
    const CREATED = '계정을 만들었습니다';
    const signupButton = () => within(main()).getByRole('button', { name: '계정 만들기' });

    it('계정 생성을 기다리는 사이에 다른 계정으로 로그인했으면 — 늦은 응답이 그 세션에 손대지 않고 화면을 옮기지 않는다. 옮겨 간 화면에 메일 안내가 없다', async () => {
      const account = held(ACCOUNT_CREATED);
      const { router, useAuthStore } = await renderApp('/signup', {
        extra: { ...SIGNUP, ...SIGNED_IN_ELSEWHERE, [CREATE_ACCOUNT]: account.handler, [LOGIN]: () => ok(tokens('B')) },
      });
      submitAccount();
      await waitFor(() => expect(sent(CREATE_ACCOUNT)).toHaveLength(1));
      await loginAsOther(router);
      const generation = useAuthStore.getState().sessionGeneration;

      account.open();
      await settled();

      expect(loginEmails()).toEqual([OTHER_EMAIL]);
      expect(useAuthStore.getState()).toMatchObject({
        accessToken: accessToken('B'),
        refreshToken: 'RT-B',
        sessionGeneration: generation,
      });
      expect(storedTokens()).toEqual(['RT-B']);
      expect(pathname()).toBe('/posts');
      expect(document.body).not.toHaveTextContent(CREATED);
    });

    it('계정 생성을 기다리는 사이에 낸 로그인은 — 계정 생성의 응답이 먼저 와도 버리지 않는다. 그 로그인이 세션이 된다', async () => {
      const account = held(ACCOUNT_CREATED);
      const login = held(() => ok(tokens('B')));
      const { router, useAuthStore } = await renderApp('/signup', {
        extra: { ...SIGNUP, ...SIGNED_IN_ELSEWHERE, [CREATE_ACCOUNT]: account.handler, [LOGIN]: login.handler },
      });
      submitAccount();
      await waitFor(() => expect(sent(CREATE_ACCOUNT)).toHaveLength(1));
      await toLoginScreen(router);
      submitLogin();
      await waitFor(() => expect(sent(LOGIN)).toHaveLength(1));

      account.open();
      await settled();
      expect(loginEmails()).toEqual([OTHER_EMAIL]);
      expect(document.body).not.toHaveTextContent(CREATED);

      login.open();
      await atPostList();
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('B'), refreshToken: 'RT-B' });
    });

    it('계정 생성을 기다리는 사이에 누른 로그아웃이 실패해 가입 화면에 머물면 — 계정을 만들었으므로 메일 안내를 보인다. 세션은 그대로다', async () => {
      const account = held(ACCOUNT_CREATED);
      const { useAuthStore } = await renderApp('/signup', {
        loggedIn: true,
        extra: { ...SIGNUP, ...SIGNED_IN_ELSEWHERE, [CREATE_ACCOUNT]: account.handler, [LOGOUT]: () => fail(500, 'C005') },
      });
      submitAccount();
      await waitFor(() => expect(sent(CREATE_ACCOUNT)).toHaveLength(1));
      clickLogout();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(LOGOUT_FAILED));

      account.open();

      await until([CHECK_MAIL, `${EMAIL} ${CREATED}.`], main);
      expect(writes()).toEqual([CREATE_ACCOUNT, LOGOUT]);
      expect(pathname()).toBe('/signup');
      expect(useAuthStore.getState()).toMatchObject({ accessToken: accessToken('1'), refreshToken: 'RT-1' });
      expect(storedTokens()).toEqual(['RT-1']);
    });

    it('계정 생성이 실패하면 — 기다리는 사이에 누른 로그아웃이 실패했어도 그 실패를 보이고 메일 안내가 없다. 계정 만들기 버튼은 막히지 않는다', async () => {
      const account = held(() => fail(500, 'C005'));
      await renderApp('/signup', {
        loggedIn: true,
        extra: { ...SIGNUP, ...SIGNED_IN_ELSEWHERE, [CREATE_ACCOUNT]: account.handler, [LOGOUT]: () => fail(500, 'C005') },
      });
      submitAccount();
      await waitFor(() => expect(sent(CREATE_ACCOUNT)).toHaveLength(1));
      clickLogout();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(LOGOUT_FAILED));

      account.open();

      await until([ERROR_SENTENCES.C005.text], main);
      expect(main()).not.toHaveTextContent(CREATED);
      expect(signupButton()).toBeEnabled();
      expect(writes()).toEqual([CREATE_ACCOUNT, LOGOUT]);
    });

    it('계정 생성을 기다리는 사이에 로그아웃했으면 — 가입 화면을 떠났으므로 옮겨 간 로그인 화면에 메일 안내가 없고 가입 화면으로 끌어오지 않는다. 토큰도 쓰지 않는다', async () => {
      const account = held(ACCOUNT_CREATED);
      const { useAuthStore } = await renderApp('/signup', {
        loggedIn: true,
        extra: { ...SIGNUP, ...SIGNED_IN_ELSEWHERE, [CREATE_ACCOUNT]: account.handler, [LOGOUT]: () => NO_CONTENT },
      });
      submitAccount();
      await waitFor(() => expect(sent(CREATE_ACCOUNT)).toHaveLength(1));
      clickLogout();
      await atPath('/login');
      await until(['계정이 없으면'], main);
      await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());

      account.open();
      await settled();

      expect(writes()).toEqual([CREATE_ACCOUNT, LOGOUT]);
      expect(pathname()).toBe('/login');
      expect(document.body).not.toHaveTextContent(CREATED);
      expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
      expect(storedTokens()).toEqual([]);
    });
  });
});

/**
 * 로그아웃과 탈퇴는 로그인 화면으로 `flushSync` 로 옮겨 떠나는 화면을 캐시를 비우는 커밋 뒤에 남기지 않는다. 없으면 옮기기가 전환으로 미뤄져
 * 떠나는 화면이 비운 캐시로 다시 묻는다(lib/queryClient.ts) — 글 상세는 조회할 때마다 조회수가 오른다. 로그아웃의 저장된 조회수는
 * e2e/live/flows.spec.ts 가 본다.
 */
describe('로그아웃과 탈퇴 — 떠나는 화면', () => {
  /** 상세 — 키 집합은 sp-docs/api-contract.md §4.3 이다. */
  const POST = {
    id: 1,
    title: '글 제목',
    category: 'FREE',
    content: '글 본문',
    writerId: PROFILE.accountId,
    writerNickname: PROFILE.nickname,
    viewCount: 3,
    commentCount: 0,
    likeCount: 0,
    liked: false,
    attachments: [],
    createdAt: '2026-10-27T10:00:00',
  };
  const ON_DETAIL: Routes = {
    'GET /api/v1/posts/1': () => ok(POST),
    'GET /api/v1/posts/1/comments': () => ok({ ...EMPTY_PAGE, size: 20 }),
  };

  it.each([
    ['글 상세', '/posts/1', POST.content],
    ['글 목록', '/posts', '등록된 게시글이 없습니다'],
    ['마이페이지', '/me', ACCOUNT.email],
  ])('%s 에서 로그아웃하면 — 로그아웃 요청만 나간다. 떠나는 화면이 다시 묻지 않는다', async (_, path, drawn) => {
    const { useAuthStore } = await renderApp(path, { loggedIn: true, extra: { ...ON_DETAIL, [LOGOUT]: () => NO_CONTENT } });
    await until([drawn], main);
    await until([PROFILE.nickname], banner);
    requests.length = 0;

    clickLogout();

    await atPath('/login');
    await until(['계정이 없으면'], main);
    await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());
    await settled();
    expect(requests.map((r) => r.key)).toEqual([LOGOUT]);
  });

  it('탈퇴를 기다리는 사이에 글 상세로 옮겼으면 — 탈퇴가 끝나도 떠나는 상세가 다시 묻지 않는다', async () => {
    const stepTwo = held(() => NO_CONTENT);
    const { router, useAuthStore } = await openMyPage({ ...WITHDRAWN, ...ON_DETAIL, [WITHDRAW_PROFILE]: stepTwo.handler });
    submitWithdrawal();
    await waitFor(() => expect(sent(WITHDRAW_PROFILE)).toHaveLength(1));
    await act(() => router.navigate('/posts/1'));
    await until([POST.content], main);
    requests.length = 0;

    stepTwo.open();

    await atPath('/login');
    await until([DONE], main);
    await settled();
    expect(requests.map((r) => r.key)).toEqual([]);
    expect(useAuthStore.getState()).toMatchObject({ accessToken: null, refreshToken: null });
  });
});

/**
 * 요청을 기다리는 사이에 화면을 떠났으면 늦은 응답이 사용자를 다른 화면으로 끌어가지 않는다 — 내려간 화면의 `navigate` 도 라우터를 움직인다.
 * 보호된 화면은 세션이 바뀌면 내려가므로 세션을 따로 보지 않는다.
 */
describe('요청을 기다리는 사이에 떠난 화면', () => {
  const CREATE_POST = 'POST /api/v1/posts';
  const UPDATE_POST = 'PUT /api/v1/posts/1';
  const DELETE_POST = 'DELETE /api/v1/posts/1';
  /** 상세 — 키 집합은 sp-docs/api-contract.md §4.3 이다. */
  const POST = {
    id: 1,
    title: '글 제목',
    category: 'FREE',
    content: '글 본문',
    writerId: PROFILE.accountId,
    writerNickname: PROFILE.nickname,
    viewCount: 3,
    commentCount: 0,
    likeCount: 0,
    liked: false,
    attachments: [],
    createdAt: '2026-10-27T10:00:00',
  };
  const ON_DETAIL: Routes = {
    'GET /api/v1/posts/1': () => ok(POST),
    'GET /api/v1/posts/1/comments': () => ok({ ...EMPTY_PAGE, size: 20 }),
  };
  const CREATED = (): Reply => ({ status: 201, body: { success: true, data: POST, error: null } });
  const REGISTERED = (): Reply => ({ status: 201, body: { success: true, data: PROFILE, error: null } });

  function submitPost() {
    type(screen.getByLabelText(/^제목/), '새 제목');
    type(screen.getByLabelText(/^본문/), '새 본문');
    fireEvent.submit(main().querySelector('form')!);
  }

  function submitProfile() {
    type(screen.getByLabelText(/^닉네임/), '새닉네임');
    fireEvent.submit(main().querySelector('form')!);
  }

  const clickDelete = () => fireEvent.click(within(main()).getByRole('button', { name: /삭제/ }));

  /** 화면을 열고 다 그려질 때까지 기다린다. */
  async function open(path: string, drawn: string, extra: Routes) {
    const stores = await renderApp(path, { loggedIn: true, extra: { ...ON_DETAIL, ...extra } });
    await until([drawn], main);
    return stores;
  }
  const NEW_POST_DRAWN = '작성에는 프로필이 필요합니다';
  const EDIT_FILLED = () => waitFor(() => expect(screen.getByLabelText(/^제목/)).toHaveValue(POST.title));

  async function leaveTo(router: Stores['router'], path: string, drawn: string) {
    await act(() => router.navigate(path));
    await until([drawn], main);
  }

  describe('떠나지 않았으면 옮겨 간다', () => {
    it('새 글 — 그 글로 간다', async () => {
      await open('/posts/new', NEW_POST_DRAWN, { [CREATE_POST]: CREATED });

      submitPost();

      await atPath('/posts/1');
    });

    it('글 수정 — 그 글로 간다', async () => {
      await open('/posts/1/edit', '글 수정', { [UPDATE_POST]: () => ok(POST) });
      await EDIT_FILLED();

      submitPost();

      await atPath('/posts/1');
    });

    it('글 삭제 — 목록으로 간다', async () => {
      await open('/posts/1', POST.content, { [DELETE_POST]: () => NO_CONTENT });

      clickDelete();

      await atPath('/posts');
    });

    it('프로필 등록 — 목록으로 간다', async () => {
      await open('/signup/profile', '프로필 등록', { [CREATE_PROFILE]: REGISTERED });

      submitProfile();

      await atPath('/posts');
    });
  });

  it('새 글 — 낸 뒤에 화면을 떠났으면 늦은 응답이 그 글로 끌어가지 않는다', async () => {
    const created = held(CREATED);
    const { router } = await open('/posts/new', NEW_POST_DRAWN, { [CREATE_POST]: created.handler });
    submitPost();
    await waitFor(() => expect(sent(CREATE_POST)).toHaveLength(1));
    await leaveTo(router, '/posts', '등록된 게시글이 없습니다');

    created.open();
    await settled();

    expect(pathname()).toBe('/posts');
  });

  it('새 글 — 로그아웃하고 다른 계정으로 로그인해 같은 화면을 다시 열었어도 앞 세션의 늦은 응답이 끌어가지 않는다', async () => {
    const created = held(CREATED);
    const { router, useAuthStore } = await open('/posts/new', NEW_POST_DRAWN, {
      [CREATE_POST]: created.handler,
      [LOGOUT]: () => NO_CONTENT,
    });
    submitPost();
    await waitFor(() => expect(sent(CREATE_POST)).toHaveLength(1));
    clickLogout();
    await atPath('/login');
    await waitFor(() => expect(useAuthStore.getState().accessToken).toBeNull());
    act(() => useAuthStore.getState().setTokens(tokens('B')));
    await leaveTo(router, '/posts/new', NEW_POST_DRAWN);

    created.open();
    await settled();

    expect(pathname()).toBe('/posts/new');
    expect(useAuthStore.getState().accessToken).toBe(accessToken('B'));
  });

  it('글 수정 — 낸 뒤에 화면을 떠났으면 늦은 응답이 그 글로 끌어가지 않는다', async () => {
    const updated = held(() => ok(POST));
    const { router } = await open('/posts/1/edit', '글 수정', { [UPDATE_POST]: updated.handler });
    await EDIT_FILLED();
    submitPost();
    await waitFor(() => expect(sent(UPDATE_POST)).toHaveLength(1));
    await leaveTo(router, '/posts', '등록된 게시글이 없습니다');

    updated.open();
    await settled();

    expect(pathname()).toBe('/posts');
  });

  it('글 삭제 — 누른 뒤에 화면을 떠났으면 늦은 응답이 목록으로 끌어가지 않는다', async () => {
    const removed = held(() => NO_CONTENT);
    const { router } = await open('/posts/1', POST.content, { [DELETE_POST]: removed.handler });
    clickDelete();
    await waitFor(() => expect(sent(DELETE_POST)).toHaveLength(1));
    await leaveTo(router, '/me', ACCOUNT.email);

    removed.open();
    await settled();

    expect(pathname()).toBe('/me');
  });

  it('프로필 등록 — 낸 뒤에 화면을 떠났으면 늦은 응답이 목록으로 끌어가지 않는다', async () => {
    const registered = held(REGISTERED);
    const { router } = await open('/signup/profile', '프로필 등록', { [CREATE_PROFILE]: registered.handler });
    submitProfile();
    await waitFor(() => expect(sent(CREATE_PROFILE)).toHaveLength(1));
    await leaveTo(router, '/me', ACCOUNT.email);

    registered.open();
    await settled();

    expect(pathname()).toBe('/me');
  });
});
