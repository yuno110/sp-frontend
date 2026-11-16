import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { confirmEmailVerification, resendVerification } from '@/features/auth/api';
import { errorOf, fieldMessages } from '@/lib/api/client';
import { EMAIL_VERIFICATION } from '@/lib/api/errorCodes';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
import { Button, ErrorBox, Field, Input, Panel, RecoveryLink } from '@/components/ui';
import { Steps } from './SignupPage';

/**
 * 메일 링크의 토큰 — `{FRONTEND_BASE_URL}/verify-email#token=<토큰>` 의 fragment 에 있다(requirements/member.md §11.5). 없거나 비었으면
 * null 이다. 토큰은 base64url 이라 `+` 가 없다 — 쿼리 문법으로 읽어도 글자가 바뀌지 않는다.
 */
function tokenIn(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') || null;
}

/**
 * 이메일 인증 — 메일의 링크가 여는 화면이다(F-08). 무인증이다 — 로그인하지 않은 탭에서도, 다른 계정으로 로그인한 탭에서도 같다.
 *
 * - **토큰을 처음 그릴 때 한 번 읽고 주소창에서 fragment 를 지운다**(security.md §12) — 주소를 복사하거나 기록을 보아도 토큰이 따라가지
 *   않는다. 그래서 새로고침하면 링크가 없는 화면이다
 * - **확인은 사용자가 버튼을 눌렀을 때만 보낸다**(같은 절) — 링크를 미리 여는 메일 보안 검사기가 토큰을 먼저 써 버리지 않게 한다. 화면을
 *   여는 것만으로는 아무 요청도 보내지 않는다
 * - 확인의 204 는 토큰을 주지 않는다 — 로그인으로 안내한다. `AU007` 은 「이미 인증했다면 로그인하라」 를 함께 보인다(errorCodes.ts 의
 *   `EMAIL_VERIFICATION`)
 */
export function VerifyEmailPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => tokenIn(location.hash));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  // 기록을 하나 더 쌓지 않고 바꾼다 — 뒤로 가기로 토큰이 든 주소에 돌아오지 않는다.
  useEffect(() => {
    if (location.hash === '') return;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  const confirm = async () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      await confirmEmailVerification(token);
      setDone(true);
    } catch (e) {
      // 쥐는 것은 요청 본문을 비운 사본이다 — 본문의 토큰은 그 자체로 자격이다(security.md §12).
      setError(withoutRequestBody(e));
    } finally {
      setBusy(false);
    }
  };

  // 링크가 쓸 수 없는 것으로 판정됐다 — 같은 토큰으로 다시 보내도 같은 답이다.
  const rejected = errorOf(error)?.code === 'AU007';

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Steps current={1} />
      <Panel title="이메일 인증">
        {done ? (
          <div className="space-y-3">
            <p className="rounded-md border border-line bg-success-50 px-3 py-2 text-sm text-success-600">
              이메일 인증을 마쳤습니다.
            </p>
            <p className="text-sm text-default">
              이제 로그인할 수 있습니다. <RecoveryLink recovery="login" />
            </p>
          </div>
        ) : token === null ? (
          <p className="text-sm text-default">인증 링크를 찾지 못했습니다. 메일의 링크를 다시 열어 주세요.</p>
        ) : (
          <div className="space-y-3">
            {rejected ? null : (
              <p className="text-sm text-default">
                아래 버튼을 누르면 이메일 인증을 마칩니다. 가입한 적이 없다면 누르지 말고 이 화면을 닫아 주세요.
              </p>
            )}
            <ErrorBox error={error} meanings={EMAIL_VERIFICATION} />
            {rejected ? null : (
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => void confirm()}
                className="w-full justify-center"
              >
                {busy ? '확인 중…' : '이메일 인증하기'}
              </Button>
            )}
          </div>
        )}
        {done ? null : (
          <p className="mt-3 text-xs text-faint">
            링크가 만료됐거나 메일을 찾을 수 없으면 <RecoveryLink recovery="resendVerification" />
          </p>
        )}
      </Panel>
    </div>
  );
}

/**
 * 인증 메일 재발송(F-08). 경로는 이 화면이 정했다(router.tsx). 무인증이다.
 *
 * **202 는 계정이 있든 없든 같은 문장이다** — 화면이 계정의 존재를 드러내지 않는다(api-contract.md §2.4). 메일이 나가는지는 서버의 뒤
 * 작업이 정한다. 형식 위반은 400 `C001` 이고 입력칸 옆에 보인다.
 */
export function ResendVerificationPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [requested, setRequested] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setRequested(false);
    try {
      await resendVerification(email);
      setRequested(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Panel title="인증 메일 다시 받기">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm text-default">
            가입한 이메일을 입력해 주세요. 아직 인증하지 않은 계정이면 인증 메일을 다시 보냅니다.
          </p>
          <Field label="이메일" errors={fieldMessages(error, 'email')}>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <ErrorBox error={error} inlineFields={['email']} />
          {requested ? (
            <p className="rounded-md border border-line bg-subtle px-3 py-2 text-sm text-default">
              요청을 받았습니다. 이 이메일로 가입한 계정이 아직 인증되지 않았다면 인증 메일이 갑니다. 메일함을 확인해 주세요.
            </p>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? '보내는 중…' : '인증 메일 보내기'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
