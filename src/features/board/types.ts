/**
 * board 도메인 타입. 정본은 sp-docs/api-contract.md §4 다.
 *
 * jworksuite6 의 `features/boards/api/types.ts` 를 베끼지 않았다 — 저쪽은 게시판 엔터티
 * (`brdId`·`boardType`)와 비밀글·고정글·첨부·`ROLE_MANAGER` 가 있는 **다른 도메인**이다.
 * 이 프로젝트에는 게시판이 하나이고 글·댓글만 있다.
 */

/** 목록 항목 — 일곱 키. `content` 가 없다(§4.3, 본문 10,000자 × 50건 때문이다). */
export interface PostListItem {
  id: number;
  title: string;
  writerId: number;
  writerNickname: string;
  viewCount: number;
  commentCount: number;
  createdAt: string;
}

/** 상세 — 목록의 일곱에 `content` 를 더한 것. 쓰기 응답도 같은 모양이다(§4.4). */
export interface PostDetail extends PostListItem {
  content: string;
}

/** 댓글 — 다섯 키 하나뿐이다. 목록·작성·수정이 같은 모양이다(§4.5). */
export interface Comment {
  id: number;
  writerId: number;
  writerNickname: string;
  content: string;
  createdAt: string;
}

/**
 * 경로 변수로 그대로 실어 보내는 식별자.
 *
 * **숫자로 좁히지 않는다.** URL 의 `/posts/abc` 를 화면이 미리 막으면 서버가 낼
 * **400 `C002`**(잘못된 타입의 값, api-contract.md §8.1)를 이 저장소로 한 번도 볼 수 없다.
 * 판정은 서버가 하고 화면은 그 답을 보여준다.
 */
export type PathId = number | string;

/** 화이트리스트 enum 이다 — 임의 컬럼명을 노출하지 않는다(§4.1). */
export type PostSort = 'latest' | 'views';

export type SearchType = 'TITLE' | 'CONTENT' | 'TITLE_CONTENT' | 'WRITER';

export const SEARCH_TYPE_LABEL: Record<SearchType, string> = {
  TITLE: '제목',
  CONTENT: '내용',
  TITLE_CONTENT: '제목+내용',
  WRITER: '작성자',
};

export const SORT_LABEL: Record<PostSort, string> = {
  latest: '최신순',
  views: '조회순',
};

/** 입력 제약 (sp-docs/requirements/board.md §4). */
export const TITLE_MAX = 200;
export const POST_CONTENT_MAX = 10_000;
export const COMMENT_CONTENT_MAX = 500;
export const PAGE_SIZE_MAX = 50;
