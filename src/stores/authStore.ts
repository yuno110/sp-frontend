import { create } from 'zustand';
import type { TokenResponse } from '@/lib/api/types';
import { withoutRequestBody } from '@/lib/api/withoutRequestBody';
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
   * 세션을 끝냈거나 되살리지 못한 실패(lib/api/client.ts 가 남긴다). 한 번 보이고 지운다 — 보호된 화면은 토큰이 비면 로그인으로
   * 가면서 그 오류를 잃으므로 로그인 화면이(pages/LoginPage.tsx), 공개 화면은 그 자리에 있으므로 머리글 아래가
   * (components/Layout.tsx) 보인다. 다시 로그인하거나 재발급에 성공하면 지운다.
   * 영속하지 않고, 토큰을 지우거나 남기는 판단에 쓰지 않는다. 남기는 것은 요청 본문을 비운 사본이다(`withoutRequestBody`).
   */
  sessionFailure: unknown;
  /**
   * 이 탭의 탈퇴가 어디까지 끝났는가(pages/MyPage.tsx 가 남긴다). `'account'` 는 계정 탈퇴가 끝나고 프로필 탈퇴가 남은
   * 상태이고 `'done'` 은 둘 다 끝난 상태다. 계정 탈퇴가 Refresh Token 을 지우므로(sp-docs/api-contract.md §9.1.1)
   * `'account'` 에서 Access Token 을 잃으면 다시 시도할 수 없다 — 그때 로그인 화면이 그 사실을 보인다(pages/LoginPage.tsx).
   * 로그인 화면은 토큰이 없을 때 한 번 보이고 지운다. 다시 로그인하면(`setTokens`) 지운다 — 로그인은 탈퇴한 계정에 토큰을
   * 주지 않는다(§2.1). **재발급은 지우지 않는다**(`setReissuedTokens`) — 계정 탈퇴보다 먼저 서버에서 끝난 재발급의 응답이 그 뒤에
   * 올 수 있고, 그래도 탈퇴가 어디까지 끝났는지는 그대로다. 영속하지 않는다.
   */
  withdrawal: 'account' | 'done' | null;
  /**
   * 가입이 계정을 만든 뒤 이어서 한 로그인의 실패(pages/SignupPage.tsx 가 남긴다). 로그인 화면이 한 번 보이고 지운다.
   * 영속하지 않는다. 남기는 것은 요청 본문을 비운 사본이다(`withoutRequestBody`).
   */
  signupLoginFailure: unknown;
  /**
   * 세션의 세대. 로그인(`setTokens`)과 세션의 끝(`clear`)에서 오르고 재발급(`setReissuedTokens`)에서는 오르지 않는다 — 재발급은 같은
   * 세션이 이어지는 것이다. 응답이 온 요청이 지금 세션의 것인지 가르는 값이다(lib/api/client.ts). 토큰을 비교해서는 가를 수 없다 — 같은
   * 계정이 같은 초에 받은 토큰은 문자열이 같다(sp-docs/requirements/member.md §6.2). 쿼리 캐시의 수명도 이 값이 정한다
   * (lib/queryClient.ts). 영속하지 않는다.
   */
  sessionGeneration: number;
  /** 로그인의 결과 — 새 세션이다. 앞 세션의 안내를 지운다. */
  setTokens: (t: TokenResponse) => void;
  /** 자동 재발급의 결과 — 같은 세션이 이어진다(lib/api/client.ts). */
  setReissuedTokens: (t: TokenResponse) => void;
  setAccessToken: (accessToken: string) => void;
  setSessionFailure: (failure: unknown) => void;
  setWithdrawal: (withdrawal: 'account' | 'done' | null) => void;
  setSignupLoginFailure: (failure: unknown) => void;
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
    // 비면 키를 지운다 — null 을 적어 두지 않으므로 로그아웃 뒤 영속 저장소에 남는 것이 없다. undefined 도 비었다고 본다 — `setItem` 은
    // 그것을 글자로 적는다.
    if (refreshToken == null) sessionStorage.removeItem(REFRESH_TOKEN_KEY);
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
  withdrawal: null,
  signupLoginFailure: null,
  sessionGeneration: 0,
  setTokens: (t) =>
    set((s) => ({
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      ...claimsOf(t.accessToken),
      sessionFailure: null,
      withdrawal: null,
      sessionGeneration: s.sessionGeneration + 1,
    })),
  setReissuedTokens: (t) =>
    set({
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      ...claimsOf(t.accessToken),
      sessionFailure: null,
    }),
  setAccessToken: (accessToken) => set({ accessToken, ...claimsOf(accessToken) }),
  setSessionFailure: (sessionFailure) => set({ sessionFailure: withoutRequestBody(sessionFailure) }),
  setWithdrawal: (withdrawal) => set({ withdrawal }),
  setSignupLoginFailure: (signupLoginFailure) =>
    set({ signupLoginFailure: withoutRequestBody(signupLoginFailure) }),
  clear: () =>
    set((s) => ({
      accessToken: null,
      refreshToken: null,
      accountId: null,
      role: null,
      sessionGeneration: s.sessionGeneration + 1,
    })),
}));

// Refresh Token 만 영속한다.
useAuthStore.subscribe((s, prev) => {
  if (s.refreshToken !== prev.refreshToken) writeRefreshToken(s.refreshToken);
});

/**
 * 지금 세션을 찍어 둔다 — 요청을 기다린 뒤에 세션에 손대는 자리가 쓴다. 기다리는 사이에 세션이 바뀔 수 있다. 로그인 화면에는 머리글의
 * 로그아웃과 로그인 폼이 함께 있고, 요청을 기다리는 동안에도 화면을 옮길 수 있다.
 *
 * `started` 는 찍어 둔 세대다. `same` 은 세션이 그대로인가다 — 재발급은 같은 세션이다. `replaced` 는 다른 세션이 시작됐는가다 — 끝나기만
 * 했으면 아니다.
 */
export function watchSession() {
  const started = useAuthStore.getState().sessionGeneration;
  const same = () => useAuthStore.getState().sessionGeneration === started;
  return { started, same, replaced: () => !same() && useAuthStore.getState().accessToken !== null };
}

let latestLogin = 0;

/**
 * 로그인을 시작한다 — 사용자가 제출할 때 부른다. 돌려주는 함수는 이것이 아직 가장 나중에 시작한 로그인인가를 답하고, 아니면 응답을 세션으로
 * 삼지 않는다. 응답은 시작한 순서대로 오지 않는다 — 늦은 응답이 세션을 덮으면 사용자가 나중에 고른 계정이 앞선 계정으로 바뀐다.
 * 로그아웃도 누를 때 부른다 — 앞서 낸 로그인의 늦은 응답이 로그아웃한 탭을 다시 로그인시키지 않는다. 로그아웃을 기다리는 동안 낸 로그인은
 * 더 나중이라 유효하다.
 *
 * 세션의 세대로 가르지 않는다. 로그아웃을 기다리는 동안 낸 로그인은 그 로그아웃으로 세대가 올라도 유효하고, 앞서 낸 로그인의 응답이 먼저
 * 오면 세대로는 앞선 쪽이 세션이 되고 나중에 낸 쪽이 버려진다.
 */
export function beginLogin() {
  const mine = ++latestLogin;
  return () => mine === latestLogin;
}
