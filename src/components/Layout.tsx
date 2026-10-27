import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { getMyProfile } from '@/features/member/api';
import { logout } from '@/features/auth/api';
import { errorOf, messageOf } from '@/lib/api/client';
import { decodeClaims, secondsUntilExpiry } from '@/lib/jwt';
import { DEV_ONLY } from '@/lib/devOnly';
import { ApiLogPanel } from './ApiLogPanel';
import { Button } from './ui';

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

export function Layout() {
  const navigate = useNavigate();
  const { accessToken, accountId, role, clear } = useAuthStore();
  const loggedIn = accessToken !== null;
  const profile = useNickname(loggedIn);
  const noProfile = errorOf(profile.error)?.code === 'M001';
  const expiresIn = secondsUntilExpiry(decodeClaims(accessToken));

  const doLogout = async () => {
    try {
      await logout();
    } finally {
      clear();
      navigate('/login');
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-4 border-b border-line bg-elev px-6 py-3">
        <Link to="/posts" className="text-lg font-bold text-default">
          sp-frontend
        </Link>

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
                {noProfile ? (
                  <Link to="/signup/profile" className="text-danger-600 underline">
                    프로필 없음 — 가입 3단계 필요
                  </Link>
                ) : profile.isError ? (
                  // M001 이 아닌 실패는 점 세 개로 덮지 않는다. member 를 내려 보는 것이
                  // 이 화면으로 보려는 것 중 하나인데, 머리글이 로딩처럼 보이면 그 장애가
                  // 가려진다 (AGENTS.md 불변식 9).
                  <span className="font-medium text-danger-600" title={messageOf(profile.error)}>
                    닉네임을 못 받았다 — {messageOf(profile.error)}
                  </span>
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
          ) : (
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

      <main className="flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </main>

      {DEV_ONLY ? <ApiLogPanel /> : null}
    </div>
  );
}
