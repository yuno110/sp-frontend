import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { LogOut } from 'lucide-react';
import { beginLogin, useAuthStore, watchSession } from '@/stores/authStore';
import { getMyProfile } from '@/features/member/api';
import { logout } from '@/features/auth/api';
import { useNoProfileMeanings } from '@/features/member/useNoProfileMeanings';
import { AFTER_WITHDRAWAL, MY_PROFILE } from '@/lib/api/errorCodes';
import { decodeClaims, secondsUntilExpiry } from '@/lib/jwt';
import { DEV_ONLY } from '@/lib/devOnly';
import { ApiLogPanel } from './ApiLogPanel';
import { Button, ErrorBox, ErrorLine, SessionEnded } from './ui';

const NAV = [
  { to: '/posts', label: '게시판' },
  { to: '/posts/mine', label: '내 글' },
  { to: '/me', label: '마이페이지' },
  // 라우트도 개발 빌드에서만 있다(router.tsx).
  ...(DEV_ONLY ? [{ to: '/tokens', label: '토큰 실험' }] : []),
];

/**
 * 닉네임은 member 에서 온다 — JWT claim 에 `nickname` 이 없다(api-contract.md §6).
 * 그래서 로그인한 상태의 머리글 한 줄에도 **두 서비스가 필요하다.**
 */
function useNickname(enabled: boolean) {
  return useQuery({
    queryKey: ['member', 'me'],
    queryFn: getMyProfile,
    enabled,
    retry: false,
  });
}

/** 라우트의 `handle` (router.tsx). */
export interface RouteHandle {
  /**
   * 세션이 끝나도 이 화면에 머문다 — 공개 화면이다. 그 이유를 머리글 아래에 그 자리에서 보인다. 없는 화면은 보이지 않는다 — 로그인
   * 화면이 스스로 보이고, 보호된 화면과 옮겨 가는 라우트는 곧 로그인 화면이나 그 옮겨 간 화면으로 간다.
   */
  showsSessionFailure?: boolean;
}

/** 머리글 아래의 안내 — 머리글에서 시작한 일의 실패이거나 그 화면에 머무는 동안 끝난 세션이다. 그 화면에서만 보인다. */
interface Notice {
  at: string;
  kind: 'logout' | 'session';
  failure: unknown;
  afterWithdrawal: boolean;
}

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { accessToken, accountId, role, restoring, sessionFailure, clear } = useAuthStore();
  const loggedIn = accessToken !== null;
  const profile = useNickname(loggedIn);
  const profileMeanings = useNoProfileMeanings(profile.error, MY_PROFILE);
  const expiresIn = secondsUntilExpiry(decodeClaims(accessToken));
  const showsFailure = useMatches().some((m) => (m.handle as RouteHandle | undefined)?.showsSessionFailure);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 지금 서 있는 화면 — 로그아웃 요청이 도는 사이에 옮겼으면 옮겨 간 화면에서 그 실패를 보인다.
  const here = useRef(pathname);

  // 공개 화면은 토큰이 비어도 로그인으로 가지 않으므로 세션이 끝난 이유를 여기서 보이고 지운다 — 다음 로그인 화면이 다시 보이지
  // 않는다. 클로저가 아니라 스토어를 다시 읽는다 — StrictMode 가 이 효과를 두 번 돌려도 한 번만 가져간다.
  useEffect(() => {
    const auth = useAuthStore.getState();
    if (auth.sessionFailure == null || !showsFailure) return;
    setNotice({
      at: pathname,
      kind: 'session',
      failure: auth.sessionFailure,
      afterWithdrawal: auth.withdrawal === 'account',
    });
    auth.setSessionFailure(null);
    // 한 번 보였으니 로그인 화면이 같은 사실을 다시 보이지 않는다(pages/LoginPage.tsx).
    if (auth.withdrawal === 'account') auth.setWithdrawal(null);
  }, [sessionFailure, showsFailure, pathname]);

  // 다른 화면으로 가면 지운다 — 돌아와도 다시 보이지 않는다.
  useEffect(() => {
    here.current = pathname;
    setNotice((current) => (current && current.at !== pathname ? null : current));
  }, [pathname]);

  const doLogout = async () => {
    setNotice(null);
    // 앞서 낸 로그인의 늦은 응답이 이 로그아웃을 되돌리지 않는다. 기다리는 동안 낸 로그인은 더 나중이라 유효하다.
    beginLogin();
    // 응답을 기다리는 사이에 세션이 바뀌면 이 응답은 지금 세션의 일이 아니다 — 로그인 화면에는 이 버튼과 로그인 폼이 함께 있다. 끝내면 새
    // 세션이 끝나고, 실패를 보이면 새 세션을 두고 로그아웃하지 못했다고 하게 된다.
    const session = watchSession();
    try {
      await logout();
    } catch (e) {
      // 토큰을 지우지 않는다 — 서버의 Refresh Token 이 남아 있는데 탭만 비우면 로그아웃한 것처럼 보이고(불변식 9) 다시 알릴 토큰도
      // 없다. 로그아웃은 멱등이라 다시 눌러도 된다(sp-docs/api-contract.md §2.1). 그 실패로 세션이 끝났으면(재발급 거부) 로그아웃할
      // 것이 없다 — 이유는 `sessionFailure` 가 잇는다.
      if (session.same()) {
        const afterWithdrawal = useAuthStore.getState().withdrawal === 'account';
        setNotice({ at: here.current, kind: 'logout', failure: e, afterWithdrawal });
      }
      return;
    }
    if (!session.same()) return;
    // `flushSync` 로 옮긴다 — 로그인 화면을 동기로 그려 떠나는 화면을 캐시를 비우는 커밋 뒤에 남기지 않는다. 없으면 옮기기가 전환으로
    // 미뤄져 떠나는 화면이 비운 캐시로 다시 묻는다(lib/queryClient.ts) — 글 상세는 조회할 때마다 조회수가 오른다. 지우기는 옮긴 뒤에 하고,
    // 옮기기를 기다리는 사이에 시작된 세션은 지우지 않는다.
    await navigate('/login', { flushSync: true });
    if (!session.same()) return;
    clear();
  };

  return (
    <div className="flex h-full flex-col">
      {/* 좁은 화면에서는 줄을 바꿔 쌓는다. 낱말 안에서는 줄을 바꾸지 않는다(`break-keep`) — 한글은 음절 사이에서 줄이 바뀌어
          자리가 모자라면 메뉴 이름이 한 글자씩 선다(F-05 의 360px 측정). */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 break-keep border-b border-line bg-elev px-6 py-3">
        {/* 제품 이름. 링크로 두지 않는다 — 탐색의 「게시판」 링크와 글자도 가는 곳(/posts)도 같아 같은 링크가 둘이 된다. */}
        <span className="text-lg font-bold text-default">게시판</span>

        <nav className="ml-4 flex items-center gap-1">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/posts'}
              className={({ isActive }) =>
                clsx(
                  'rounded-md px-2.5 py-1.5 text-sm',
                  isActive ? 'bg-subtle font-medium text-default' : 'text-muted hover:text-default',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-sm">
          {loggedIn ? (
            <>
              <span className="text-muted">
                {profile.isError ? (
                  // 실패를 점 세 개로 덮지 않는다 — 머리글이 로딩처럼 보이면 member 의 장애가 가려진다
                  // (AGENTS.md 불변식 9). 이 조회의 M001 은 "프로필이 아직 없음" 이거나 탈퇴한 프로필이다.
                  <ErrorLine error={profile.error} meanings={profileMeanings} />
                ) : (
                  <span className="font-medium text-default">{profile.data?.nickname ?? '…'}</span>
                )}
                {DEV_ONLY ? (
                  <span className="ml-2 font-mono text-xs text-faint">
                    sub {accountId} · {role}
                    {expiresIn !== null ? ` · exp ${expiresIn}s` : ''}
                  </span>
                ) : null}
              </span>
              <Button onClick={doLogout}>
                <LogOut size={13} /> 로그아웃
              </Button>
            </>
          ) : restoring ? null : (
            // 되살리는 동안은 어느 쪽 링크도 그리지 않는다 — 그 세션이 되살아날지 아직 모른다.
            <>
              <NavLink to="/login" className="text-muted hover:text-default">
                로그인
              </NavLink>
              <NavLink to="/signup" className="text-accent-600 hover:text-accent-700">
                가입
              </NavLink>
            </>
          )}
        </div>
      </header>

      {/* 머리글의 로그인 칸과 본문 밖이다 — 이 실패들이 바꾸는 자리 안에 두면 그 실패가 안내를 지운다. */}
      {notice?.at === pathname ? (
        <div role="alert" className="border-b border-line bg-elev px-6 py-3">
          <div className="mx-auto max-w-5xl space-y-2">
            {notice.kind === 'logout' ? (
              <>
                <p className="text-sm text-default">로그아웃하지 못했습니다. 로그인 상태가 그대로입니다.</p>
                <ErrorBox error={notice.failure} meanings={notice.afterWithdrawal ? AFTER_WITHDRAWAL : undefined} />
              </>
            ) : (
              <SessionEnded failure={notice.failure} afterWithdrawal={notice.afterWithdrawal} />
            )}
          </div>
        </div>
      ) : null}

      <main className="flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>

      {DEV_ONLY ? <ApiLogPanel /> : null}
    </div>
  );
}
