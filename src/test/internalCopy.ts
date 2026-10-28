/**
 * 사용자에게 내부 구조를 설명하는 문구를 잡는 검사 목록 (sp-docs/plan/phase2.md §7.2 F-03).
 *
 * 문구를 하나하나 열거하지 않고 **성질로** 잡는다(같은 절의 「범위는 성질로 정한다」). 패턴의 **갈래마다 표본을
 * 하나씩** 두고 패턴이 그것을 잡는지 본다(internalCopy.test.ts) — 갈래 하나를 지우거나 좁히면 그 표본이 빨개진다.
 * **API 필드 이름은 예외다** — 표본이 `API_FIELDS` 자신이라 패턴이 목록을 빠짐없이 엮는지만 본다. 목록에서 이름을
 * 지우면 표본도 함께 사라지므로, 목록이 정본의 필드를 다 갖는지는 정본과 대조해 본다.
 * 표본은 F-03 전 화면(개발 빌드 포함)에 있던 문구의 조각이고, 예전 화면에 없던 갈래는 리뷰가 든 예다. 아무것도
 * 잡지 못하는 패턴은 "걸리는 것이 없다" 를 패턴이 틀려도 낸다.
 *
 * **오류 코드는 보조 정보로 화면에 남는다**(AGENTS.md 불변식 9). 그 자리(`data-error-code`)만 검사에서 뺀다 —
 * 코드가 그 밖에 나오면 "에러 코드 체계의 설명" 으로 잡힌다.
 */

/** 정본이 정한 요청·응답 필드, 경로 변수, 토큰 claim 의 이름 (sp-docs/api-contract.md §2~§7·§9). */
const API_FIELDS = [
  // 공통 응답과 페이징 (§7·§7.1)
  'success', 'data', 'error', 'code', 'message', 'fieldErrors', 'field',
  'content', 'page', 'size', 'totalElements', 'totalPages', 'first', 'last',
  // auth (§2·§9)
  'accountId', 'email', 'password', 'currentPassword', 'newPassword', 'createdAt', 'available',
  'grantType', 'accessToken', 'refreshToken', 'accessTokenExpiresIn',
  // member (§3)
  'nickname', 'deleted',
  // board (§4)
  'id', 'postId', 'title', 'writerId', 'writerNickname', 'viewCount', 'commentCount',
  'sort', 'searchType', 'keyword',
  // claim (§6)
  'sub', 'role', 'iss', 'iat', 'exp',
];

export const INTERNAL_COPY: ReadonlyArray<{ name: string; pattern: RegExp; samples: string[] }> = [
  {
    name: '서비스 이름',
    pattern: /\b(?:auth|member|board)\b|(?:인증|회원|게시판|계정|프로필)\s?서비스/,
    samples: [
      '계정 — auth',
      '프로필 — member',
      'board — GET /api/v1/posts/me',
      '인증 서비스',
      '회원 서비스',
      '게시판 서비스',
      '계정서비스',
      '프로필 서비스',
    ],
  },
  {
    name: 'HTTP 메서드',
    pattern: /\b(?:GET|POST|PUT|PATCH|DELETE)\b/,
    samples: ['GET', 'POST', 'PUT', 'PATCH', '1단계 — DELETE'],
  },
  {
    name: 'API 경로',
    pattern: /\/(?:api|internal)\/v\d/,
    samples: ['POST /api/v1/accounts', '/internal/v1/members/bulk'],
  },
  {
    // 버전 접두어가 없는 경로 조각. 화면의 `/` 는 글자 수(`0 / 200`)와 쪽수(`1 / 3`)뿐이고 뒤가 공백이나 숫자다.
    name: '경로 조각',
    pattern: /\/[a-z][\w-]*/,
    samples: ['/accounts/me'],
  },
  {
    name: 'API 라는 말',
    pattern: /\bAPI\b/,
    samples: ['작성은 member 내부 API 를 먼저 호출한다'],
  },
  {
    // 숫자만으로는 글자 수 안내(`0 / 200`)와 가르지 못한다 — 코드나 서술이 앞뒤에 붙은 상태 코드를 잡는다.
    name: '상태 코드',
    pattern:
      /\b[1-5]\d{2}\s*(?:[A-Z]{1,2}\d{3}\b|다(?![가-힣])|오류|에러|응답|상태)|(?:오류|에러|응답|상태)\s*[1-5]\d{2}\b|\bHTTP\b/,
    samples: [
      '규칙 위반은 400 C001 로',
      '두 번 눌러도 204 다.',
      '404 오류',
      '404 에러',
      '200 응답',
      '500 상태',
      '오류 404',
      '에러 500',
      '응답 200',
      '상태 503',
      'HTTP',
    ],
  },
  {
    name: '에러 코드',
    pattern: /\b[A-Z]{1,2}\d{3}\b/,
    samples: ['M001 — 프로필이 없다.', 'AU003 이메일 또는 비밀번호가 일치하지 않습니다.'],
  },
  {
    name: '정본 문서',
    pattern: /[\w-]+\.md\b|§\s*\d|\badr\/\d+|정본/,
    samples: ['api-contract.md', '§1', 'adr/0003', '정본'],
  },
  {
    // 이 프로젝트의 저장소는 `sp-` 로 시작하고 `yuno110` 아래에 있다. 제품 이름은 「게시판」이다(CLAUDE.md).
    name: '저장소 이름',
    pattern: /\bsp-[a-z]+\b|\byuno110\b/,
    samples: ['sp-frontend', 'sp-docs', 'yuno110'],
  },
  {
    name: 'API 필드 이름',
    pattern: new RegExp(`\\b(?:${API_FIELDS.join('|')})\\b`),
    samples: [...API_FIELDS],
  },
  {
    name: 'camelCase 식별자',
    pattern: /\b[a-z]+(?:[A-Z][a-z\d]*)+\b/,
    samples: ['fieldErrors 에'],
  },
  {
    name: 'snake_case 식별자',
    pattern: /\b[a-z\d]+(?:_[a-z\d]+)+\b/,
    samples: ['created_at'],
  },
  { name: '응답 값', pattern: /\b(?:true|false|null)\b/, samples: ['true — 탈퇴한 회원', 'false', 'null'] },
  { name: '역할 상수', pattern: /\b(?:ADMIN|USER)\b/, samples: ['삭제 (ADMIN)', '7 / USER'] },
  {
    name: '토큰',
    pattern: /토큰|\b[Tt]oken\b|\bJWT\b|\bBearer\b/,
    samples: ['토큰 비우기 (로컬만)', 'Access Token', 'token', 'JWT', 'Bearer abc.def.ghi'],
  },
  {
    name: '설계 용어',
    pattern: /멱등|스냅샷|연동|\bclaim\b/,
    samples: ['멱등이라', '스냅샷된 닉네임이다', '연동 실패', 'claim 에'],
  },
  {
    name: '네트워크 설정',
    pattern: /\bCORS\b|오리진|프록시/,
    samples: ['CORS', '오리진이 맞는지', 'Vite 프록시 경유'],
  },
];

/** 읽어 주거나 마우스를 올리면 보이는 속성. */
const VISIBLE_ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];

/**
 * 화면에 보이는 문구 — 텍스트 노드와 위 속성값을 줄로 잇는다. 오류 코드 자리는 뺀다.
 *
 * 텍스트 노드를 하나씩 줄로 가른다 — `textContent` 로 이으면 이웃한 요소의 글자가 붙어 `\b` 가 사라진다.
 */
export function visibleCopy(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('[data-error-code]').forEach((el) => el.remove());
  const parts: string[] = [];
  const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) parts.push(node.nodeValue ?? '');
  for (const el of clone.querySelectorAll('*')) {
    for (const name of VISIBLE_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value) parts.push(value);
    }
  }
  return parts.join('\n');
}

/** 검사 목록에 걸린 것 — `[패턴 이름, 걸린 문자열]` 의 목록이다. 없으면 빈 배열이다. */
export function internalCopyIn(text: string): Array<[string, string]> {
  return INTERNAL_COPY.flatMap(({ name, pattern }) =>
    [...text.matchAll(new RegExp(pattern.source, 'g'))].map((m): [string, string] => [name, m[0]]),
  );
}
