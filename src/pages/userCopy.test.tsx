import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_SENTENCES, MY_PROFILE, NO_RESPONSE, UNEXPECTED } from '@/lib/api/errorCodes';
import { internalCopyIn, visibleCopy } from '@/test/internalCopy';
import indexHtml from '../../index.html?raw';

/**
 * 사용자에게 보이는 문구와 오류 표시 (sp-docs/plan/phase2.md §7.2 F-03).
 *
 * 화면은 **프로덕션 모드**로 그린다 — 개발 빌드에서만 그리는 것(CLAUDE.md)은 이 항목의 대상이 아니다. 흉내는
 * src/lib/devOnly.test.tsx 와 같다. 요청은 axios 의 기본 어댑터로 받는다 — 재발급은 재시도 인터셉터가 없는
 * 별도 인스턴스로 나가므로 인스턴스가 만들어지기 전에 기본값을 바꾼다(src/stores/authStore.test.tsx 와 같다).
 */

const EXP = Math.floor(Date.now() / 1000) + 1800;

interface Who {
  sub: number;
  role: 'USER' | 'ADMIN';
}
const ME: Who = { sub: 7, role: 'USER' };
const ADMIN: Who = { sub: 1, role: 'ADMIN' };

/** 서명은 검증하지 않으므로(lib/jwt.ts) payload 만 맞으면 된다. */
const tokenOf = (who: Who) =>
  [
    btoa(JSON.stringify({ alg: 'RS256' })),
    btoa(JSON.stringify({ sub: String(who.sub), role: who.role, exp: EXP })),
    'signature',
  ].join('.');

type Reply = { status: number; body: unknown } | 'no-response';
type Routes = Record<string, (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>>;
type FieldErrors = Array<{ field: string; message: string }>;

/** 서버가 코드마다 내는 메시지 (sp-docs/api-contract.md §8). 화면이 무엇을 대신 보여주는지 보려고 그대로 싣는다. */
const SERVER_MESSAGE: Record<string, string> = {
  C001: '잘못된 입력값입니다.',
  A001: '인증이 필요합니다.',
  A002: '유효하지 않은 토큰입니다.',
  A003: '만료된 토큰입니다.',
  M001: '프로필을 찾을 수 없습니다.',
  P001: '게시글을 찾을 수 없습니다.',
  CM002: '댓글에 대한 권한이 없습니다.',
  S001: '일시적으로 서비스 연동에 실패했습니다.',
  S002: '프로필 등록이 필요합니다.',
  AU003: '이메일 또는 비밀번호가 일치하지 않습니다.',
};

const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data, error: null } });
const fail = (status: number, code: string, fieldErrors: FieldErrors = [], message = SERVER_MESSAGE[code]): Reply => ({
  status,
  body: { success: false, data: null, error: { code, message, fieldErrors } },
});

const PROFILE = { accountId: 7, nickname: '테스트닉' };
const ACCOUNT = { email: 'user@example.com', createdAt: '2026-10-27T10:00:00' };
const POST = {
  id: 1,
  title: '첫 글',
  writerId: 7,
  writerNickname: '테스트닉',
  viewCount: 3,
  commentCount: 1,
  createdAt: '2026-10-27T09:00:00',
  content: '본문입니다',
};
const COMMENT = { id: 5, writerId: 7, writerNickname: '테스트닉', content: '첫 댓글', createdAt: '2026-10-27T09:30:00' };
const pageOf = (content: unknown[]) => ({
  content,
  page: 0,
  size: 10,
  totalElements: content.length,
  totalPages: 1,
  first: true,
  last: true,
});

const BASE: Routes = {
  'GET /api/v1/members/me': () => ok(PROFILE),
  'GET /api/v1/accounts/me': () => ok(ACCOUNT),
  'GET /api/v1/posts': () => ok(pageOf([POST])),
  'GET /api/v1/posts/me': () => ok(pageOf([POST])),
  'GET /api/v1/posts/1': () => ok(POST),
  'GET /api/v1/posts/1/comments': () => ok(pageOf([COMMENT])),
  'GET /api/v1/members/7': () => ok({ ...PROFILE, createdAt: '2026-10-27T09:00:00', deleted: false }),
  'GET /api/v1/members/13': () =>
    ok({ accountId: 13, nickname: '탈퇴한 회원', createdAt: '2026-10-01T09:00:00', deleted: true }),
};

/** 프로필 등록 전의 계정 — `GET /members/me` 가 404 `M001` 이다(api-contract.md §3). */
const NO_PROFILE: Routes = { 'GET /api/v1/members/me': () => fail(404, 'M001') };

let routes: Routes = {};
const requests: string[] = [];

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push(key);
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

let restoreAdapter: (() => void) | null = null;
let disposeRouter: (() => void) | null = null;

/** 프로덕션 모드로 모듈을 새로 읽고 그린다. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function renderApp(
  path: string,
  { as, extra = {}, strict = false }: { as?: Who; extra?: Routes; strict?: boolean } = {},
) {
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
  // main.tsx 처럼 StrictMode 로 그리면 효과가 두 번 돈다 — 한 번만 보이고 지우는 표시가 그래도 남는지 본다.
  render(
    strict ? (
      <StrictMode>
        <App />
      </StrictMode>
    ) : (
      <App />
    ),
  );
}

/** 앞 페이지에서 로그인해 둔다. 새로 읽은 모듈에는 영속 저장소(Refresh Token)만 남는다 — 새로고침이다. */
async function loggedInOnPreviousPage() {
  vi.resetModules();
  const { useAuthStore } = await import('@/stores/authStore');
  useAuthStore.getState().setTokens({
    grantType: 'Bearer',
    accessToken: tokenOf(ME),
    refreshToken: 'RT-0',
    accessTokenExpiresIn: 1800,
  });
}

/** 머리글 — 문서의 첫 `header` 다. 패널 제목도 `header` 지만 본문 안에 있어 뒤에 온다. */
const banner = () => document.querySelector('header')!;
const main = () => document.querySelector('main')!;

/** 없다는 단언은 화면이 다 그려진 뒤에 한다. 그리기 전이면 무엇이든 없다. */
const until = (texts: string[], el: () => Element = () => document.body) =>
  waitFor(() => {
    for (const text of texts) expect(el()).toHaveTextContent(text);
  });

/** 오류 상자가 그려질 때까지. 문구가 아니라 상자의 모양으로 기다린다 — 문구는 이 항목이 바꾸는 것이다. */
const errorShown = () => waitFor(() => expect(document.querySelector('.bg-danger-50')).not.toBeNull());

const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
const section = (heading: RegExp) => screen.getByRole('heading', { name: heading }).closest('section')!;
const commentItem = () => screen.getByText(COMMENT.content).closest('li')!;
/** 댓글 작성란 — 댓글 수정란은 `form` 이 아니다. */
const commentDraft = () => main().querySelector('form textarea')!;

const hits = () => internalCopyIn(visibleCopy(document.body));
const codeShown = (code: string) => document.querySelector(`[data-error-code="${code}"]`);

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

/* ───────── 가입 단계로 가는 조작 ───────── */

async function signupToLoginStep() {
  type(screen.getByLabelText(/^이메일/), 'new@example.com');
  type(screen.getByLabelText(/^비밀번호/), 'Passw0rd!');
  fireEvent.submit(main().querySelector('form')!);
  await until(['2단계 — 로그인']);
}

async function signupToProfileStep() {
  await signupToLoginStep();
  fireEvent.click(within(main()).getByRole('button'));
  await until(['3단계 — 프로필 등록']);
}

const SIGNUP_ROUTES: Routes = {
  'POST /api/v1/accounts': () => ok({ accountId: 7, email: 'new@example.com' }),
  'POST /api/v1/auth/login': () =>
    ok({ grantType: 'Bearer', accessToken: tokenOf(ME), refreshToken: 'RT-1', accessTokenExpiresIn: 1800 }),
  ...NO_PROFILE,
};

/* ───────── 화면마다 보이는 문구 ───────── */

interface CopyState {
  name: string;
  path: string;
  as?: Who;
  extra?: Routes;
  /** 그 상태로 가는 조작과, 그 상태가 다 그려졌는지의 확인. */
  ready: () => Promise<unknown>;
}

const COPY_STATES: CopyState[] = [
  { name: '목록 — 비로그인', path: '/posts', ready: () => until([POST.title]) },
  {
    name: '목록 — 로그인',
    path: '/posts',
    as: ME,
    ready: () => Promise.all([until([POST.title]), until(['테스트닉'], banner)]),
  },
  {
    name: '내 글',
    path: '/posts/mine',
    as: ME,
    ready: () => Promise.all([until([POST.title], main), until(['테스트닉'], banner)]),
  },
  {
    name: '글 상세 — 내 글과 내 댓글',
    path: '/posts/1',
    as: ME,
    ready: () => Promise.all([until([POST.content, COMMENT.content]), until(['테스트닉'], banner)]),
  },
  {
    name: '글 상세 — 관리자가 남의 글을 볼 때',
    path: '/posts/1',
    as: ADMIN,
    extra: { 'GET /api/v1/members/me': () => ok({ accountId: 1, nickname: '관리자' }) },
    ready: () => Promise.all([until([POST.content, COMMENT.content]), until(['관리자'], banner)]),
  },
  {
    name: '글 상세 — 비로그인',
    path: '/posts/1',
    ready: () => until([POST.content, COMMENT.content, '댓글을 쓰려면']),
  },
  {
    name: '글 상세 — 댓글 수정 중',
    path: '/posts/1',
    as: ME,
    ready: async () => {
      await until([COMMENT.content]);
      fireEvent.click(within(commentItem()).getByRole('button', { name: '수정' }));
      await screen.findByRole('button', { name: '저장' });
    },
  },
  {
    name: '글 상세 — 댓글 작성 실패',
    path: '/posts/1',
    as: ME,
    extra: { 'POST /api/v1/posts/1/comments': () => fail(403, 'S002') },
    ready: async () => {
      await until([COMMENT.content]);
      type(commentDraft(), '새 댓글');
      fireEvent.submit(commentDraft().closest('form')!);
      await errorShown();
    },
  },
  {
    name: '글 상세 — 댓글 수정 입력 오류',
    path: '/posts/1',
    as: ME,
    extra: {
      'PUT /api/v1/comments/5': () => fail(400, 'C001', [{ field: 'content', message: '댓글은 1~500자여야 합니다.' }]),
    },
    ready: async () => {
      await until([COMMENT.content]);
      fireEvent.click(within(commentItem()).getByRole('button', { name: '수정' }));
      fireEvent.click(await screen.findByRole('button', { name: '저장' }));
      await errorShown();
    },
  },
  {
    name: '글 상세 — 댓글 삭제 실패',
    path: '/posts/1',
    as: ME,
    extra: { 'DELETE /api/v1/comments/5': () => fail(403, 'CM002') },
    ready: async () => {
      await until([COMMENT.content]);
      fireEvent.click(within(commentItem()).getByRole('button', { name: '삭제' }));
      await errorShown();
    },
  },
  { name: '글쓰기', path: '/posts/new', as: ME, ready: () => until(['새 글', '테스트닉']) },
  {
    name: '글쓰기 — 입력 오류',
    path: '/posts/new',
    as: ME,
    extra: {
      'POST /api/v1/posts': () =>
        fail(400, 'C001', [
          { field: 'title', message: '제목은 1~200자여야 합니다.' },
          { field: 'content', message: '본문은 1~10000자여야 합니다.' },
        ]),
    },
    ready: async () => {
      await until(['새 글']);
      fireEvent.submit(main().querySelector('form')!);
      await until(['제목은 1~200자여야 합니다.']);
    },
  },
  {
    name: '글쓰기 — 연동 실패',
    path: '/posts/new',
    as: ME,
    extra: { 'POST /api/v1/posts': () => fail(503, 'S001') },
    ready: async () => {
      await until(['새 글']);
      fireEvent.submit(main().querySelector('form')!);
      await errorShown();
    },
  },
  {
    name: '글 수정',
    path: '/posts/1/edit',
    as: ME,
    ready: () => waitFor(() => expect(screen.getByDisplayValue(POST.title)).toBeInTheDocument()),
  },
  {
    name: '마이페이지',
    path: '/me',
    as: ME,
    ready: () => Promise.all([until([ACCOUNT.email, '테스트닉'], main), until(['테스트닉'], banner)]),
  },
  {
    name: '마이페이지 — 프로필 없음',
    path: '/me',
    as: ME,
    extra: NO_PROFILE,
    ready: () =>
      Promise.all([
        until([ACCOUNT.email], main),
        waitFor(() => expect(within(main()).getByRole('link', { name: /프로필 등록/ })).toBeInTheDocument()),
        waitFor(() => expect(within(banner()).getByRole('link', { name: /프로필/ })).toBeInTheDocument()),
      ]),
  },
  {
    name: '마이페이지 — 비밀번호 변경 입력 오류',
    path: '/me',
    as: ME,
    extra: {
      'PATCH /api/v1/accounts/me/password': () =>
        fail(400, 'C001', [{ field: 'newPassword', message: '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.' }]),
    },
    ready: async () => {
      await until([ACCOUNT.email], main);
      fireEvent.submit(section(/^비밀번호 변경/).querySelector('form')!);
      await errorShown();
    },
  },
  {
    name: '마이페이지 — 닉네임 수정 완료',
    path: '/me',
    as: ME,
    extra: { 'PATCH /api/v1/members/me': () => ok({ accountId: 7, nickname: '새닉' }) },
    ready: async () => {
      await until([ACCOUNT.email], main);
      type(screen.getByLabelText(/^새 닉네임/), '새닉');
      fireEvent.submit(screen.getByLabelText(/^새 닉네임/).closest('form')!);
      await until(['닉네임 수정 완료'], main);
    },
  },
  {
    name: '글 상세 — 글을 받지 못함',
    path: '/posts/1',
    extra: { 'GET /api/v1/posts/1': () => fail(404, 'P001') },
    ready: () => Promise.all([errorShown(), until(['목록으로'], main)]),
  },
  {
    name: '작성자 프로필',
    path: '/members/7',
    ready: () => until(['테스트닉', '2026-10-27 09:00:00']),
  },
  { name: '작성자 프로필 — 탈퇴한 회원', path: '/members/13', ready: () => until(['탈퇴한 회원']) },
  {
    name: '작성자 프로필 — 프로필 없음',
    path: '/members/99',
    extra: { 'GET /api/v1/members/99': () => fail(404, 'M001') },
    ready: errorShown,
  },
  { name: '로그인', path: '/login', ready: () => until(['계정이 없으면']) },
  {
    name: '로그인 — 실패',
    path: '/login',
    extra: { 'POST /api/v1/auth/login': () => fail(401, 'AU003') },
    ready: async () => {
      fireEvent.submit(main().querySelector('form')!);
      await errorShown();
    },
  },
  {
    name: '가입 — 계정 단계, 쓸 수 있는 이메일',
    path: '/signup',
    extra: { 'GET /api/v1/accounts/check-email': () => ok({ available: true }) },
    ready: async () => {
      type(screen.getByLabelText(/^이메일/), 'new@example.com');
      fireEvent.click(screen.getByRole('button', { name: '중복 확인' }));
      await until(['쓸 수 있']);
    },
  },
  {
    name: '가입 — 계정 단계, 이미 쓰이는 이메일',
    path: '/signup',
    extra: { 'GET /api/v1/accounts/check-email': () => ok({ available: false }) },
    ready: async () => {
      type(screen.getByLabelText(/^이메일/), 'user@example.com');
      fireEvent.click(screen.getByRole('button', { name: '중복 확인' }));
      await until(['이미 쓰이고']);
    },
  },
  { name: '가입 — 로그인 단계', path: '/signup', extra: SIGNUP_ROUTES, ready: signupToLoginStep },
  {
    name: '가입 — 프로필 단계, 닉네임 중복 확인',
    path: '/signup',
    extra: { ...SIGNUP_ROUTES, 'GET /api/v1/members/check-nickname': () => ok({ available: true }) },
    ready: async () => {
      await signupToProfileStep();
      type(screen.getByLabelText(/^닉네임/), '새닉');
      fireEvent.click(screen.getByRole('button', { name: '중복 확인' }));
      await until(['쓸 수 있']);
      await waitFor(() => expect(within(banner()).getByRole('link', { name: /프로필/ })).toBeInTheDocument());
    },
  },
  {
    name: '목록 — 응답 없음',
    path: '/posts',
    extra: { 'GET /api/v1/posts': () => 'no-response' },
    ready: errorShown,
  },
  {
    name: '목록 — 모르는 코드',
    path: '/posts',
    extra: { 'GET /api/v1/posts': () => fail(400, 'X999', [], '새로 생긴 오류입니다.') },
    ready: errorShown,
  },
  {
    name: '목록 — 입력칸이 없는 필드의 오류',
    path: '/posts',
    extra: { 'GET /api/v1/posts': () => fail(400, 'C001', [{ field: 'page', message: '0 이상이어야 합니다' }]) },
    ready: errorShown,
  },
  {
    name: '머리글 — 닉네임을 받지 못함',
    path: '/posts',
    as: ME,
    extra: { 'GET /api/v1/members/me': () => 'no-response' },
    ready: () =>
      Promise.all([
        until([POST.title], main),
        waitFor(() => {
          expect(requests).toContain('GET /api/v1/members/me');
          expect(banner()).not.toHaveTextContent('…');
        }),
      ]),
  },
];

describe('화면마다 보이는 문구', () => {
  it.each(COPY_STATES)('$name — 검사 목록에 걸리는 것이 없다', async ({ path, as, extra, ready }) => {
    await renderApp(path, { as, extra });
    await ready();

    expect(hits()).toEqual([]);
  });
});

/** 제품 이름은 「게시판」이다 — 사용자가 2026-10-28 에 정했다(CLAUDE.md). 저장소 이름을 화면에 쓰지 않는다. */
describe('제품 이름', () => {
  it('index.html 의 <title> 이 제품 이름이고 검사 목록에 걸리지 않는다', () => {
    const title = /<title>(.*?)<\/title>/.exec(indexHtml)?.[1] ?? '';
    expect(title).toBe('게시판');
    expect(internalCopyIn(title)).toEqual([]);
  });

  it('머리글 로고가 제품 이름이고 링크가 아니다 — 「게시판」 링크는 탐색의 하나다', async () => {
    await renderApp('/posts');
    await until([POST.title], main);

    expect(banner().firstElementChild).toHaveTextContent(/^게시판$/);
    expect(within(banner()).getAllByRole('link', { name: '게시판' })).toHaveLength(1);
    expect(within(banner()).getByRole('navigation')).toContainElement(
      within(banner()).getByRole('link', { name: '게시판' }),
    );
  });
});

/* ───────── 복구 안내 ───────── */

/** 복구 링크 — 문구가 아니라 가는 곳으로 찾는다. */
const linksTo = (href: string, el: Element = document.body) =>
  [...el.querySelectorAll('a')].filter((a) => a.getAttribute('href') === href);

describe('복구 안내', () => {
  it('프로필이 아직 없으면 프로필 등록으로 — 마이페이지와 머리글', async () => {
    await renderApp('/me', { as: ME, extra: NO_PROFILE });
    await until([MY_PROFILE.M001.text], main);

    expect(linksTo('/signup/profile', main())).toHaveLength(1);
    expect(linksTo('/signup/profile', banner())).toHaveLength(1);
    expect(codeShown('M001')).toBeVisible();
  });

  it('프로필이 아직 없으면 — 다른 화면에서도 머리글이 프로필 등록으로 안내하고 코드를 남긴다', async () => {
    await renderApp('/posts', { as: ME, extra: NO_PROFILE });
    await until([MY_PROFILE.M001.text], banner);

    expect(linksTo('/signup/profile', banner())).toHaveLength(1);
    expect(banner().querySelector('[data-error-code="M001"]')).toBeVisible();
  });

  it.each([
    [
      '글쓰기',
      '/posts/new',
      { 'POST /api/v1/posts': () => fail(403, 'S002') },
      () => fireEvent.submit(main().querySelector('form')!),
    ],
    [
      '댓글 작성',
      '/posts/1',
      { 'POST /api/v1/posts/1/comments': () => fail(403, 'S002') },
      async () => {
        await until([COMMENT.content]);
        type(commentDraft(), '새 댓글');
        fireEvent.submit(commentDraft().closest('form')!);
      },
    ],
  ] as const)('%s 의 S002 — 프로필 등록으로', async (_, path, extra, act) => {
    await renderApp(path, { as: ME, extra });
    await until(['테스트닉'], banner);
    await act();
    await until([ERROR_SENTENCES.S002.text], main);

    expect(linksTo('/signup/profile', main())).toHaveLength(1);
    expect(codeShown('S002')).toBeVisible();
  });

  it.each(['A001', 'A002'])('%s — 로그인으로', async (code) => {
    await renderApp('/posts/mine', { as: ME, extra: { 'GET /api/v1/posts/me': () => fail(401, code) } });
    await until([ERROR_SENTENCES[code].text], main);

    expect(linksTo('/login', main())).toHaveLength(1);
    expect(codeShown(code)).toBeVisible();
  });

  it('A003 — 재발급도 거부되면 로그인으로. 세션이 끝나 작성란이 사라져도 안내는 남는다', async () => {
    await renderApp('/posts/1', {
      as: ME,
      extra: {
        'POST /api/v1/posts/1/comments': () => fail(401, 'A003'),
        'POST /api/v1/auth/reissue': () => fail(401, 'A002'),
      },
    });
    await until([COMMENT.content]);
    type(commentDraft(), '새 댓글');
    fireEvent.submit(commentDraft().closest('form')!);

    await until([ERROR_SENTENCES.A003.text], main);
    expect(requests).toContain('POST /api/v1/auth/reissue');
    // 재발급이 거부되어 토큰이 비었다 — 작성란 대신 로그인 안내가 그려진 화면이다.
    await until(['댓글을 쓰려면'], main);
    expect(linksTo('/login', main()).length).toBeGreaterThanOrEqual(1);
    expect(within(main()).getByRole('link', { name: '로그인하기' })).toHaveAttribute('href', '/login');
    expect(codeShown('A003')).toBeVisible();
  });

  it('S001 — 잠시 후 다시 시도하게 한다', async () => {
    await renderApp('/posts/new', { as: ME, extra: { 'POST /api/v1/posts': () => fail(503, 'S001') } });
    await until(['새 글']);
    fireEvent.submit(main().querySelector('form')!);

    await until([ERROR_SENTENCES.S001.text], main);
    expect(main()).toHaveTextContent('잠시 후 다시 시도');
    expect(codeShown('S001')).toBeVisible();
  });
});

/**
 * 보호된 화면은 토큰이 비면 로그인으로 가며 그 화면의 오류를 잃는다. 그 실패를 로그인 화면이 이어 보이는지 본다 —
 * 세션을 끝낸 실패, 새로고침 복원의 거부·응답 없음. 영속된 Refresh Token 이 처음부터 없으면(그냥 비로그인) 보일 것이
 * 없다. 토큰을 지우고 남기는 판단은 src/stores/authStore.test.tsx 가 잠근다.
 */
describe('보호된 화면에서 세션이 끝나 로그인으로 갈 때', () => {
  const ENDED = '로그인 상태를 이어가지 못했습니다.';
  /** 로그인 화면의 이유 상자 — 그 안내 문장을 담은 줄의 다음 상자다. */
  const reasonBox = () => screen.getByText(ENDED).parentElement!;
  const atLogin = () => waitFor(() => expect(window.location.pathname).toBe('/login'));

  it.each([
    [
      '글쓰기',
      '/posts/new',
      { 'POST /api/v1/posts': () => fail(401, 'A003') },
      async () => {
        await until(['새 글']);
        fireEvent.submit(main().querySelector('form')!);
      },
    ],
    [
      '마이페이지 닉네임 수정',
      '/me',
      { 'PATCH /api/v1/members/me': () => fail(401, 'A003') },
      async () => {
        await until(['테스트닉'], main);
        fireEvent.submit(screen.getByLabelText(/^새 닉네임/).closest('form')!);
      },
    ],
  ] as const)('%s 이 401 A003 이고 재발급도 거부되면 — 로그인 화면이 그 실패를 문장과 코드로 이어 보인다', async (_, path, extra, act) => {
    await renderApp(path, {
      as: ME,
      strict: true,
      extra: { ...extra, 'POST /api/v1/auth/reissue': () => fail(401, 'A002') },
    });
    await act();

    await atLogin();
    await until([ENDED, ERROR_SENTENCES.A003.text], main);
    expect(within(reasonBox()).getByText('A003')).toBeVisible();
    // 이미 로그인 화면이다 — 로그인으로 가는 링크를 두지 않는다. 다시 로그인은 문장과 이 화면의 폼이 안내한다.
    expect(within(reasonBox()).queryByRole('link')).toBeNull();
    expect(hits()).toEqual([]);
  });

  it.each([
    ['거부되면 — 그 코드를 보인다', () => fail(401, 'A002'), ERROR_SENTENCES.A002.text, 'A002'],
    ['응답이 없으면 — 연결 실패 문장을 보인다', (): Reply => 'no-response', NO_RESPONSE, null],
  ] as const)('새로고침 복원이 %s', async (_, reply, sentence, code) => {
    await loggedInOnPreviousPage();
    await renderApp('/me', { strict: true, extra: { 'POST /api/v1/auth/reissue': reply } });

    await atLogin();
    await until([ENDED, sentence], main);
    if (code) expect(within(reasonBox()).getByText(code)).toBeVisible();
    else expect(document.querySelector('[data-error-code]')).toBeNull();
    expect(hits()).toEqual([]);
  });

  it('로그인 화면을 연 채로 복원이 실패해도 — 그 뒤에 남은 이유를 받아 보인다', async () => {
    await loggedInOnPreviousPage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await renderApp('/login', {
      strict: true,
      extra: {
        'POST /api/v1/auth/reissue': async () => {
          await gate;
          return fail(401, 'A002');
        },
      },
    });
    await until(['계정이 없으면'], main);
    expect(main()).not.toHaveTextContent(ENDED);

    release();

    await until([ENDED, ERROR_SENTENCES.A002.text], main);
    expect(within(reasonBox()).getByText('A002')).toBeVisible();
  });

  it('영속된 Refresh Token 이 처음부터 없으면 — 그냥 비로그인이라 아무 이유도 보이지 않는다', async () => {
    await renderApp('/me', { strict: true });

    await atLogin();
    await until(['계정이 없으면'], main);
    expect(main()).not.toHaveTextContent(ENDED);
    expect(document.querySelector('.bg-danger-50')).toBeNull();
    expect(requests).toEqual([]);
  });

  it('한 번 보이고 나면 지운다 — 다른 화면에 갔다 다시 와도 보이지 않는다', async () => {
    await loggedInOnPreviousPage();
    await renderApp('/me', { strict: true, extra: { 'POST /api/v1/auth/reissue': () => fail(401, 'A002') } });
    await atLogin();
    await until([ENDED], main);

    fireEvent.click(within(banner()).getByRole('link', { name: '게시판' }));
    await until([POST.title], main);
    fireEvent.click(within(banner()).getByRole('link', { name: '로그인' }));
    await until(['계정이 없으면'], main);

    expect(main()).not.toHaveTextContent(ENDED);
  });
});

describe('같은 코드의 다른 뜻', () => {
  it.each([
    ['비로그인', undefined],
    ['로그인 — 내 프로필은 있다', ME],
  ] as const)('남의 프로필 조회의 M001 (%s) — 프로필 등록 안내가 없다', async (_, as) => {
    await renderApp('/members/99', { as, extra: { 'GET /api/v1/members/99': () => fail(404, 'M001') } });
    await until([ERROR_SENTENCES.M001.text], main);
    if (as) await until(['테스트닉'], banner);

    expect(linksTo('/signup/profile')).toEqual([]);
    expect(document.body).not.toHaveTextContent(MY_PROFILE.M001.text);
    expect(codeShown('M001')).toBeVisible();
  });
});

describe('사전에 없는 코드', () => {
  it('서버 메시지와 코드를 그대로 보여준다', async () => {
    await renderApp('/posts', { extra: { 'GET /api/v1/posts': () => fail(400, 'X999', [], '새로 생긴 오류입니다.') } });

    await until(['새로 생긴 오류입니다.'], main);
    expect(codeShown('X999')).toHaveTextContent(/^X999$/);
    expect(codeShown('X999')).toBeVisible();
  });
});

describe('응답 없음', () => {
  it('연결 실패 문장이 보이고 코드 자리가 없다', async () => {
    await renderApp('/posts', { extra: { 'GET /api/v1/posts': () => 'no-response' } });

    await until([NO_RESPONSE], main);
    expect(document.querySelector('[data-error-code]')).toBeNull();
    expect(hits()).toEqual([]);
  });
});

describe('글 수정 — 고칠 글을 받지 못함', () => {
  const cases: Array<[string, () => Reply, string, string | null]> = [
    ['P001', () => fail(404, 'P001'), ERROR_SENTENCES.P001.text, 'P001'],
    ['응답 없음', () => 'no-response', NO_RESPONSE, null],
  ];

  it.each(cases)('%s — 다른 화면과 같은 오류 상자를 보이고 폼을 그리지 않는다', async (_, reply, sentence, code) => {
    await renderApp('/posts/9/edit', { as: ME, extra: { 'GET /api/v1/posts/9': reply } });

    await until([sentence], main);
    if (code) expect(codeShown(code)).toBeVisible();
    else expect(document.querySelector('[data-error-code]')).toBeNull();
    expect(main().querySelector('form')).toBeNull();
    expect(hits()).toEqual([]);
  });
});

describe('오류 응답의 모양이 아닌 실패', () => {
  it('2xx 인데 data 가 없다(계약에 없는 응답) — 사용자 문장만 보이고 원문은 프로덕션에서 그리지 않는다', async () => {
    await renderApp('/posts', { extra: { 'GET /api/v1/posts': () => ok(null) } });

    await until([UNEXPECTED], main);
    expect(main()).not.toHaveTextContent('계약 위반 응답');
    expect(hits()).toEqual([]);
  });

  it('오류 본문이 없는 응답 — HTTP 상태가 코드 자리에 남는다', async () => {
    await renderApp('/posts', { extra: { 'GET /api/v1/posts': () => ({ status: 502, body: '<html>Bad Gateway</html>' }) } });

    await until([UNEXPECTED], main);
    expect(codeShown('HTTP 502')).toHaveTextContent(/^HTTP 502$/);
    expect(codeShown('HTTP 502')).toBeVisible();
    expect(hits()).toEqual([]);
  });
});

/* ───────── 필드 오류 ───────── */

/** 입력칸 옆 — 그 입력칸을 감싼 필드. `Field` 안이면 label 의 부모, 아니면 입력칸의 부모다. */
const beside = (input: Element) => input.closest('label')?.parentElement ?? input.parentElement!;
/** 오류 상자(요약) — 그 문장을 담은 상자다. */
const summaryOf = (sentence: string) => screen.getByText(sentence).parentElement!;

interface FieldCase {
  name: string;
  path: string;
  extra: Routes;
  as?: Who;
  /** 그 오류를 내는 조작. 끝나면 입력칸마다 메시지를 돌려준다. */
  act: () => Promise<Array<[input: Element, message: string]>>;
}

const C001 = (fieldErrors: FieldErrors) => () => fail(400, 'C001', fieldErrors);

const FIELD_CASES: FieldCase[] = [
  {
    name: '가입 — 계정',
    path: '/signup',
    extra: {
      'POST /api/v1/accounts': C001([
        { field: 'email', message: '올바른 이메일 형식이 아닙니다.' },
        { field: 'password', message: '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.' },
      ]),
    },
    act: async () => {
      fireEvent.submit(main().querySelector('form')!);
      await errorShown();
      return [
        [screen.getByLabelText(/^이메일/), '올바른 이메일 형식이 아닙니다.'],
        [screen.getByLabelText(/^비밀번호/), '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.'],
      ];
    },
  },
  {
    name: '가입 — 이메일 중복 확인',
    path: '/signup',
    extra: { 'GET /api/v1/accounts/check-email': C001([{ field: 'email', message: '올바른 이메일 형식이 아닙니다.' }]) },
    act: async () => {
      fireEvent.click(screen.getByRole('button', { name: '중복 확인' }));
      await errorShown();
      return [[screen.getByLabelText(/^이메일/), '올바른 이메일 형식이 아닙니다.']];
    },
  },
  {
    name: '가입 — 프로필',
    path: '/signup/profile',
    as: ME,
    extra: { ...NO_PROFILE, 'POST /api/v1/members': C001([{ field: 'nickname', message: '닉네임은 2~10자여야 합니다.' }]) },
    act: async () => {
      fireEvent.submit(main().querySelector('form')!);
      await errorShown();
      return [[screen.getByLabelText(/^닉네임/), '닉네임은 2~10자여야 합니다.']];
    },
  },
  {
    name: '글쓰기',
    path: '/posts/new',
    as: ME,
    extra: {
      'POST /api/v1/posts': C001([
        { field: 'title', message: '제목은 1~200자여야 합니다.' },
        { field: 'content', message: '본문은 1~10000자여야 합니다.' },
      ]),
    },
    act: async () => {
      fireEvent.submit(main().querySelector('form')!);
      await errorShown();
      return [
        [screen.getByLabelText(/^제목/), '제목은 1~200자여야 합니다.'],
        [screen.getByLabelText(/^본문/), '본문은 1~10000자여야 합니다.'],
      ];
    },
  },
  {
    name: '댓글 작성',
    path: '/posts/1',
    as: ME,
    extra: { 'POST /api/v1/posts/1/comments': C001([{ field: 'content', message: '댓글은 1~500자여야 합니다.' }]) },
    act: async () => {
      await until([COMMENT.content]);
      fireEvent.submit(commentDraft().closest('form')!);
      await errorShown();
      return [[commentDraft(), '댓글은 1~500자여야 합니다.']];
    },
  },
  {
    name: '댓글 수정',
    path: '/posts/1',
    as: ME,
    extra: { 'PUT /api/v1/comments/5': C001([{ field: 'content', message: '댓글은 1~500자여야 합니다.' }]) },
    act: async () => {
      await until([COMMENT.content]);
      fireEvent.click(within(commentItem()).getByRole('button', { name: '수정' }));
      fireEvent.click(await screen.findByRole('button', { name: '저장' }));
      await errorShown();
      return [[within(commentItem()).getByRole('textbox'), '댓글은 1~500자여야 합니다.']];
    },
  },
  {
    name: '마이페이지 — 닉네임',
    path: '/me',
    as: ME,
    extra: { 'PATCH /api/v1/members/me': C001([{ field: 'nickname', message: '닉네임은 2~10자여야 합니다.' }]) },
    act: async () => {
      await until(['테스트닉'], main);
      const input = screen.getByLabelText(/^새 닉네임/);
      fireEvent.submit(input.closest('form')!);
      await errorShown();
      return [[input, '닉네임은 2~10자여야 합니다.']];
    },
  },
  {
    name: '마이페이지 — 비밀번호 변경',
    path: '/me',
    as: ME,
    extra: {
      'PATCH /api/v1/accounts/me/password': C001([
        { field: 'currentPassword', message: '현재 비밀번호를 입력해주세요.' },
        { field: 'newPassword', message: '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.' },
      ]),
    },
    act: async () => {
      await until([ACCOUNT.email], main);
      const panel = section(/^비밀번호 변경/);
      fireEvent.submit(panel.querySelector('form')!);
      await errorShown();
      return [
        [within(panel).getByLabelText(/^현재 비밀번호/), '현재 비밀번호를 입력해주세요.'],
        [within(panel).getByLabelText(/^새 비밀번호/), '비밀번호는 8~20자의 영문, 숫자, 특수문자 조합이어야 합니다.'],
      ];
    },
  },
  {
    name: '마이페이지 — 탈퇴',
    path: '/me',
    as: ME,
    extra: { 'DELETE /api/v1/accounts/me': C001([{ field: 'password', message: '비밀번호를 입력해주세요.' }]) },
    act: async () => {
      await until([ACCOUNT.email], main);
      const panel = section(/^탈퇴/);
      fireEvent.submit(panel.querySelector('form')!);
      await errorShown();
      return [[within(panel).getByLabelText(/^현재 비밀번호/), '비밀번호를 입력해주세요.']];
    },
  },
];

describe('입력칸이 있는 필드의 오류', () => {
  it.each(FIELD_CASES)('$name — 그 입력칸 옆에 보이고 요약에는 없다', async ({ path, as, extra, act }) => {
    await renderApp(path, { as, extra });

    const pairs = await act();

    const summary = summaryOf(ERROR_SENTENCES.C001.text);
    for (const [input, message] of pairs) {
      expect(within(beside(input)).getByText(message)).toBeInTheDocument();
      expect(summary).not.toHaveTextContent(message);
    }
    expect(codeShown('C001')).toBeVisible();
  });
});

describe('입력칸이 없는 필드의 오류', () => {
  it('댓글 수정에 실패한 뒤 수정을 취소해 입력칸이 사라지면 — 그 필드 오류는 요약에 남는다', async () => {
    await renderApp('/posts/1', {
      as: ME,
      extra: { 'PUT /api/v1/comments/5': C001([{ field: 'content', message: '댓글은 1~500자여야 합니다.' }]) },
    });
    await until([COMMENT.content]);
    fireEvent.click(within(commentItem()).getByRole('button', { name: '수정' }));
    fireEvent.click(await screen.findByRole('button', { name: '저장' }));
    await until(['댓글은 1~500자여야 합니다.'], main);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '저장' })).toBeNull());

    expect(summaryOf(ERROR_SENTENCES.C001.text)).toHaveTextContent('댓글은 1~500자여야 합니다.');
  });

  it('목록의 page — 요약에 보인다', async () => {
    await renderApp('/posts', {
      extra: { 'GET /api/v1/posts': C001([{ field: 'page', message: '0 이상이어야 합니다' }]) },
    });

    await until([ERROR_SENTENCES.C001.text], main);
    expect(summaryOf(ERROR_SENTENCES.C001.text)).toHaveTextContent('0 이상이어야 합니다');
  });

  it('입력칸이 있는 필드와 섞여도 — 입력칸이 없는 쪽은 요약에, 있는 쪽은 그 옆에', async () => {
    await renderApp('/posts/new', {
      as: ME,
      extra: {
        'POST /api/v1/posts': C001([
          { field: 'title', message: '제목은 1~200자여야 합니다.' },
          { field: 'tags', message: '태그는 받지 않습니다.' },
        ]),
      },
    });
    await until(['새 글']);
    fireEvent.submit(main().querySelector('form')!);
    await until([ERROR_SENTENCES.C001.text], main);

    const summary = summaryOf(ERROR_SENTENCES.C001.text);
    expect(summary).toHaveTextContent('태그는 받지 않습니다.');
    expect(summary).not.toHaveTextContent('제목은 1~200자여야 합니다.');
    expect(within(beside(screen.getByLabelText(/^제목/))).getByText('제목은 1~200자여야 합니다.')).toBeInTheDocument();
  });
});
