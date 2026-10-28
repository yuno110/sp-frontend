import { create } from 'zustand';
import type { TokenResponse } from '@/lib/api/types';
import { decodeClaims } from '@/lib/jwt';

/**
 * 토큰 보관. **Access Token 은 메모리에만 두고, 영속하는 것은 Refresh Token 하나다**
 * (sp-docs/plan/phase2.md §7.1). Refresh Token 은 `sessionStorage` 에 두므로 탭을 닫으면 사라진다.
 * 새로고침하면 Access Token 이 없으므로 Refresh Token 으로 다시 받는다(lib/api/client.ts 의 `restoreSession`).
 *
 * `sessionStorage` 는 스크립트가 읽을 수 있는 자리다 — 남는 위험은 CLAUDE.md 「경계」가 적는다.
 * 쿠키를 쓰지 않는 것은 계약이다 — 토큰은 `Authorization` 헤더로 보내고 `allowCredentials` 는
 * false 다(sp-docs/security.md §1.1).
 */
interface AuthState {
  /** 메모리에만 있다. 새로고침하면 사라진다. */
  accessToken: string | null;
  /** 이 값만 영속한다(아래 `subscribe`). */
  refreshToken: string | null;
  accountId: number | null;
  role: string | null;
  /**
   * 영속된 Refresh Token 으로 세션을 되살리는 중인가. 그동안은 그 세션이 되살아날지 알 수 없으므로
   * 보호된 경로가 판정을 미룬다(router.tsx 의 `RequireToken`).
   */
  restoring: boolean;
  /**
   * 세션을 끝냈거나 되살리지 못한 실패(lib/api/client.ts 가 남긴다). 보호된 화면은 토큰이 비면 로그인으로 가면서 그
   * 오류를 잃으므로 로그인 화면이 이어 보이고 지운다(pages/LoginPage.tsx). 다시 로그인하면(`setTokens`) 지운다.
   * 영속하지 않고, 토큰을 지우거나 남기는 판단에 쓰지 않는다.
   */
  sessionFailure: unknown;
  setTokens: (t: TokenResponse) => void;
  setAccessToken: (accessToken: string) => void;
  setSessionFailure: (failure: unknown) => void;
  clear: () => void;
}

/** 영속 키. 값은 Refresh Token 문자열 그대로다. */
const REFRESH_TOKEN_KEY = 'sp-auth';

/**
 * 영속 저장소에 접근하면 던지는 환경이 있다(예: 저장소 접근이 SecurityError). 그때는 던지지 않고
 * 영속 없이 메모리로 동작한다 — 걷어낸 zustand `persist` 도 경고를 남기고 그렇게 동작했다. 새로고침이
 * 세션을 잇지 못하게 되므로 경고는 남긴다.
 */
function readRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY);
  } catch (e) {
    console.warn('sessionStorage 를 읽지 못했다 — 영속된 세션 없이 시작한다', e);
    return null;
  }
}

function writeRefreshToken(refreshToken: string | null) {
  try {
    // 비면 키를 지운다 — null 을 적어 두지 않으므로 로그아웃 뒤 영속 저장소에 남는 것이 없다.
    if (refreshToken === null) sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    else sessionStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  } catch (e) {
    console.warn('sessionStorage 에 쓰지 못했다 — Refresh Token 이 메모리에만 있다', e);
  }
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

const persisted = readRefreshToken();

export const useAuthStore = create<AuthState>()((set) => ({
  accessToken: null,
  refreshToken: persisted,
  accountId: null,
  role: null,
  restoring: persisted !== null,
  sessionFailure: null,
  setTokens: (t) =>
    set({
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      ...claimsOf(t.accessToken),
      sessionFailure: null,
    }),
  setAccessToken: (accessToken) => set({ accessToken, ...claimsOf(accessToken) }),
  setSessionFailure: (sessionFailure) => set({ sessionFailure }),
  clear: () => set({ accessToken: null, refreshToken: null, accountId: null, role: null }),
}));

// Refresh Token 만 영속한다.
useAuthStore.subscribe((s, prev) => {
  if (s.refreshToken !== prev.refreshToken) writeRefreshToken(s.refreshToken);
});
