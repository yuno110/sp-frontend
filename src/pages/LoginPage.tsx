import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { login } from '@/features/auth/api';
import { DEV_ONLY } from '@/lib/devOnly';
import { useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel } from '@/components/ui';

/**
 * 로그인. **400 이 없다** — 누락·빈 값·형식 오류도 401 `AU003` 이다(api-contract.md §2.1).
 * 그래서 클라이언트에서 형식을 미리 막지 않는다. 서버가 어떤 코드를 내는지 보는 것이 목적이다.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const setTokens = useAuthStore((s) => s.setTokens);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  // 세션을 끝낸 실패 — 보호된 화면은 토큰이 비면 이리로 오면서 그 오류를 잃는다. 여기서 이어 보이고 저장소에서는
  // 지운다(한 번만 보인다, stores/authStore.ts 의 `sessionFailure`). 이 화면이 그려진 뒤에 남겨진 실패도 받는다 —
  // 토큰이 비는 것과 이유가 남는 것 사이에 화면이 먼저 바뀔 수 있다.
  const sessionFailure = useAuthStore((s) => s.sessionFailure);
  const [ended, setEnded] = useState<unknown>(() => useAuthStore.getState().sessionFailure);
  useEffect(() => {
    if (sessionFailure == null) return;
    setEnded(sessionFailure);
    useAuthStore.getState().setSessionFailure(null);
  }, [sessionFailure]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setEnded(null);
    try {
      setTokens(await login(email, password));
      navigate('/posts');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Panel title="로그인">
        {ended != null ? (
          <div className="mb-3 space-y-2">
            <p className="text-sm text-default">로그인 상태를 이어가지 못했습니다.</p>
            <ErrorBox error={ended} />
          </div>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label="이메일">
            <Input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </Field>
          <Field label="비밀번호">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </Field>
          <ErrorBox error={error} />
          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? '확인 중…' : '로그인'}
          </Button>
        </form>
        <p className="mt-3 text-xs text-faint">
          계정이 없으면 <Link to="/signup" className="text-accent-600 underline">가입</Link>.
          {DEV_ONLY ? ' 가입은 계정 → 로그인 → 프로필 3단계다 (api-contract.md §9.1).' : null}
        </p>
      </Panel>
    </div>
  );
}
