import http, { unwrap } from '@/lib/api/client';
import type { ApiResponse } from '@/lib/api/types';
import type { PathId } from '@/features/board/types';

/** member-service. 정본은 sp-docs/api-contract.md §3 이다. */

/** `GET /me`·`POST`·`PATCH` 가 모두 이 모양이다(§3.1). */
export interface MyProfile {
  accountId: number;
  nickname: string;
}

/** `GET /{accountId}` 만 네 키다 — 탈퇴 표기에 `deleted` 가 필요하다(§3.1). */
export interface PublicProfile {
  accountId: number;
  nickname: string;
  createdAt: string;
  deleted: boolean;
}

/** 가입 3단계. 인증이 필요하고 `accountId` 는 JWT `sub` 에서 온다 — 본문에 넣지 않는다. */
export function createProfile(nickname: string) {
  return unwrap(http.post<ApiResponse<MyProfile>>('/api/v1/members', { nickname }));
}

/** 프로필이 없으면 404 `M001` 이다. 오류가 아니라 "가입 3단계가 아직" 이라는 뜻이다(§3). */
export function getMyProfile() {
  return unwrap(http.get<ApiResponse<MyProfile>>('/api/v1/members/me'));
}

/** 토큰을 반환하지 않는다 — claim 에 `nickname` 이 없어 토큰이 낡지 않는다(§3). */
export function updateNickname(nickname: string) {
  return unwrap(http.patch<ApiResponse<MyProfile>>('/api/v1/members/me', { nickname }));
}

/** 탈퇴 2단계. 멱등이다 — 이미 탈퇴한 프로필도 204 다(§3.1). */
export function withdrawProfile() {
  return http.delete('/api/v1/members/me');
}

export function checkNickname(nickname: string) {
  return unwrap(
    http.get<ApiResponse<{ available: boolean }>>('/api/v1/members/check-nickname', {
      params: { nickname },
    }),
  );
}

/** 경로 변수는 `accountId` 다 — `member.id` 는 외부에 노출하지 않는다(§3). */
export function getProfile(accountId: PathId) {
  return unwrap(http.get<ApiResponse<PublicProfile>>(`/api/v1/members/${accountId}`));
}
