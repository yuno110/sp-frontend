import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listPosts } from './api';

const get = vi.fn();

vi.mock('@/lib/api/client', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
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
});
