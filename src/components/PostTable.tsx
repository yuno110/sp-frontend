import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import type { PostListItem } from '@/features/board/types';
import { formatDateTime } from '@/lib/format';

/**
 * 목록 항목에는 content 가 없다 — 크기 때문이다 (api-contract.md §4.3).
 *
 * **좁은 화면(`sm` 아래)에서는 표 대신 줄 목록을 그린다**(F-05). 표는 360px 폭에 들어가지 않는다 — 긴 제목이면 본문 영역을
 * 가로로 넘치고, 제목이 줄을 바꾸게 해도 칸이 좁아져 표 머리 글자가 한 자씩 선다(F-05 측정). 줄 목록은 번호를 빼고 나머지 값을
 * 담는다. 화면 폭에 따라 둘 중 하나만 보인다.
 */
export function PostTable({ items }: { items: PostListItem[] }) {
  return (
    <>
      <table className="hidden w-full border-collapse overflow-hidden rounded-md border border-line bg-elev text-sm sm:table">
        <thead>
          <tr className="border-b border-line bg-subtle text-left text-xs text-muted">
            <th className="w-16 px-3 py-2 text-center">번호</th>
            <th className="px-3 py-2">제목</th>
            <th className="w-32 px-3 py-2">작성자</th>
            <th className="w-16 px-3 py-2 text-center">조회</th>
            <th className="w-16 px-3 py-2 text-center">댓글</th>
            <th className="w-40 px-3 py-2">작성일</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-line-soft last:border-0 hover:bg-subtle">
              <td className="px-3 py-2 text-center font-mono text-xs text-faint">{item.id}</td>
              <td className="px-3 py-2">
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
              <td className="px-3 py-2 text-muted">{formatDateTime(item.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="divide-y divide-[var(--color-line-soft)] rounded-md border border-line bg-elev text-sm sm:hidden">
        {items.map((item) => (
          <li key={item.id} className="px-3 py-2.5">
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
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
