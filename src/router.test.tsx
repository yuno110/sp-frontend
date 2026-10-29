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
  disposeRouter?.();
  disposeRouter = null;
  vi.unstubAllEnvs();
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
