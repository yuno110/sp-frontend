import http, { inSession, unwrap } from '@/lib/api/client';
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

/** 프로필이 없거나 탈퇴했으면 404 `M001` 이다. 없으면 "가입 3단계가 아직" 이고, 이 응답으로는 둘을 가를 수 없다(§3) — 가르는 것은 `getProfile` 의 `deleted` 다. */
export function getMyProfile() {
  return unwrap(http.get<ApiResponse<MyProfile>>('/api/v1/members/me'));
}

/** 토큰을 반환하지 않는다 — claim 에 `nickname` 이 없어 토큰이 낡지 않는다(§3). */
export function updateNickname(nickname: string) {
  return unwrap(http.patch<ApiResponse<MyProfile>>('/api/v1/members/me', { nickname }));
}

/**
 * 탈퇴 2단계. 멱등이다 — 이미 탈퇴한 프로필도 204 다(§3.1). 1단계와 같은 로그인의 Access Token 으로 부른다(§9.1.1, requirements/member.md §8) — 토큰과 세션은 부르는 쪽이
 * 넘긴다(pages/MyPage.tsx). 1단계를 시작한 세션이 그대로면 지금 토큰이고, 끝났거나 바뀌었으면 1단계가 실제로 보낸 토큰이다.
 */
export function withdrawProfile(accessToken: string, generation: number) {
  return http.delete('/api/v1/members/me', inSession(accessToken, generation));
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

/**
 * 프로필 일괄 조회 (ADMIN, §3.2). 원소는 `getProfile` 과 같은 모양이다 — 탈퇴한 프로필은 `"탈퇴한 회원"`·`deleted: true` 로 온다.
 * **없는 `accountId` 는 결과에서 빠진다** — 프로필이 없는 계정(가입 3단계 미완료)이다. 그래서 이 함수의 실패를 빈 결과로 바꾸지 않는다 —
 * 바꾸면 모든 계정이 「프로필 없음」 으로 보인다.
 *
 * `accountIds` 는 1개 이상 50개 이하다(§3.2). 비면 400 `C001` 이라 부르는 쪽이 부르지 않는다(pages/AdminMembersPage.tsx). 쉼표 목록으로
 * 보낸다 — axios 의 배열 직렬화(`accountIds[]=`)는 §3.2 가 받는 모양이 아니다.
 */
export function getProfiles(accountIds: number[]) {
  return unwrap(
    http.get<ApiResponse<{ members: PublicProfile[] }>>('/api/v1/members', {
      params: { accountIds: accountIds.join(',') },
    }),
  );
}
