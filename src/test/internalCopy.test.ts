import { describe, expect, it } from 'vitest';
import { INTERNAL_COPY, internalCopyIn, visibleCopy } from './internalCopy';

/**
 * 검사 목록의 양성 대조. 패턴의 갈래마다 표본을 잡아야 한다 — 그래야 화면 검사의 빈 결과가 "그런 문구가 없다" 를
 * 뜻한다(sp-docs/process/review-policy.md §4.1 의 "0 을 믿기 전에 패턴의 양성 대조를 세운다").
 */
describe('검사 목록', () => {
  it.each(INTERNAL_COPY.flatMap((c) => c.samples.map((sample) => [c.name, sample, c.pattern] as const)))(
    '%s — "%s" 를 잡는다',
    (_, sample, pattern) => {
      expect(sample).toMatch(pattern);
    },
  );

  it('사용자 말로 쓴 문구는 잡지 않는다 — 글자 수·쪽수의 숫자와 `/` 도 상태 코드·경로로 읽지 않는다', () => {
    expect(
      internalCopyIn(
        [
          '게시글을 찾을 수 없습니다.',
          '0 / 200 · 공백만으로 채울 수 없다',
          '댓글 (최대 500자)',
          '1 / 3 · 전체 25건',
          '회원 프로필',
          '게시판',
          '오류 코드',
          'user@example.com',
          '2026-10-27 09:00:00',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('visibleCopy', () => {
  it('오류 코드 자리만 빼고 텍스트와 보이는 속성을 모은다', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<p>오류 코드 <span data-error-code="C001">C001</span></p>',
      '<p>없으면 S002</p>',
      '<a title="accountId 12">작성자</a>',
      '<input placeholder="POST /api/v1/posts" />',
    ].join('');

    expect(internalCopyIn(visibleCopy(root))).toEqual([
      ['HTTP 메서드', 'POST'],
      ['API 경로', '/api/v1'],
      ['경로 조각', '/api'],
      ['경로 조각', '/v1'],
      ['경로 조각', '/posts'],
      ['에러 코드', 'S002'],
      ['API 필드 이름', 'accountId'],
      ['camelCase 식별자', 'accountId'],
    ]);
  });

  it('이웃한 요소의 글자를 붙이지 않는다 — 붙이면 단어 경계가 사라져 놓친다', () => {
    const root = document.createElement('div');
    root.innerHTML = '<span>sub</span><span>7</span>';
    expect(internalCopyIn(root.textContent ?? '')).toEqual([]);
    expect(internalCopyIn(visibleCopy(root))).toEqual([['API 필드 이름', 'sub']]);
  });
});
