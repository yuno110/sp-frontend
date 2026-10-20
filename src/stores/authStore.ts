import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { TokenResponse } from '@/lib/api/types';
import { decodeClaims } from '@/lib/jwt';

/**
 * 토큰 보관. **sessionStorage 에 둔다** — 새로고침은 살아남고 탭을 닫으면 사라진다.
 *
 * localStorage 가 아닌 이유는 이 저장소가 로컬 확인용이라도 토큰을 영구 저장할 이유가
 * 없기 때문이다. 쿠키를 쓰지 않는 것은 계약이다 — 토큰은 `Authorization` 헤더로 보내고
 * `allowCredentials` 는 false 다(sp-docs/security.md §1.1).
 */
interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  accountId: number | null;
  role: string | null;
  setTokens: (t: TokenResponse) => void;
  setAccessToken: (accessToken: string) => void;
  clear: () => void;
}

function claimsOf(accessToken: string): { accountId: number | null; role: string | null } {
  const claims = decodeClaims(accessToken);
  if (!claims) return { accountId: null, role: null };
  const parsed = Number(claims.sub);
  return {
    accountId: Number.isFinite(parsed) ? parsed : null,
    role: claims.role ?? null,
  };
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      accountId: null,
      role: null,
      setTokens: (t) =>
        set({ accessToken: t.accessToken, refreshToken: t.refreshToken, ...claimsOf(t.accessToken) }),
      setAccessToken: (accessToken) => set({ accessToken, ...claimsOf(accessToken) }),
      clear: () => set({ accessToken: null, refreshToken: null, accountId: null, role: null }),
    }),
    { name: 'sp-auth', storage: createJSONStorage(() => sessionStorage) },
  ),
);
