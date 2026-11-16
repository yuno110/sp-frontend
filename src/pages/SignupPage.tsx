import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { clsx } from 'clsx';
import { checkEmail, createAccount } from '@/features/auth/api';
import { checkNickname, createProfile } from '@/features/member/api';
import { fieldMessages } from '@/lib/api/client';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
import { DEV_ONLY } from '@/lib/devOnly';
import { useMounted } from '@/lib/useMounted';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel, RecoveryLink } from '@/components/ui';

/**
 * 가입. **사용자가 내는 것은 계정 정보와 닉네임이고, 그 사이에 메일의 링크로 인증하고 로그인한다**(F-08). 서버의 단계는 그대로다
 * (api-contract.md §9.1·§9.10).
 *
 * 1) `POST /api/v1/accounts` (auth, 무인증) — 커밋 뒤 인증 메일이 나간다
 *    `POST /api/v1/accounts/email-verification/confirm` (auth, 무인증) — 메일의 링크를 연 인증 화면(pages/VerifyEmailPage.tsx)
 * 2) `POST /api/v1/auth/login` (auth, 무인증) — 로그인 화면(pages/LoginPage.tsx). 프로필이 없으면 프로필 등록으로 간다
 * 3) `POST /api/v1/members` (member, 인증) — `accountId` 는 본문이 아니라 JWT `sub` 에서 온다
 *
 * **계정을 만든 화면은 로그인하지 않는다** — 인증 전의 로그인은 403 `AU006` 이다(requirements/member.md §3 규칙 11·§4). 「메일을 확인하세요」
 * 로 끝난다. 2026-10-27 의 결정(계정을 만들면 같은 비밀번호로 바로 로그인한다, F-04)은 그때의 계약 위에 있었다.
 */
const STEPS = ['계정 만들기', '이메일 인증', '프로필 등록'];

export function Steps({ current }: { current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={clsx(
            'flex items-center gap-1 rounded-md px-2 py-1 break-keep',
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
      setChecked(available ? `쓸 수 있는 ${what}입니다` : `이미 쓰이고 있는 ${what}입니다`);
    });

  return { busy, error, checked, run, check };
}

function Checked({ text }: { text: string | null }) {
  return text ? (
    <div className="rounded-md border border-line bg-subtle px-3 py-2 text-xs text-default">{text}</div>
  ) : null;
}

/**
 * 가입의 첫 화면 — 계정을 만든다. **비밀번호는 이 화면의 입력값에만 둔다** — 이 화면이 쥐는 오류는 요청 본문을 비운 사본이다
 * (`useSubmit`). 저장소에도, 다른 화면에 넘기는 값에도 두지 않는다. 계정을 만들면 입력값을 비우고 폼 대신 메일 안내를 그린다 — 비밀번호
 * 입력칸이 함께 내려간다.
 *
 * 로그인하지 않으므로 세션에 손대지 않는다 — 기다리는 사이에 다른 로그인이나 로그아웃이 있어도 가를 것이 없다. 화면을 떠났으면 늦게 온
 * 응답이 바꿀 화면이 없다.
 */
export function SignupPage() {
  const { busy, error, checked, run, check } = useSubmit();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // 만든 계정의 이메일 — 서버가 돌려준 값이다. 인증 메일은 그 주소로 간다(requirements/member.md §11).
  const [created, setCreated] = useState<string | null>(null);

  const submit = () =>
    run(async () => {
      const account = await createAccount(email, password);
      setPassword('');
      setCreated(account.email);
    });

  if (created !== null) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <Steps current={1} />
        <Panel title="메일을 확인하세요">
          <div className="space-y-2 text-sm text-default">
            {/* 이메일은 띄어쓰기 없이 길 수 있다 — 줄을 바꾸지 않으면 좁은 화면에서 가로로 스크롤된다(F-05). */}
            <p className="wrap-anywhere">{created} 계정을 만들었습니다.</p>
            <p>이 주소로 인증 메일을 보냅니다. 메일의 링크를 열어 인증을 마친 뒤 로그인해 주세요.</p>
            <p className="text-muted">
              메일이 오지 않으면 <RecoveryLink recovery="resendVerification" />
            </p>
          </div>
        </Panel>
      </div>
    );
  }

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
 * 가입의 마지막 화면 — 프로필을 등록한다. 인증한 뒤 처음 로그인했을 때 프로필이 없으면 로그인 화면이 여기로 보낸다(pages/LoginPage.tsx).
 * 프로필 없이 로그인한 계정도 프로필 등록 안내를 따라 여기로 온다(errorCodes.ts 의 `MY_PROFILE`·`S002`). 등록은 인증 요청이라
 * **보호된 경로다**(router.tsx).
 */
export function SignupProfilePage() {
  const navigate = useNavigate();
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const accountId = useAuthStore((s) => s.accountId);
  const { busy, error, checked, run, check } = useSubmit();
  const [nickname, setNickname] = useState('');

  const submit = () =>
    run(async () => {
      await createProfile(nickname);
      // 머리글의 닉네임은 내 프로필 조회에서 온다(components/Layout.tsx) — 등록 전에 받은 「프로필 없음」을 남기지 않는다.
      await queryClient.invalidateQueries({ queryKey: ['member', 'me'] });
      if (mounted.current) navigate('/posts');
    });

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Steps current={2} />
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
          나중에 등록해도 됩니다 — 프로필이 없으면 글과 댓글만 쓸 수 없습니다.
        </p>
      </Panel>
    </div>
  );
}
