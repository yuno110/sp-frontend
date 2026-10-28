/**
 * 에러 코드 사전. 정본은 sp-docs/api-contract.md §8 이다 — 코드를 더하거나 빼면 아래의 코드 표와
 * errorCodes.test.ts 의 코드 목록을 함께 고친다.
 */

/** 복구 동작. 화면이 그곳으로 가는 링크를 붙인다(components/ui.tsx). */
export type Recovery = 'profile' | 'login';

export interface Sentence {
  text: string;
  recovery?: Recovery;
}

/**
 * **사용자에게 보여줄 문장.** 화면은 서버의 `message` 대신 이것을 쓰고 코드는 보조 정보로 남긴다
 * (lib/api/client.ts 의 `describeError`). 서버의 `message` 는 코드마다 하나로 정해져 있어(§8) 코드가 남으면
 * 잃는 것이 없다.
 *
 * 문장은 사용자 말로 쓴다 — 서비스 이름·경로·상태 코드·필드 이름을 쓰지 않는다(sp-docs/plan/phase2.md §7.2 F-03).
 */
export const ERROR_SENTENCES: Record<string, Sentence> = {
  C001: { text: '입력한 내용을 확인해 주세요.' },
  C002: { text: '주소나 입력한 값의 형식이 올바르지 않습니다.' },
  C003: { text: '지원하지 않는 요청입니다.' },
  C004: { text: '요청한 내용을 찾을 수 없습니다.' },
  C005: { text: '서버에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' },
  C006: { text: '지원하지 않는 형식의 요청입니다.' },
  C007: { text: '요청한 형식으로 응답할 수 없습니다.' },
  A001: { text: '로그인이 필요합니다.', recovery: 'login' },
  A002: { text: '로그인 정보가 올바르지 않습니다. 다시 로그인해 주세요.', recovery: 'login' },
  A003: { text: '로그인이 만료되었습니다. 다시 로그인해 주세요.', recovery: 'login' },
  A004: { text: '이 작업을 할 권한이 없습니다.' },

  // `M001` 의 기본 뜻은 §8.2 의 메시지 그대로다. "프로필이 아직 없음" 으로 쓰는 엔드포인트는 그 뜻을 넘긴다(아래 MY_PROFILE).
  M001: { text: '프로필을 찾을 수 없습니다.' },
  M003: { text: '이미 사용 중인 닉네임입니다.' },
  M006: { text: '이미 프로필이 등록되어 있습니다.' },
  M007: { text: '탈퇴한 프로필은 다시 등록할 수 없습니다.' },

  P001: { text: '게시글을 찾을 수 없습니다. 삭제되었을 수 있습니다.' },
  P002: { text: '이 게시글을 수정하거나 삭제할 권한이 없습니다.' },
  CM001: { text: '댓글을 찾을 수 없습니다. 삭제되었을 수 있습니다.' },
  CM002: { text: '이 댓글을 수정하거나 삭제할 권한이 없습니다.' },
  S001: { text: '일시적인 문제로 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.' },
  S002: { text: '글과 댓글을 쓰려면 프로필을 먼저 등록해야 합니다.', recovery: 'profile' },

  AU001: { text: '계정을 찾을 수 없습니다. 탈퇴한 계정일 수 있습니다.' },
  AU002: { text: '이미 사용 중인 이메일입니다.' },
  AU003: { text: '이메일 또는 비밀번호가 일치하지 않습니다.' },
  AU004: { text: '현재 비밀번호가 일치하지 않습니다.' },
};

/**
 * 같은 코드가 엔드포인트마다 다른 뜻을 갖는 자리. 그 엔드포인트를 부른 화면이 `describeError` 에 넘긴다 —
 * 뜻은 api-contract.md 가 정한다. 넘기지 않은 자리는 `ERROR_SENTENCES` 의 기본 뜻을 쓴다.
 */
export type Meanings = Record<string, Sentence>;

/**
 * `GET /api/v1/members/me` — 404 `M001` 은 오류가 아니라 "가입 3단계가 아직" 이고 클라이언트는 프로필 등록으로
 * 보낸다(api-contract.md §3). **남의 프로필 조회(`GET /members/{accountId}`)의 `M001` 은 이 뜻이 아니다** — 그
 * 회원의 프로필이 없다는 것이다(§3.1).
 */
export const MY_PROFILE: Meanings = {
  M001: { text: '아직 프로필을 등록하지 않았습니다.', recovery: 'profile' },
};

/**
 * 계정 탈퇴가 끝난 뒤의 로그인 만료 — 다시 로그인하라고 안내하지 않는다. 탈퇴한 계정은 로그인도 재발급도 되지 않는다
 * (api-contract.md §2.1 의 `account.deleted` 검사, §2.2 의 Refresh Token 삭제). 로그인 화면이 탈퇴를 마치지 못한 사실과
 * 함께 쓰고(pages/LoginPage.tsx), 마이페이지의 탈퇴 칸이 계정 탈퇴가 끝난 동안 쓴다 — 재발급이 응답하지 못하면 토큰이 남아
 * 그 화면에 머문다(pages/MyPage.tsx). 그 자리의 실패는 401 복구가 끝내지 못한 요청이다 — 복구하는 코드는 `A003` 이다
 * (lib/api/client.ts).
 */
export const AFTER_WITHDRAWAL: Meanings = {
  A003: { text: '로그인이 만료되었습니다.' },
};

/** 응답이 아예 없는 실패 — 연결 거부·CORS 거부·타임아웃. 업무 오류와 다른 문장이다. */
export const NO_RESPONSE = '서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.';

/** 오류 응답의 모양이 아닌 실패 — 본문 없는 응답, 계약에 없는 응답, 화면 쪽 예외. */
export const UNEXPECTED = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';

/*
 * 개발 빌드의 요청 기록 패널이 붙이는 설명 — **어느 서비스에서 난 코드인지**와 짧은 설명이다. 접두어로
 * 서비스를 식별하는 것은 §8 의 마지막 문장이 정한 규칙이다. 사용자에게 보이지 않는다.
 */
export type CodeOwner = '공통' | 'auth' | 'member' | 'board';

export interface CodeInfo {
  owner: CodeOwner;
  status: number;
  note: string;
}

export const ERROR_CODES: Record<string, CodeInfo> = {
  C001: { owner: '공통', status: 400, note: '잘못된 입력값. fieldErrors 를 본다' },
  C002: { owner: '공통', status: 400, note: '잘못된 타입' },
  C003: { owner: '공통', status: 405, note: '지원하지 않는 메서드' },
  C004: { owner: '공통', status: 404, note: '리소스 없음' },
  C005: { owner: '공통', status: 500, note: '서버 내부 오류' },
  C006: { owner: '공통', status: 415, note: '지원하지 않는 미디어 타입' },
  C007: { owner: '공통', status: 406, note: '응답할 수 있는 형식 없음' },
  A001: { owner: '공통', status: 401, note: '자격증명 미제시 (헤더 없음·다른 스킴·b64token 문법 위반)' },
  A002: { owner: '공통', status: 401, note: '유효하지 않은 토큰 (사유를 가르지 않는다)' },
  A003: { owner: '공통', status: 401, note: '만료된 토큰 — 재발급 대상' },
  A004: { owner: '공통', status: 403, note: '권한 없음' },

  AU001: { owner: 'auth', status: 404, note: '계정 없음' },
  AU002: { owner: 'auth', status: 409, note: '이미 사용 중인 이메일' },
  AU003: { owner: 'auth', status: 401, note: '이메일 또는 비밀번호 불일치 (누락·빈 값도 여기다)' },
  AU004: { owner: 'auth', status: 400, note: '현재 비밀번호 불일치' },

  M001: { owner: 'member', status: 404, note: '프로필 없음 — 오류가 아니라 가입 3단계 미완료' },
  M003: { owner: 'member', status: 409, note: '이미 사용 중인 닉네임' },
  M006: { owner: 'member', status: 409, note: '이미 프로필이 등록된 계정' },
  M007: { owner: 'member', status: 409, note: '탈퇴한 프로필' },

  P001: { owner: 'board', status: 404, note: '게시글 없음 (삭제된 글도 여기다)' },
  P002: { owner: 'board', status: 403, note: '게시글 권한 없음' },
  CM001: { owner: 'board', status: 404, note: '댓글 없음' },
  CM002: { owner: 'board', status: 403, note: '댓글 권한 없음' },
  S001: { owner: 'board', status: 503, note: 'member 연동 실패 — 경보 대상. 조회·수정·삭제는 영향 없다' },
  S002: { owner: 'board', status: 403, note: '프로필 등록이 필요하다 (가입 3단계 미완료)' },
};

export function describeCode(code: string | null | undefined): CodeInfo | null {
  if (!code) return null;
  return ERROR_CODES[code] ?? null;
}
