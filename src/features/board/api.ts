import http, { unwrap } from '@/lib/api/client';
import type { ApiResponse, Page } from '@/lib/api/types';
import type { Comment, PathId, PostDetail, PostListItem, PostSort, SearchType } from './types';

/** board-service. 정본은 sp-docs/api-contract.md §4 다. */

export interface PostListParams {
  page: number;
  size: number;
  sort: PostSort;
  searchType?: SearchType;
  keyword?: string;
}

/**
 * 목록·검색. 무인증으로 열려 있다(§4.2).
 *
 * `searchType` 과 `keyword` 는 **둘 다 있거나 둘 다 없어야 한다** — 한쪽만 보내면
 * 400 `C001` 이다(§4.1). 한쪽을 조용히 무시하면 검색이 걸린 줄 알고 전체 목록을 받는다.
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
  return unwrap(http.get<ApiResponse<Page<PostListItem>>>('/api/v1/posts', { params: query }));
}

/** 내가 쓴 글. `page`·`size`·`sort` 만 받는다 — 검색이 없다(§4.1). 조회 키는 JWT `sub` 다. */
export function listMyPosts(params: { page: number; size: number; sort: PostSort }) {
  return unwrap(http.get<ApiResponse<Page<PostListItem>>>('/api/v1/posts/me', { params }));
}

export function getPost(id: PathId) {
  return unwrap(http.get<ApiResponse<PostDetail>>(`/api/v1/posts/${id}`));
}

/** 작성에만 member 내부 API 호출이 끼어든다 — 프로필이 없으면 403 `S002`, 연동 실패는 503 `S001`. */
export function createPost(title: string, content: string) {
  return unwrap(http.post<ApiResponse<PostDetail>>('/api/v1/posts', { title, content }));
}

/** 수정은 스냅샷을 갱신하지 않으므로 member 를 호출하지 않는다(§4.2). */
export function updatePost(id: PathId, title: string, content: string) {
  return unwrap(http.put<ApiResponse<PostDetail>>(`/api/v1/posts/${id}`, { title, content }));
}

export function deletePost(id: PathId) {
  return http.delete(`/api/v1/posts/${id}`);
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
