import { describe, expect, it } from 'vitest';
import { internalCopyIn } from '@/test/internalCopy';
import { ERROR_CODES, ERROR_SENTENCES, MY_PROFILE, NO_RESPONSE, UNEXPECTED } from './errorCodes';

/**
 * sp-docs/api-contract.md §8.1~§8.4 의 코드 표를 옮긴 것. **정본 파일을 읽지 않고 여기 적는다** — 이 저장소의
 * 테스트가 옆에 `sp-docs` 를 받아 둔 경우에만 돌게 되기 때문이다. 백엔드의 `ErrorCodeTest` 도 같은 방식이다.
 * 그래서 **정본에 코드가 더해져도 이 테스트는 알지 못한다** — §8 이 바뀌면 이 저장소가 이 목록과 사전을 고친다.
 * 고치기 전까지 화면은 사전에 없는 코드를 서버 메시지와 코드로 보여준다(lib/api/client.ts 의 `describeError`) —
 * 빠진 문장이 오류를 숨기지는 않는다.
 */
const CONTRACT_CODES = [
  // §8.1 공통 (세 서비스)
  'C001', 'C002', 'C003', 'C004', 'C005', 'C006', 'C007', 'A001', 'A002', 'A003', 'A004',
  // §8.2 member-service
  'M001', 'M003', 'M006', 'M007',
  // §8.3 board-service
  'P001', 'P002', 'CM001', 'CM002', 'S001', 'S002',
  // §8.4 auth-service
  'AU001', 'AU002', 'AU003', 'AU004',
];

const sorted = (codes: string[]) => [...codes].sort();

describe('코드 사전', () => {
  it('옮긴 목록에 중복이 없다', () => {
    expect(new Set(CONTRACT_CODES).size).toBe(CONTRACT_CODES.length);
  });

  it('사용자 문장의 코드 집합이 §8 의 코드 집합과 같다', () => {
    expect(sorted(Object.keys(ERROR_SENTENCES))).toEqual(sorted(CONTRACT_CODES));
  });

  it('요청 기록 패널의 설명도 같은 코드 집합이다', () => {
    expect(sorted(Object.keys(ERROR_CODES))).toEqual(sorted(CONTRACT_CODES));
  });

  it('엔드포인트별 뜻은 §8 의 코드에만 붙는다', () => {
    expect(CONTRACT_CODES).toEqual(expect.arrayContaining(Object.keys(MY_PROFILE)));
  });
});

describe('사용자 문장', () => {
  const all = [
    ...Object.entries(ERROR_SENTENCES).map(([code, s]) => [code, s.text] as const),
    ...Object.entries(MY_PROFILE).map(([code, s]) => [`${code} (내 프로필)`, s.text] as const),
    ['응답 없음', NO_RESPONSE] as const,
    ['오류 응답이 아닌 실패', UNEXPECTED] as const,
  ];

  it.each(all)('%s — 내부 구조를 설명하지 않는다', (_, text) => {
    expect(internalCopyIn(text)).toEqual([]);
  });

  it('응답 없음은 업무 오류와 다른 문장이다', () => {
    expect(Object.values(ERROR_SENTENCES).map((s) => s.text)).not.toContain(NO_RESPONSE);
  });
});

describe('복구 동작', () => {
  it.each(['A001', 'A002', 'A003'])('%s — 로그인으로', (code) => {
    expect(ERROR_SENTENCES[code].recovery).toBe('login');
  });

  it('S002 — 프로필 등록으로', () => {
    expect(ERROR_SENTENCES.S002.recovery).toBe('profile');
  });

  it('M001 — 내 프로필 조회에서만 프로필 등록으로. 기본 뜻(남의 프로필 조회 등)에는 안내가 없다', () => {
    expect(MY_PROFILE.M001.recovery).toBe('profile');
    expect(ERROR_SENTENCES.M001.recovery).toBeUndefined();
  });

  it('S001 — 잠시 후 다시 시도하게 한다', () => {
    expect(ERROR_SENTENCES.S001.text).toContain('잠시 후 다시 시도');
  });

  it('복구 동작은 위 코드에만 있다 — 나머지 코드가 엉뚱한 곳으로 보내지 않는다', () => {
    const withRecovery = Object.entries(ERROR_SENTENCES)
      .filter(([, s]) => s.recovery)
      .map(([code]) => code);
    expect(sorted(withRecovery)).toEqual(['A001', 'A002', 'A003', 'S002']);
  });
});
