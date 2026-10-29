import type { Page, Request } from '@playwright/test';

/**
 * API 스텁. 백엔드를 띄우지 않으므로 화면이 보내는 요청에 이 파일이 답한다(sp-docs/plan/phase2.md §7.2 F-05).
 * **경로와 응답의 모양은 sp-docs/api-contract.md 에서 온다** — 경로 표(§2~§4), 공통 응답(§7), 페이징(§7.1), 토큰(§9.2),
 * 오류 코드와 메시지(§8). 필드 오류의 문장은 sp-docs/requirements/member.md §2 와 phase2.md §7.2 F-03 의 예다.
 *
 * 경로로만 고른다 — 어느 서비스 주소로 갔는지는 보지 않는다. 주소 배정은 src/lib/api/services.test.ts 가 보고, 빌드의
 * CSP 가 허용하지 않은 주소로 가면 그 위반이 잡힌다(e2e/checks.ts).
 *
 * **preflight(OPTIONS)는 여기 오지 않는다.** 가로채기를 켜면 Playwright 가 직접 답한다(playwright-core 의
 * crNetworkManager). 그래서 이 스텁으로는 CORS 를 재지 못한다 — 실제 서비스와의 e2e(F-06)가 본다. 본 응답에는 허용
 * 오리진을 싣는다(sp-docs/security.md §1.1).
 */

export interface FieldError {
  field: string;
  message: string;
}

export interface Reply {
  status: number;
  body?: unknown;
}

/** 요청 하나의 답. 함수면 요청을 보고 답한다 — 앞선 요청에 따라 답이 바뀌는 흐름(가입)이 쓴다. */
export type Answer = Reply | ((request: Request) => Reply);

/** `METHOD 경로` → 답. 쿼리는 키에 넣지 않는다. */
export type Routes = Record<string, Answer>;

export const ok = (data: unknown, status = 200): Reply => ({ status, body: { success: true, data, error: null } });

export const NO_CONTENT: Reply = { status: 204 };

/** §8 의 코드 — 이 스텁이 쓰는 것만 둔다. */
const ERRORS = {
  C001: { status: 400, message: '잘못된 입력값입니다.' },
  C005: { status: 500, message: '서버 내부 오류가 발생했습니다.' },
  A002: { status: 401, message: '유효하지 않은 토큰입니다.' },
  M001: { status: 404, message: '프로필을 찾을 수 없습니다.' },
  P001: { status: 404, message: '게시글을 찾을 수 없습니다.' },
  AU003: { status: 401, message: '이메일 또는 비밀번호가 일치하지 않습니다.' },
} as const;

export const fail = (code: keyof typeof ERRORS, fieldErrors: FieldError[] = []): Reply => ({
  status: ERRORS[code].status,
  body: { success: false, data: null, error: { code, message: ERRORS[code].message, fieldErrors } },
});

/** §7.1. 한 쪽짜리 페이지다. */
export const pageOf = (content: unknown[], size = 10) => ({
  content,
  page: 0,
  size,
  totalElements: content.length,
  totalPages: content.length > 0 ? 1 : 0,
  first: true,
  last: true,
});

export interface Who {
  accountId: number;
  role: 'USER' | 'ADMIN';
}

export const ME: Who = { accountId: 7, role: 'USER' };
export const OTHER_ID = 12;
export const WITHDRAWN_ID = 13;

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** claim 은 §6 이다. 화면은 서명을 검증하지 않는다(src/lib/jwt.ts) — 서명 자리는 아무 값이다. */
function jwt(who: Who): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: String(who.accountId), role: who.role, iss: 'auth-service', iat: now, exp: now + 1800 };
  return [base64url({ alg: 'RS256', kid: 'e2e' }), base64url(claims), 'e2e-signature'].join('.');
}

/** 로그인·재발급의 응답(§9.2). */
export const tokens = (who: Who) => ({
  grantType: 'Bearer',
  accessToken: jwt(who),
  refreshToken: `refresh-${who.accountId}-${Date.now()}`,
  accessTokenExpiresIn: 1800,
});

// ── 화면에 그릴 값. 이메일·닉네임·제목의 길이는 입력 제약의 끝으로 둔다 — 360px 폭에서 넘치는지 보려는 것이다
//    (sp-docs/requirements/member.md §2, requirements/board.md §4).

/** 띄어쓰기 없는 긴 낱말. 사용자가 붙여 넣는 주소가 그렇다. */
export const LONG_WORD = `https://example.com/${'segment/'.repeat(8)}end`;

export const EMAIL = `${'a'.repeat(64)}@${'b'.repeat(31)}.com`;
export const NICKNAME = '열글자까지쓰는닉네임';
export const TITLE = `${LONG_WORD} 를 붙인 제목 ${'가나다라 '.repeat(40)}`.slice(0, 200);
const CREATED_AT = '2026-10-27T09:00:00';

export const POST = {
  id: 1,
  title: TITLE,
  writerId: ME.accountId,
  writerNickname: NICKNAME,
  viewCount: 152,
  commentCount: 2,
  createdAt: CREATED_AT,
};

export const OTHER_POST = {
  id: 2,
  title: '짧은 글',
  writerId: OTHER_ID,
  writerNickname: '다른사람',
  viewCount: 0,
  commentCount: 0,
  createdAt: '2026-10-26T18:30:00',
};

export const POST_DETAIL = { ...POST, content: `본문 첫 줄\n${LONG_WORD}\n${'본문을 채우는 문장입니다. '.repeat(20)}` };

export const COMMENTS = [
  { id: 5, writerId: ME.accountId, writerNickname: NICKNAME, content: `내 댓글 ${LONG_WORD}`, createdAt: '2026-10-27T09:30:00' },
  { id: 6, writerId: OTHER_ID, writerNickname: '다른사람', content: '짧은 댓글', createdAt: '2026-10-27T10:00:00' },
];

export const MY_PROFILE = { accountId: ME.accountId, nickname: NICKNAME };

/** 기본 답. 테스트가 `use` 로 덮는다. */
const BASE: Routes = {
  'GET /api/v1/posts': ok(pageOf([POST, OTHER_POST])),
  'GET /api/v1/posts/me': ok(pageOf([POST])),
  'GET /api/v1/posts/1': ok(POST_DETAIL),
  'GET /api/v1/posts/1/comments': ok(pageOf(COMMENTS, 20)),
  'GET /api/v1/members/me': ok(MY_PROFILE),
  'GET /api/v1/accounts/me': ok({ email: EMAIL, createdAt: '2026-10-27T08:00:00' }),
  [`GET /api/v1/members/${ME.accountId}`]: ok({ ...MY_PROFILE, createdAt: '2026-10-27T08:05:00', deleted: false }),
  // 탈퇴한 프로필도 200 이고 닉네임은 "탈퇴한 회원" 이다(§3.1).
  [`GET /api/v1/members/${WITHDRAWN_ID}`]: ok({
    accountId: WITHDRAWN_ID,
    nickname: '탈퇴한 회원',
    createdAt: '2026-10-01T09:00:00',
    deleted: true,
  }),
};

/** Refresh Token 을 두는 영속 키 — src/stores/authStore.ts 의 `REFRESH_TOKEN_KEY` 다. */
const REFRESH_TOKEN_KEY = 'sp-auth';

export interface Sent {
  key: string;
  body: unknown;
}

export class ApiStub {
  /** 화면이 보낸 요청 — 순서대로. */
  readonly sent: Sent[] = [];
  /** 표에 없는 요청. 끊고 여기 남긴다 — 테스트가 끝날 때 비어 있어야 한다(e2e/fixtures.ts). */
  readonly unexpected: string[] = [];
  private readonly routes: Routes = { ...BASE };
  private readonly page: Page;
  private readonly origin: string;

  private constructor(page: Page, origin: string) {
    this.page = page;
    this.origin = origin;
  }

  static async start(page: Page, baseURL: string): Promise<ApiStub> {
    const stub = new ApiStub(page, new URL(baseURL).origin);
    await page.route((url) => url.pathname.startsWith('/api/'), async (route) => {
      const request = route.request();
      const key = `${request.method()} ${new URL(request.url()).pathname}`;
      const body = request.postData();
      stub.sent.push({ key, body: body ? JSON.parse(body) : null });
      const answer = stub.routes[key];
      if (!answer) {
        stub.unexpected.push(key);
        await route.abort();
        return;
      }
      const reply = typeof answer === 'function' ? answer(request) : answer;
      await route.fulfill({
        status: reply.status,
        headers: { 'Access-Control-Allow-Origin': stub.origin },
        contentType: 'application/json',
        body: reply.body === undefined ? '' : JSON.stringify(reply.body),
      });
    });
    return stub;
  }

  /** 답을 더하거나 덮는다. */
  use(routes: Routes): void {
    Object.assign(this.routes, routes);
  }

  /**
   * 로그인한 상태로 연다 — 새로고침과 같은 길이다. Refresh Token 을 영속 키에 두면 화면이 재발급으로 세션을 되살린다
   * (src/lib/api/client.ts 의 `restoreSession`). 문서가 열릴 때마다 다시 둔다. 화면을 열기 전에 부른다.
   */
  async login(who: Who = ME): Promise<void> {
    await this.page.addInitScript(
      ([origin, key]) => {
        if (location.origin === origin) sessionStorage.setItem(key, 'refresh-token-before-reload');
      },
      [this.origin, REFRESH_TOKEN_KEY] as const,
    );
    this.use({ 'POST /api/v1/auth/reissue': () => ok(tokens(who)) });
  }

  /** 보낸 요청의 키만 — 순서를 볼 때 쓴다. */
  keys(): string[] {
    return this.sent.map((s) => s.key);
  }
}
