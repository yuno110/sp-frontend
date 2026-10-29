import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { listPosts } from '@/features/board/api';
import {
  SEARCH_TYPE_LABEL,
  SORT_LABEL,
  type PostSort,
  type SearchType,
} from '@/features/board/types';
import { useAuthStore } from '@/stores/authStore';
import { Button, Empty, ErrorBox } from '@/components/ui';
import { PostTable } from '@/components/PostTable';
import { Pager } from '@/components/Pager';

const SIZE = 10;

/**
 * 게시글 목록. 무인증으로 열려 있다 (api-contract.md §4.2).
 *
 * searchType 과 keyword 는 둘 다 보내거나 둘 다 안 보낸다 — 한쪽만 보내면 400 C001
 * 이다 (§4.1). 그 조합 판정은 features/board/api.ts 가 한 자리에서 한다.
 */
export function PostListPage() {
  const navigate = useNavigate();
  const loggedIn = useAuthStore((s) => s.accessToken) !== null;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<PostSort>('latest');
  const [searchType, setSearchType] = useState<SearchType>('TITLE');
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');

  const query = useQuery({
    queryKey: ['posts', { page, sort, searchType, applied }],
    queryFn: () => listPosts({ page, size: SIZE, sort, searchType, keyword: applied }),
    retry: false,
  });

  const apply = () => {
    setApplied(keyword);
    setPage(0);
  };

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-default">게시판</h1>
        {loggedIn ? (
          <Button variant="primary" onClick={() => navigate('/posts/new')}>
            <Plus size={14} /> 새 글
          </Button>
        ) : (
          <Link to="/login" className="text-sm text-accent-600 underline">
            글을 쓰려면 로그인
          </Link>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-subtle px-3 py-2.5">
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
        <select
          value={searchType}
          onChange={(e) => setSearchType(e.target.value as SearchType)}
          aria-label="검색 유형"
          className="rounded-md border border-line bg-elev px-2 py-1.5 text-sm"
        >
          {(Object.keys(SEARCH_TYPE_LABEL) as SearchType[]).map((t) => (
            <option key={t} value={t}>
              {SEARCH_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
            placeholder="검색어 (부분 일치)"
            aria-label="검색어"
            className="rounded-md border border-line bg-elev py-1.5 pl-7 pr-3 text-sm"
          />
        </div>
        <Button onClick={apply}>검색</Button>
        {applied ? (
          <span className="text-xs text-faint wrap-anywhere">
            적용: {SEARCH_TYPE_LABEL[searchType]} / {applied}
          </span>
        ) : null}
      </div>

      {query.isError ? <ErrorBox error={query.error} /> : null}

      {query.isLoading ? (
        <Empty>불러오는 중…</Empty>
      ) : query.data && query.data.content.length > 0 ? (
        <>
          <PostTable items={query.data.content} />
          <Pager page={query.data} onChange={setPage} />
        </>
      ) : query.data ? (
        <Empty>{applied ? '검색 결과가 없다' : '등록된 게시글이 없다'}</Empty>
      ) : null}
    </div>
  );
}
