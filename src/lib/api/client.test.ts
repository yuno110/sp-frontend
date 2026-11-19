import { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http, { describeError, fieldMessages } from './client';
import { ERROR_SENTENCES, MY_PROFILE, NO_RESPONSE, UNEXPECTED, tooManyRequests } from './errorCodes';
import {
  confirmEmailVerification,
  confirmPasswordReset,
  login,
  reissue,
  requestPasswordReset,
  resendVerification,
} from '@/features/auth/api';
import { listPosts } from '@/features/board/api';
import { useAuthStore } from '@/stores/authStore';

/**
 * 요청에 `Authorization` 이 붙는지 **실측으로** 잠근다.
 *
 * 인터셉터는 세 가지를 가른다 — 헤더가 지정되지 않았으면 스토어의 토큰을 넣고,
 * `null` 로 지정되면 떼고, 문자열로 지정되면 그대로 둔다.
 *
 * **무인증 경로에 토큰을 붙이면 오진을 만든다.** `POST /api/v1/auth/reissue` 는 인증이
 * 없는 경로인데(api-contract.md §2.1 의 인증 칸이 `-` 다) 만료된 Access Token 이 붙어
 * 있으면 bearer 필터가 인가 평가보다 먼저 돌아 **재발급 핸들러에 닿기 전에 401 `A003`**
 * 이 난다. 그러면 Refresh Token 을 읽어 보지도 못한 실패가 "Refresh Token 만료" 로 읽힌다.
 */
const seen: Array<{ url?: string; auth: unknown }> = [];

function stubAdapter(body: unknown) {
  http.defaults.adapter = vi.fn(async (config) => {
    seen.push({ url: config.url, auth: config.headers?.Authorization ?? null });
    return {
      data: body,
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    };
  }) as never;
}

const TOKENS = {
  grantType: 'Bearer',
  accessToken: 'AT-1',
  refreshToken: 'RT-1',
  accessTokenExpiresIn: 1800,
};

describe('Authorization 헤더', () => {
  beforeEach(() => {
    seen.length = 0;
    useAuthStore.setState({
      accessToken: 'AT-0',
      refreshToken: 'RT-0',
      accountId: 1,
      role: 'USER',
    });
  });

  it('지정하지 않으면 스토어의 토큰을 넣는다', async () => {
    stubAdapter({ success: true, data: { content: [] }, error: null });
    await listPosts({ page: 0, size: 10, sort: 'latest' });
    expect(seen).toHaveLength(1);
    expect(seen[0].auth).toBe('Bearer AT-0');
  });

  it('재발급은 무인증 경로이므로 헤더를 떼고 보낸다', async () => {
    stubAdapter({ success: true, data: TOKENS, error: null });
    await reissue('RT-0');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/api/v1/auth/reissue');
    expect(seen[0].auth).toBeNull();
  });

  /**
   * 로그인과 api-contract.md §2.4 의 무인증 요청(F-08, 비밀번호 재설정은 F-09). 스토어에 Access Token 이 있어도 싣지 않는다 — 실으면 서버의 bearer 필터가 그
   * 토큰을 검증해 만료면 401 `A003`, 잘못됐으면 401 `A002` 로 끊는다(CLAUDE.md 「경계」). '지정하지 않으면 스토어의 토큰을 넣는다' 가 양성 대조다 — 정하지 않은
   * 요청에는 같은 스토어의 토큰이 실린다.
   */
  it.each([
    ['로그인', '/api/v1/auth/login', () => login('user@example.com', 'Passw0rd!'), { success: true, data: TOKENS, error: null }],
    ['인증 메일 재발송', '/api/v1/accounts/email-verification', () => resendVerification('user@example.com'), { success: true, data: null, error: null }],
    ['이메일 인증 확인', '/api/v1/accounts/email-verification/confirm', () => confirmEmailVerification('link-token'), ''],
    ['비밀번호 재설정 요청', '/api/v1/accounts/password-reset', () => requestPasswordReset('user@example.com'), { success: true, data: null, error: null }],
    ['비밀번호 재설정 확인', '/api/v1/accounts/password-reset/confirm', () => confirmPasswordReset('link-token', 'NewPassw0rd!'), ''],
  ] as const)('%s — 스토어에 Access Token 이 있어도 헤더를 싣지 않는다', async (_, url, call, body) => {
    stubAdapter(body);
    await call();
    expect(seen).toEqual([{ url, auth: null }]);
    expect(useAuthStore.getState().accessToken).toBe('AT-0');
  });

  it('null 로 지정하면 떼고, 문자열로 지정하면 그대로 둔다 — 토큰 실험 화면이 쓰는 경로다', async () => {
    stubAdapter({ success: true, data: { content: [] }, error: null });
    await http.get('/api/v1/posts', { headers: { Authorization: null as unknown as string } });
    await http.get('/api/v1/posts', { headers: { Authorization: 'Bearer not!a!token' } });
    expect(seen.map((s) => s.auth)).toEqual([null, 'Bearer not!a!token']);
  });
});

/**
 * 화면에 보여줄 오류 (sp-docs/plan/phase2.md §7.2 F-03). 문장은 사용자 말로 바꾸되 **코드와 `fieldErrors` 는
 * 버리지 않는다** — 불변식 9의 "다듬는 것과 버리는 것은 다르다" 다.
 */
describe('describeError', () => {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const respond = (status: number, data: unknown) =>
    new AxiosError(`status ${status}`, AxiosError.ERR_BAD_REQUEST, config, null, {
      data,
      status,
      statusText: '',
      headers: {},
      config,
    } as AxiosResponse);
  const apiError = (status: number, code: string, message: string, fieldErrors: unknown[] = []) =>
    respond(status, { success: false, data: null, error: { code, message, fieldErrors } });

  it('사전에 있는 코드 — 사전의 문장과 복구 동작, 그리고 서버의 코드와 fieldErrors', () => {
    const fieldErrors = [{ field: 'title', message: '제목은 1~200자여야 합니다.' }];
    expect(describeError(apiError(400, 'C001', '잘못된 입력값입니다.', fieldErrors))).toEqual({
      text: ERROR_SENTENCES.C001.text,
      code: 'C001',
      recovery: null,
      fieldErrors,
      detail: null,
      retryAfter: null,
    });
    expect(describeError(apiError(401, 'A003', '만료된 토큰입니다.'))).toMatchObject({
      code: 'A003',
      recovery: 'login',
    });
  });

  it('엔드포인트별 뜻을 넘기면 그 뜻을 따르고, 넘기지 않으면 기본 뜻이다', () => {
    const e = apiError(404, 'M001', '프로필을 찾을 수 없습니다.');
    expect(describeError(e, MY_PROFILE)).toMatchObject({ text: MY_PROFILE.M001.text, recovery: 'profile', code: 'M001' });
    expect(describeError(e)).toMatchObject({ text: ERROR_SENTENCES.M001.text, recovery: null, code: 'M001' });
  });

  // 2차 계약이 §8 에 더한 코드(sp-docs/plan/phase2-frontend-integration.md F-07). 사전의 문장이 서버 메시지와 다른 코드를
  // 고른다 — 같은 코드(예: `AT002`)로는 어느 쪽을 골랐는지 갈리지 않는다.
  it('2차 계약에 더해진 코드 — 사전의 문장을 고르고 코드를 남긴다', () => {
    expect(describeError(apiError(409, 'AT003', '게시글당 첨부 파일 수를 넘었습니다.'))).toEqual({
      text: ERROR_SENTENCES.AT003.text,
      code: 'AT003',
      recovery: null,
      fieldErrors: [],
      detail: null,
      retryAfter: null,
    });
  });

  it('사전에 없는 코드 — 서버 메시지와 코드를 그대로 쓴다', () => {
    expect(describeError(apiError(400, 'X999', '새로 생긴 오류입니다.'))).toMatchObject({
      text: '새로 생긴 오류입니다.',
      code: 'X999',
      recovery: null,
    });
  });

  it('응답이 없다 — 연결 실패 문장이고 코드가 없다', () => {
    expect(describeError(new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {}))).toEqual({
      text: NO_RESPONSE,
      code: null,
      recovery: null,
      fieldErrors: [],
      detail: null,
      retryAfter: null,
    });
  });

  it('오류 본문이 없는 응답 — HTTP 상태를 코드 자리에 남긴다', () => {
    expect(describeError(respond(502, '<html>Bad Gateway</html>'))).toMatchObject({
      text: UNEXPECTED,
      code: 'HTTP 502',
      detail: 'status 502',
    });
  });

  it('화면 쪽 예외 — 원문은 사용자 문장이 아니라 detail 에 둔다', () => {
    expect(describeError(new Error('계약 위반 응답: success=true, data=null'))).toEqual({
      text: UNEXPECTED,
      code: null,
      recovery: null,
      fieldErrors: [],
      detail: '계약 위반 응답: success=true, data=null',
      retryAfter: null,
    });
  });

  it('fieldMessages — 그 필드의 메시지만, 온 순서대로 모두', () => {
    const e = apiError(400, 'C001', '잘못된 입력값입니다.', [
      { field: 'nickname', message: '닉네임은 2~10자여야 합니다.' },
      { field: 'email', message: '올바른 이메일 형식이 아닙니다.' },
      { field: 'nickname', message: '같은 필드의 두 번째 메시지' },
    ]);
    expect(fieldMessages(e, 'nickname')).toEqual(['닉네임은 2~10자여야 합니다.', '같은 필드의 두 번째 메시지']);
    expect(fieldMessages(new Error('x'), 'nickname')).toEqual([]);
  });
});

/**
 * 요청 수 제한의 `Retry-After` (sp-docs/plan/phase2-frontend-integration.md F-10). 정본의 값은 초 정수이고 최소 1 이다
 * (security.md §10, api-contract.md §9.13). 그 모양이 아니면 없는 것으로 읽고, 그때도 `C009` 의 문장과 코드는 나간다.
 */
describe('Retry-After', () => {
  const config = { headers: {} } as InternalAxiosRequestConfig;
  const BODY = {
    success: false,
    data: null,
    error: { code: 'C009', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', fieldErrors: [] },
  };
  const tooMany = (headers: AxiosResponse['headers'], data: unknown = BODY) =>
    new AxiosError('status 429', AxiosError.ERR_BAD_REQUEST, config, null, {
      data,
      status: 429,
      statusText: '',
      headers,
      config,
    } as AxiosResponse);

  it('초 정수 — 그 초를 싣고 문장이 그 초를 말한다', () => {
    expect(describeError(tooMany({ 'retry-after': '30' }))).toEqual({
      text: '요청이 너무 많습니다. 30초 뒤에 다시 시도해 주세요.',
      code: 'C009',
      recovery: null,
      fieldErrors: [],
      detail: null,
      retryAfter: 30,
    });
  });

  it('브라우저가 준 헤더 모양(AxiosHeaders)에서도, 이름의 대소문자와 무관하게 읽는다', () => {
    // XHR 어댑터는 `getAllResponseHeaders()` 의 문자열을 이렇게 읽는다.
    expect(describeError(tooMany(AxiosHeaders.from('Content-Type: application/json\r\nRetry-After: 37\r\n'))).retryAfter).toBe(37);
    expect(describeError(tooMany(new AxiosHeaders({ 'Retry-After': '37' }))).retryAfter).toBe(37);
  });

  it('60초부터는 분과 초로 말한다 — 한 시간 창의 제한은 수천 초다', () => {
    expect(tooManyRequests(1)).toBe('요청이 너무 많습니다. 1초 뒤에 다시 시도해 주세요.');
    expect(tooManyRequests(59)).toBe('요청이 너무 많습니다. 59초 뒤에 다시 시도해 주세요.');
    expect(tooManyRequests(60)).toBe('요청이 너무 많습니다. 1분 뒤에 다시 시도해 주세요.');
    expect(tooManyRequests(90)).toBe('요청이 너무 많습니다. 1분 30초 뒤에 다시 시도해 주세요.');
    expect(tooManyRequests(3600)).toBe('요청이 너무 많습니다. 60분 뒤에 다시 시도해 주세요.');
  });

  it('헤더가 없다 — 초 없는 기본 문장이고 코드가 남는다', () => {
    expect(describeError(tooMany({}))).toEqual({
      text: ERROR_SENTENCES.C009.text,
      code: 'C009',
      recovery: null,
      fieldErrors: [],
      detail: null,
      retryAfter: null,
    });
  });

  it.each(['', ' ', 'abc', '0', '-5', '1.5', '30s', '1e3', 'Wed, 21 Oct 2015 07:28:00 GMT', '99999999999999999999'])(
    '읽지 못하는 값 %j — 없는 것과 같다. 문장은 초 없이, 코드는 남는다',
    (value) => {
      expect(describeError(tooMany({ 'retry-after': value }))).toMatchObject({
        text: ERROR_SENTENCES.C009.text,
        code: 'C009',
        retryAfter: null,
      });
    },
  );

  it('화면이 뜻을 넘겨도 C009 의 문장은 같다 — 화면마다 다르게 보이지 않는다', () => {
    const view = describeError(tooMany({ 'retry-after': '30' }), { C009: { text: '다른 문장', recovery: 'login' } });
    expect(view).toMatchObject({ text: '요청이 너무 많습니다. 30초 뒤에 다시 시도해 주세요.', recovery: null });
  });

  it('본문을 비운 사본(withoutRequestBody)도 헤더를 잃지 않는다 — 로그인 화면이 쥐는 것은 그 사본이다', async () => {
    const { withoutRequestBody } = await import('./withoutRequestBody');
    expect(describeError(withoutRequestBody(tooMany({ 'retry-after': '30' }))).retryAfter).toBe(30);
  });

  it('응답이 없거나 오류 응답이 아니면 null 이다', () => {
    expect(describeError(new AxiosError('Network Error', AxiosError.ERR_NETWORK, config, {})).retryAfter).toBeNull();
    expect(describeError(new Error('x')).retryAfter).toBeNull();
  });
});
