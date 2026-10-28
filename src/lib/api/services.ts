/**
 * 경로 접두어 → 서비스 주소. 정본은 sp-docs/api-contract.md §1 의 경로 표다.
 *
 * 1차에는 게이트웨이가 없어 클라이언트가 주소를 직접 안다(sp-docs/adr/0009).
 * 그 ADR 이 "§1 의 경로 표는 2차 전환 시 게이트웨이 라우팅 규칙의 명세가 된다" 고
 * 적었으므로 **이 맵을 한 군데로 모아 둔다** — 게이트웨이가 생기면 이 파일만 비운다.
 *
 * **주소의 개수는 그 ADR 에서 가져오지 않는다.** adr/0009 는 auth 분리 전(2026-09-11)에
 * 쓰여 "member·board 두 개" 로 적혀 있다. 셋이 된 것은 adr/0012 가 auth 를 떼어낸
 * 뒤이고, 지금 주소를 정하는 것은 api-contract.md §1 의 경로 표다.
 */
export type ServiceName = 'auth' | 'member' | 'board';

const BASE: Record<ServiceName, string> = {
  auth: import.meta.env.VITE_AUTH_BASE_URL ?? '',
  member: import.meta.env.VITE_MEMBER_BASE_URL ?? '',
  board: import.meta.env.VITE_BOARD_BASE_URL ?? '',
};

/** proxy 모드에서는 모든 주소가 빈 문자열(같은 오리진)이 되어 Vite 프록시를 탄다. */
const PROXY_MODE = import.meta.env.VITE_API_MODE === 'proxy';

const PREFIXES: Array<[string, ServiceName]> = [
  ['/api/v1/auth', 'auth'],
  ['/api/v1/accounts', 'auth'],
  ['/api/v1/members', 'member'],
  ['/api/v1/posts', 'board'],
  ['/api/v1/comments', 'board'],
];

/** 경로가 어느 서비스의 것인지. 접두어가 없으면 null 이다 — 추측하지 않는다. */
export function serviceOf(path: string): ServiceName | null {
  for (const [prefix, service] of PREFIXES) {
    if (path.startsWith(prefix)) return service;
  }
  return null;
}

/**
 * 경로에 붙일 베이스 URL.
 *
 * 접두어를 모르는 경로는 던진다. 조용히 한 서비스로 보내면 404 나 CORS 오류가
 * 엉뚱한 서비스에서 나고, 원인을 경로 오설정이 아니라 그 서비스의 장애로 읽게 된다.
 */
export function baseUrlFor(path: string): string {
  if (PROXY_MODE) return '';
  const service = serviceOf(path);
  if (service === null) {
    throw new Error(`서비스 접두어를 모르는 경로다: ${path}`);
  }
  return BASE[service];
}

export const apiMode = PROXY_MODE ? 'proxy' : 'direct';
export const serviceBaseUrls = BASE;
