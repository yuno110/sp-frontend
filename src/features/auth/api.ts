import http, { unwrap } from '@/lib/api/client';
import type { ApiResponse, TokenResponse } from '@/lib/api/types';

/** auth-service. 정본은 sp-docs/api-contract.md §2 다. */

export interface AccountCreated {
  accountId: number;
  email: string;
}

export interface MyAccount {
  email: string;
  /** `account.created_at`. 오프셋 없음, 소수부는 저장값에 따른다(§2.2). */
  createdAt: string;
}

/** 가입 1단계. 무인증이다. */
export function createAccount(email: string, password: string) {
  return unwrap(http.post<ApiResponse<AccountCreated>>('/api/v1/accounts', { email, password }));
}

/** 자격증명 필드 이름은 `password` 다 — 하나뿐이면 그 이름이 기본이다(§2.2). */
export function login(email: string, password: string) {
  return unwrap(http.post<ApiResponse<TokenResponse>>('/api/v1/auth/login', { email, password }));
}

/**
 * 응답은 로그인과 같은 `TokenResponse` 다(§2.1). **Refresh Token 도 회전 발급된다** —
 * 응답의 둘을 함께 저장해야 하고, 그러지 않으면 두 번째 갱신부터 막힌다.
 *
 * 화면에서 손으로 재발급해 볼 때 쓴다(`/tokens`). **인터셉터는 이 함수를 쓰지 않는다** —
 * 그쪽은 재시도 인터셉터가 달리지 않은 별도 인스턴스가 필요해서 `lib/api/client.ts` 안에
 * 사본을 갖는다. 본문 모양(`{ refreshToken }`)이 두 곳에 있으므로 한쪽만 고치지 않는다.
 */
export function reissue(refreshToken: string) {
  // **Authorization 을 떼고 보낸다.** 이 경로는 무인증이고(§2.1 의 인증 칸이 `-` 다),
  // 헤더가 붙으면 bearer 필터가 인가 평가보다 먼저 돌아 **만료된 Access Token 이
  // 재발급 핸들러에 닿기 전에 401 A003 을 만든다.** 그러면 Refresh Token 을 읽어 보지도
  // 못한 실패가 "Refresh Token 만료" 로 읽힌다 — 자동 경로(`lib/api/client.ts` 의
  // `reissueHttp`)는 인터셉터가 없어 애초에 붙지 않는다.
  return unwrap(
    http.post<ApiResponse<TokenResponse>>(
      '/api/v1/auth/reissue',
      { refreshToken },
      { headers: { Authorization: null } },
    ),
  );
}

/** 멱등이다 — 저장된 Refresh Token 이 없어도 204 다(§2.1). */
export function logout() {
  return http.post('/api/v1/auth/logout');
}

/** 이메일과 가입일 둘만 온다. `accountId` 는 없다(§2.2). */
export function getMyAccount() {
  return unwrap(http.get<ApiResponse<MyAccount>>('/api/v1/accounts/me'));
}

export function checkEmail(email: string) {
  return unwrap(
    http.get<ApiResponse<{ available: boolean }>>('/api/v1/accounts/check-email', {
      params: { email },
    }),
  );
}

/** 비밀번호가 둘이라 이름이 갈린다 — 여기만 `currentPassword` 다(§2.2). */
export function changePassword(currentPassword: string, newPassword: string) {
  return http.patch('/api/v1/accounts/me/password', { currentPassword, newPassword });
}

/** 탈퇴 1단계. 본문으로 비밀번호를 재확인한다. 이미 탈퇴했으면 검증 없이 204 다(§2.2). */
export function withdrawAccount(password: string) {
  return http.delete('/api/v1/accounts/me', { data: { password } });
}
