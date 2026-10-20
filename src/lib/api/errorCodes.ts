/**
 * 에러 코드 사전. 정본은 sp-docs/api-contract.md §8 이다.
 *
 * 화면이 메시지를 다시 쓰지 않는다 — 서버가 보낸 `message` 를 그대로 보여주고
 * 이 표는 **어느 서비스에서 난 코드인지**와 짧은 설명만 붙인다. 접두어로 서비스를
 * 식별하는 것은 §8 의 마지막 문장이 정한 규칙이다.
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
