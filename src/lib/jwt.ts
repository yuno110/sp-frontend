/**
 * Access Token 의 payload 를 **표시 목적으로만** 읽는다.
 *
 * 서명을 검증하지 않는다. 판정은 전부 서버가 한다 — 이 값으로 화면을 가리는 것은
 * 편의이고 보안 경계가 아니다(sp-docs/security.md §5.1 이 판정 위치를 서버로 못박는다).
 * claim 계약은 sp-docs/api-contract.md §6 이다.
 */
export interface TokenClaims {
  sub: string;
  role: string;
  iss: string;
  iat: number;
  exp: number;
}

export function decodeClaims(token: string | null): TokenClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(
      atob(payload)
        .split('')
        .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
        .join(''),
    );
    return JSON.parse(json) as TokenClaims;
  } catch {
    return null;
  }
}

/** `exp` 까지 남은 초. 음수면 이미 지났다. 서버 시계와 다를 수 있다. */
export function secondsUntilExpiry(claims: TokenClaims | null): number | null {
  if (!claims?.exp) return null;
  return claims.exp - Math.floor(Date.now() / 1000);
}
