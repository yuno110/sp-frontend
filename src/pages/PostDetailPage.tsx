import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Pencil, Trash2 } from 'lucide-react';
import {
  createComment,
  deleteComment,
  deletePost,
  getPost,
  likePost,
  listComments,
  unlikePost,
  updateComment,
} from '@/features/board/api';
import { COMMENT_CONTENT_MAX, type PostDetail } from '@/features/board/types';
import { useNoProfileMeanings } from '@/features/member/useNoProfileMeanings';
import { fieldMessages } from '@/lib/api/client';
import { DEV_ONLY } from '@/lib/devOnly';
import { formatDateTime } from '@/lib/format';
import { useMounted } from '@/lib/useMounted';
import { useAuthStore } from '@/stores/authStore';
import { Button, Empty, ErrorBox, FieldErrors, Panel, Textarea } from '@/components/ui';
import { Pager } from '@/components/Pager';

const COMMENT_SIZE = 20;

/** 댓글 작성란·수정란이 옆에 오류를 그리는 필드. */
const COMMENT_FIELDS = ['content'];

/**
 * 마지막 실패. 어느 동작의 실패냐에 따라 그리는 자리가 갈린다 — 작성은 작성란 위, 나머지는 댓글 목록 위다.
 * 어느 동작이든 성공하면 비운다.
 */
type Failure =
  | { action: 'add'; error: unknown }
  | { action: 'save'; error: unknown; commentId: number }
  | { action: 'remove'; error: unknown };

/**
 * 게시글 상세 + 댓글. 상세 조회는 인증을 선택으로 받는다(api-contract.md §4.8) — 토큰을 실으면 응답의 `liked` 가 그 계정의 것이고,
 * 없으면 `null` 이다(§4.3). 댓글 목록은 무인증이다(§4.2).
 *
 * 상세 응답과 댓글의 모양은 §4.3·§4.5 가 정한다. 댓글을 상세 응답에 싣지 않으므로 목록을
 * 따로 부른다.
 */
export function PostDetailPage() {
  const { id } = useParams();
  // 경로 변수를 그대로 쓴다 — 숫자가 아니면 서버가 400 C002 로 답하고, 그것이 보여야 한다.
  const postId = id ?? '';
  const navigate = useNavigate();
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const { accountId, role, accessToken, restoring } = useAuthStore();
  const loggedIn = accessToken !== null;

  const [commentPage, setCommentPage] = useState(0);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [failure, setFailure] = useState<Failure | null>(null);
  const addFailure = failure?.action === 'add' ? failure.error : null;
  const addMeanings = useNoProfileMeanings(addFailure);
  /** 좋아요의 마지막 실패. 다시 누르면 지우고, 실패하면 다시 둔다. */
  const [likeFailure, setLikeFailure] = useState<unknown>(null);
  /**
   * 누른 것의 응답을 기다리는 중. 그동안의 누르기는 보내지 않는다. 그린 상태(`like.isPending`)로는 다 막지 못한다 — 요청이 돈다는
   * 것은 화면에 다음 작업(setTimeout 0)에 알려지므로(TanStack Query 의 `notifyManager`) 같은 작업 안의 두 번째 누르기가 그대로
   * 나간다(2026-11-17 e2e/like.spec.ts 변이 측정).
   */
  const pressing = useRef(false);

  const post = useQuery({
    queryKey: ['post', postId],
    queryFn: () => getPost(postId),
    retry: false,
    // 새로고침의 세션 복원이 끝난 뒤에 묻는다 — 응답의 `liked` 는 실린 토큰의 것이다. 복원 전에 토큰 없이 받으면 되살아난 세션의
    // 화면에 `null`(로그인 안내)이 남는다 — 복원의 재발급은 세션을 바꾸지 않아 캐시를 비우지 않는다(lib/queryClient.ts). 그 조회는
    // 그 계정과 다른 조회자라 조회수에도 세질 수 있다(sp-docs/requirements/board.md §9.2).
    enabled: !restoring,
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
      setFailure(null);
      refresh();
    },
    onError: (error) => setFailure({ action: 'add', error }),
  });

  const saveComment = useMutation({
    mutationFn: (commentId: number) => updateComment(commentId, editDraft),
    onSuccess: () => {
      setEditing(null);
      setFailure(null);
      refresh();
    },
    onError: (error, commentId) => setFailure({ action: 'save', error, commentId }),
  });

  const removeComment = useMutation({
    mutationFn: (commentId: number) => deleteComment(commentId),
    onSuccess: () => {
      setFailure(null);
      refresh();
    },
    onError: (error) => setFailure({ action: 'remove', error }),
  });

  const removePost = useMutation({
    mutationFn: () => deletePost(postId),
    onSuccess: () => {
      if (mounted.current) navigate('/posts');
    },
    onError: (error) => setFailure({ action: 'remove', error }),
  });

  /**
   * 누르기는 `PUT`, 취소는 `DELETE` 다(api-contract.md §4.6). 버튼의 상태와 수는 응답으로 바꾼다 — 화면이 셈하지 않는다. 그 사이 다른
   * 계정이 누른 것도 응답의 수에 들어 있다. 실패하면 상태와 수를 그대로 두고 그 실패를 보인다.
   */
  const like = useMutation({
    // 보낸 세션과 글을 함께 돌려준다 — 기다리는 사이에 세션이 바뀌었으면 그 응답은 앞 세션의 계정이 누른 상태다. 응답은 보낸 글의 캐시에
    // 넣는다. 상세 라우트는 글마다 새로 그리지만(router.tsx), 화면 하나가 다른 글로 이어지면 도는 요청의 콜백도 그 화면이 마지막으로 그린
    // 옵션으로 바뀌어(TanStack Query 의 `MutationObserver.setOptions`) `postId` 가 바뀐 글이다(2026-11-18 F-13 리뷰 측정: 앞 글의 응답이
    // 바뀐 글에 들어갔다).
    mutationFn: async (press: boolean) => {
      const generation = useAuthStore.getState().sessionGeneration;
      const state = await (press ? likePost(postId) : unlikePost(postId));
      return { state, generation, sentPostId: postId };
    },
    onSuccess: ({ state, generation, sentPostId }) => {
      if (useAuthStore.getState().sessionGeneration !== generation) return;
      const key = ['post', sentPostId];
      // 도는 상세 조회는 이 누르기보다 먼저 읽었을 수 있다 — 늦게 오면 이 응답의 상태를 덮는다. 그 조회를 버리고 다시 읽는다
      // (`invalidateQueries` 는 도는 조회를 취소하고 새로 보낸다). 버리기만 하면 그 조회가 가져올 다른 값(예: 댓글을 쓴 뒤의 댓글 수)을 잃는다.
      const reading = queryClient.isFetching({ queryKey: key, exact: true }) > 0;
      queryClient.setQueryData<PostDetail>(key, (old) =>
        old ? { ...old, liked: state.liked, likeCount: state.likeCount } : old,
      );
      if (reading) void queryClient.invalidateQueries({ queryKey: key, exact: true });
    },
    onError: (error) => setLikeFailure(error),
    onSettled: () => {
      pressing.current = false;
    },
  });

  const toggleLike = (liked: boolean) => {
    if (pressing.current) return;
    pressing.current = true;
    setLikeFailure(null);
    like.mutate(!liked);
  };

  // 받기 전이다 — 세션 복원을 기다리느라 아직 묻지 않은 때도 그렇다.
  if (post.isPending) return <Empty>불러오는 중…</Empty>;
  if (post.isError) {
    return (
      <div className="space-y-3">
        <ErrorBox error={post.error} />
        <Link to="/posts" className="text-sm text-accent-600 underline">
          목록으로
        </Link>
      </div>
    );
  }
  if (!post.data) return null;

  const mine = accountId !== null && accountId === post.data.writerId;
  const admin = role === 'ADMIN';
  const { liked, likeCount } = post.data;
  /** 수정에 실패한 댓글의 수정란이 지금 그려져 있는가. 아니면 그 필드 오류는 목록 위 요약에 남는다. */
  const savingShown =
    failure?.action === 'save' &&
    editing === failure.commentId &&
    (comments.data?.content.some((c) => c.id === failure.commentId) ?? false);

  return (
    <div className="space-y-4">
      <Panel>
        {/* 띄어쓰기 없는 긴 낱말(붙여 넣은 주소)도 줄을 바꾼다(`wrap-anywhere`) — 안 바꾸면 본문 영역이 가로로
            스크롤된다(F-05). 아래 본문과 댓글도 같다. */}
        {/* 좁은 폭에서는 버튼을 제목 아래로 내린다 — 옆에 두면 제목이 버튼에 밀려 몇 글자씩 줄을 바꾼다. */}
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-bold text-default wrap-anywhere">{post.data.title}</h1>
            <p className="mt-1 text-xs text-muted">
              <Link to={`/members/${post.data.writerId}`} className="hover:text-accent-600">
                {post.data.writerNickname}
              </Link>
              <span className="text-faint">
                {' '}
                {DEV_ONLY ? `· sub ${post.data.writerId} ` : null}·{' '}
                {formatDateTime(post.data.createdAt)} · 조회 {post.data.viewCount} · 댓글{' '}
                {post.data.commentCount}
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
                <Trash2 size={13} /> 삭제{admin && !mine ? ' (관리자)' : ''}
              </Button>
            ) : null}
          </div>
        </header>
        <div className="mt-4 whitespace-pre-wrap border-t border-line-soft pt-4 text-sm text-default wrap-anywhere">
          {post.data.content}
        </div>
        <div className="mt-4 space-y-2 border-t border-line-soft pt-4">
          {/* `liked: null` 은 「누구인지 모른다」 이고 `false` 와 다르다(api-contract.md §4.3) — 누를 버튼 대신 로그인 안내다.
              눌림을 그리지 않는다. */}
          {liked === null ? (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 text-muted">
                <Heart size={14} /> 좋아요 {likeCount}
              </span>
              <span className="text-xs text-faint">
                좋아요를 누르려면{' '}
                <Link to="/login" className="text-accent-600 underline">
                  로그인
                </Link>
              </span>
            </p>
          ) : (
            // 기다리는 동안 `disabled` 가 아니라 `aria-disabled` 다 — `disabled` 면 포커스를 잃어 키보드로 누른 사람의 다음 키가 버튼에
            // 닿지 않는다(2026-11-17 e2e/keyboard.spec.ts 변이 측정). 누르기를 막는 것은 `pressing` 이다.
            <Button
              variant={liked ? 'primary' : 'ghost'}
              aria-pressed={liked}
              aria-disabled={like.isPending || undefined}
              className="aria-disabled:cursor-wait"
              onClick={() => toggleLike(liked)}
            >
              <Heart size={14} fill={liked ? 'currentColor' : 'none'} /> 좋아요 {likeCount}
            </Button>
          )}
          {/* 누르기의 실패는 버튼 밖에 둔다 — 실패가 세션을 끝내면(A003 뒤 재발급 거부) 버튼이 로그인 안내로 바뀌는데, 그때도
              무엇이 났고 어디로 가면 되는지는 남아야 한다. */}
          <ErrorBox error={likeFailure} />
        </div>
      </Panel>

      <Panel title={`댓글 ${comments.data ? comments.data.totalElements : ''}`}>
        <ErrorBox
          error={failure && failure.action !== 'add' ? failure.error : null}
          inlineFields={savingShown ? COMMENT_FIELDS : []}
        />

        {comments.isError ? <ErrorBox error={comments.error} /> : null}

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
                        aria-label="댓글 수정"
                        onChange={(e) => setEditDraft(e.target.value)}
                      />
                      <FieldErrors
                        messages={
                          failure?.action === 'save' && failure.commentId === c.id
                            ? fieldMessages(failure.error, 'content')
                            : []
                        }
                      />
                      <div className="flex gap-1.5">
                        <Button variant="primary" onClick={() => saveComment.mutate(c.id)}>
                          저장
                        </Button>
                        <Button onClick={() => setEditing(null)}>취소</Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-default wrap-anywhere">{c.content}</p>
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
          <Empty>댓글이 없습니다</Empty>
        ) : null}

        {comments.data && comments.data.totalPages > 1 ? (
          <div className="mt-3">
            <Pager page={comments.data} onChange={setCommentPage} />
          </div>
        ) : null}

        <div className="mt-4 space-y-2 border-t border-line-soft pt-4">
          {/* 작성 실패는 작성란 밖에 둔다 — 실패가 세션을 끝내면(A003 뒤 재발급 거부) 작성란이 사라지는데,
              그때도 무엇이 났고 어디로 가면 되는지는 남아야 한다. */}
          <ErrorBox error={addFailure} meanings={addMeanings} inlineFields={loggedIn ? COMMENT_FIELDS : []} />
          {loggedIn ? (
            <form
              className="space-y-2"
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
              <FieldErrors messages={fieldMessages(addFailure, 'content')} />
              <div className="flex items-center justify-between">
                <span className="text-xs text-faint">
                  {draft.length} / {COMMENT_CONTENT_MAX} · 작성에는 프로필이 필요합니다
                </span>
                <Button type="submit" variant="primary" disabled={addComment.isPending}>
                  등록
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-xs text-faint">
              댓글을 쓰려면{' '}
              <Link to="/login" className="text-accent-600 underline">
                로그인
              </Link>
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
