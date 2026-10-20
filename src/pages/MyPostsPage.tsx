import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listMyPosts } from '@/features/board/api';
import { SORT_LABEL, type PostSort } from '@/features/board/types';
import { messageOf } from '@/lib/api/client';
import { Empty, ErrorBox } from '@/components/ui';
import { PostTable } from '@/components/PostTable';
import { Pager } from '@/components/Pager';

const SIZE = 10;

/**
 * 내가 쓴 글 (api-contract.md §4.1 의 GET /posts/me).
 *
 * **검색 파라미터가 없다** — page·size·sort 만 받는다. 조회 키는 쿼리 파라미터가 아니라
 * JWT 의 sub 다. 그리고 이 경로의 인가 규칙은 /posts/{id} 보다 먼저 선언되어야 한다
 * (SecurityConfig 는 선언 순서대로 평가한다) — B-09 가 실측으로 잡은 자리다.
 */
export function MyPostsPage() {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<PostSort>('latest');

  const query = useQuery({
    queryKey: ['posts', 'me', page, sort],
    queryFn: () => listMyPosts({ page, size: SIZE, sort }),
    retry: false,
  });

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-default">내 글</h1>
        <select
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as PostSort);
            setPage(0);
          }}
          aria-label="정렬"
          className="rounded-md border border-line bg-elev px-2 py-1.5 text-sm"
        >
          {(Object.keys(SORT_LABEL) as PostSort[]).map((s) => (
            <option key={s} value={s}>
              {SORT_LABEL[s]}
            </option>
          ))}
        </select>
      </header>

      {query.isError ? <ErrorBox message={messageOf(query.error)} /> : null}

      {query.isLoading ? (
        <Empty>불러오는 중…</Empty>
      ) : query.data && query.data.content.length > 0 ? (
        <>
          <PostTable items={query.data.content} />
          <Pager page={query.data} onChange={setPage} />
        </>
      ) : query.data ? (
        <Empty>쓴 글이 없다</Empty>
      ) : null}
    </div>
  );
}
