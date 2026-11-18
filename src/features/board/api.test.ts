import { beforeEach, describe, expect, it, vi } from 'vitest';
import { likePost, listPosts, unlikePost } from './api';

const get = vi.fn();
const put = vi.fn();
const del = vi.fn();

vi.mock('@/lib/api/client', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    put: (...args: unknown[]) => put(...args),
    delete: (...args: unknown[]) => del(...args),
  },
  unwrap: async (p: Promise<unknown>) => p,
}));

/**
 * searchType 과 keyword 는 **둘 다 보내거나 둘 다 안 보낸다** — 한쪽만 오면 서버가
 * 400 C001 이다 (sp-docs/api-contract.md §4.1). 그리고 **공백만인 keyword 는 "없음"
 * 이다** — 정규화를 조합 검증보다 먼저 한다.
 *
 * 그 규칙을 화면마다 흩어 두면 한 화면만 어긋난다. 여기 한 자리에서 지킨다.
 */
describe('listPosts 의 검색 파라미터 조합', () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { success: true, data: null, error: null } });
  });

  const paramsOf = () => get.mock.calls[0][1].params as Record<string, unknown>;

  it('keyword 가 없으면 searchType 도 보내지 않는다', async () => {
    await listPosts({ page: 0, size: 10, sort: 'latest', searchType: 'TITLE' });
    expect(paramsOf()).toEqual({ page: 0, size: 10, sort: 'latest' });
  });

  it('공백만인 keyword 는 없음으로 본다 — 한쪽만 보내면 400 C001 이 된다', async () => {
    await listPosts({ page: 0, size: 10, sort: 'latest', searchType: 'TITLE', keyword: '   ' });
    expect(paramsOf()).toEqual({ page: 0, size: 10, sort: 'latest' });
  });

  it('searchType 이 없으면 keyword 도 보내지 않는다', async () => {
    await listPosts({ page: 0, size: 10, sort: 'latest', keyword: '공지' });
    expect(paramsOf()).toEqual({ page: 0, size: 10, sort: 'latest' });
  });

  it('둘 다 있으면 둘 다 보내고 keyword 는 trim 한다', async () => {
    await listPosts({ page: 1, size: 10, sort: 'views', searchType: 'WRITER', keyword: ' 홍길동 ' });
    expect(paramsOf()).toEqual({
      page: 1,
      size: 10,
      sort: 'views',
      searchType: 'WRITER',
      keyword: '홍길동',
    });
  });

  // category 는 검색·정렬과 AND 로 걸린다(§4.1). 주지 않으면 싣지 않는다 — 이 describe 의 다른 단언이 category 없이 불러 그 키가
  // 없는 객체와 견준다.
  it('category 가 있으면 검색·정렬과 함께 보낸다', async () => {
    await listPosts({ page: 2, size: 10, sort: 'views', searchType: 'TITLE', keyword: '점검', category: 'QNA' });
    expect(paramsOf()).toEqual({
      page: 2,
      size: 10,
      sort: 'views',
      searchType: 'TITLE',
      keyword: '점검',
      category: 'QNA',
    });
  });
});

/**
 * 좋아요 — `PUT` 이 누르고 `DELETE` 가 취소한다. 둘 다 본문이 없다(sp-docs/api-contract.md §4.6). 화면이 보낸 요청의 메서드와 본문은
 * src/pages/postLike.test.tsx 가 화면에서 다시 본다.
 */
describe('좋아요 요청', () => {
  beforeEach(() => {
    put.mockReset();
    del.mockReset();
  });

  it('누르기는 그 글의 like 경로로 PUT 이고 본문을 싣지 않는다', async () => {
    await likePost(12);
    expect(put.mock.calls).toEqual([['/api/v1/posts/12/like']]);
    expect(del).not.toHaveBeenCalled();
  });

  it('취소는 그 글의 like 경로로 DELETE 이고 본문을 싣지 않는다', async () => {
    await unlikePost(12);
    expect(del.mock.calls).toEqual([['/api/v1/posts/12/like']]);
    expect(put).not.toHaveBeenCalled();
  });
});
