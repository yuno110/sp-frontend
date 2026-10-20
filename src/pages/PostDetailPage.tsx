import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import {
  createComment,
  deleteComment,
  deletePost,
  getPost,
  listComments,
  updateComment,
} from '@/features/board/api';
import { COMMENT_CONTENT_MAX } from '@/features/board/types';
import { messageOf } from '@/lib/api/client';
import { formatDateTime } from '@/lib/format';
import { useAuthStore } from '@/stores/authStore';
import { Button, Empty, ErrorBox, Panel, Textarea } from '@/components/ui';
import { Pager } from '@/components/Pager';

const COMMENT_SIZE = 20;

/**
 * 게시글 상세 + 댓글. 조회는 무인증이다 (api-contract.md §4.2).
 *
 * 상세 응답은 목록의 일곱 키에 content 를 더한 것이고, 댓글은 다섯 키 한 모양이다
 * (§4.3·§4.5). 댓글을 상세 응답에 싣지 않으므로 목록을 따로 부른다.
 */
export function PostDetailPage() {
  const { id } = useParams();
  // 경로 변수를 그대로 쓴다 — 숫자가 아니면 서버가 400 C002 로 답하고, 그것이 보여야 한다.
  const postId = id ?? '';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { accountId, role, accessToken } = useAuthStore();
  const loggedIn = accessToken !== null;

  const [commentPage, setCommentPage] = useState(0);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const post = useQuery({
    queryKey: ['post', postId],
    queryFn: () => getPost(postId),
    retry: false,
  });

  const comments = useQuery({
    queryKey: ['comments', postId, commentPage],
    queryFn: () => listComments(postId, { page: commentPage, size: COMMENT_SIZE }),
    retry: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['comments', postId] });
    void queryClient.invalidateQueries({ queryKey: ['post', postId] });
  };

  const addComment = useMutation({
    mutationFn: () => createComment(postId, draft),
    onSuccess: () => {
      setDraft('');
      setError(null);
      refresh();
    },
    onError: (e) => setError(messageOf(e)),
  });

  const saveComment = useMutation({
    mutationFn: (commentId: number) => updateComment(commentId, editDraft),
    onSuccess: () => {
      setEditing(null);
      setError(null);
      refresh();
    },
    onError: (e) => setError(messageOf(e)),
  });

  const removeComment = useMutation({
    mutationFn: (commentId: number) => deleteComment(commentId),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (e) => setError(messageOf(e)),
  });

  const removePost = useMutation({
    mutationFn: () => deletePost(postId),
    onSuccess: () => navigate('/posts'),
    onError: (e) => setError(messageOf(e)),
  });

  if (post.isLoading) return <Empty>불러오는 중…</Empty>;
  if (post.isError) {
    return (
      <div className="space-y-3">
        <ErrorBox message={messageOf(post.error)} />
        <Link to="/posts" className="text-sm text-accent-600 underline">
          목록으로
        </Link>
      </div>
    );
  }
  if (!post.data) return null;

  const mine = accountId !== null && accountId === post.data.writerId;
  const admin = role === 'ADMIN';

  return (
    <div className="space-y-4">
      <Panel>
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-bold text-default">{post.data.title}</h1>
            <p className="mt-1 text-xs text-muted">
              <Link to={`/members/${post.data.writerId}`} className="hover:text-accent-600">
                {post.data.writerNickname}
              </Link>
              <span className="text-faint">
                {' '}
                · sub {post.data.writerId} · {formatDateTime(post.data.createdAt)} · 조회{' '}
                {post.data.viewCount} · 댓글 {post.data.commentCount}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {mine ? (
              <Button onClick={() => navigate(`/posts/${postId}/edit`)}>
                <Pencil size={13} /> 수정
              </Button>
            ) : null}
            {mine || admin ? (
              <Button variant="danger" onClick={() => removePost.mutate()}>
                <Trash2 size={13} /> 삭제{admin && !mine ? ' (ADMIN)' : ''}
              </Button>
            ) : null}
          </div>
        </header>
        <div className="mt-4 whitespace-pre-wrap border-t border-line-soft pt-4 text-sm text-default">
          {post.data.content}
        </div>
      </Panel>

      <Panel title={`댓글 ${comments.data ? comments.data.totalElements : ''}`}>
        <ErrorBox message={error} />

        {comments.isError ? <ErrorBox message={messageOf(comments.error)} /> : null}

        {comments.data && comments.data.content.length > 0 ? (
          <ul className="divide-y divide-[var(--color-line-soft)]">
            {comments.data.content.map((c) => {
              const canEdit = accountId !== null && accountId === c.writerId;
              return (
                <li key={c.id} className="py-3 first:pt-0">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-sm font-medium text-default">
                      <Link to={`/members/${c.writerId}`} className="hover:text-accent-600">
                        {c.writerNickname}
                      </Link>
                    </span>
                    <span className="font-mono text-xs text-faint">
                      {formatDateTime(c.createdAt)}
                    </span>
                  </div>
                  {editing === c.id ? (
                    <div className="mt-2 space-y-2">
                      <Textarea
                        rows={2}
                        value={editDraft}
                        maxLength={COMMENT_CONTENT_MAX}
                        onChange={(e) => setEditDraft(e.target.value)}
                      />
                      <div className="flex gap-1.5">
                        <Button variant="primary" onClick={() => saveComment.mutate(c.id)}>
                          저장
                        </Button>
                        <Button onClick={() => setEditing(null)}>취소</Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-default">{c.content}</p>
                  )}
                  {editing === c.id ? null : (
                    <div className="mt-1.5 flex gap-2 text-xs">
                      {canEdit ? (
                        <button
                          type="button"
                          className="text-muted hover:text-default"
                          onClick={() => {
                            setEditing(c.id);
                            setEditDraft(c.content);
                          }}
                        >
                          수정
                        </button>
                      ) : null}
                      {canEdit || admin ? (
                        <button
                          type="button"
                          className="text-danger-600 hover:text-danger-500"
                          onClick={() => removeComment.mutate(c.id)}
                        >
                          삭제
                        </button>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : comments.data ? (
          <Empty>댓글이 없다</Empty>
        ) : null}

        {comments.data && comments.data.totalPages > 1 ? (
          <div className="mt-3">
            <Pager page={comments.data} onChange={setCommentPage} />
          </div>
        ) : null}

        {loggedIn ? (
          <form
            className="mt-4 space-y-2 border-t border-line-soft pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              addComment.mutate();
            }}
          >
            <Textarea
              rows={3}
              value={draft}
              maxLength={COMMENT_CONTENT_MAX}
              placeholder={`댓글 (최대 ${COMMENT_CONTENT_MAX}자)`}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-faint">
                {draft.length} / {COMMENT_CONTENT_MAX} · 작성에는 프로필이 필요하다 (없으면 403 S002)
              </span>
              <Button type="submit" variant="primary" disabled={addComment.isPending}>
                등록
              </Button>
            </div>
          </form>
        ) : (
          <p className="mt-4 border-t border-line-soft pt-4 text-xs text-faint">
            댓글을 쓰려면{' '}
            <Link to="/login" className="text-accent-600 underline">
              로그인
            </Link>
          </p>
        )}
      </Panel>
    </div>
  );
}
