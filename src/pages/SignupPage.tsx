import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { clsx } from 'clsx';
import { checkEmail, createAccount, login } from '@/features/auth/api';
import { checkNickname, createProfile } from '@/features/member/api';
import { fieldMessages } from '@/lib/api/client';
import type { TokenResponse } from '@/lib/api/types';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
import { DEV_ONLY } from '@/lib/devOnly';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel } from '@/components/ui';

/**
 * 가입. **사용자가 내는 것은 계정 정보와 닉네임이다** — 사이의 로그인은 화면이 방금 입력한 비밀번호로 한다
 * (sp-docs/plan/phase2.md §7.1). 서버의 단계는 그대로다(api-contract.md §9.1).
 *
 * 1) `POST /api/v1/accounts` (auth, 무인증)
 * 2) `POST /api/v1/auth/login` (auth, 무인증) — 토큰을 받는다
 * 3) `POST /api/v1/members` (member, 인증) — `accountId` 는 본문이 아니라 JWT `sub` 에서 온다
 *
 * **1단계만 끝난 상태도 정상이다** — 로그인·탈퇴는 되고 글 작성만 `S002` 로 막힌다. 그래서 계정을 만든 뒤 로그인이
 * 실패하면 로그인 화면으로 보낸다.
 */
const STEPS = ['계정 만들기', '프로필 등록'];

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2 text-xs">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={clsx(
            'flex items-center gap-1 rounded-md px-2 py-1',
            i === current ? 'bg-accent-50 font-medium text-accent-700' : 'text-faint',
          )}
        >
          {i < current ? <Check size={12} /> : <span className="font-mono">{i + 1}</span>}
          {label}
        </li>
      ))}
    </ol>
  );
}

/** 화면 하나의 제출 상태 — 보내는 중인가, 마지막 실패, 중복 확인의 결과. */
function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [checked, setChecked] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // 규칙 위반은 C001 이고 그 본체는 fieldErrors 다(requirements/member.md §2 의 필드별 메시지). 버리면
      // 오류 문장 한 줄만 남아 무엇이 틀렸는지 알 수 없다 — 입력칸 옆과 요약에 나눠 그린다. 쥐는 것은 요청 본문을 비운
      // 사본이다 — 계정 생성의 본문에는 비밀번호가 있다.
      setError(withoutRequestBody(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 중복 확인 (api-contract.md §2.3). 두 엔드포인트가 같은 모양이고 **`available` 이
   * true 면 쓸 수 있다** — 부정형(`duplicated`)이 아니다.
   *
   * **경합을 막지 못한다.** 확인과 생성 사이에 다른 사용자가 같은 값을 쓸 수 있고 최종
   * 판정은 UNIQUE 제약이다. 편의 기능이므로 이 버튼을 눌러야 제출할 수 있는 것은 아니다.
   */
  const check = (what: '이메일' | '닉네임', fn: () => Promise<{ available: boolean }>) =>
    run(async () => {
      setChecked(null);
      const { available } = await fn();
      setChecked(available ? `쓸 수 있는 ${what}이다` : `이미 쓰이고 있는 ${what}이다`);
    });

  return { busy, error, checked, run, check };
}

function Checked({ text }: { text: string | null }) {
  return text ? (
    <div className="rounded-md border border-line bg-subtle px-3 py-2 text-xs text-default">{text}</div>
  ) : null;
}

/**
 * 가입의 첫 화면 — 계정을 만들고 같은 비밀번호로 바로 로그인한다. **비밀번호는 이 화면의 입력값에만 둔다** — 이 화면이
 * 쥐는 오류는 요청 본문을 비운 사본이다(`useSubmit`). 로그인 요청이 끝나면 어느 쪽이든 다른 화면으로 가고
 * (`/signup/profile` 은 다른 컴포넌트다) 이 화면과 함께 입력값이 사라진다. 저장소에도, 다음 화면에 넘기는 값에도 두지 않는다.
 */
export function SignupPage() {
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const { busy, error, checked, run, check } = useSubmit();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // 계정 생성이 실패하면 이 화면에 남는다 — 로그인하지 않는다.
  const submit = () =>
    run(async () => {
      await createAccount(email, password);
      let tokens: TokenResponse;
      try {
        tokens = await login(email, password);
      } catch (e) {
        // 계정은 만들어졌다. 1단계만 끝난 상태는 정상이므로 로그인 화면으로 보내고 그 화면이 이 실패를 보인다. 스토어는
        // 요청 본문(비밀번호)을 비운 사본만 남긴다(stores/authStore.ts).
        useAuthStore.getState().setSignupLoginFailure(e);
        navigate('/login', { replace: true });
        return;
      }
      setTokens(tokens);
      navigate('/signup/profile', { replace: true });
    });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Steps current={0} />
      <Panel title="계정 만들기">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="이메일" errors={fieldMessages(error, 'email')}>
            <div className="flex gap-2">
              <Input value={email} onChange={(e) => setEmail(e.target.value)} />
              <Button
                className="shrink-0"
                disabled={busy}
                onClick={() => void check('이메일', () => checkEmail(email))}
              >
                중복 확인
              </Button>
            </div>
          </Field>
          <Field label="비밀번호" errors={fieldMessages(error, 'password')}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Checked text={checked} />
          <ErrorBox error={error} inlineFields={['email', 'password']} />
          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? '보내는 중…' : '계정 만들기'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}

/**
 * 가입의 마지막 화면 — 프로필을 등록한다. 프로필 없이 로그인한 계정도 프로필 등록 안내를 따라 여기로 온다
 * (errorCodes.ts 의 `MY_PROFILE`·`S002`). 등록은 인증 요청이라 **보호된 경로다**(router.tsx).
 */
export function SignupProfilePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const accountId = useAuthStore((s) => s.accountId);
  const { busy, error, checked, run, check } = useSubmit();
  const [nickname, setNickname] = useState('');

  const submit = () =>
    run(async () => {
      await createProfile(nickname);
      // 머리글의 닉네임은 내 프로필 조회에서 온다(components/Layout.tsx) — 등록 전에 받은 「프로필 없음」을 남기지 않는다.
      await queryClient.invalidateQueries({ queryKey: ['member', 'me'] });
      navigate('/posts');
    });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Steps current={1} />
      <Panel title="프로필 등록">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {DEV_ONLY ? (
            <p className="text-xs text-muted">
              member 가 받는 본문은 nickname 하나다. accountId 는 검증된 토큰의 sub
              {accountId !== null ? ` (= ${accountId})` : ''} 에서 온다.
            </p>
          ) : null}
          <Field label="닉네임" errors={fieldMessages(error, 'nickname')}>
            <div className="flex gap-2">
              <Input value={nickname} onChange={(e) => setNickname(e.target.value)} />
              <Button
                className="shrink-0"
                disabled={busy}
                onClick={() => void check('닉네임', () => checkNickname(nickname))}
              >
                중복 확인
              </Button>
            </div>
          </Field>
          <Checked text={checked} />
          <ErrorBox error={error} inlineFields={['nickname']} />
          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? '보내는 중…' : '프로필 등록'}
          </Button>
        </form>
        <p className="mt-3 text-xs text-faint">
          나중에 등록해도 된다 — 프로필이 없으면 글과 댓글만 쓸 수 없다.
        </p>
      </Panel>
    </div>
  );
}
