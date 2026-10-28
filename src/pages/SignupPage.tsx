import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { clsx } from 'clsx';
import { checkEmail, createAccount, login } from '@/features/auth/api';
import { checkNickname, createProfile } from '@/features/member/api';
import { fieldMessages } from '@/lib/api/client';
import { DEV_ONLY } from '@/lib/devOnly';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel } from '@/components/ui';

/**
 * 가입 3단계. **여기가 두 서비스가 엮이는 자리다**(api-contract.md §9.1).
 *
 * 1) `POST /api/v1/accounts` (auth, 무인증)
 * 2) `POST /api/v1/auth/login` (auth, 무인증) — 토큰을 받는다
 * 3) `POST /api/v1/members` (member, 인증) — `accountId` 는 본문이 아니라 JWT `sub` 에서 온다
 *
 * **1단계만 끝난 상태도 정상이다** — 로그인·탈퇴는 되고 글 작성만 `S002` 로 막힌다.
 */
const STEPS = ['계정 만들기', '로그인', '프로필 등록'];

/** 단계마다 입력칸 옆에 오류를 그리는 필드. 나머지 필드의 오류는 그 단계의 요약에 남는다. */
const INLINE_FIELDS: string[][] = [['email', 'password'], [], ['nickname']];

export function SignupPage({ startAt = 0 }: { startAt?: number }) {
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const accountId = useAuthStore((s) => s.accountId);

  const [step, setStep] = useState(startAt);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);

  /**
   * 중복 확인 (api-contract.md §2.3). 두 엔드포인트가 같은 모양이고 **`available` 이
   * true 면 쓸 수 있다** — 부정형(`duplicated`)이 아니다.
   *
   * **경합을 막지 못한다.** 확인과 생성 사이에 다른 사용자가 같은 값을 쓸 수 있고 최종
   * 판정은 UNIQUE 제약이다. 편의 기능이므로 이 버튼을 눌러야 다음 단계로 가지는 것은 아니다.
   */
  const check = (what: '이메일' | '닉네임', fn: () => Promise<{ available: boolean }>) =>
    run(async () => {
      setChecked(null);
      const { available } = await fn();
      setChecked(available ? `쓸 수 있는 ${what}이다` : `이미 쓰이고 있는 ${what}이다`);
    });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      // 규칙 위반은 C001 이고 그 본체는 fieldErrors 다(requirements/member.md §2 의 필드별 메시지). 버리면
      // 오류 문장 한 줄만 남아 무엇이 틀렸는지 알 수 없다 — 입력칸 옆과 요약에 나눠 그린다.
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const doAccount = () =>
    run(async () => {
      await createAccount(email, password);
      setStep(1);
    });

  const doLogin = () =>
    run(async () => {
      setTokens(await login(email, password));
      setStep(2);
    });

  const doProfile = () =>
    run(async () => {
      await createProfile(nickname);
      navigate('/posts');
    });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <ol className="flex items-center gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={clsx(
              'flex items-center gap-1 rounded-md px-2 py-1',
              i === step ? 'bg-accent-50 font-medium text-accent-700' : 'text-faint',
            )}
          >
            {i < step ? <Check size={12} /> : <span className="font-mono">{i + 1}</span>}
            {label}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <Panel title="1단계 — 계정 생성">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void doAccount();
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
            {checked ? (
              <div className="rounded-md border border-line bg-subtle px-3 py-2 text-xs text-default">
                {checked}
              </div>
            ) : null}
            <ErrorBox error={error} inlineFields={INLINE_FIELDS[0]} />
            <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
              {busy ? '보내는 중…' : '계정 만들기'}
            </Button>
          </form>
        </Panel>
      ) : null}

      {step === 1 ? (
        <Panel title="2단계 — 로그인">
          <p className="mb-3 text-xs text-muted">
            계정이 만들어졌다. 로그인하면 프로필을 등록할 수 있다.
          </p>
          {checked ? (
              <div className="rounded-md border border-line bg-subtle px-3 py-2 text-xs text-default">
                {checked}
              </div>
            ) : null}
            <ErrorBox error={error} inlineFields={INLINE_FIELDS[1]} />
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void doLogin()}
            className="mt-2 w-full justify-center"
          >
            {busy ? '보내는 중…' : '로그인'}
          </Button>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel title="3단계 — 프로필 등록">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void doProfile();
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
            {checked ? (
              <div className="rounded-md border border-line bg-subtle px-3 py-2 text-xs text-default">
                {checked}
              </div>
            ) : null}
            <ErrorBox error={error} inlineFields={INLINE_FIELDS[2]} />
            <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
              {busy ? '보내는 중…' : '프로필 등록'}
            </Button>
          </form>
          <p className="mt-3 text-xs text-faint">
            나중에 등록해도 된다 — 프로필이 없으면 글과 댓글만 쓸 수 없다.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
