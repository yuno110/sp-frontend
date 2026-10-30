import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPost, getPost, updatePost } from '@/features/board/api';
import { POST_CONTENT_MAX, TITLE_MAX } from '@/features/board/types';
import { fieldMessages } from '@/lib/api/client';
import { Button, Empty, ErrorBox, Field, Input, Panel, Textarea } from '@/components/ui';

/** 입력칸 옆에 오류를 그리는 필드. 나머지 필드의 오류는 요약에 남는다. */
const INLINE_FIELDS = ['title', 'content'];

/**
 * 글 작성·수정.
 *
 * **작성만 member 를 호출한다** — board 가 트랜잭션 밖에서 내부 API 로 닉네임 스냅샷을
 * 받는다 (api-contract.md §4.2, adr/0012 §6). 그래서 member 가 내려가면 작성은 503 S001
 * 로 막히고 **수정은 계속 된다.** 그 차이가 이 화면에서 바로 보인다.
 */
export function PostFormPage({ mode }: { mode: 'create' | 'edit' }) {
  const { id } = useParams();
  const postId = id ?? '';
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  /** 입력칸을 채운 글의 id. */
  const [filledFor, setFilledFor] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const existing = useQuery({
    queryKey: ['post', postId],
    queryFn: () => getPost(postId),
    retry: false,
    enabled: mode === 'edit',
  });

  // 고칠 글은 이 화면이 열린 뒤 받은 값으로 한 번만 채운다. 상세가 받아 둔 값(같은 조회의 캐시)으로는 채우지 않는다 — 그 사이
  // 바뀌었으면 옛 글을 고쳐 저장하게 된다. 채운 뒤 다시 받은 값으로는 덮지 않는다 — 상세 조회는 조회수를 올려 받을 때마다 새
  // 값이라, 덮으면 입력한 것이 사라지고 옛 값이 저장된다(F-06 측정).
  const received = existing.isFetchedAfterMount && existing.isSuccess ? existing.data : undefined;
  useEffect(() => {
    if (!received || filledFor === postId) return;
    setTitle(received.title);
    setContent(received.content);
    setFilledFor(postId);
  }, [received, filledFor, postId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved =
        mode === 'create'
          ? await createPost(title, content)
          : await updatePost(postId, title, content);
      navigate(`/posts/${saved.id}`);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // 채우기 전에는 폼을 그리지 않는다 — 빈 입력칸에 쓴 것을 받은 값이 덮는다. 고칠 글을 받지 못했으면 폼 대신 그 실패를
  // 보인다. 빈 폼은 그 글이 비어 있는 것처럼 보이고, 저장하면 보지 못한 글을 덮어쓴다(AGENTS.md 불변식 9).
  if (mode === 'edit' && filledFor !== postId) {
    return (
      <Panel title="글 수정">
        {existing.isFetchedAfterMount && existing.isError ? (
          <div className="space-y-3">
            <ErrorBox error={existing.error} />
            <Link to="/posts" className="text-sm text-accent-600 underline">
              목록으로
            </Link>
          </div>
        ) : (
          <Empty>불러오는 중…</Empty>
        )}
      </Panel>
    );
  }

  return (
    <Panel title={mode === 'create' ? '새 글' : '글 수정'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          label="제목"
          hint={`${title.length} / ${TITLE_MAX} · 공백만으로 채울 수 없다`}
          errors={fieldMessages(error, 'title')}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} />
        </Field>
        <Field
          label="본문"
          hint={`${content.length} / ${POST_CONTENT_MAX}`}
          errors={fieldMessages(error, 'content')}
        >
          <Textarea
            rows={14}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={POST_CONTENT_MAX}
          />
        </Field>
        <ErrorBox error={error} inlineFields={INLINE_FIELDS} />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? '보내는 중…' : mode === 'create' ? '등록' : '저장'}
          </Button>
          <Button onClick={() => navigate(-1)}>취소</Button>
          {mode === 'create' ? (
            <span className="text-xs text-faint">작성에는 프로필이 필요하다</span>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}
