# sp-frontend

이 프로젝트의 **프론트엔드 화면**이다. `sp-auth`·`sp-member`·`sp-board` 세 서비스를 호출하는 클라이언트이고, 서비스가 아니다.

> 2026-10-20에 확인용 도구로 시작해 같은 날 **제품 화면으로 승격됐다**(`sp-docs/plan/phase1.md` D-08·D-09). **분류가 바뀐 것이고 코드가 바뀐 것이 아니다** — 아직 제품 수준이 아닌 자리는 아래 「한계」가 가리키는 목록에 있다.

## 띄우기

세 서비스가 먼저 떠 있어야 한다. MySQL과 `application-local.yml`은 각 저장소의 `CLAUDE.md`를 본다.

```bash
# 세 서비스 (각자 다른 터미널)
cd ../sp-auth   && ./gradlew bootRun --args='--spring.profiles.active=local'   # :8083
cd ../sp-member && ./gradlew bootRun --args='--spring.profiles.active=local'   # :8081
cd ../sp-board  && ./gradlew bootRun --args='--spring.profiles.active=local'   # :8082

# 화면
pnpm install
pnpm dev        # http://localhost:3000
```

**포트 3000을 바꾸지 않는다.** 세 서비스의 `cors.allowed-origins`가 그 값이다.

| 스크립트 | |
| --- | --- |
| `pnpm dev` | 개발 서버 (:3000) |
| `pnpm typecheck` | 타입 검사 |
| `pnpm test:run` | 단위 테스트 |
| `pnpm build` | 프로덕션 빌드 |
| `pnpm test:e2e` | 브라우저 테스트 — 프로덕션 빌드를 :3000 에 띄우고 API 는 스텁으로 답한다. 세 서비스는 띄우지 않고, 3000 번이 비어 있어야 한다 |
| `pnpm test:e2e:live` | 실제 서비스와의 브라우저 테스트 — 세 서비스를 먼저 띄운다. 프로덕션 빌드를 직접 모드로 :3000 에 띄우고 화면 흐름을 처음부터 끝까지 밟는다. 3000 번이 비어 있어야 하고, 실행마다 데이터가 남는다(아래 「실제 서비스와의 e2e」) |

## 화면

| 경로 | 무엇을 보는가 |
| --- | --- |
| `/signup` | **가입** — 사용자는 계정 정보와 닉네임을 내고, 화면이 계정(auth) → 로그인(auth) → 프로필(member) 순서로 부른다. 두 서비스가 `sub`로 이어지는 자리 |
| `/login` | 로그인. 누락·빈 값·형식 오류도 **401 `AU003`**이다 (400이 없다) |
| `/posts` | 목록·검색·정렬·페이징. 무인증으로 열려 있다 |
| `/posts/:id` | 상세 + 댓글. 상세에만 `content`가 있다 |
| `/posts/new` | **작성 — board가 member 내부 API를 호출하는 유일한 경로** |
| `/posts/mine` | 내가 쓴 글. 조회 키는 쿼리 파라미터가 아니라 JWT `sub` |
| `/me` | 마이페이지. **한 화면에 두 서비스가 필요하다** — 이메일·가입일은 auth, 닉네임은 member |
| `/members/:accountId` | 작성자 프로필. 탈퇴한 프로필도 **200**이고 `nickname`이 `"탈퇴한 회원"`이다 |
| `/tokens` | **개발 빌드에서만 있다.** `A001`·`A002`·`A003`의 경계를 눈으로 본다. 프로덕션 빌드에서는 목록으로 간다 |

개발 빌드(`pnpm dev`)에서는 화면 아래 **요청 기록** 패널이 요청마다 서비스·상태·에러 코드·`fieldErrors`를 남긴다(재발급 왕복도 남는다). **이것은 개발자 패널이고 제품 화면이 사용자에게 보여줄 것이 아니다** — 프로덕션 빌드(`pnpm build`)에는 패널이 없고 기록도 모으지 않는다(`sp-docs/plan/phase2.md` §7.1, `F-01`). 정본을 인용하는 안내문과 토큰 claim(`sub`·`role`·`exp`) 표시, 오류 응답의 모양이 아닌 실패의 원문도 개발 빌드에서만 보인다.

## 직접 확인해 볼 수 있는 것

**member를 내려 보는 것.** `sp-member`만 끄고 글을 쓰면 **503 `S001`**이고, 조회·수정·삭제는 계속 된다. `adr/0012`가 비용으로 수용한 동작이다. **`pnpm test:e2e:live` 는 이 흐름을 자동화하지 않는다** — 테스트가 서비스를 내리고 올리는 것은 그 항목의 범위를 넘는다(`sp-docs/plan/phase2.md` §7.2 `F-06`). 손으로 본다.

1. 세 서비스와 화면을 띄우고(「띄우기」) 로그인한다. 글을 하나 써 둔다
2. `sp-member` 를 띄운 터미널에서 그것만 끈다
3. 새 글을 등록한다 — 글이 만들어지지 않고, 화면이 `S001` 의 문장(`src/lib/api/errorCodes.ts`)과 코드 `S001` 을 보인다. 써 둔 글에 댓글을 등록해도 같다 — member 를 부르는 동작은 글·댓글 생성이다(`sp-docs/api-contract.md` §4.2)
4. 써 둔 글을 목록에서 열어 수정하고 지운다 — 둘 다 된다
5. `sp-member` 를 다시 띄운다

**프로필 없이 글을 쓰는 것.** 가입 1단계만 끝낸 계정으로 작성하면 **403 `S002`**다. 1단계만 끝난 상태는 정상이고, 로그인·탈퇴는 된다.

**닉네임을 바꾸는 것.** 과거 글의 작성자 이름이 바뀌지 않는다 — 스냅샷이고 의도된 동작이다(`adr/0003`).

## 실제 서비스와의 e2e

`pnpm test:e2e:live` 가 세 서비스와 함께 화면 흐름을 처음부터 끝까지 밟는다(`sp-docs/plan/phase2.md` §7.2 `F-06` 의 검증 표). 흐름은 `e2e/live/flows.spec.ts` 에, 설정은 `playwright.live.config.ts` 에 있다.

1. MySQL 과 세 서비스를 `local` 프로파일로 띄운다(「띄우기」). **테스트는 서비스를 띄우지도 내리지도 않는다**
2. 3000 번을 비운다 — 개발 서버를 띄워 두었으면 내린다. 테스트가 프로덕션 빌드를 만들어 3000 번에 띄우고 끝나면 내린다
3. `pnpm test:e2e:live`

- **직접 모드로 빌드한다.** `.env.local` 이 `VITE_API_MODE=proxy` 로 바꿔 두어도 이 실행은 직접 모드다 — 프록시 모드는 같은 오리진이라 preflight 가 날아가지 않고, 그러면 CORS 를 보지 못한다
- 흐름은 하나씩 돈다. 흐름마다 화면으로 가입해 자기 계정을 만들고 끝에 화면으로 탈퇴한다. 이메일과 닉네임이 실행마다 달라 같은 스위트를 다시 돌릴 수 있다
- 흐름이 실패하면 그 흐름의 trace 가 `test-results/` 에 남는다

### e2e 가 남긴 데이터

**실행마다 행이 남는다.** 탈퇴와 삭제는 계정·프로필·글·댓글의 행을 지우지 않는다 — 계정·프로필은 탈퇴 표시로, 글·댓글은 삭제 표시로 남는다. 중간에 실패한 흐름은 탈퇴하지 못한 계정과 그 프로필·Refresh Token, 지우지 못한 글·댓글을 남긴다. **테스트는 DB 를 직접 지우지 않는다** — 정리는 사람이 아래 절차로 한다.

e2e 가 만든 계정은 **이메일이 `e2e-live-` 로 시작한다**(`e2e/live/flows.spec.ts` 의 `EMAIL_PREFIX`). 이 접두어와 ADMIN seed 가드로만 고른다.

- **`DROP`·`TRUNCATE`·스키마 변경을 쓰지 않는다.** 아래 조건에 맞는 행만 `DELETE` 한다
- **ADMIN seed 는 `account.id = 1` 이고 그 프로필은 `member.account_id = 1` 이다.** 모든 문장에 `<> 1` 가드를 둔다 — 접두어가 ADMIN 을 빼더라도 가드를 지우지 않는다
- **지우기 전에 같은 조건으로 `SELECT` 한다.** 고른 행이 e2e 의 것인지 눈으로 본다
- **e2e 가 아닌 계정의 데이터가 얽혀 있으면 멈추고 묻는다.** e2e 글에 다른 계정의 댓글이 있으면 그 글은 지워지지 않는다(`comment.post_id` 의 FK). 다른 계정의 글에 e2e 댓글이 있으면 그 댓글을 지운 뒤 그 글의 `comment_count`(비정규화 값)가 맞지 않을 수 있다. 1단계의 멈출 조건이 모두 0건일 때만 2단계로 간다
- 로컬 프로파일은 세 스키마(`sp_auth`·`sp_member`·`sp_board`)가 같은 MySQL 에 있다(세 저장소 `application.yml` 의 `DB_URL` 기본값). 그래서 board·member 의 행을 `sp_auth.account` 의 이메일로 고른다. **순서는 board(댓글 → 글) → member → auth(Refresh Token → 계정)다** — 계정을 먼저 지우면 나머지를 고를 기준이 사라지고, 스키마 안의 FK(`comment.post_id`·`refresh_token.account_id`)가 그 순서를 요구한다

1단계 — 본다.

```sql
-- e2e 계정
SELECT id, email, deleted, created_at FROM sp_auth.account
 WHERE email LIKE 'e2e-live-%' AND id <> 1;

-- 멈출 조건: e2e 글에 달린 다른 계정의 댓글 — 0건이어야 한다
SELECT c.id, c.post_id, c.writer_id FROM sp_board.comment c
  JOIN sp_board.post p ON p.id = c.post_id
 WHERE p.writer_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1)
   AND c.writer_id NOT IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1);

-- 멈출 조건: 다른 계정의 글에 달린 e2e 댓글 — 0건이어야 한다
SELECT c.id, c.post_id, c.writer_id FROM sp_board.comment c
  JOIN sp_board.post p ON p.id = c.post_id
 WHERE c.writer_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1)
   AND p.writer_id NOT IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1);

-- 지울 행의 수 — 2단계의 문장 순서와 같다
SELECT COUNT(*) FROM sp_board.comment
 WHERE writer_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND writer_id <> 1;
SELECT COUNT(*) FROM sp_board.post
 WHERE writer_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND writer_id <> 1;
SELECT COUNT(*) FROM sp_member.member
 WHERE account_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND account_id <> 1;
SELECT COUNT(*) FROM sp_auth.refresh_token
 WHERE account_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND account_id <> 1;
SELECT COUNT(*) FROM sp_auth.account
 WHERE email LIKE 'e2e-live-%' AND id <> 1;
```

2단계 — 지운다. 한 트랜잭션으로 돌리고, **문장마다 지운 행의 수가 1단계의 수와 같을 때만 `COMMIT;` 을 친다.** 하나라도 다르거나 오류가 나면 `ROLLBACK;` 하고 1단계로 돌아간다. 아래 묶음은 `COMMIT` 앞에서 멈춘다.

```sql
START TRANSACTION;
DELETE FROM sp_board.comment
 WHERE writer_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND writer_id <> 1;
DELETE FROM sp_board.post
 WHERE writer_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND writer_id <> 1;
DELETE FROM sp_member.member
 WHERE account_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND account_id <> 1;
DELETE FROM sp_auth.refresh_token
 WHERE account_id IN (SELECT id FROM sp_auth.account WHERE email LIKE 'e2e-live-%' AND id <> 1) AND account_id <> 1;
DELETE FROM sp_auth.account
 WHERE email LIKE 'e2e-live-%' AND id <> 1;
-- 여기서 멈춘다. 지운 수를 1단계와 맞춰 본 뒤 COMMIT; — 다르면 ROLLBACK;
```

## 한계

- **제품 수준이 아닌 자리가 있다.** 무엇이 비어 있는지는 `CLAUDE.md` 의 「제품으로서 비어 있는 것」이 적는다 — **여기에 옮겨 적지 않는다.** 그것을 받는 자리는 `sp-docs/plan/phase2.md` §7 의 `F-xx` 다(배포 오리진은 같은 문서 §2)
- **만료 토큰을 이 화면에서 만들 수 없다.** 개인키로 서명해야 하고 그 키는 이 저장소에 없다. `/tokens`는 `A001`·`A002`만 재현한다. "만료 + claim 계약 위반이 겹칠 때 member는 `A002`, auth·board는 `A003`"(`api-contract.md` §8.5의 `D-05` 실측)은 서버 쪽에서 서명한 토큰으로 측정한 것이고 여기서 재현되지 않는다
- 단위 테스트가 덮는 것은 서비스 주소 배정, 검색 파라미터 조합 규칙, 에러 표시가 `fieldErrors`를 버리지 않는지, 화면마다 보이는 문구가 내부 구조를 설명하지 않는지(검사 목록과 그 양성 대조), 에러 코드마다 사용자 문장이 있고 코드가 보조 정보로 남는지, 복구 안내와 같은 코드의 다른 뜻을 따르는지, 사전에 없는 코드와 응답 없음을 어떻게 보이는지, 필드 오류가 입력칸 옆이나 요약에 남는지, 글 수정 폼이 화면이 열린 뒤 받은 글로 입력칸을 한 번만 채워 다시 받은 값이 입력을 덮지 않는지, 보호된 화면에서 세션이 끝나거나 새로고침 복원이 실패해 로그인으로 가면 그 실패를 로그인 화면이 한 번 이어 보이는지, 가입이 계정 → 로그인 → 프로필 순서로 부르고 로그인이 실패하면 로그인 화면이 계정을 만들었다는 것과 그 실패를 보이는지, 로그인 요청 뒤에 비밀번호를 저장소·스토어·캐시·주소 기록에 남기지 않는지, 비밀번호를 싣는 요청의 실패를 화면과 스토어가 요청 본문 없이 쥐는지, 프로필을 등록하면 머리글이 그 닉네임을 보이는지, 프로필 등록 화면이 새로고침 복원이 끝날 때까지 그려지지 않는지, 탈퇴가 계정 → 프로필 순서로 부르고 첫 단계가 실패하면 둘째를 부르지 않는지, 둘째의 `M001` 을 끝난 것으로 보는지, 둘째가 실패하면 첫 단계부터 다시 시도하게 하고 다시 시도할 수 없게 되면 그 사실을 보이는지, 계정 탈퇴 뒤의 실패가 다시 로그인하라고 하지 않는지, 서버에 알리지 않고 토큰만 지우는 버튼이 마이페이지에 없는지, 무인증 경로에 토큰을 붙이지 않는지, 개발 전용 표시가 프로덕션 모드에서 빠지는지, 영속 저장소에 Refresh Token 만 남고 로그아웃하면 비는지, 영속 저장소에 접근할 수 없으면 메모리로 동작하는지, 동시에 일어나는 재발급을 합치되 끝난 재발급은 다시 쓰지 않는지, 새로고침 뒤 그것이 끝날 때까지 보호된 경로만 판정을 미루는지, 재발급 실패가 4xx 거부이거나 accessToken 없는 응답일 때만 토큰을 비우고 그 사이 바뀐 토큰은 건드리지 않는지, 프로덕션 빌드에만 CSP 를 넣고 그 `connect-src` 를 빌드 환경값에서 만드는지, 입력칸의 이름이 라벨 글자뿐이고 안내와 오류가 그 입력칸의 설명으로 이어지는지, 브라우저 테스트의 라우트 목록이 라우터와 같은지다
- 브라우저 테스트(`pnpm test:e2e`)가 덮는 것은 개발 전용이 아닌 라우트마다 axe-core 의 serious·critical 위반이 없는지, 360px·640px 폭에서 가로 스크롤이 없는지, 그 두 폭에서 라벨 자리의 낱말이 줄에서 쪼개지지 않는지, 가입·로그인·글 작성을 키보드만으로 끝낼 수 있고 Tab 으로 옮긴 자리가 보이는지, CSP 위반이 콘솔에 나오지 않는지다. **API 는 스텁이다** — 세 서비스와 함께 도는지와 CORS 는 덮지 않고, 그것은 아래 `pnpm test:e2e:live` 가 덮는다
- 실제 서비스와의 브라우저 테스트(`pnpm test:e2e:live`)가 덮는 것은 가입이 한 흐름으로 프로필까지 만들고 로그인 상태인지, 새로고침 뒤 로그인 상태가 이어지는지, 글 작성 → 상세 → 수정 → 삭제와 댓글 작성 → 수정 → 삭제의 단계마다 화면에 반영되는지, 내 글에 방금 쓴 글이 보이는지, 닉네임을 바꿔도 과거 글의 작성자 이름이 그대로인지, 탈퇴가 한 동작으로 끝나고 로그인 상태가 아닌지, 로그아웃 뒤 보호된 경로가 로그인으로 가는지, 흐름마다 CSP 위반과 브라우저가 실패로 끝낸 요청과 서비스가 허용하지 않은 preflight 가 없는지, 세 서비스가 preflight 에 직접 답했고 board 가 글 수정의 `PUT` preflight 를 허용하는지다. **member 를 내린 `S001` 은 덮지 않는다**(「직접 확인해 볼 수 있는 것」). 화면의 오리진은 3000 번 하나다 — 배포 오리진은 아직 없다

정본은 전부 [`sp-docs`](https://github.com/yuno110/sp-docs)에 있다.
