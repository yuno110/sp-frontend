import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { confirmPasswordReset, requestPasswordReset } from '@/features/auth/api';
import { errorOf, fieldMessages } from '@/lib/api/client';
import { PASSWORD_RESET } from '@/lib/api/errorCodes';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
import { Button, ErrorBox, Field, Input, Panel, RecoveryLink } from '@/components/ui';

/**
 * 메일 링크의 토큰 — `{FRONTEND_BASE_URL}/reset-password#token=<토큰>` 의 fragment 에 있다(requirements/member.md §11.5). 없거나 비었으면
 * null 이다. 토큰은 base64url 이라 `+` 가 없다 — 쿼리 문법으로 읽어도 글자가 바뀌지 않는다.
 */
function tokenIn(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('token') || null;
}

/**
 * 비밀번호 재설정 — 메일의 링크가 여는 화면이다(F-09). 무인증이다 — 로그인하지 않은 탭에서도, 다른 계정으로 로그인한 탭에서도 같다.
 *
 * - **토큰을 처음 그릴 때 한 번 읽고 주소창에서 fragment 를 지운다**(security.md §12) — 주소를 복사하거나 기록을 보아도 토큰이 따라가지
 *   않는다. 새로고침하면 링크가 없는 화면이다
 * - **확인은 새 비밀번호를 넣고 제출했을 때만 보낸다** — 화면을 여는 것만으로는 아무 요청도 보내지 않는다
 * - **토큰은 이 화면의 상태에만 둔다.** `newPassword` 의 400 `C001` 은 토큰을 쓰기 전에 걸러지므로(requirements/member.md §11.4) 입력칸
 *   옆의 오류를 보고 고쳐 같은 토큰으로 다시 낸다 — 주소창의 fragment 는 이미 지웠다. 응답이 없거나 서버 오류로 실패해도 같은 토큰으로 다시
 *   낸다
 * - `AU007` 은 같은 토큰으로 다시 내도 같은 답이라 폼을 내리고 비밀번호 찾기로 안내한다(errorCodes.ts 의 `PASSWORD_RESET`)
 * - 확인의 204 는 토큰을 주지 않는다 — 입력값을 비우고 폼 대신 로그인 안내를 그린다. 이 탭의 세션에는 손대지 않는다
 */
export function ResetPasswordPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [token] = useState(() => tokenIn(location.hash));
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  // 기록을 하나 더 쌓지 않고 바꾼다 — 뒤로 가기로 토큰이 든 주소에 돌아오지 않는다.
  useEffect(() => {
    if (location.hash === '') return;
    navigate({ pathname: location.pathname, search: location.search }, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);

  const submit = async () => {
    if (token === null) return;
    setBusy(true);
    setError(null);
    try {
      await confirmPasswordReset(token, newPassword);
      setNewPassword('');
      setDone(true);
    } catch (e) {
      // 쥐는 것은 요청 본문을 비운 사본이다 — 본문에 새 비밀번호와 링크의 토큰이 있다.
      setError(withoutRequestBody(e));
    } finally {
      setBusy(false);
    }
  };

  // 링크가 쓸 수 없는 것으로 판정됐다 — 같은 토큰으로 다시 보내도 같은 답이다.
  const rejected = errorOf(error)?.code === 'AU007';

  return (
    <div className="mx-auto max-w-md">
      <Panel title="비밀번호 재설정">
        {done ? (
          <div className="space-y-3">
            <p className="rounded-md border border-line bg-success-50 px-3 py-2 text-sm text-success-600">
              비밀번호를 바꿨습니다.
            </p>
            <p className="text-sm text-default">
              새 비밀번호로 로그인해 주세요. <RecoveryLink recovery="login" />
            </p>
          </div>
        ) : token === null ? (
          <p className="text-sm text-default">재설정 링크를 찾지 못했습니다. 메일의 링크를 다시 열어 주세요.</p>
        ) : rejected ? (
          <ErrorBox error={error} meanings={PASSWORD_RESET} />
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p className="text-sm text-default">새로 쓸 비밀번호를 입력해 주세요.</p>
            <Field label="새 비밀번호" errors={fieldMessages(error, 'newPassword')}>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <ErrorBox error={error} inlineFields={['newPassword']} />
            <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
              {busy ? '바꾸는 중…' : '비밀번호 바꾸기'}
            </Button>
          </form>
        )}
        {/* 쓸 수 없는 링크면 오류 상자가 같은 곳으로 안내한다 — 링크를 겹쳐 두지 않는다. */}
        {done || rejected ? null : (
          <p className="mt-3 text-xs text-faint">
            링크가 만료됐거나 메일을 찾을 수 없으면 <RecoveryLink recovery="requestPasswordReset" />
          </p>
        )}
      </Panel>
    </div>
  );
}

/**
 * 비밀번호 찾기 — 재설정 메일을 요청한다(F-09). 경로는 이 화면이 정했다(router.tsx). 무인증이다. 로그인 화면이 이리로 가는 링크를 둔다.
 *
 * **202 는 계정이 있든 없든 같은 문장이다** — 화면이 계정의 존재를 드러내지 않는다(api-contract.md §2.4). 메일이 나가는지는 서버의 뒤
 * 작업이 정한다(requirements/member.md §11.3). 형식 위반은 400 `C001` 이고 입력칸 옆에 보인다.
 */
export function RequestPasswordResetPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [requested, setRequested] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setRequested(false);
    try {
      await requestPasswordReset(email);
      setRequested(true);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Panel title="비밀번호 찾기">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm text-default">
            가입한 이메일을 입력해 주세요. 그 이메일의 계정이면 비밀번호를 다시 정하는 링크를 메일로 보냅니다.
          </p>
          <Field label="이메일" errors={fieldMessages(error, 'email')}>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <ErrorBox error={error} inlineFields={['email']} />
          {requested ? (
            <p className="rounded-md border border-line bg-subtle px-3 py-2 text-sm text-default">
              요청을 받았습니다. 이 이메일로 가입한 계정이 있다면 비밀번호 재설정 메일이 갑니다. 메일함을 확인해 주세요.
            </p>
          ) : null}
          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? '보내는 중…' : '재설정 메일 보내기'}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
