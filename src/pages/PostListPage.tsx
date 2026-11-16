import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { listPosts } from '@/features/board/api';
import {
  CATEGORY_LABEL,
  SEARCH_TYPE_LABEL,
  SORT_LABEL,
  type PostCategory,
  type PostSort,
  type SearchType,
} from '@/features/board/types';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/authStore';
import { Button, Empty, ErrorBox, Panel } from '@/components/ui';
import { PostTable } from '@/components/PostTable';
import { Pager } from '@/components/Pager';

const SIZE = 10;

/** 고정 영역에 보이는 최근 공지의 수 — 화면이 정한다(sp-docs/requirements/board.md §8). */
const PINNED_SIZE = 3;

/** 카테고리 탭. 「전체」는 `category` 를 보내지 않는다 — 공지도 들어간다(api-contract.md §4.1). */
const TABS: Array<{ category: PostCategory | undefined; label: string }> = [
  { category: undefined, label: '전체' },
  ...(Object.keys(CATEGORY_LABEL) as PostCategory[]).map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
  })),
];

/**
 * 게시글 목록. 무인증으로 열려 있다 (api-contract.md §4.2).
 *
 * searchType 과 keyword 는 둘 다 보내거나 둘 다 안 보낸다 — 한쪽만 보내면 400 C001
 * 이다 (§4.1). 그 조합 판정은 features/board/api.ts 가 한 자리에서 한다.
 *
 * 카테고리 탭은 검색·정렬과 함께 걸린다(§4.1). 전체 탭의 첫 페이지 위에는 최근 공지를 따로 받아 고정한다 — 서버에 "고정" 상태는
 * 없다(sp-docs/requirements/board.md §8). 서버는 전체 목록에서 공지를 빼지 않으므로 같은 글이 고정 영역과 아래 목록에 함께
 * 보인다. 아래 목록에서 빼지 않는 이유는 CLAUDE.md 「카테고리와 공지」에 있다.
 */
export function PostListPage() {
  const navigate = useNavigate();
  const loggedIn = useAuthStore((s) => s.accessToken) !== null;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<PostSort>('latest');
  const [searchType, setSearchType] = useState<SearchType>('TITLE');
  const [keyword, setKeyword] = useState('');
  const [applied, setApplied] = useState('');
  const [category, setCategory] = useState<PostCategory | undefined>(undefined);

  const query = useQuery({
    queryKey: ['posts', { page, sort, searchType, applied, category }],
    queryFn: () => listPosts({ page, size: SIZE, sort, searchType, keyword: applied, category }),
    retry: false,
  });

  // 고정 영역은 검색을 걸지 않은 전체 탭의 첫 페이지에만 있다. 공백뿐인 검색어는 요청에 실리지 않는다(features/board/api.ts) —
  // 그때 받는 것은 전체 목록이다.
  const pinnedShown = category === undefined && page === 0 && applied.trim() === '';
  const pinned = useQuery({
    queryKey: ['posts', 'pinned'],
    queryFn: () => listPosts({ page: 0, size: PINNED_SIZE, sort: 'latest', category: 'NOTICE' }),
    retry: false,
    enabled: pinnedShown,
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

      <div role="group" aria-label="카테고리" className="flex flex-wrap gap-1.5">
        {TABS.map((tab) => (
          <Button
            key={tab.label}
            variant={tab.category === category ? 'primary' : 'ghost'}
            aria-pressed={tab.category === category}
            onClick={() => {
              setCategory(tab.category);
              setPage(0);
            }}
          >
            {tab.label}
          </Button>
        ))}
      </div>

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

      {/* 받는 동안과 공지가 없을 때는 그리지 않는다. 받지 못했으면 그 실패를 그 자리에 보인다(AGENTS.md 불변식 9). */}
      {pinnedShown && pinned.isError ? (
        <Panel title="최근 공지">
          <ErrorBox error={pinned.error} />
        </Panel>
      ) : pinnedShown && pinned.data && pinned.data.content.length > 0 ? (
        <Panel title="최근 공지">
          <ul className="space-y-1.5 text-sm">
            {pinned.data.content.map((item) => (
              <li key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3">
                <Link
                  to={`/posts/${item.id}`}
                  className="text-default wrap-anywhere hover:text-accent-600"
                >
                  {item.title}
                </Link>
                <span className="text-xs text-muted">{formatDateTime(item.createdAt)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {query.isError ? <ErrorBox error={query.error} /> : null}

      {query.isLoading ? (
        <Empty>불러오는 중…</Empty>
      ) : query.data && query.data.content.length > 0 ? (
        <>
          <PostTable items={query.data.content} />
          <Pager page={query.data} onChange={setPage} />
        </>
      ) : query.data ? (
        <Empty>{applied ? '검색 결과가 없습니다' : '등록된 게시글이 없습니다'}</Empty>
      ) : null}
    </div>
  );
}
