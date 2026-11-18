import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { CATEGORY_LABEL, type PostListItem } from '@/features/board/types';
import { formatDateTime } from '@/lib/format';

/** 공지 배지 — 제목 앞에 둔다. 공지가 아닌 글에는 배지가 없다(F-12). */
function NoticeBadge({ item }: { item: PostListItem }) {
  if (item.category !== 'NOTICE') return null;
  return (
    <span className="mr-1.5 whitespace-nowrap rounded-sm bg-accent-50 px-1.5 py-0.5 text-xs font-medium text-accent-700">
      {CATEGORY_LABEL.NOTICE}
    </span>
  );
}

/**
 * 목록 항목에는 content 가 없다 — 크기 때문이다 (api-contract.md §4.3).
 *
 * **좁은 화면(`md` 아래)에서는 표 대신 줄 목록을 그린다**(F-05). 표는 360px 폭에 들어가지 않는다 — 긴 제목이면 본문 영역을
 * 가로로 넘치고, 제목이 줄을 바꾸게 해도 칸이 좁아져 표 머리 글자가 한 자씩 선다(F-05 측정). 다른 열의 폭이 정해져 있어 640px 에서는
 * 제목 칸이 111px 까지 좁아졌다(측정). 줄 목록은 번호를 빼고 나머지 값을 담는다. 화면 폭에 따라 둘 중 하나만 보인다.
 *
 * **표의 번호 칸은 `lg`(1024px)부터 그린다.** 좋아요 칸을 더하자 768px 에서 제목 칸이 175px 이 되어 e2e/widths.spec.ts 의
 * 하한(200px)을 밑돌았다(2026-11-17 F-13 측정). 번호는 줄 목록도 빼는 값이라 그 사이 폭에서도 뺀다.
 */
export function PostTable({ items }: { items: PostListItem[] }) {
  return (
    <>
      <table className="hidden w-full border-collapse overflow-hidden rounded-md border border-line bg-elev text-sm md:table">
        <thead>
          <tr className="border-b border-line bg-subtle text-left text-xs text-muted">
            <th className="hidden w-16 px-3 py-2 text-center lg:table-cell">번호</th>
            <th className="px-3 py-2">제목</th>
            <th className="w-32 px-3 py-2">작성자</th>
            <th className="w-16 px-3 py-2 text-center">조회</th>
            <th className="w-16 px-3 py-2 text-center">댓글</th>
            <th className="w-16 px-3 py-2 text-center">좋아요</th>
            <th className="w-40 px-3 py-2">작성일</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-line-soft last:border-0 hover:bg-subtle">
              <td className="hidden px-3 py-2 text-center font-mono text-xs text-faint lg:table-cell">{item.id}</td>
              <td className="px-3 py-2">
                <NoticeBadge item={item} />
                <Link to={`/posts/${item.id}`} className="text-default wrap-anywhere hover:text-accent-600">
                  {item.title}
                </Link>
              </td>
              <td className="px-3 py-2">
                <Link
                  to={`/members/${item.writerId}`}
                  className="text-muted hover:text-accent-600"
                  title="작성 당시의 닉네임"
                >
                  {item.writerNickname}
                </Link>
              </td>
              <td className="px-3 py-2 text-center text-muted">{item.viewCount}</td>
              <td className="px-3 py-2 text-center text-muted">
                {item.commentCount > 0 ? (
                  <span className="inline-flex items-center gap-0.5 text-accent-600">
                    <MessageSquare size={11} /> {item.commentCount}
                  </span>
                ) : (
                  <span className="text-faint">0</span>
                )}
              </td>
              <td className="px-3 py-2 text-center text-muted">{item.likeCount}</td>
              <td className="px-3 py-2 text-muted">{formatDateTime(item.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-[var(--color-line-soft)] rounded-md border border-line bg-elev text-sm md:hidden">
        {items.map((item) => (
          <li key={item.id} className="px-3 py-2.5">
            <NoticeBadge item={item} />
            <Link to={`/posts/${item.id}`} className="text-default wrap-anywhere hover:text-accent-600">
              {item.title}
            </Link>
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
              <Link to={`/members/${item.writerId}`} className="hover:text-accent-600" title="작성 당시의 닉네임">
                {item.writerNickname}
              </Link>
              <span>{formatDateTime(item.createdAt)}</span>
              <span>조회 {item.viewCount}</span>
              <span>댓글 {item.commentCount}</span>
              <span>좋아요 {item.likeCount}</span>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
