import http, { unwrap } from '@/lib/api/client';
import type { ApiResponse, Page } from '@/lib/api/types';
import type {
  Comment,
  LikeState,
  PathId,
  PostCategory,
  PostDetail,
  PostListItem,
  PostSort,
  SearchType,
} from './types';

/** board-service. 정본은 sp-docs/api-contract.md §4 다. */

export interface PostListParams {
  page: number;
  size: number;
  sort: PostSort;
  searchType?: SearchType;
  keyword?: string;
  /** 없으면 모든 카테고리다 — 공지도 들어간다(§4.1). */
  category?: PostCategory;
}

/**
 * 목록·검색. 무인증으로 열려 있다(§4.2).
 *
 * `searchType` 과 `keyword` 는 **둘 다 있거나 둘 다 없어야 한다** — 한쪽만 보내면
 * 400 `C001` 이다(§4.1). 한쪽을 조용히 무시하면 검색이 걸린 줄 알고 전체 목록을 받는다.
 *
 * `category` 는 검색·정렬과 AND 로 걸린다(§4.1). 없으면 보내지 않는다.
 */
export function listPosts(params: PostListParams) {
  const query: Record<string, string | number> = {
    page: params.page,
    size: params.size,
    sort: params.sort,
  };
  const keyword = params.keyword?.trim();
  if (params.searchType && keyword) {
    query.searchType = params.searchType;
    query.keyword = keyword;
  }
  if (params.category) query.category = params.category;
  return unwrap(http.get<ApiResponse<Page<PostListItem>>>('/api/v1/posts', { params: query }));
}

/** 내가 쓴 글. `page`·`size`·`sort` 만 받는다 — 검색이 없다(§4.1). 조회 키는 JWT `sub` 다. */
export function listMyPosts(params: { page: number; size: number; sort: PostSort }) {
  return unwrap(http.get<ApiResponse<Page<PostListItem>>>('/api/v1/posts/me', { params }));
}

export function getPost(id: PathId) {
  return unwrap(http.get<ApiResponse<PostDetail>>(`/api/v1/posts/${id}`));
}

/**
 * 작성은 member 내부 API 호출을 거친다(§4.2) — 프로필이 없거나 탈퇴했으면 403 `S002`, 연동 실패는 503 `S001`. 공지를 ADMIN 이
 * 아닌 계정이 쓰면 403 `P003` 이고, 그 판정이 member 호출보다 먼저다(requirements/board.md §8).
 */
export function createPost(title: string, content: string, category: PostCategory) {
  return unwrap(http.post<ApiResponse<PostDetail>>('/api/v1/posts', { title, content, category }));
}

/**
 * 수정은 스냅샷을 갱신하지 않으므로 member 를 호출하지 않는다(§4.2). 카테고리가 공지로 바뀌거나 공지에서 바뀔 때만 ADMIN 을 요구한다 —
 * 지금 값을 그대로 보내면 그 판정을 거치지 않는다(requirements/board.md §8).
 */
export function updatePost(id: PathId, title: string, content: string, category: PostCategory) {
  return unwrap(
    http.put<ApiResponse<PostDetail>>(`/api/v1/posts/${id}`, { title, content, category }),
  );
}

export function deletePost(id: PathId) {
  return http.delete(`/api/v1/posts/${id}`);
}

/**
 * 좋아요 — `PUT` 이 누르고 `DELETE`(`unlikePost`)가 취소한다. 둘 다 멱등이고 본문이 없으며, 응답은 그 요청 뒤의 상태다(§4.6). 인증이
 * 필요하고 프로필은 필요 없다 — `S002` 가 나지 않는다. 없는·삭제된 글은 404 `P001` 이다.
 */
export function likePost(id: PathId) {
  return unwrap(http.put<ApiResponse<LikeState>>(`/api/v1/posts/${id}/like`));
}

export function unlikePost(id: PathId) {
  return unwrap(http.delete<ApiResponse<LikeState>>(`/api/v1/posts/${id}/like`));
}

/** 없는 게시글의 댓글 목록은 404 `P001` 이다 — 빈 페이지 200 이 아니다(§4.5). */
export function listComments(postId: PathId, params: { page: number; size: number }) {
  return unwrap(
    http.get<ApiResponse<Page<Comment>>>(`/api/v1/posts/${postId}/comments`, { params }),
  );
}

export function createComment(postId: PathId, content: string) {
  return unwrap(http.post<ApiResponse<Comment>>(`/api/v1/posts/${postId}/comments`, { content }));
}

export function updateComment(id: PathId, content: string) {
  return unwrap(http.put<ApiResponse<Comment>>(`/api/v1/comments/${id}`, { content }));
}

export function deleteComment(id: PathId) {
  return http.delete(`/api/v1/comments/${id}`);
}
