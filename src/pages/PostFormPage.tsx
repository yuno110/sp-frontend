import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPost, getPost, updatePost } from '@/features/board/api';
import { POST_CONTENT_MAX, TITLE_MAX } from '@/features/board/types';
import { errorOf, messageOf } from '@/lib/api/client';
import { Button, ErrorBox, Field, Input, Panel, Textarea } from '@/components/ui';

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
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
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
    setFields([]);
    try {
      const saved =
        mode === 'create'
          ? await createPost(title, content)
          : await updatePost(postId, title, content);
      navigate(`/posts/${saved.id}`);
    } catch (e) {
      setError(messageOf(e));
      setFields((errorOf(e)?.fieldErrors ?? []).map((f) => `${f.field}: ${f.message}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={mode === 'create' ? '새 글' : '글 수정'}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="제목" hint={`${title.length} / ${TITLE_MAX} · 공백만으로 채울 수 없다`}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TITLE_MAX} />
        </Field>
        <Field label="본문" hint={`${content.length} / ${POST_CONTENT_MAX}`}>
          <Textarea
            rows={14}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={POST_CONTENT_MAX}
          />
        </Field>
        <ErrorBox message={error} fields={fields} />
        <div className="flex items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? '보내는 중…' : mode === 'create' ? 'POST /api/v1/posts' : `PUT /api/v1/posts/${postId}`}
          </Button>
          <Button onClick={() => navigate(-1)}>취소</Button>
          {mode === 'create' ? (
            <span className="text-xs text-faint">
              작성은 member 내부 API 를 먼저 호출한다 — 프로필 없음 403 S002, 연동 실패 503 S001
            </span>
          ) : (
            <span className="text-xs text-faint">
              수정은 스냅샷을 갱신하지 않으므로 member 를 호출하지 않는다
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}
