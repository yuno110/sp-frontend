import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internalCopyIn, visibleCopy } from '@/test/internalCopy';

/**
 * 글 수정 폼이 고칠 글로 입력칸을 채우는 때 (sp-docs/plan/phase2.md §7.2 F-06 — 실제 서비스와의 e2e 가 찾은 결함이다).
 *
 * 상세와 수정 화면은 같은 글을 같은 조회로 받고, 상세 조회는 조회수를 올리므로 다시 받을 때마다 앞의 응답과 다른 값이 온다.
 * 수정 화면이 받은 값마다 입력칸을 채우면 입력한 뒤에 온 응답이 입력을 덮고, 사용자는 고친 줄 알고 옛 값을 저장한다.
 *
 * 화면은 프로덕션 모드와 StrictMode 로 그린다 — 흉내는 src/pages/userCopy.test.tsx 와 같다. 요청은 axios 의 기본 어댑터로 받는다.
 */

const EXP = Math.floor(Date.now() / 1000) + 1800;

/** 서명은 검증하지 않으므로(lib/jwt.ts) payload 만 맞으면 된다. */
const ACCESS_TOKEN = [
  btoa(JSON.stringify({ alg: 'RS256' })),
  btoa(JSON.stringify({ sub: '7', role: 'USER', exp: EXP })),
  'signature',
].join('.');

type Reply = { status: number; body: unknown };
type Routes = Record<string, (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>>;

const ok = (data: unknown): Reply => ({ status: 200, body: { success: true, data, error: null } });

const DETAIL = 'GET /api/v1/posts/9';
const UPDATE = 'PUT /api/v1/posts/9';

/** 서버에 있는 글의 제목·본문. */
let stored = { title: '처음 제목', content: '처음 본문' };
let views = 0;
/** 켜 두면 상세 조회의 응답을 `release` 까지 붙든다. */
let holding = false;
const held: Array<() => void> = [];
const release = () => held.splice(0).forEach((resolve) => resolve());

const post = () => ({
  id: 9,
  writerId: 7,
  writerNickname: '테스트닉',
  commentCount: 0,
  createdAt: '2026-10-27T09:00:00',
  ...stored,
  viewCount: views,
});

const ROUTES: Routes = {
  'GET /api/v1/members/me': () => ok({ accountId: 7, nickname: '테스트닉' }),
  // 서버처럼 상세 조회마다 조회수가 오른다.
  [DETAIL]: async () => {
    if (holding) await new Promise<void>((resolve) => held.push(resolve));
    views += 1;
    return ok(post());
  },
  'GET /api/v1/posts/9/comments': () =>
    ok({ content: [], page: 0, size: 20, totalElements: 0, totalPages: 0, first: true, last: true }),
  [UPDATE]: (config) => {
    stored = JSON.parse(config.data as string);
    return ok(post());
  },
};

const requests: Array<{ key: string; body: unknown }> = [];
const sent = (key: string) => requests.filter((r) => r.key === key);

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push({ key, body: typeof config.data === 'string' ? JSON.parse(config.data) : null });
  const handler = ROUTES[key];
  if (!handler) throw new Error(`스텁에 없는 요청: ${key}`);
  const reply = await handler(config);
  return { data: reply.body, status: reply.status, statusText: '', headers: {}, config } as AxiosResponse;
}

let restoreAdapter: (() => void) | null = null;
let disposeRouter: (() => void) | null = null;

/** 프로덕션 모드로 모듈을 새로 읽고 글쓴이(sub 7)로 로그인한 채 그린다. 라우터는 모듈을 읽을 때 주소창을 읽으므로 경로를 먼저 둔다. */
async function renderApp(path: string) {
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
  useAuthStore.getState().setTokens({
    grantType: 'Bearer',
    accessToken: ACCESS_TOKEN,
    refreshToken: 'RT-1',
    accessTokenExpiresIn: 1800,
  });
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  const { App } = await import('@/App');
  const { queryClient } = await import('@/lib/queryClient');
  // 조회 결과를 화면에 알리는 것을 미루지 않는다 — 기본은 다음 작업(setTimeout 0)으로 미뤄, 단언이 그 알림 전에 돌면 받은 값마다
  // 덮는 코드도 통과한다(측정).
  const { notifyManager } = await import('@tanstack/react-query');
  notifyManager.setScheduler((callback) => callback());
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  return { queryClient, router };
}

beforeEach(() => {
  sessionStorage.clear();
  requests.length = 0;
  stored = { title: '처음 제목', content: '처음 본문' };
  views = 0;
  holding = false;
  held.length = 0;
});

afterEach(() => {
  release();
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
const pathname = () => window.location.pathname;
const atPath = (path: string) => waitFor(() => expect(pathname()).toBe(path));
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });

/**
 * 상세를 그린 뒤 그 글의 「수정」을 누른다 — 상세가 받아 둔 글이 캐시에 있는 채로 수정 화면이 열린다. `meanwhile` 은 상세를 그린
 * 뒤, 누르기 전에 한다.
 */
async function openEditFromDetail(meanwhile = () => {}) {
  const rendered = await renderApp('/posts/9');
  await waitFor(() => expect(main()).toHaveTextContent('처음 제목'));
  meanwhile();
  fireEvent.click(within(main()).getByRole('button', { name: '수정' }));
  await atPath('/posts/9/edit');
  return rendered;
}

describe('글 수정 — 입력칸을 채우는 때', () => {
  it('수정 화면이 스스로 받은 값으로 채운다 — 받기 전에는 폼을 그리지 않고, 상세가 받아 둔 값으로 채우지 않는다', async () => {
    // 상세가 받아 둔 뒤 서버의 글이 바뀌었다(다른 곳에서 고쳤다).
    await openEditFromDetail(() => {
      stored = { title: '다른 곳에서 고친 제목', content: '다른 곳에서 고친 본문' };
      holding = true;
    });

    // 수정 화면의 조회가 나갔고 아직 답이 없다 — 그동안 입력칸이 없다. 그 사이 보이는 문구도 내부 구조를 설명하지 않는다
    // (src/pages/userCopy.test.tsx 의 검사).
    await waitFor(() => expect(held).toHaveLength(1));
    expect(screen.queryByLabelText(/^제목/)).toBeNull();
    expect(screen.queryByLabelText(/^본문/)).toBeNull();
    expect(main()).toHaveTextContent('불러오는 중…');
    expect(internalCopyIn(visibleCopy(document.body))).toEqual([]);

    act(() => release());
    await waitFor(() => expect(screen.getByLabelText(/^제목/)).toHaveValue('다른 곳에서 고친 제목'));
    expect(screen.getByLabelText(/^본문/)).toHaveValue('다른 곳에서 고친 본문');
  });

  it('입력한 뒤 다시 받은 값이 와도 입력이 그대로이고, 저장하는 것은 그 입력이다', async () => {
    const { queryClient } = await openEditFromDetail();
    const title = await screen.findByLabelText(/^제목/);
    const content = screen.getByLabelText(/^본문/);
    await waitFor(() => expect(title).toHaveValue('처음 제목'));
    type(title, '고친 제목');
    type(content, '고친 본문');

    // 다시 받는다 — 조회수가 올라 앞의 응답과 다른 값이 온다. 결과는 곧바로 화면에 알린다(renderApp 의 스케줄러).
    const before = sent(DETAIL).length;
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['post', '9'] });
    });
    expect(sent(DETAIL)).toHaveLength(before + 1);
    expect(title).toHaveValue('고친 제목');
    expect(content).toHaveValue('고친 본문');

    fireEvent.submit(title.closest('form')!);
    await atPath('/posts/9');
    expect(sent(UPDATE).map((r) => r.body)).toEqual([{ title: '고친 제목', content: '고친 본문' }]);
  });

  it('새 글 화면에 들렀다 기록으로 돌아오면 고칠 글로 다시 채운다 — 새 글에 쓰던 입력이 수정 폼에 남지 않는다', async () => {
    const { router } = await openEditFromDetail();
    await waitFor(() => expect(screen.getByLabelText(/^제목/)).toHaveValue('처음 제목'));

    await act(() => router.navigate('/posts/new'));
    await atPath('/posts/new');
    type(await screen.findByLabelText(/^제목/), '새 글에 쓰던 제목');

    await act(() => router.navigate(-1));
    await atPath('/posts/9/edit');
    await waitFor(() => expect(screen.getByLabelText(/^제목/)).toHaveValue('처음 제목'));
    expect(screen.getByLabelText(/^본문/)).toHaveValue('처음 본문');
  });
});
