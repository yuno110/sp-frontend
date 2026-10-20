import { Link } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import type { PostListItem } from '@/features/board/types';
import { formatDateTime } from '@/lib/format';

/** 목록 항목에는 content 가 없다 — 크기 때문이다 (api-contract.md §4.3). */
export function PostTable({ items }: { items: PostListItem[] }) {
  return (
    <table className="w-full border-collapse overflow-hidden rounded-md border border-line bg-elev text-sm">
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
              <Link to={`/posts/${item.id}`} className="text-default hover:text-accent-600">
                {item.title}
              </Link>
            </td>
            <td className="px-3 py-2">
              <Link
                to={`/members/${item.writerId}`}
                className="text-muted hover:text-accent-600"
                title={`accountId ${item.writerId} — 스냅샷된 닉네임이다`}
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
  );
}
