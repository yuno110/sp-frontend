/**
 * board 도메인 타입. 정본은 sp-docs/api-contract.md §4 다.
 *
 * jworksuite6 의 `features/boards/api/types.ts` 를 베끼지 않았다 — 저쪽은 게시판 엔터티
 * (`brdId`·`boardType`)와 비밀글·고정글·첨부·`ROLE_MANAGER` 가 있는 **다른 도메인**이다.
 * 이 프로젝트에는 게시판이 하나이고 글·댓글만 있다.
 */

/**
 * 카테고리 — 값은 sp-docs/requirements/board.md §8 이 정한다. 공지(`NOTICE`)는 ADMIN 만 쓰고, 그 판정은 서버의 403 `P003` 이다 —
 * 화면이 공지 선택지를 가리는 것은 편의다.
 */
export type PostCategory = 'NOTICE' | 'FREE' | 'QNA';

/** 화면에 보이는 이름. 선언 순서가 탭과 선택지의 순서다. */
export const CATEGORY_LABEL: Record<PostCategory, string> = {
  NOTICE: '공지',
  FREE: '자유',
  QNA: '질문',
};

/** 목록 항목 — 키는 §4.3 의 목록 항목 줄이다. `content` 가 없다(본문 10,000자 × 50건 때문이다). */
export interface PostListItem {
  id: number;
  title: string;
  category: PostCategory;
  writerId: number;
  writerNickname: string;
  viewCount: number;
  commentCount: number;
  likeCount: number;
  createdAt: string;
}

/**
 * 상세 — 목록 항목의 키에 `content`·`liked` 를 더한 것. 쓰기 응답도 같은 모양이다(§4.4). §4.3 의 상세 키 가운데 `attachments` 는 이
 * 화면이 읽지 않으므로 두지 않는다.
 */
export interface PostDetail extends PostListItem {
  content: string;
  /**
   * 요청에 실린 Access Token 의 계정이 이 글을 눌렀는가. 토큰 없이 받았으면 `null` 이다 — 「누구인지 모른다」 이고 `false`(누르지
   * 않았다)와 다르다(§4.3).
   */
  liked: boolean | null;
}

/** 좋아요의 응답 — 그 요청 뒤의 상태다. `PUT` 이면 `liked` 가 언제나 `true`, `DELETE` 면 언제나 `false` 다(§4.6). */
export interface LikeState {
  liked: boolean;
  likeCount: number;
}

/** 댓글 — 목록·작성·수정이 같은 모양이다(§4.5). */
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
