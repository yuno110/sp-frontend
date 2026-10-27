import type { Plugin } from 'vite';

/**
 * 프로덕션 빌드의 `index.html` 에 넣는 CSP (sp-docs/plan/phase2.md §7.2 F-02).
 *
 * `connect-src` 는 **빌드 때의 환경값**에서 만든다 — 주소를 여기에 두지 않는다. 직접 호출이면 서비스
 * 주소의 오리진이고, 프록시 모드면 같은 오리진(`'self'`)이다. 두 모드를 가르는 규칙은
 * `src/lib/api/services.ts` 와 같다.
 */
const SERVICE_BASE_URLS = ['VITE_AUTH_BASE_URL', 'VITE_MEMBER_BASE_URL', 'VITE_BOARD_BASE_URL'];

export function contentSecurityPolicy(env: Record<string, string | undefined>): string {
  const connect =
    env.VITE_API_MODE === 'proxy'
      ? ["'self'"]
      : [...new Set(SERVICE_BASE_URLS.map((name) => originOf(name, env[name])))];
  return [`default-src 'self'`, `script-src 'self'`, `connect-src ${connect.join(' ')}`].join('; ');
}

/** 주소가 비었거나 http(s) 가 아니면 빌드를 멈춘다 — 조용히 빼면 그 서비스로 가는 호출을 CSP 가 막는다. */
function originOf(name: string, value: string | undefined): string {
  const url = value ? URL.parse(value) : null;
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(
      `CSP 의 connect-src 를 만들 수 없다 — ${name} 이 http(s) 주소가 아니다: ${JSON.stringify(value)}`,
    );
  }
  return url.origin;
}

/**
 * 빌드에만 붙는다. 개발 서버에 넣지 않는 것은 React 플러그인의 Fast Refresh 가 인라인 스크립트를
 * 쓰기 때문이다.
 *
 * `<meta>` 를 `<head>` 맨 앞에 둔다 — 정책은 그 요소 뒤에 오는 것에만 걸리고, 빌드가 넣는 스크립트
 * 태그도 `<head>` 에 들어간다.
 */
export function cspPlugin(): Plugin {
  let policy = '';
  return {
    name: 'sp-frontend:csp',
    apply: 'build',
    configResolved(config) {
      policy = contentSecurityPolicy(config.env);
    },
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: policy },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}
