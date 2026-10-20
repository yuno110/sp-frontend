import { beforeEach, describe, expect, it, vi } from 'vitest';
import http from './client';
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
