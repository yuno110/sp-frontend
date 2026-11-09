import { cleanup, render, waitFor } from '@testing-library/react';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROUTES } from '../e2e/routes';

/**
 * 브라우저 테스트가 여는 라우트 목록(e2e/routes.ts)이 라우터와 같은가 (sp-docs/plan/phase2.md §7.2 F-05 — "개발 전용이 아닌
 * 모든 라우트"). 라우터를 모드마다 새로 읽어 경로를 모은다 — 흉내는 src/lib/devOnly.test.tsx 와 같다. 라우트마다 잰 상태가
 * 있는지는 e2e/screens.spec.ts 가 본다.
 */

interface RouteNode {
  path?: string;
  index?: boolean;
  children?: RouteNode[];
}

/** 화면이 되는 라우트(자식이 없는 것)의 경로. 색인 라우트는 부모의 경로다. */
function patternsOf(routes: RouteNode[], parent = ''): string[] {
  return routes.flatMap((route) => {
    const path = route.index ? parent : route.path?.startsWith('/') ? route.path : `${parent.replace(/\/$/, '')}/${route.path ?? ''}`;
    return route.children ? patternsOf(route.children, path) : [path];
  });
}

async function routerPatterns(mode: 'dev' | 'prod'): Promise<string[]> {
  vi.stubEnv('DEV', mode === 'dev');
  vi.stubEnv('PROD', mode === 'prod');
  vi.resetModules();
  const { router } = await import('@/router');
  disposeRouter = () => router.dispose();
  return patternsOf(router.routes as RouteNode[]).sort();
}

let disposeRouter: (() => void) | null = null;

afterEach(() => {
  cleanup();
  disposeRouter?.();
  disposeRouter = null;
  vi.unstubAllEnvs();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('브라우저 테스트의 라우트 목록', () => {
  it('프로덕션 빌드의 라우터와 같다', async () => {
    expect(await routerPatterns('prod')).toEqual([...ROUTES].sort());
  });

  it('개발 빌드의 라우터는 개발 전용 라우트를 더 갖는다 — 목록에 없는 것은 그것뿐이다', async () => {
    const dev = await routerPatterns('dev');
    expect(dev.filter((pattern) => !(ROUTES as readonly string[]).includes(pattern))).toEqual(['/tokens']);
  });
});

/**
 * 세션이 끝난 이유를 보이는 자리. 토큰이 비어도 머무는 화면은 라우트에 표시를 달아 머리글 아래에서 보이고, 나머지는 로그인 화면이 잇는다.
 * 표시가 없는 새 공개 화면은 이유를 다음 로그인 화면 방문에야 보이고, 표시가 있는 보호된 화면은 곧 사라질 화면이 이유를 가져가 버린다.
 */
describe('세션이 끝난 이유를 보이는 화면', () => {
  interface Leaf {
    path?: string;
    index?: boolean;
    handle?: { showsSessionFailure?: boolean };
    element?: { type?: { name?: string } };
  }

  /** 토큰이 비면 로그인 화면으로 가거나, 스스로 로그인 화면이거나, 다른 라우트로 옮겨 간다. */
  const NOT_STAYING = ['RequireToken', 'Navigate', 'LoginPage'];

  it('토큰이 비어도 머무는 화면만 표시한다', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('PROD', false);
    vi.resetModules();
    const { router } = await import('@/router');
    disposeRouter = () => router.dispose();
    const leaves = router.routes[0].children as Leaf[];
    const marked = leaves.filter((leaf) => leaf.handle?.showsSessionFailure === true);
    const staying = leaves.filter((leaf) => !NOT_STAYING.includes(leaf.element?.type?.name ?? ''));

    expect(marked.map((leaf) => leaf.path)).toEqual(staying.map((leaf) => leaf.path));
    // 양성 대조 — 위 걸음이 라우트의 컴포넌트를 실제로 가른다. 이름을 읽지 못하면 모두 머무는 화면이 된다.
    expect(staying.map((leaf) => leaf.path)).toEqual(['signup', 'posts', 'posts/:id', 'members/:accountId', 'tokens']);
  });
});

/**
 * 서버의 `/api/v1/posts/me` 와 같은 꼴을 주소창에 치는 경우. `/posts/:id` 와 `/posts/:id/edit` 이 `me` 를 글 id 로 받으면 **목록
 * 응답을 글로 읽는다** — 200 이라 오류도 뜨지 않고 제목·본문이 빈 화면이나 폼이 된다.
 */
describe('글 id 자리의 me', () => {
  it.each(['/posts/me', '/posts/me/edit'])('%s — 내 글로 간다. 목록 응답을 글로 읽지 않는다', async (path) => {
    vi.resetModules();
    window.history.replaceState(null, '', path);
    const requested: string[] = [];
    const { default: axios } = await import('axios');
    const original = axios.defaults.adapter;
    axios.defaults.adapter = (async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
      requested.push(`${config.method?.toUpperCase()} ${config.url}`);
      const data = config.url?.endsWith('/members/me')
        ? { accountId: 7, nickname: '테스트닉' }
        : { content: [], page: 0, size: 10, totalElements: 0, totalPages: 0, first: true, last: true };
      return { data: { success: true, data, error: null }, status: 200, statusText: 'OK', headers: {}, config };
    }) as never;
    try {
      const { useAuthStore } = await import('@/stores/authStore');
      const claims = btoa(JSON.stringify({ sub: '7', role: 'USER', exp: Math.floor(Date.now() / 1000) + 1800 }));
      useAuthStore.getState().setTokens({
        grantType: 'Bearer',
        accessToken: [btoa('{"alg":"RS256"}'), claims, 'signature'].join('.'),
        refreshToken: 'RT-1',
        accessTokenExpiresIn: 1800,
      });
      const { router } = await import('@/router');
      disposeRouter = () => router.dispose();
      const { App } = await import('@/App');
      render(<App />);

      await waitFor(() => expect(window.location.pathname).toBe('/posts/mine'));
      await waitFor(() => expect(document.querySelector('main')).toHaveTextContent('쓴 글이 없습니다'));
      // 내 글 화면의 조회 하나뿐이다 — 글 상세의 댓글 조회도, 수정 폼도 나가지 않았다.
      expect(requested.filter((key) => key.includes('/posts'))).toEqual(['GET /api/v1/posts/me']);
      expect(document.querySelector('form')).toBeNull();
    } finally {
      axios.defaults.adapter = original;
    }
  });
});
