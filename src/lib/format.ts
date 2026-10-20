/**
 * 시각 문자열은 KST 기준이고 **오프셋을 표기하지 않는다**(sp-docs/tech-stack.md §6).
 * 소수부는 저장값에 따른다 — 운영(MySQL DATETIME)은 초 단위고 H2 는 마이크로초다.
 * 그래서 파싱해서 다시 포맷하지 않고 **구분자만 바꿔 그대로 보여준다.**
 */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace('T', ' ');
}
