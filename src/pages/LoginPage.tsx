import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { login } from '@/features/auth/api';
import { messageOf } from '@/lib/api/client';
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      setTokens(await login(email, password));
      navigate('/posts');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Panel title="로그인">
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
          <ErrorBox message={error} />
          <Button type="submit" variant="primary" disabled={busy} className="w-full justify-center">
            {busy ? '확인 중…' : '로그인'}
          </Button>
        </form>
        <p className="mt-3 text-xs text-faint">
          계정이 없으면 <Link to="/signup" className="text-accent-600 underline">가입</Link>. 가입은
          계정 → 로그인 → 프로필 3단계다 (api-contract.md §9.1).
        </p>
      </Panel>
    </div>
  );
}
