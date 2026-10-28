import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPost, getPost, updatePost } from '@/features/board/api';
import { POST_CONTENT_MAX, TITLE_MAX } from '@/features/board/types';
import { fieldMessages } from '@/lib/api/client';
import { Button, ErrorBox, Field, Input, Panel, Textarea } from '@/components/ui';

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
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const existing = useQuery({
    queryKey: ['post', postId],
    queryFn: () => getPost(postId),
    retry: false,
    enabled: mode === 'edit',
  });

  useEffect(() => {
    if (existing.data) {
      setTitle(existing.data.title);
      setContent(existing.data.content);
    }
  }, [existing.data]);

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

  // 고칠 글을 받지 못했으면 폼 대신 그 실패를 보인다. 빈 폼은 그 글이 비어 있는 것처럼 보이고, 저장하면
  // 보지 못한 글을 덮어쓴다(AGENTS.md 불변식 9).
  if (existing.isError) {
    return (
      <Panel title="글 수정">
        <div className="space-y-3">
          <ErrorBox error={existing.error} />
          <Link to="/posts" className="text-sm text-accent-600 underline">
            목록으로
          </Link>
        </div>
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
