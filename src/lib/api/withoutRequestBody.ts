import axios, { AxiosError } from 'axios';

/**
 * 실패의 사본 — 요청 본문을 비운다. axios 는 보낸 설정을 오류에 싣고(`config.data`, `response.config` 도 같은 객체다) 그
 * 본문에 비밀번호가 있을 수 있다(예: 로그인, 계정 탈퇴). **비밀번호를 싣는 요청의 실패를 쥐는 자리는 이 사본을 쥔다** — 화면의 오류 상태와
 * stores/authStore.ts 다. 화면이 쓰는 코드·메시지·상태는 응답과 메시지에 있어 그대로다(client.ts 의 `describeError`).
 *
 * `AxiosError.from` 은 원래 오류를 `cause` 로 붙들므로 쓰지 않는다. 원래 오류는 건드리지 않는다 — 요청한 쪽은 그것을 그대로
 * 받는다. stores/authStore.ts 가 쓰므로 client.ts 에 두지 않는다(client.ts 가 그 스토어를 읽는다).
 */
export function withoutRequestBody(failure: unknown): unknown {
  if (!axios.isAxiosError(failure) || !failure.config) return failure;
  const config = { ...failure.config, data: undefined };
  const response = failure.response && { ...failure.response, config, request: undefined };
  return new AxiosError(failure.message, failure.code, config, undefined, response);
}
