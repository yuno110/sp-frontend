# 이 저장소

`sp-frontend`다. **백엔드 확인용 화면**이다 — `sp-auth`·`sp-member`·`sp-board` 세 서비스가 실제로 엮여 도는지 브라우저에서 보기 위한 것이고, 사용자에게 내보낼 제품 화면이 아니다. 포트는 **3000**이다.

> **2026-10-20에 제품 화면으로 승격할 예정이다.** 그때 `sp-docs/overview.md` §1·§3.3의 "프론트엔드 화면 범위 제외"와 `security.md` §1.1의 "프론트엔드가 없는 JSON API" 서술을 함께 고친다. 승격 전까지는 그 문장들이 참이다.

## 행동 원칙

`sp-auth`·`sp-member`·`sp-board`의 `AGENTS.md`와 **같은 원칙을 따른다.** 그 파일을 이 저장소에 복제하지 않는다 — 그 파일의 머리글이 "세 저장소에 같은 내용으로 둔다"고 적고 있어서, 네 번째 사본을 두면 그 문장이 거짓이 된다. 원칙이 필요하면 `../sp-auth/AGENTS.md`를 읽는다.

특히 이 저장소에서 자주 걸리는 것:

- **불변식 4 — 단일 진실 원천.** 엔드포인트·필드명·에러 코드·페이징 키는 `sp-docs`에서만 가져온다. **`jworksuite6`의 타입을 베끼지 않는다** — 저쪽은 게시판 엔터티(`brdId`)·비밀글·첨부·`ROLE_MANAGER`가 있는 다른 도메인이다
- **불변식 9 — 실패 은폐 금지.** 에러를 토스트 한 줄로 뭉개지 않는다. 서버가 보낸 `code`·`message`·`fieldErrors`를 그대로 보여준다. 이 저장소의 목적이 **무엇이 왔는지 보는 것**이다
- **불변식 2 — YAGNI.** 확인에 필요 없는 것을 넣지 않는다(다국어, 에디터, 차트, 그리드, 테마 분기)

## 정본 문서

정본은 **문서 저장소** `yuno110/sp-docs`에 있다. 이 저장소에는 정본을 두지 않는다.

| 무엇 | 어디 |
| --- | --- |
| 엔드포인트·요청/응답·에러 코드 | `sp-docs/api-contract.md` |
| 입력 제약(길이·범위) | `sp-docs/requirements/board.md` §4, `requirements/member.md` §2 |
| CORS·토큰 수명·판정 위치 | `sp-docs/security.md` |
| 서비스 주소 | `sp-docs/api-contract.md` §1 |

**구현 중에 정본이 틀렸다고 판단되면 고치지 말고 보고한다.** 이 저장소는 정본의 소비자다.

## 기술 스택

`jworksuite6/frontend/react`의 스택을 참고해 맞췄다. Vite 7 · React 19 · TypeScript 5.9 · Tailwind **v4**(`@tailwindcss/postcss`) · react-router 7 · TanStack Query 5 · axios · zustand · vitest. 패키지 매니저는 **pnpm**이다.

가져온 것은 **시맨틱 토큰 어휘**(`bg-elev`·`bg-subtle`·`text-muted`·`text-faint`)와 통신 골격(요청에 토큰 주입 → 401에 재발급 → 원요청 1회 재시도)이다. 가져오지 않은 것은 `@jwork/grid`·`@jwork/tree`(저장소 밖 `file:` 의존성이라 독립 클론이 깨진다), i18n, tiptap, 차트, 테마 네 벌이다.

> **선 색에 전경 토큰 이름을 쓰지 않는다.** Tailwind v4는 `--color-default` 하나에서 `text-default`와 `border-default`를 **둘 다** 만든다. 그래서 전경에 `--color-default`를 두고 선에도 `border-default`를 쓰려 하면 같은 변수를 공유한다. 선 색은 `--color-line`·`--color-line-soft`로 따로 두고 `border-line`을 쓴다. **전경의 `--color-default`(`text-default`)는 그대로 쓴다** — 금지하는 것은 선 쪽의 이름 공유뿐이다.
>
> **첫 판은 선 색에도 `--color-border-default`를 두고 커스텀 `@utility border-default`로 이름을 짧게 만들었다. 그 유틸리티와 색 유틸리티의 선언이 겹쳐 나중 것(전경색)이 이겼고, 모든 테두리가 글자색으로 칠해졌다** — 빌드 CSS에서 `border-color`가 두 번 선언된 규칙을 찾아 측정한 결함이다. 지금은 `@utility`를 쓰지 않으므로 이 저장소에 그 충돌이 없다.
>
> **그래도 `.border-default`는 빌드 결과에 남아 있다.** Tailwind v4가 콘텐츠를 자동 탐색하면서 **이 문서의 산문까지** 후보로 읽기 때문이다 — 마크업에는 `border-default`가 0건인데 경고문 자신이 그 유틸리티를 만들어 냈다. 쓰이지 않으므로 런타임 영향은 없다.

## 서비스 주소와 CORS

**브라우저가 세 주소를 직접 호출한다.** 1차에는 게이트웨이가 없다(`sp-docs/adr/0009`).

| 경로 | 서비스 | 주소 |
| --- | --- | --- |
| `/api/v1/auth/**`·`/api/v1/accounts/**` | auth | `:8083` |
| `/api/v1/members/**` | member | `:8081` |
| `/api/v1/posts/**`·`/api/v1/comments/**` | board | `:8082` |

이 맵은 `src/lib/api/services.ts` **한 곳에만** 둔다. `adr/0009`가 "§1의 경로 표는 2차 전환 시 게이트웨이 라우팅 규칙의 명세가 된다"고 적었으므로, 게이트웨이가 생기면 이 파일만 비운다.

- **포트를 3000에서 바꾸지 않는다.** 세 서비스의 `cors.allowed-origins`가 `http://localhost:3000`이다. 바꾸면 세 곳의 `application-local.yml`을 함께 고쳐야 한다
- **직접 호출이 기본이다.** `VITE_API_MODE=proxy`는 비상구이고, 그 모드에서는 preflight가 날아가지 않아 **CORS 설정이 검증되지 않는다**. `security.md` §1.1이 "board의 `PUT`이 허용 메서드에서 빠진 결함이 프론트엔드가 없어 살아남았다"고 적은 그 구멍이다
- `/internal/v1/**`은 **호출하지 않는다.** 서비스 간 전용이고 외부 노출 금지다(`api-contract.md` §5)

## 경계

- **인가를 프론트에서 판정하지 않는다.** `RequireToken`과 버튼 숨김은 화면 전환을 줄이는 편의일 뿐이고, 판정은 서버가 한다(`security.md` §5.1). 토큰의 `role`을 읽는 것도 표시 목적이다 — 서명을 검증하지 않는다
- **개인키를 두지 않는다.** 공개키도 필요 없다 — 이 저장소는 토큰을 검증하지 않는다
- **비밀 값을 커밋하지 않는다.** `.env`는 세 서비스의 로컬 주소뿐이라 비밀이 아니고 커밋한다. 비밀이 생기면 `.env.local`(gitignore됨)에 둔다
- 토큰은 **sessionStorage**에 둔다. 새로고침은 살아남고 탭을 닫으면 사라진다

## 작업 규칙

- 순서: 구현 → 테스트 → `pnpm typecheck` → `pnpm test:run` → `pnpm build` → **`git add -A`** → 리뷰 → 커밋
- **리뷰를 통과하기 전에 커밋·푸시하지 않는다.** 리뷰가 게이트다
- **실패하는 테스트를 건너뛰거나 단언을 약화하지 않는다**
- 테스트가 0건 통과·전부 통과로 나오면 **변이를 넣어 실패하는지 먼저 확인한다**(`sp-docs/process/review-policy.md` §4.1). 통과는 패턴이 틀려도 나온다
