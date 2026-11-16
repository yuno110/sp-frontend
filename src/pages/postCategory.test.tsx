import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ERROR_SENTENCES } from '@/lib/api/errorCodes';

/**
 * 카테고리와 공지 고정 (sp-docs/plan/phase2-frontend-integration.md F-12). 검증 표의 줄마다 화면을 연다 — 같은 표를
 * e2e/category.spec.ts 가 프로덕션 빌드에서 밟는다.
 *
 * 서버는 카테고리로 거른다(sp-docs/api-contract.md §4.1) — 이 스텁도 요청의 `category`·`page` 로 답을 고른다. 그래서 화면이 보낸
 * 값과 화면이 그린 글이 함께 맞아야 통과한다. 화면은 프로덕션 모드와 StrictMode 로 그린다 — 흉내는 src/pages/postEdit.test.tsx 와
 * 같다.
 */

const EXP = Math.floor(Date.now() / 1000) + 1800;

interface Who {
  sub: number;
  role: 'USER' | 'ADMIN';
}
const USER: Who = { sub: 7, role: 'USER' };
const ADMIN: Who = { sub: 1, role: 'ADMIN' };

/** 서명은 검증하지 않으므로(lib/jwt.ts) payload 만 맞으면 된다. */
const tokenOf = (who: Who) =>
  [
    btoa(JSON.stringify({ alg: 'RS256' })),
    btoa(JSON.stringify({ sub: String(who.sub), role: who.role, exp: EXP })),
    'signature',
  ].join('.');

type Reply = { status: number; body: unknown };
type Handler = (config: InternalAxiosRequestConfig) => Reply | Promise<Reply>;
type Query = Record<string, unknown>;

const ok = (data: unknown, status = 200): Reply => ({ status, body: { success: true, data, error: null } });
const fail = (status: number, code: string, message: string): Reply => ({
  status,
  body: { success: false, data: null, error: { code, message, fieldErrors: [] } },
});

/** 목록 항목 — 키는 api-contract.md §4.3 의 목록 항목 줄이다(§9.3). */
const item = (id: number, title: string, category: string, createdAt: string) => ({
  id,
  title,
  category,
  writerId: category === 'NOTICE' ? ADMIN.sub : USER.sub,
  writerNickname: category === 'NOTICE' ? '관리자' : '테스트닉',
  viewCount: id,
  commentCount: 0,
  likeCount: 0,
  createdAt,
});

/** 상세 — 목록 항목의 키에 `content`·`liked`·`attachments` 를 더한 것(§4.3·§9.6). */
const detail = (post: ReturnType<typeof item>, content: string) => ({ ...post, content, liked: false, attachments: [] });
/** 저장한 뒤 옮겨 가는 상세가 묻는 것 — 그 글과 빈 댓글 목록이다. */
const detailRoutes = (post: ReturnType<typeof item>): Record<string, Handler> => ({
  [`GET /api/v1/posts/${post.id}`]: () => ok(detail(post, '지금 본문')),
  [`GET /api/v1/posts/${post.id}/comments`]: () =>
    ok({ content: [], page: 0, size: 20, totalElements: 0, totalPages: 0, first: true, last: true }),
});

const NOTICE = item(30, '점검 안내', 'NOTICE', '2026-10-28T09:00:00');
const FREE_POST = item(29, '자유 글', 'FREE', '2026-10-27T09:00:00');
const QNA_POST = item(28, '질문 글', 'QNA', '2026-10-26T09:00:00');
const OLD_NOTICE = item(10, '지난 공지', 'NOTICE', '2026-10-20T09:00:00');
/** 서버에 있는 글 — 최신순이다. 한 페이지(10건)에 다 든다. */
const POSTS = [NOTICE, FREE_POST, QNA_POST, OLD_NOTICE];
/**
 * 전체 목록이 한 페이지를 넘는 서버 — 전체 목록의 첫 페이지에는 지난 공지가 없고 둘째 페이지에 있다. 공지만 받으면 첫 페이지에
 * 둘 다 있다.
 */
const MANY = [
  NOTICE,
  ...Array.from({ length: 10 }, (_, i) => item(20 - i, `자유 글 ${i + 1}`, 'FREE', '2026-10-25T09:00:00')),
  OLD_NOTICE,
];

/** 글 목록의 답 — 요청의 `category` 로 거르고 `page`·`size` 로 자른다(§4.1·§7.1). */
const listOf =
  (posts: Array<ReturnType<typeof item>>): Handler =>
  (config) => {
    const { page = 0, size = 10, category } = (config.params ?? {}) as { page?: number; size?: number; category?: string };
    const matched = posts.filter((post) => !category || post.category === category);
    return ok({
      content: matched.slice(page * size, (page + 1) * size),
      page,
      size,
      totalElements: matched.length,
      totalPages: Math.ceil(matched.length / size),
      first: page === 0,
      last: (page + 1) * size >= matched.length,
    });
  };

const LIST = 'GET /api/v1/posts';
const CREATE = 'POST /api/v1/posts';
/** 고정 영역의 요청 — 공지의 첫 페이지 3건이다(sp-docs/requirements/board.md §8 의 예). */
const PINNED_QUERY = { page: 0, size: 3, sort: 'latest', category: 'NOTICE' };
const P003 = () => fail(403, 'P003', '공지를 작성하거나 변경할 권한이 없습니다.');

let routes: Record<string, Handler> = {};
const requests: Array<{ key: string; params: Query | null; body: unknown }> = [];
const sent = (key: string) => requests.filter((r) => r.key === key);
/** 글 목록 요청의 쿼리 — 보낸 순서대로. */
const listQueries = () => sent(LIST).map((r) => r.params);
/** 아래 목록의 요청 — 한 페이지 10건이다(pages/PostListPage.tsx). 고정 영역의 요청은 3건이다. */
const mainQueries = () => listQueries().filter((query) => query?.size === 10);

async function adapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const key = `${config.method?.toUpperCase()} ${config.url}`;
  requests.push({
    key,
    params: (config.params as Query | undefined) ?? null,
    body: typeof config.data === 'string' ? JSON.parse(config.data) : null,
  });
  const handler = routes[key];
  if (!handler) throw new Error(`스텁에 없는 요청: ${key}`);
  const reply = await handler(config);
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
      ok(as === ADMIN ? { accountId: ADMIN.sub, nickname: '관리자' } : { accountId: USER.sub, nickname: '테스트닉' }),
    [LIST]: listOf(POSTS),
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
  // 조회 결과를 화면에 알리는 것을 미루지 않는다(src/pages/postEdit.test.tsx 와 같다).
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
const pathname = () => window.location.pathname;
const type = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
/** 보낸 조회의 답이 화면까지 갔을 자리를 지난다 — 스텁은 곧바로 답한다. 그리지 않았다는 단언 앞에 둔다. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

const tab = (name: string) => within(screen.getByRole('group', { name: '카테고리' })).getByRole('button', { name });
/** 최근 공지 영역 — 없으면 `null` 이다. */
const pinnedPanel = () => screen.queryByRole('heading', { name: '최근 공지' })?.closest('section') ?? null;
/** 아래 목록이 그 글을 그린 자리 — 표의 줄과 좁은 화면의 줄 목록 항목이다(components/PostTable.tsx). 고정 영역은 뺀다. */
const listed = (title: string) => {
  const pinned = pinnedPanel();
  return within(main())
    .queryAllByRole('link', { name: title })
    .filter((link) => !pinned?.contains(link))
    .map((link) => link.closest('tr, li') as HTMLElement);
};
const badged = (place: HTMLElement) => within(place).queryByText('공지', { exact: true }) !== null;
/** 아래 목록이 다 그려질 때까지 — 표와 줄 목록에 그 글이 있다. */
const listShows = (title: string) => waitFor(() => expect(listed(title)).toHaveLength(2));

const categorySelect = () => screen.getByLabelText('카테고리') as HTMLSelectElement;
const choices = () => [...categorySelect().options].map((option) => [option.value, option.textContent]);

describe('글 목록 — 카테고리 탭', () => {
  it('탭 + 검색어 + 정렬 — 세 파라미터가 한 요청에 함께 나간다. 탭을 바꾸면 그 값으로 다시 묻고, 전체는 카테고리를 싣지 않는다', async () => {
    await renderApp('/posts');
    await listShows(FREE_POST.title);

    type(screen.getByLabelText('정렬'), 'views');
    type(screen.getByLabelText('검색어'), '글');
    fireEvent.click(screen.getByRole('button', { name: '검색' }));
    fireEvent.click(tab('질문'));

    await waitFor(() =>
      expect(mainQueries().at(-1)).toEqual({
        page: 0,
        size: 10,
        sort: 'views',
        searchType: 'TITLE',
        keyword: '글',
        category: 'QNA',
      }),
    );
    // 그 탭의 답을 그린다 — 다른 카테고리의 글은 사라진다.
    await listShows(QNA_POST.title);
    expect(listed(FREE_POST.title)).toEqual([]);
    expect(tab('질문')).toHaveAttribute('aria-pressed', 'true');
    expect(tab('전체')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(tab('자유'));
    await waitFor(() => expect(mainQueries().at(-1)).toMatchObject({ sort: 'views', keyword: '글', category: 'FREE' }));
    await listShows(FREE_POST.title);
    expect(listed(QNA_POST.title)).toEqual([]);

    fireEvent.click(tab('전체'));
    await waitFor(() => expect(mainQueries().at(-1)).toEqual({ page: 0, size: 10, sort: 'views', searchType: 'TITLE', keyword: '글' }));
  });

  it('전체 탭에는 공지도 들어 있다 — 아래 목록에서 공지에만 배지가 붙는다', async () => {
    await renderApp('/posts');
    await listShows(NOTICE.title);

    expect(mainQueries()[0]).not.toHaveProperty('category');
    expect(listed(NOTICE.title).map(badged)).toEqual([true, true]);
    expect(listed(FREE_POST.title).map(badged)).toEqual([false, false]);
    expect(listed(QNA_POST.title).map(badged)).toEqual([false, false]);
  });

  it('탭을 바꾸면 첫 페이지로 간다', async () => {
    await renderApp('/posts', { extra: { [LIST]: listOf(MANY) } });
    await listShows('자유 글 1');
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    await waitFor(() => expect(mainQueries().at(-1)).toMatchObject({ page: 1 }));

    fireEvent.click(tab('자유'));

    await waitFor(() => expect(mainQueries().at(-1)).toMatchObject({ page: 0, category: 'FREE' }));
  });

  it('내 글 목록에는 카테고리 탭이 없다 — 요청에 카테고리가 없고, 공지에는 배지가 붙는다', async () => {
    await renderApp('/posts/mine', { as: ADMIN, extra: { 'GET /api/v1/posts/me': listOf([NOTICE, OLD_NOTICE]) } });
    await listShows(NOTICE.title);

    expect(screen.queryByRole('group', { name: '카테고리' })).toBeNull();
    expect(sent('GET /api/v1/posts/me').map((r) => r.params)).toEqual([{ page: 0, size: 10, sort: 'latest' }]);
    expect(listed(OLD_NOTICE.title).map(badged)).toEqual([true, true]);
  });
});

describe('글 목록 — 최근 공지 고정', () => {
  it('전체 목록 첫 페이지 — 고정 영역이 공지를 따로 받아 그린다. 같은 공지는 아래 목록에도 배지와 함께 남는다', async () => {
    await renderApp('/posts', { extra: { [LIST]: listOf(MANY) } });
    await listShows(NOTICE.title);

    expect(listQueries()).toContainEqual(PINNED_QUERY);
    // 지난 공지는 아래 목록의 첫 페이지에 없다 — 고정 영역이 따로 받은 것을 그린다.
    await waitFor(() => expect(pinnedPanel()).not.toBeNull());
    const pinned = within(pinnedPanel()!);
    expect(pinned.getAllByRole('link').map((link) => link.textContent)).toEqual([NOTICE.title, OLD_NOTICE.title]);
    expect(pinned.getByRole('link', { name: OLD_NOTICE.title })).toHaveAttribute('href', `/posts/${OLD_NOTICE.id}`);
    expect(listed(OLD_NOTICE.title)).toEqual([]);
    expect(listed(NOTICE.title).map(badged)).toEqual([true, true]);
  });

  it('전체 목록 둘째 페이지 — 고정 영역이 없다. 첫 페이지로 돌아오면 다시 있다', async () => {
    await renderApp('/posts', { extra: { [LIST]: listOf(MANY) } });
    await listShows('자유 글 1');
    await waitFor(() => expect(pinnedPanel()).not.toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '다음' }));

    await listShows(OLD_NOTICE.title);
    expect(mainQueries().at(-1)).toMatchObject({ page: 1 });
    expect(pinnedPanel()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '이전' }));
    await listShows('자유 글 1');
    expect(pinnedPanel()).not.toBeNull();
  });

  // 탭의 줄은 저마다 다른 카테고리를 기대한다 — 공지 탭이 제 값을 싣는지와 어느 탭에나 같은 값을 싣지 않는지를 함께 가른다.
  // 스텁은 검색어로 거르지 않으므로(`listOf`) 검색의 줄은 받은 글을 다 그린다.
  it.each([
    ['공지가 아닌 탭', () => fireEvent.click(tab('질문')), { category: 'QNA' }, [QNA_POST]],
    ['공지 탭', () => fireEvent.click(tab('공지')), { category: 'NOTICE' }, [NOTICE, OLD_NOTICE]],
    [
      '검색을 건 목록',
      () => {
        type(screen.getByLabelText('검색어'), '안내');
        fireEvent.click(screen.getByRole('button', { name: '검색' }));
      },
      { searchType: 'TITLE', keyword: '안내' },
      POSTS,
    ],
  ])('%s — 아래 목록을 그 조건으로 받아 그리고, 고정 영역이 없다', async (_, narrow, condition, drawn) => {
    await renderApp('/posts');
    await waitFor(() => expect(pinnedPanel()).not.toBeNull());
    const before = mainQueries().length;

    narrow();

    await waitFor(() => expect(mainQueries()).toHaveLength(before + 1));
    expect(mainQueries().at(-1)).toEqual({ page: 0, size: 10, sort: 'latest', ...condition });
    await waitFor(() => expect(main()).not.toHaveTextContent('불러오는 중'));
    expect(POSTS.filter((post) => listed(post.title).length > 0).map((post) => post.title)).toEqual(
      drawn.map((post) => post.title),
    );
    expect(pinnedPanel()).toBeNull();
  });

  it('공백뿐인 검색어 — 검색으로 치지 않는다. 검색어를 싣지 않고 고정 영역이 남는다', async () => {
    await renderApp('/posts');
    await waitFor(() => expect(pinnedPanel()).not.toBeNull());
    const before = mainQueries().length;

    type(screen.getByLabelText('검색어'), '   ');
    fireEvent.click(screen.getByRole('button', { name: '검색' }));

    // 적용한 검색어가 바뀌어 다시 묻는다 — 공백뿐인 검색어는 요청에 실리지 않는다(features/board/api.ts).
    await waitFor(() => expect(mainQueries()).toHaveLength(before + 1));
    expect(mainQueries().at(-1)).toEqual({ page: 0, size: 10, sort: 'latest' });
    await waitFor(() => expect(main()).not.toHaveTextContent('불러오는 중'));
    expect(pinnedPanel()).not.toBeNull();
  });

  it('공지를 받는 동안 — 고정 영역을 그리지 않는다. 받으면 그린다', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const list = listOf(POSTS);
    await renderApp('/posts', {
      extra: {
        [LIST]: async (config) => {
          if (config.params?.size === 3) await gate;
          return list(config);
        },
      },
    });
    await listShows(NOTICE.title);
    await waitFor(() => expect(listQueries()).toContainEqual(PINNED_QUERY));
    await settle();

    expect(pinnedPanel()).toBeNull();

    release();

    await waitFor(() => expect(pinnedPanel()).not.toBeNull());
    expect(within(pinnedPanel()!).getAllByRole('link').map((link) => link.textContent)).toEqual([
      NOTICE.title,
      OLD_NOTICE.title,
    ]);
  });

  it('공지가 없으면 — 고정 영역을 그리지 않는다', async () => {
    await renderApp('/posts', { extra: { [LIST]: listOf([FREE_POST, QNA_POST]) } });
    await listShows(FREE_POST.title);
    await waitFor(() => expect(listQueries()).toContainEqual(PINNED_QUERY));
    await settle();

    expect(pinnedPanel()).toBeNull();
  });

  it('고정 영역을 받지 못하면 — 그 자리에 오류 상자가 코드와 함께 보이고 아래 목록은 그대로다', async () => {
    const list = listOf(POSTS);
    await renderApp('/posts', {
      extra: {
        [LIST]: (config) => (config.params?.size === 3 ? fail(500, 'C005', '서버 내부 오류가 발생했습니다.') : list(config)),
      },
    });
    await listShows(NOTICE.title);

    await waitFor(() => expect(pinnedPanel()?.querySelector('[data-error-code="C005"]')).not.toBeNull());
    expect(pinnedPanel()).toHaveTextContent(ERROR_SENTENCES.C005.text);
    expect(listed(NOTICE.title).map(badged)).toEqual([true, true]);
  });
});

describe('글 작성·수정 폼 — 카테고리', () => {
  it.each([
    ['USER 로', USER, [['FREE', '자유'], ['QNA', '질문']]],
    ['ADMIN 으로', ADMIN, [['NOTICE', '공지'], ['FREE', '자유'], ['QNA', '질문']]],
  ] as const)('%s 폼을 연다 — 공지 선택지는 ADMIN 에게만 있고, 처음 값은 자유다', async (_, as, expected) => {
    await renderApp('/posts/new', { as });
    await screen.findByLabelText('카테고리');

    expect(choices()).toEqual(expected);
    expect(categorySelect()).toHaveValue('FREE');
  });

  it('새 글 — 고른 카테고리를 보낸다', async () => {
    await renderApp('/posts/new', {
      as: USER,
      extra: { ...detailRoutes(QNA_POST), [CREATE]: () => ok(detail(QNA_POST, '지금 본문'), 201) },
    });
    type(await screen.findByLabelText('카테고리'), 'QNA');
    type(screen.getByLabelText(/^제목/), '질문이 있습니다');
    type(screen.getByLabelText(/^본문/), '본문');

    fireEvent.submit(main().querySelector('form')!);

    await waitFor(() => expect(pathname()).toBe(`/posts/${QNA_POST.id}`));
    expect(sent(CREATE).map((r) => r.body)).toEqual([{ title: '질문이 있습니다', content: '본문', category: 'QNA' }]);
  });

  it('저장 → 403 P003 — 그 안내가 코드와 함께 보이고 입력이 남는다', async () => {
    await renderApp('/posts/new', { as: ADMIN, extra: { [CREATE]: P003 } });
    type(await screen.findByLabelText('카테고리'), 'NOTICE');
    type(screen.getByLabelText(/^제목/), '점검 공지');
    type(screen.getByLabelText(/^본문/), '점검 시간을 알립니다.');

    fireEvent.submit(main().querySelector('form')!);

    await waitFor(() => expect(document.querySelector('[data-error-code="P003"]')).not.toBeNull());
    expect(main()).toHaveTextContent(ERROR_SENTENCES.P003.text);
    expect(sent(CREATE).map((r) => r.body)).toEqual([{ title: '점검 공지', content: '점검 시간을 알립니다.', category: 'NOTICE' }]);
    expect(pathname()).toBe('/posts/new');
    expect(categorySelect()).toHaveValue('NOTICE');
    expect(screen.getByLabelText(/^제목/)).toHaveValue('점검 공지');
    expect(screen.getByLabelText(/^본문/)).toHaveValue('점검 시간을 알립니다.');
  });

  describe('수정 폼', () => {
    const edit = (post: ReturnType<typeof item>, as: Who, update: Handler) =>
      renderApp(`/posts/${post.id}/edit`, {
        as,
        extra: { ...detailRoutes(post), [`PUT /api/v1/posts/${post.id}`]: update },
      });
    const saved = (post: ReturnType<typeof item>) => () => ok(detail(post, '지금 본문'));
    const submit = () => fireEvent.submit(main().querySelector('form')!);

    it('지금 카테고리가 골라져 있다 — 바꾸지 않고 저장하면 그 값을 그대로 보낸다', async () => {
      // 폼의 처음 값(자유)과 다른 카테고리다 — 받은 값으로 골랐는지 가른다.
      const mine = { ...QNA_POST, writerId: USER.sub };
      await edit(mine, USER, saved(mine));
      await waitFor(() => expect(categorySelect()).toHaveValue('QNA'));
      expect(choices()).toEqual([['FREE', '자유'], ['QNA', '질문']]);

      submit();

      await waitFor(() => expect(pathname()).toBe(`/posts/${mine.id}`));
      expect(sent(`PUT /api/v1/posts/${mine.id}`).map((r) => r.body)).toEqual([
        { title: mine.title, content: '지금 본문', category: 'QNA' },
      ]);
    });

    it('ADMIN 의 공지 — 공지가 골라져 있다', async () => {
      await edit(NOTICE, ADMIN, saved(NOTICE));

      await waitFor(() => expect(categorySelect()).toHaveValue('NOTICE'));
      expect(choices()).toEqual([['NOTICE', '공지'], ['FREE', '자유'], ['QNA', '질문']]);
    });

    describe('ADMIN 이 아닌데 지금 공지인 글', () => {
      const mine = { ...OLD_NOTICE, writerId: USER.sub };
      // 서버처럼 — ADMIN 이 아니면 공지에서 다른 값으로 바꾸는 수정만 막는다(sp-docs/requirements/board.md §8).
      const update: Handler = (config) =>
        JSON.parse(config.data as string).category === 'NOTICE' ? saved(mine)() : P003();

      it('공지가 골라져 있다 — 바꾸지 않고 저장하면 공지를 그대로 보낸다', async () => {
        await edit(mine, USER, update);
        await waitFor(() => expect(categorySelect()).toHaveValue('NOTICE'));
        expect(choices()).toEqual([['NOTICE', '공지'], ['FREE', '자유'], ['QNA', '질문']]);

        submit();

        await waitFor(() => expect(pathname()).toBe(`/posts/${mine.id}`));
        expect(sent(`PUT /api/v1/posts/${mine.id}`).map((r) => r.body)).toEqual([
          { title: mine.title, content: '지금 본문', category: 'NOTICE' },
        ]);
      });

      it('다른 값으로 바꾸면 — 서버의 P003 이 보이고 입력과 공지 선택지가 남는다. 공지로 되돌려 저장하면 공지를 보낸다', async () => {
        await edit(mine, USER, update);
        await waitFor(() => expect(categorySelect()).toHaveValue('NOTICE'));

        type(categorySelect(), 'FREE');
        submit();

        await waitFor(() => expect(document.querySelector('[data-error-code="P003"]')).not.toBeNull());
        expect(main()).toHaveTextContent(ERROR_SENTENCES.P003.text);
        expect(sent(`PUT /api/v1/posts/${mine.id}`).map((r) => r.body)).toEqual([
          { title: mine.title, content: '지금 본문', category: 'FREE' },
        ]);
        expect(pathname()).toBe(`/posts/${mine.id}/edit`);
        expect(categorySelect()).toHaveValue('FREE');
        expect(screen.getByLabelText(/^제목/)).toHaveValue(mine.title);
        expect(screen.getByLabelText(/^본문/)).toHaveValue('지금 본문');
        // 공지 선택지는 받은 글의 카테고리로 둔다 — 지금 고른 값이 공지가 아니어도 남는다.
        expect(choices()).toEqual([['NOTICE', '공지'], ['FREE', '자유'], ['QNA', '질문']]);

        type(categorySelect(), 'NOTICE');
        submit();

        await waitFor(() => expect(pathname()).toBe(`/posts/${mine.id}`));
        expect(sent(`PUT /api/v1/posts/${mine.id}`).map((r) => r.body)).toEqual([
          { title: mine.title, content: '지금 본문', category: 'FREE' },
          { title: mine.title, content: '지금 본문', category: 'NOTICE' },
        ]);
      });
    });
  });
});
