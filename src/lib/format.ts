/**
 * 시각 문자열은 KST 기준이고 **오프셋을 표기하지 않는다**(sp-docs/tech-stack.md §6).
 * 소수부는 저장값에 따른다 — 감사가 만든 값에는 없지만(sp-docs/api-contract.md §4.3 의 D-11)
 * SQL 로 심은 행에는 남을 수 있다.
 * 그래서 파싱해서 다시 포맷하지 않고 **구분자만 바꿔 그대로 보여준다.**
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace('T', ' ');
}
