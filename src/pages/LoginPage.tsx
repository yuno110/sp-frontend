import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { login } from '@/features/auth/api';
import { getMyProfile, getProfile } from '@/features/member/api';
import { errorOf } from '@/lib/api/client';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
import { DEV_ONLY } from '@/lib/devOnly';
import { beginLogin, useAuthStore } from '@/stores/authStore';
import { Button, ErrorBox, Field, Input, Panel, SessionEnded } from '@/components/ui';

/**
 * 로그인한 뒤에 갈 곳 — 프로필이 아직 없으면 프로필 등록이고, 그 밖에는 목록이다. 인증한 뒤 처음 로그인하면 프로필 등록으로 이어진다
 * (requirements/member.md §4, F-08).
 *
 * 내 프로필 조회의 404 `M001` 은 미등록과 탈퇴를 가르지 않는다(api-contract.md §3.1). 탈퇴한 프로필의 등록은 409 `M007` 이므로 그때는
 * 프로필 등록으로 보내지 않는다(CLAUDE.md 「화면 문구와 오류 표시」) — 공개 조회의 `deleted` 로 가른다. 그 답을 받지 못했으면 미등록으로
 * 본다 — 등록을 눌러 `M007` 을 받으면 그 문장이 새 계정으로 안내한다.
 *
 * 두 조회는 머리글과 같은 키다(components/Layout.tsx 의 `useNickname`, features/member/useNoProfileMeanings.ts) — 캐시가 하나라
 * (lib/queryClient.ts) 내 프로필 조회는 머리글의 것과 한 요청으로 합쳐진다. 공개 조회는 머리글이 내 프로필 조회의 `M001` 을 받은 뒤에
 * 시작하므로 그 사이 이 조회가 끝났으면 다시 묻는다(`staleTime` 0). 내 프로필 조회가 실패해도 로그인은 끝났으므로 목록으로 간다 — 그
 * 실패는 머리글이 보인다. 던지지 않는다.
 */
async function landing(client: QueryClient): Promise<string> {
  try {
    await client.fetchQuery({ queryKey: ['member', 'me'], queryFn: getMyProfile });
    return '/posts';
  } catch (e) {
    if (errorOf(e)?.code !== 'M001') return '/posts';
  }
  const { accountId } = useAuthStore.getState();
  if (accountId === null) return '/signup/profile';
  try {
    const profile = await client.fetchQuery({
      queryKey: ['member', 'profile', String(accountId)],
      queryFn: () => getProfile(accountId),
    });
    return profile.deleted ? '/posts' : '/signup/profile';
  } catch {
    return '/signup/profile';
  }
}

/**
 * 로그인. **400 이 없다** — 누락·빈 값·형식 오류도 401 `AU003` 이다(api-contract.md §2.1).
 * 그래서 클라이언트에서 형식을 미리 막지 않는다. 서버가 어떤 코드를 내는지 보는 것이 목적이다.
 *
 * 인증 전의 계정은 비밀번호가 맞으면 403 `AU006` 이다(§2.1) — 그 오류가 인증 메일을 다시 받는 화면으로 안내한다(errorCodes.ts).
 * 잠긴 이메일은 비밀번호가 맞든 틀리든 401 `AU005` 이고 비밀번호 찾기 화면으로 안내한다. 요청 수 제한은 429 `C009` 이고 문장은
 * 어느 화면과도 같은 것이다(client.ts 의 `describeError`). 셋 다 아래 `ErrorBox` 가 가른다. 이 화면이 코드를 읽는 것은 하나다 —
 * `AU005` 의 오류 상자에 「비밀번호 찾기」 링크가 있으므로 그동안 아래 안내의 같은 링크를 내린다(CLAUDE.md 「화면 문구와 오류 표시」,
 * 같은 곳으로 가는 링크를 둘 두지 않는다).
 */
export function LoginPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setTokens = useAuthStore((s) => s.setTokens);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const locked = errorOf(error)?.code === 'AU005';

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

  // 탈퇴가 어디까지 끝났는가(pages/MyPage.tsx). 토큰이 없을 때만 보인다 — 토큰이 남아 있으면 마이페이지에서 다시 시도할 수 있다.
  const withdrawal = useAuthStore((s) => (s.accessToken === null ? s.withdrawal : null));
  const [withdrawn, setWithdrawn] = useState(() => {
    const s = useAuthStore.getState();
    return s.accessToken === null ? s.withdrawal : null;
  });
  // 클로저가 아니라 스토어를 다시 읽는다 — 이 값은 `'account'` 에서 `'done'` 으로 나아간다. 화면이 그려지고 이 효과가 돌기 전에 프로필
  // 탈퇴가 끝날 수 있고, 클로저의 값을 보이고 지우면 끝났다는 사실이 사라진다.
  useEffect(() => {
    const s = useAuthStore.getState();
    const latest = s.accessToken === null ? s.withdrawal : null;
    if (latest === null) return;
    setWithdrawn(latest);
    s.setWithdrawal(null);
  }, [withdrawal]);

  const submit = async () => {
    const latest = beginLogin();
    setBusy(true);
    setError(null);
    setEnded(null);
    setWithdrawn(null);
    try {
      const tokens = await login(email, password);
      // 그 사이 다른 로그인이나 로그아웃을 시작했으면 이 응답은 세션이 되지 않는다 — 이 화면은 이미 내려갔거나 그 세션의 화면이다.
      if (!latest()) return;
      setTokens(tokens);
      const next = await landing(queryClient);
      // 프로필을 묻는 사이에 다른 로그인이나 로그아웃을 시작했으면 옮기지 않는다 — 이 세션은 이미 지나갔다.
      if (!latest()) return;
      navigate(next);
    } catch (e) {
      // 쥐는 것은 요청 본문을 비운 사본이다 — 로그인 본문에는 비밀번호가 있다.
      setError(withoutRequestBody(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <Panel title="로그인">
        {/* 한 자리에 하나다. 프로필 탈퇴가 그 뒤에 끝날 수 있다 — 끝났으면 탈퇴했다는 것만 보인다. 세션을 끝낸 실패는 더 할 일이 없다. */}
        {withdrawn === 'done' ? (
          <p className="mb-3 rounded-md border border-line bg-success-50 px-3 py-2 text-sm text-success-600">
            탈퇴했습니다.
          </p>
        ) : withdrawn === 'account' ? (
          <SessionEnded failure={ended} afterWithdrawal className="mb-3" />
        ) : ended != null ? (
          <SessionEnded failure={ended} className="mb-3" />
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
          {locked ? null : (
            <>
              {' '}비밀번호를 잊었다면{' '}
              <Link to="/reset-password/request" className="text-accent-600 underline">
                비밀번호 찾기
              </Link>
              .
            </>
          )}
          {DEV_ONLY
            ? ' 가입은 계정 → 이메일 인증 → 로그인 → 프로필 순서다 (api-contract.md §9.1·§9.10). 로그인 뒤 내 프로필 조회가 M001 이면 프로필 등록으로 간다.'
            : null}
        </p>
      </Panel>
    </div>
  );
}
