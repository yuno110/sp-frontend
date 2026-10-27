// @vitest-environment node
import path from 'node:path';
import { resolveConfig, type HtmlTagDescriptor, type IndexHtmlTransformHook } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contentSecurityPolicy } from './csp.ts';

/**
 * 프로덕션 빌드의 CSP (sp-docs/plan/phase2.md §7.2 F-02).
 *
 * 변환 함수에는 이 저장소의 `.env` 와 다른 임의의 주소를 준다 — 주소를 코드에 박았다면 그 주소가
 * 정책에 들어가지 않는다. 빌드에만 붙는지는 이 저장소의 `vite.config.ts` 를 두 명령으로 풀어서 본다.
 * 브라우저에서 위반이 없는지는 여기서 보지 않는다(F-05).
 *
 * 환경은 node 다 — jsdom 에서는 vite 가 싣는 esbuild 가 `TextEncoder` 불변식 검사에 걸려 이 파일이
 * 아예 실리지 않는다.
 */

/** `지시어 값 값; 지시어 값` → 지시어마다 값 목록. */
const parse = (policy: string) =>
  new Map(
    policy.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );

const DIRECT = {
  VITE_API_MODE: 'direct',
  VITE_AUTH_BASE_URL: 'https://auth.example.test',
  VITE_MEMBER_BASE_URL: 'https://member.example.test:8443/',
  VITE_BOARD_BASE_URL: 'http://127.0.0.1:9082/board',
};
const PROXY = { VITE_API_MODE: 'proxy' };

describe('contentSecurityPolicy', () => {
  it('직접 호출 — connect-src 가 환경값 주소의 오리진을 갖는다', () => {
    expect(parse(contentSecurityPolicy(DIRECT)).get('connect-src')).toEqual([
      'https://auth.example.test',
      'https://member.example.test:8443',
      'http://127.0.0.1:9082',
    ]);
  });

  it('프록시 모드 — connect-src 가 같은 오리진뿐이고 서비스 주소를 읽지 않는다', () => {
    expect(parse(contentSecurityPolicy(PROXY)).get('connect-src')).toEqual(["'self'"]);
  });

  it.each([
    ['직접 호출', DIRECT],
    ['프록시 모드', PROXY],
  ])('%s — script-src 가 인라인과 eval 을 허용하지 않는다', (_, env) => {
    const policy = contentSecurityPolicy(env);
    expect(parse(policy).get('script-src')).toEqual(["'self'"]);
    expect(policy).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });

  it('지시어는 default-src·script-src·connect-src 다', () => {
    expect([...parse(contentSecurityPolicy(DIRECT)).keys()]).toEqual([
      'default-src',
      'script-src',
      'connect-src',
    ]);
    expect(parse(contentSecurityPolicy(DIRECT)).get('default-src')).toEqual(["'self'"]);
  });

  it.each([undefined, '', 'localhost:8081'])(
    '직접 호출인데 주소가 %j 이면 정책을 만들지 않고 멈춘다',
    (value) => {
      expect(() => contentSecurityPolicy({ ...DIRECT, VITE_MEMBER_BASE_URL: value })).toThrow(
        /VITE_MEMBER_BASE_URL/,
      );
    },
  );
});

describe('vite.config.ts', () => {
  const configFile = path.resolve(import.meta.dirname, 'vite.config.ts');

  const cspPluginFor = async (command: 'build' | 'serve') => {
    const config = await resolveConfig({ configFile, logLevel: 'silent' }, command);
    return { config, plugin: config.plugins.find((p) => p.name === 'sp-frontend:csp') };
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('빌드 — index.html 의 머리 맨 앞에 빌드 환경값으로 만든 CSP 를 넣는다', async () => {
    // 빌드 환경에 `.env` 와 다른 주소를 준다 — 플러그인이 환경값 대신 고정값을 쓰면 이 오리진이 빠진다.
    vi.stubEnv('VITE_MEMBER_BASE_URL', 'https://member.build-env.test:9443/');
    const { config, plugin } = await cspPluginFor('build');
    // 이 플러그인의 변환은 인수를 읽지 않는다.
    const transform = plugin?.transformIndexHtml as IndexHtmlTransformHook;
    const tags = (await transform.call(undefined as never, '', undefined as never)) as
      HtmlTagDescriptor[] | undefined;

    expect(tags).toEqual([
      {
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: contentSecurityPolicy(config.env),
        },
        injectTo: 'head-prepend',
      },
    ]);
    expect(parse(String(tags?.[0].attrs?.content)).get('connect-src')).toContain(
      'https://member.build-env.test:9443',
    );
  });

  it('개발 서버 — 넣지 않는다', async () => {
    const { plugin } = await cspPluginFor('serve');
    expect(plugin).toBeUndefined();
  });
});
