import { useQuery } from '@tanstack/react-query';
import { errorOf } from '@/lib/api/client';
import { WITHDRAWN_PROFILE, type Meanings } from '@/lib/api/errorCodes';
import { useAuthStore } from '@/stores/authStore';
import { getProfile } from './api';

/**
 * 내 프로필이 없다는 실패(`GET /members/me` 의 `M001`, 글·댓글 작성의 `S002`)의 뜻을 고른다. 두 코드는 미등록과 탈퇴를 가르지 않는데
 * (sp-docs/api-contract.md §3.1·§5.1) 탈퇴한 프로필의 등록은 409 `M007` 이라(§3) 복구 안내가 달라야 한다. 가르는 것은 공개 조회
 * `GET /members/{accountId}` 의 `deleted` 다 — 탈퇴한 프로필은 200 이고 없는 프로필은 404 다(§3.1).
 *
 * 그 코드일 때만 묻는다. 답을 받기 전이나 받지 못했으면 `base` 를 쓴다 — 미등록이 훨씬 흔하고, 등록을 눌러도 `M007` 의 안내가 잇는다.
 */
export function useNoProfileMeanings(error: unknown, base?: Meanings): Meanings | undefined {
  const accountId = useAuthStore((s) => s.accountId);
  const code = errorOf(error)?.code;
  const profile = useQuery({
    // 작성자 프로필 화면(pages/MemberProfilePage.tsx)과 같은 조회다 — 키와 모양이 같다.
    queryKey: ['member', 'profile', String(accountId)],
    queryFn: () => getProfile(accountId as number),
    enabled: (code === 'M001' || code === 'S002') && accountId !== null,
    retry: false,
  });
  return profile.data?.deleted ? WITHDRAWN_PROFILE : base;
}
