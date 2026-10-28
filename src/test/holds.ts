/**
 * 값 안 어디에든 그 문자열이 있는가 — 객체를 따라가고 같은 객체는 한 번만 본다. 함수는 열지 않는다.
 *
 * 비밀번호 같은 값이 상태에 남지 않았는지 볼 때 쓴다. **없다는 결과는 이 검사가 그 모양을 들여다보지 못해도 나온다** —
 * 쓰는 쪽은 그 문자열을 실제로 든 같은 모양의 값(예: 그 요청의 오류)에서 참이 나오는 것을 함께 보인다.
 */
export function holds(value: unknown, needle: string, seen = new Set<object>()): boolean {
  if (typeof value === 'string') return value.includes(needle);
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some((key) => {
    let child: unknown;
    try {
      child = (value as Record<PropertyKey, unknown>)[key];
    } catch {
      return false;
    }
    return holds(child, needle, seen);
  });
}
