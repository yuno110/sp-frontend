import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getProfile } from '@/features/member/api';
import { messageOf } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { Empty, ErrorBox, Panel } from '@/components/ui';

/**
 * 작성자 프로필 (api-contract.md §3.1 의 GET /api/v1/members/{accountId}).
 *
 * **`/me` 와 다른 모양이다** — 여기는 accountId·nickname·createdAt·deleted 네 키다.
 * 그리고 **탈퇴한 프로필도 200 이다**: nickname 이 "탈퇴한 회원" 이고 deleted 가 true 다.
 * /me 는 탈퇴면 404 M001 인데 이쪽이 200 인 것이 의도다 — 글이 남아 있으므로 표시할 것이 있다.
 */
export function MemberProfilePage() {
  const { accountId } = useParams();
  // 숫자로 좁히지 않는다 — /members/abc 는 서버가 400 C002 로 답한다.
  const id = accountId ?? '';

  const query = useQuery({
    // `['member', 'me']` 와 겹치지 않게 네임스페이스를 하나 더 둔다 — 머리글과
    // 마이페이지가 그 키로 2키 `MyProfile` 을 캐시하는데 이 화면은 4키를 기대한다.
    queryKey: ['member', 'profile', id],
    queryFn: () => getProfile(id),
    retry: false,
  });

  return (
    <div className="mx-auto max-w-md space-y-3">
      <Panel title={`프로필 — accountId ${accountId}`}>
        {query.isLoading ? (
          <Empty>불러오는 중…</Empty>
        ) : query.isError ? (
          <ErrorBox message={messageOf(query.error)} />
        ) : query.data ? (
          <dl className="space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">닉네임</dt>
              <dd className={query.data.deleted ? 'text-faint' : 'text-default'}>
                {query.data.nickname}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">프로필 등록</dt>
              <dd className="font-mono text-xs text-default">
                {formatDateTime(query.data.createdAt)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-24 shrink-0 text-muted">탈퇴</dt>
              <dd className={query.data.deleted ? 'text-danger-600' : 'text-default'}>
                {query.data.deleted ? 'true — 탈퇴한 회원' : 'false'}
              </dd>
            </div>
          </dl>
        ) : null}
        <p className="mt-3 text-xs text-faint">
          이 가입일은 member.created_at(프로필 등록 시각)이다. 마이페이지의 계정 생성 시각과 다른
          값이다 — 가입이 3단계이므로 사이에 로그인이 끼었다.
        </p>
      </Panel>
      <Link to="/posts" className="block text-sm text-accent-600 underline">
        목록으로
      </Link>
    </div>
  );
}
