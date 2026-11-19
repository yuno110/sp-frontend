import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_ONLY, NO_RESPONSE, UNEXPECTED } from '@/lib/api/errorCodes';

/**
 * 관리자 회원 목록 (sp-docs/plan/phase2-frontend-integration.md F-11). 검증 표의 줄마다 화면을 연다.
 *
 * 스텁의 경로와 응답 모양은 sp-docs/api-contract.md §2.5·§3.2·§9.12 에서 온다. 계정 목록의 스텁은 요청의 `page`·`size` 로 자르고,
 * 일괄 조회의 스텁은 요청의 `accountIds` 로 고른다(없는 id 는 뺀다, §3.2) — 그래서 화면이 보낸 값과 화면이 그린 줄이 함께 맞아야
 * 통과한다. 화면은 프로덕션 모드와 StrictMode 로 그린다 — 흉내는 src/pages/postCategory.test.tsx 와 같다.
 */

const EXP = Math.floor(Date.now() / 1000) + 1800;

interface Who {
  sub: number;
  role: 'USER' | 'ADMIN';
}
const USER: Who = { sub: 7, role: 'USER' };
const ADMIN: Who = { sub: 1, role: 'ADMIN' };

const tokenOf = (who: Who) =>
  [
    btoa(JSON.stringify({ alg: 'RS256' })),
    btoa(JSON.stringify({ sub: String(who.sub), role: who.role, exp: EXP })),
    'signature',
  ].join('.');

type Reply = { status: number; body: unknown } | 'no-response';
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;
type Query = Record<string, unknown>;

const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data, error: null } });
const fail = (status: number, code: string, message: string): Reply => ({
  status,
  body: { success: false, data: null, error: { code, message, fieldErrors: [] } },
});

/** 계정 목록의 원소 — 키는 §2.5 의 표다(§9.12). */
const account = (id: number, email: string, extra: Partial<Record<string, unknown>> = {}) => ({
  id,
  email,
  role: 'USER',
  deleted: false,
  createdAt: '2026-10-01T08:59:00',
  emailVerified: true,
  locked: false,
  ...extra,
});

/** 프로필 — 공개 조회와 같은 모양이다(§3.1·§3.2). */
const profile = (accountId: number, nickname: string, deleted = false) => ({
  accountId,
  nickname,
  createdAt: '2026-10-01T09:00:00',
  deleted,
});

/** 프로필이 있는 계정, 프로필이 없는 계정(가입 3단계 미완료), 프로필을 탈퇴한 계정. 최신순이다. */
const WITH_PROFILE = account(1, 'admin@example.com', { role: 'ADMIN' });
const NO_PROFILE = account(2, 'noprofile@example.com');
const WITHDRAWN = account(3, 'gone@example.com', { deleted: true });
const ACCOUNTS = [WITHDRAWN, NO_PROFILE, WITH_PROFILE];
const PROFILES = [profile(1, '관리자닉'), profile(3, '탈퇴한 회원', true)];

/** 계정 목록의 답 — 요청의 `page`·`size` 로 자른다(§7.1). */
const accountsOf =
  (rows: Array<ReturnType<typeof account>>): Handler =>
  (config) => {
    const { page = 0, size = 20 } = (config.params ?? {}) as { page?: number; size?: number };
    return ok({
      content: rows.slice(page * size, (page + 1) * size),
      page,
      size,
      totalElements: rows.length,
      totalPages: Math.ceil(rows.length / size),
      first: page === 0,
      last: (page + 1) * size >= rows.length,
    });
  };

/** 일괄 조회의 답 — 요청의 `accountIds` 에 있는 프로필만, `accountId` 오름차순으로(§3.2). 없는 id 는 뺀다. */
const membersOf =
  (profiles: Array<ReturnType<typeof profile>>): Handler =>
  (config) => {
    const ids = idsOf(config.params as Query);
    return ok({ members: profiles.filter((p) => ids.includes(p.accountId)).sort((a, b) => a.accountId - b.accountId) });
  };

/** 보낸 `accountIds` — 쉼표 목록이다(§3.2). */
const idsOf = (params: Query | null) =>
  String(params?.accountIds ?? '')
    .split(',')
    .filter((s) => s !== '')
    .map(Number);

const ACCOUNTS_KEY = 'GET /api/v1/accounts';
const MEMBERS_KEY = 'GET /api/v1/members';
const A004 = () => fail(403, 'A004', '권한이 없습니다.');

let routes: Record<string, Handler> = {};
const requests: Array<{ key: string; params: Query | null }> = [];
const sent = (key: string) => requests.filter((r) => r.key === key);
/** 일괄 조회 외에 프로필을 묻는 요청(계정마다 부르는 `GET /members/{id}`)이 있었는가. `/members/me` 는 머리글의 것이다. */
const perAccountProfileRequests = () =>
  requests.filter((r) => /^GET \/api\/v1\/members\/\d+$/.test(r.key)).map((r) => r.key);

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push({ key, params: (config.params as Query | undefined) ?? null });
  const handler = routes[key];
  if (!handler) throw new Error(`스텁에 없는 요청: ${key}`);
  const reply = await handler(config);
  // 응답이 없는 실패 — axios 가 연결 거부·CORS 거부에 내는 모양이다(`response` 가 없다).
  if (reply === 'no-response') throw new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {});
  const response = { data: reply.body, status: reply.status, statusText: '', headers: {}, config } as AxiosResponse;
  if (reply.status >= 400) throw new AxiosError(`status ${reply.status}`, AxiosError.ERR_BAD_REQUEST, config, null, response);
  return response;
}

let restoreAdapter: (() => void) | null = null;
let disposeRouter: (() => void) | null = null;

/** 프로덕션 모드로 모듈을 새로 읽고 그린다. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function renderApp(path: string, { as, extra = {} }: { as?: Who; extra?: Record<string, Handler> } = {}) {
  routes = {
    'GET /api/v1/members/me': () =>
      ok(as === ADMIN ? { accountId: ADMIN.sub, nickname: '관리자닉' } : { accountId: USER.sub, nickname: '테스트닉' }),
    'GET /api/v1/posts': accountsOf([]),
    [ACCOUNTS_KEY]: accountsOf(ACCOUNTS),
    [MEMBERS_KEY]: membersOf(PROFILES),
    ...extra,
  };
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
  if (as) {
    useAuthStore.getState().setTokens({
      grantType: 'Bearer',
      accessToken: tokenOf(as),
      refreshToken: 'RT-1',
      accessTokenExpiresIn: 1800,
    });
  }
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  const { App } = await import('@/App');
  const { notifyManager } = await import('@tanstack/react-query');
  notifyManager.setScheduler((callback) => callback());
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  requests.length = 0;
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
const banner = () => document.querySelector('header')!;
/** 보낸 조회의 답이 화면까지 갔을 자리를 지난다 — 스텁은 곧바로 답한다. 부르지 않았다는 단언 앞에 둔다. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
/** 표의 줄 — 이메일 칸으로 찾는다. 좁은 화면의 줄 목록은 따로 본다(`listItem`). */
const tableRow = (email: string) => within(main().querySelector('table')!).getByText(email).closest('tr')!;
const listItem = (email: string) => within(main().querySelector('ul')!).getByText(email).closest('li')!;
/** 표와 좁은 화면의 줄 목록 — 둘 다 같은 값을 담는다(화면 폭에 따라 하나만 보인다). */
const bothViews = (email: string) => [tableRow(email), listItem(email)];
const select = (name: string) => screen.getByRole('combobox', { name });
const accountQueries = () => sent(ACCOUNTS_KEY).map((r) => r.params);
const codeShown = (code: string) => main().querySelector(`[data-error-code="${code}"]`);

describe('계정 한 페이지와 프로필 일괄 조회', () => {
  it('프로필이 없는 계정이 섞인 페이지 — 일괄 조회는 한 번이고 그 계정도 줄로 그려진다', async () => {
    await renderApp('/admin/members', { as: ADMIN });

    await waitFor(() => expect(within(tableRow(WITH_PROFILE.email)).getByText('관리자닉')).toBeInTheDocument());
    await settle();

    // 한 페이지에 한 번 — 그 페이지의 id 전부를 싣는다. 계정마다 부르지 않는다.
    expect(sent(MEMBERS_KEY)).toHaveLength(1);
    expect(idsOf(sent(MEMBERS_KEY)[0].params).sort()).toEqual([1, 2, 3]);
    // 쉼표 목록의 문자열로 싣는다 — 배열이면 axios 가 `accountIds[]=` 로 보내고(§3.2 의 모양이 아니다) `String()` 은 둘을 가르지 못한다.
    expect(typeof sent(MEMBERS_KEY)[0].params?.accountIds).toBe('string');
    expect(perAccountProfileRequests()).toEqual([]);
    // 한 페이지의 id 수가 일괄 조회의 상한(50, §3.2) 안이다 — 화면이 보내는 `size` 가 그 안이다.
    expect(accountQueries()[0]?.size).toBeLessThanOrEqual(50);

    for (const row of bothViews(NO_PROFILE.email)) {
      expect(within(row).getByText('프로필 없음')).toBeInTheDocument();
    }
    // 탈퇴한 프로필은 공개 조회와 같은 모양으로 온다 — 그 닉네임에 탈퇴 표시를 붙인다.
    for (const row of bothViews(WITHDRAWN.email)) {
      expect(row).toHaveTextContent('탈퇴한 회원(프로필 탈퇴)');
      expect(within(row).queryByText('프로필 없음')).toBeNull();
    }
    for (const row of bothViews(WITH_PROFILE.email)) {
      expect(within(row).getByText('관리자닉')).toBeInTheDocument();
      expect(within(row).queryByText('프로필 없음')).toBeNull();
    }
  });

  it('빈 페이지 — 일괄 조회를 부르지 않는다', async () => {
    await renderApp('/admin/members', { as: ADMIN, extra: { [ACCOUNTS_KEY]: accountsOf([]) } });

    await waitFor(() => expect(main()).toHaveTextContent('계정이 없습니다'));
    await settle();

    expect(sent(ACCOUNTS_KEY)).toHaveLength(1);
    expect(sent(MEMBERS_KEY)).toHaveLength(0);
  });

  it('조건에 맞는 계정이 없는 페이지 — 그 문장이고 일괄 조회를 부르지 않는다', async () => {
    await renderApp('/admin/members', { as: ADMIN, extra: { [ACCOUNTS_KEY]: accountsOf([]) } });
    await waitFor(() => expect(main()).toHaveTextContent('계정이 없습니다'));

    fireEvent.change(select('역할'), { target: { value: 'ADMIN' } });
    await waitFor(() => expect(main()).toHaveTextContent('조건에 맞는 계정이 없습니다'));
    await settle();

    expect(sent(ACCOUNTS_KEY)).toHaveLength(2);
    expect(sent(MEMBERS_KEY)).toHaveLength(0);
  });

  it.each([
    { name: '응답 없음', reply: (): Reply => 'no-response', text: NO_RESPONSE, code: null },
    { name: '500', reply: () => fail(500, 'C005', '서버 내부 오류'), text: null, code: 'C005' },
    { name: '오류 본문 없는 502', reply: (): Reply => ({ status: 502, body: '' }), text: UNEXPECTED, code: 'HTTP 502' },
  ])('일괄 조회 실패($name) — 실패가 보이고 「프로필 없음」 이 그려지지 않는다', async ({ reply, text, code }) => {
    await renderApp('/admin/members', { as: ADMIN, extra: { [MEMBERS_KEY]: reply } });

    await waitFor(() => expect(main()).toHaveTextContent('닉네임을 불러오지 못했습니다.'));
    if (text) expect(main()).toHaveTextContent(text);
    if (code) expect(codeShown(code)).not.toBeNull();

    // 계정 줄은 그대로 있다 — 실패한 것은 닉네임뿐이다.
    for (const email of [WITH_PROFILE.email, NO_PROFILE.email, WITHDRAWN.email]) {
      for (const row of bothViews(email)) {
        expect(within(row).getByText('불러오지 못함')).toBeInTheDocument();
      }
    }
    expect(within(main()).queryAllByText('프로필 없음')).toEqual([]);
    expect(sent(MEMBERS_KEY)).toHaveLength(1);
  });
});

describe('필터·정렬·페이지', () => {
  it('처음 연 화면은 정한 조건만 보낸다 — 첫 페이지·기본 정렬이고 거르는 조건이 없다', async () => {
    await renderApp('/admin/members', { as: ADMIN });
    await waitFor(() => expect(accountQueries()).toHaveLength(1));
    expect(accountQueries()[0]).toEqual({ page: 0, size: 20, sort: 'latest' });
  });

  it('바꾼 조건이 §2.5 의 파라미터로 나간다 — 조건을 바꾸면 첫 페이지로 간다', async () => {
    // 두 페이지가 되는 서버 — 다음 페이지를 누를 수 있다.
    const many = Array.from({ length: 25 }, (_, i) => account(100 - i, `user${i}@example.com`));
    await renderApp('/admin/members', { as: ADMIN, extra: { [ACCOUNTS_KEY]: accountsOf(many) } });
    await waitFor(() => expect(tableRow('user0@example.com')).toBeInTheDocument());

    fireEvent.click(within(main()).getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(tableRow('user20@example.com')).toBeInTheDocument());
    expect(accountQueries().at(-1)).toEqual({ page: 1, size: 20, sort: 'latest' });
    // 둘째 페이지의 일괄 조회는 그 페이지의 id 다.
    expect(idsOf(sent(MEMBERS_KEY).at(-1)!.params).sort()).toEqual(many.slice(20).map((a) => a.id).sort());

    fireEvent.change(select('정렬'), { target: { value: 'email' } });
    await waitFor(() => expect(accountQueries().at(-1)).toEqual({ page: 0, size: 20, sort: 'email' }));

    fireEvent.change(select('역할'), { target: { value: 'ADMIN' } });
    await waitFor(() => expect(accountQueries().at(-1)).toEqual({ page: 0, size: 20, sort: 'email', role: 'ADMIN' }));

    fireEvent.change(select('탈퇴 여부'), { target: { value: 'deleted' } });
    await waitFor(() =>
      expect(accountQueries().at(-1)).toEqual({ page: 0, size: 20, sort: 'email', role: 'ADMIN', deleted: true }),
    );
    fireEvent.change(select('탈퇴 여부'), { target: { value: 'active' } });
    await waitFor(() =>
      expect(accountQueries().at(-1)).toEqual({ page: 0, size: 20, sort: 'email', role: 'ADMIN', deleted: false }),
    );

    // 이메일은 누를 때 걸린다 — 앞뒤 공백은 싣지 않는다.
    fireEvent.change(screen.getByRole('textbox', { name: '이메일 검색어' }), { target: { value: '  example ' } });
    fireEvent.click(within(main()).getByRole('button', { name: '검색' }));
    await waitFor(() =>
      expect(accountQueries().at(-1)).toEqual({
        page: 0,
        size: 20,
        sort: 'email',
        role: 'ADMIN',
        deleted: false,
        email: 'example',
      }),
    );

    // 「모든 역할」·「탈퇴 포함」 으로 돌리면 그 조건을 보내지 않는다 — 서버는 그때 둘 다다.
    fireEvent.change(select('역할'), { target: { value: '' } });
    fireEvent.change(select('탈퇴 여부'), { target: { value: '' } });
    await waitFor(() =>
      expect(accountQueries().at(-1)).toEqual({ page: 0, size: 20, sort: 'email', email: 'example' }),
    );
  });

  it.each([
    ['역할', () => fireEvent.change(select('역할'), { target: { value: 'USER' } }), { role: 'USER' }],
    ['탈퇴 여부', () => fireEvent.change(select('탈퇴 여부'), { target: { value: 'deleted' } }), { deleted: true }],
    [
      '이메일 검색',
      () => {
        fireEvent.change(screen.getByRole('textbox', { name: '이메일 검색어' }), { target: { value: 'user' } });
        fireEvent.click(within(main()).getByRole('button', { name: '검색' }));
      },
      { email: 'user' },
    ],
  ])('둘째 페이지에서 %s 만 바꿔도 첫 페이지로 간다', async (_name, change, expected) => {
    const many = Array.from({ length: 25 }, (_, i) => account(100 - i, `user${i}@example.com`));
    await renderApp('/admin/members', { as: ADMIN, extra: { [ACCOUNTS_KEY]: accountsOf(many) } });
    await waitFor(() => expect(tableRow('user0@example.com')).toBeInTheDocument());
    fireEvent.click(within(main()).getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(accountQueries().at(-1)).toEqual({ page: 1, size: 20, sort: 'latest' }));

    change();

    await waitFor(() => expect(accountQueries().at(-1)).toEqual({ page: 0, size: 20, sort: 'latest', ...expected }));
  });

  it('다음 페이지의 닉네임은 그 페이지의 일괄 조회를 받을 때까지 받는 중이다 — 앞 페이지의 결과로 「프로필 없음」 을 그리지 않는다', async () => {
    const many = Array.from({ length: 25 }, (_, i) => account(100 - i, `user${i}@example.com`));
    let release: (() => void) | null = null;
    const batch = membersOf(many.map((a) => profile(a.id, `닉${a.id}`)));
    await renderApp('/admin/members', {
      as: ADMIN,
      extra: {
        [ACCOUNTS_KEY]: accountsOf(many),
        // 둘째 페이지(id 80 이하)의 일괄 조회는 풀어 줄 때까지 답하지 않는다.
        [MEMBERS_KEY]: (config) =>
          idsOf(config.params as Query).every((id) => id <= 80)
            ? new Promise<Reply>((resolve) => {
                release = () => resolve(batch(config) as Reply);
              })
            : batch(config),
      },
    });
    await waitFor(() => expect(tableRow('user0@example.com')).toHaveTextContent('닉100'));

    fireEvent.click(within(main()).getByRole('button', { name: /다음/ }));
    await waitFor(() => expect(tableRow('user20@example.com')).toBeInTheDocument());
    await settle();
    expect(tableRow('user20@example.com')).toHaveTextContent('…');
    expect(main()).not.toHaveTextContent('프로필 없음');

    act(() => release!());
    await waitFor(() => expect(tableRow('user20@example.com')).toHaveTextContent('닉80'));
  });
});

describe('거부', () => {
  it('USER 토큰으로 연다 — 403 A004 의 안내가 보이고 일괄 조회를 부르지 않는다', async () => {
    await renderApp('/admin/members', { as: USER, extra: { [ACCOUNTS_KEY]: A004 } });

    await waitFor(() => expect(main()).toHaveTextContent(ADMIN_ONLY.A004.text));
    expect(codeShown('A004')).not.toBeNull();
    await settle();
    expect(sent(MEMBERS_KEY)).toHaveLength(0);
    expect(main().querySelector('table')).toBeNull();
  });

  it('일괄 조회만 403 A004 여도 — 그 안내가 보이고 「프로필 없음」 이 아니다', async () => {
    await renderApp('/admin/members', { as: ADMIN, extra: { [MEMBERS_KEY]: A004 } });

    await waitFor(() => expect(main()).toHaveTextContent(ADMIN_ONLY.A004.text));
    expect(main()).toHaveTextContent('닉네임을 불러오지 못했습니다.');
    expect(codeShown('A004')).not.toBeNull();
    expect(within(main()).queryAllByText('프로필 없음')).toEqual([]);
  });

  it('로그인하지 않았으면 로그인 화면으로 간다 — 조회를 보내지 않는다', async () => {
    await renderApp('/admin/members');
    await waitFor(() => expect(window.location.pathname).toBe('/login'));
    await settle();
    expect(sent(ACCOUNTS_KEY)).toHaveLength(0);
  });
});

describe('계정의 상태', () => {
  it('잠긴 계정·미인증 계정·탈퇴한 계정과 역할 — 그 표시', async () => {
    const LOCKED = account(10, 'locked@example.com', { locked: true });
    const UNVERIFIED = account(11, 'unverified@example.com', { emailVerified: false });
    const PLAIN = account(12, 'plain@example.com');
    await renderApp('/admin/members', {
      as: ADMIN,
      extra: { [ACCOUNTS_KEY]: accountsOf([LOCKED, UNVERIFIED, WITHDRAWN, WITH_PROFILE, PLAIN]) },
    });
    await waitFor(() => expect(within(tableRow(WITH_PROFILE.email)).getByText('관리자닉')).toBeInTheDocument());

    for (const row of bothViews(LOCKED.email)) {
      expect(within(row).getByText('잠김')).toBeInTheDocument();
      expect(within(row).getByText('인증됨')).toBeInTheDocument();
      expect(within(row).queryByText('미인증')).toBeNull();
    }
    for (const row of bothViews(UNVERIFIED.email)) {
      expect(within(row).getByText('미인증')).toBeInTheDocument();
      expect(within(row).queryByText('인증됨')).toBeNull();
      expect(within(row).queryByText('잠김')).toBeNull();
    }
    for (const row of bothViews(WITHDRAWN.email)) {
      expect(within(row).getByText('탈퇴')).toBeInTheDocument();
    }
    for (const row of bothViews(PLAIN.email)) {
      expect(within(row).queryByText('잠김')).toBeNull();
      expect(within(row).queryByText('탈퇴')).toBeNull();
      expect(within(row).getByText('일반')).toBeInTheDocument();
      expect(row).toHaveTextContent('2026-10-01 08:59:00');
    }
    for (const row of bothViews(WITH_PROFILE.email)) {
      expect(within(row).getByText('관리자')).toBeInTheDocument();
    }
  });

  it('이메일은 띄어쓰기 없이 길어도 줄을 바꾼다 — 표와 줄 목록 둘 다', async () => {
    const LONG = account(20, `${'a'.repeat(80)}@example.com`);
    await renderApp('/admin/members', { as: ADMIN, extra: { [ACCOUNTS_KEY]: accountsOf([LONG]) } });
    await waitFor(() => expect(tableRow(LONG.email)).toBeInTheDocument());

    expect(within(tableRow(LONG.email)).getByText(LONG.email)).toHaveClass('wrap-anywhere');
    expect(within(listItem(LONG.email)).getByText(LONG.email)).toHaveClass('wrap-anywhere');
  });
});

describe('머리글의 회원 관리 링크', () => {
  it('ADMIN 토큰이면 그린다', async () => {
    await renderApp('/posts', { as: ADMIN });
    await waitFor(() => expect(banner()).toHaveTextContent('관리자닉'));
    expect(within(banner()).getByRole('link', { name: '회원 관리' })).toHaveAttribute('href', '/admin/members');
  });

  it.each([
    { name: 'USER 토큰', as: USER as Who | undefined, ready: '테스트닉' },
    { name: '로그인하지 않음', as: undefined, ready: '로그인' },
  ])('$name 이면 그리지 않는다', async ({ as, ready }) => {
    await renderApp('/posts', { as });
    await waitFor(() => expect(banner()).toHaveTextContent(ready));
    // 양성 대조 — 같은 탐색의 다른 링크는 그려져 있다.
    expect(within(banner()).getByRole('link', { name: '게시판' })).toBeInTheDocument();
    expect(within(banner()).queryByRole('link', { name: '회원 관리' })).toBeNull();
  });
});
