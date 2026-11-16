import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { createPost, getPost, updatePost } from '@/features/board/api';
import {
  CATEGORY_LABEL,
  POST_CONTENT_MAX,
  TITLE_MAX,
  type PostCategory,
} from '@/features/board/types';
import { useNoProfileMeanings } from '@/features/member/useNoProfileMeanings';
import { fieldMessages } from '@/lib/api/client';
import { useMounted } from '@/lib/useMounted';
import { useAuthStore } from '@/stores/authStore';
import { Button, Empty, ErrorBox, Field, Input, Panel, Select, Textarea } from '@/components/ui';

/** 입력칸 옆에 오류를 그리는 필드. 나머지 필드의 오류는 요약에 남는다. */
const INLINE_FIELDS = ['category', 'title', 'content'];

/** 새 글의 카테고리 — 고르지 않으면 서버도 이것이다(sp-docs/requirements/board.md §8). */
const DEFAULT_CATEGORY: PostCategory = 'FREE';

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
  const mounted = useMounted();
  const role = useAuthStore((s) => s.role);
  const [category, setCategory] = useState<PostCategory>(DEFAULT_CATEGORY);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  /** 입력칸을 채운 글의 id. */
  const [filledFor, setFilledFor] = useState<string | null>(null);
  /** 고칠 글을 받았을 때의 카테고리. */
  const [filledCategory, setFilledCategory] = useState<PostCategory | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errorMeanings = useNoProfileMeanings(error);

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
    setCategory(received.category);
    setFilledCategory(received.category);
    setTitle(received.title);
    setContent(received.content);
    setFilledFor(postId);
  }, [received, filledFor, postId]);

  // 공지 선택지는 토큰의 role 이 ADMIN 일 때만 그린다 — 판정은 서버의 403 P003 이고 그 답은 이 폼의 오류 상자(`ErrorBox`)에 보인다.
  // 고치는 글이 지금 공지면 ADMIN 이 아니어도 그 값을 남긴다 — 지금 값을 그대로 보내는 수정은 공지 판정을 거치지 않는다
  // (sp-docs/requirements/board.md §8).
  const choices = (Object.keys(CATEGORY_LABEL) as PostCategory[]).filter(
    (choice) => choice !== 'NOTICE' || role === 'ADMIN' || filledCategory === 'NOTICE',
  );

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved =
        mode === 'create'
          ? await createPost(title, content, category)
          : await updatePost(postId, title, content, category);
      if (mounted.current) navigate(`/posts/${saved.id}`);
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
        <Field label="카테고리" errors={fieldMessages(error, 'category')}>
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as PostCategory)}
            className="sm:w-48"
          >
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {CATEGORY_LABEL[choice]}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="제목"
          hint={`${title.length} / ${TITLE_MAX} · 공백만으로 채울 수 없습니다`}
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
        <ErrorBox error={error} meanings={errorMeanings} inlineFields={INLINE_FIELDS} />
        {/* 좁은 폭에서는 안내를 다음 줄로 넘긴다 — 한 줄에 두면 버튼이 눌려 글자가 쪼개진다. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? '보내는 중…' : mode === 'create' ? '등록' : '저장'}
          </Button>
          <Button onClick={() => navigate(-1)}>취소</Button>
          {mode === 'create' ? (
            <span className="text-xs text-faint">작성에는 프로필이 필요합니다</span>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}
