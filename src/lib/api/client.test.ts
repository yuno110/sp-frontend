import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import http, { describeError, fieldMessages } from './client';
import { ERROR_SENTENCES, MY_PROFILE, NO_RESPONSE, UNEXPECTED } from './errorCodes';
import { reissue } from '@/features/auth/api';
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
