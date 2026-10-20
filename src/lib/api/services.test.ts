import { describe, expect, it } from 'vitest';
import { baseUrlFor, serviceOf } from './services';

/**
 * 경로 → 서비스 배정 (sp-docs/api-contract.md §1).
 *
 * 이 맵이 틀리면 요청이 엉뚱한 포트로 가고, 그 결과(404·CORS 거부)를 **그 서비스의
 * 장애로 읽게 된다.** 그래서 접두어를 모르는 경로는 조용히 넘기지 않고 던진다.
 */
describe('serviceOf', () => {
  it.each([
    ['/api/v1/auth/login', 'auth'],
    ['/api/v1/auth/reissue', 'auth'],
    ['/api/v1/accounts', 'auth'],
    ['/api/v1/accounts/me/password', 'auth'],
    ['/api/v1/members', 'member'],
    ['/api/v1/members/me', 'member'],
    ['/api/v1/members/7', 'member'],
    ['/api/v1/posts', 'board'],
    ['/api/v1/posts/me', 'board'],
    ['/api/v1/posts/3/comments', 'board'],
    ['/api/v1/comments/9', 'board'],
  ])('%s → %s', (path, expected) => {
    expect(serviceOf(path)).toBe(expected);
  });

  it('내부 API 는 접두어에 없다 — 프론트가 호출할 경로가 아니다 (§5)', () => {
    expect(serviceOf('/internal/v1/members/bulk')).toBeNull();
  });

  it('모르는 경로는 null 이다', () => {
    expect(serviceOf('/api/v1/unknown')).toBeNull();
  });
});

describe('baseUrlFor', () => {
  it('접두어를 모르는 경로는 던진다 — 한 서비스로 추측해 보내지 않는다', () => {
    expect(() => baseUrlFor('/api/v1/unknown')).toThrow(/서비스 접두어를 모르는 경로/);
  });

  it('세 서비스가 서로 다른 주소를 받는다', () => {
    const auth = baseUrlFor('/api/v1/auth/login');
    const member = baseUrlFor('/api/v1/members/me');
    const board = baseUrlFor('/api/v1/posts');
    expect(new Set([auth, member, board]).size).toBe(3);
  });
});
