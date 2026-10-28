import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { baseUrlFor, serviceOf } from './services';
import type { ApiResponse, ErrorResponse, FieldError, TokenResponse } from './types';
import { ERROR_SENTENCES, NO_RESPONSE, UNEXPECTED, type Meanings, type Recovery } from './errorCodes';
import { useAuthStore } from '@/stores/authStore';
import { useApiLogStore } from '@/stores/apiLogStore';
import { DEV_ONLY } from '@/lib/devOnly';

/**
 * HTTP 클라이언트. 주소는 경로 접두어로 갈라진다(services.ts).
 *
 * 인터셉터 구조(요청에 토큰 주입 → 401 에 재발급 후 원요청 1회 재시도 → 대기열로
 * 동시 401 합치기)는 jworksuite6 의 `src/lib/api/interceptors.ts` 패턴을 따랐다.
 * 엔드포인트와 조건은 이 프로젝트의 계약이다 — 재발급은 `POST /api/v1/auth/reissue` 이고
 * 본문은 `{ refreshToken }` 이다(sp-docs/api-contract.md §2.1).
 */
const http = axios.create({
  timeout: 10_000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * 재발급 전용. **재시도 인터셉터를 달지 않는다** — 재발급이 401 이면 다시 재발급하면 안 된다.
 * 다만 **기록은 남긴다.** 재발급 왕복이 패널에서 빠지면 "세 서비스가 엮이는 모습을 본다" 는
 * 목적에서 하필 그 상호작용이 사라진다(만료는 30분 + 스큐 60초마다 통상 사용에서 밟힌다).
 */
const reissueHttp = axios.create({ timeout: 10_000 });

reissueHttp.interceptors.request.use((config) => {
  (config as Retryable)._startedAt = performance.now();
  return config;
});

reissueHttp.interceptors.response.use(
  (res) => {
    log(res.config, res.status, res.data, null);
    return res;
  },
  (error: AxiosError<ApiResponse<unknown>>) => {
    if (error.response) log(error.config, error.response.status, error.response.data, null);
    else log(error.config, null, null, error.message);
    return Promise.reject(error);
  },
);

interface Retryable extends InternalAxiosRequestConfig {
  _retried?: boolean;
  _logged?: boolean;
  _startedAt?: number;
}

/** 재발급 경로. 이 경로의 401 은 복구 대상이 아니다 — 아래 인터셉터가 그렇게 가른다. */
const REISSUE_PATH = '/api/v1/auth/reissue';

async function reissue(): Promise<string> {
  const { refreshToken, setTokens, clear } = useAuthStore.getState();
  if (!refreshToken) throw new Error('refreshToken 이 없다');
  // 결과는 보낸 토큰이 아직 스토어의 값일 때만 반영한다. 그 사이 토큰이 바뀌었으면(예: 되살리는
  // 창의 로그인) 늦게 끝난 이 재발급이 그것을 지우거나 덮지 않는다.
  const unchanged = () => useAuthStore.getState().refreshToken === refreshToken;
  let token: TokenResponse | null | undefined;
  try {
    const res = await reissueHttp.post<ApiResponse<TokenResponse>>(
      REISSUE_PATH,
      { refreshToken },
      { baseURL: baseUrlFor(REISSUE_PATH), headers: { 'Content-Type': 'application/json' } },
    );
    token = res.data?.data;
  } catch (e) {
    // 토큰을 비우는 것은 서버의 거부(4xx)뿐이다 — 계약의 재발급 거부는 401 이다(api-contract.md §2.1·§8.1).
    // 5xx 와 응답 없음(연결 거부·타임아웃)은 Refresh Token 을 그대로 두고 실패만 전한다. 새로고침이
    // auth 를 거치므로, 지우면 auth 의 장애가 로그아웃이 된다.
    const status = axios.isAxiosError(e) ? e.response?.status : undefined;
    if (status !== undefined && status >= 400 && status < 500 && unchanged()) clear();
    throw e;
  }
  if (!token?.accessToken) {
    if (unchanged()) clear();
    throw new Error('재발급 응답에 accessToken 이 없다');
  }
  // Refresh Token 도 회전 발급되므로 둘을 함께 저장한다 — accessToken 만 받으면
  // 회전된 refreshToken 이 유실되고 두 번째 갱신부터 막힌다(api-contract.md §2.1).
  if (unchanged()) setTokens(token);
  return token.accessToken;
}

let refreshing: Promise<string> | null = null;

/**
 * Access Token 을 다시 받는다. **진행 중인 재발급이 있으면 새로 쏘지 않고 그것을 같이 기다린다.**
 * 부트스트랩(`restoreSession`)과 401 복구가 이 한 자리를 탄다 — 같은 Refresh Token 으로 두 번
 * 재발급하면 하나가 회전의 조건부 UPDATE 에 지고(api-contract.md §2.1), 그 실패가 먼저 도착하면
 * 세션이 끝난다.
 */
function refreshAccessToken(): Promise<string> {
  refreshing ??= reissue().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * 새로고침 뒤 세션을 되살린다. Access Token 은 메모리에만 있으므로(stores/authStore.ts) 영속된
 * Refresh Token 으로 다시 받는다.
 *
 * 되살리는 동안 여러 번 불려도 재발급은 한 번이다 — StrictMode 는 개발 중 효과를 두 번 실행한다.
 * 끝난 뒤에 불리면 재발급하지 않는다. 끝나면 성공이든 실패든 `restoring` 을 내린다.
 *
 * 실패를 다시 던지지 않는다 — 판정은 스토어의 상태가 한다. 거부(4xx)면 `reissue()` 가 토큰을 비우고,
 * 5xx·응답 없음이면 Refresh Token 을 남겨 다음 새로고침이 다시 묻는다. 결과는 이 재발급이 받은
 * Access Token 이고, 실패했으면 null 이다.
 */
export function restoreSession(): Promise<string | null> {
  const { restoring, accessToken } = useAuthStore.getState();
  if (!restoring) return Promise.resolve(accessToken);
  return refreshAccessToken()
    .catch((e: unknown) => {
      // 되살리지 못한 이유를 남긴다 — 보호된 경로는 로그인으로 가고 로그인 화면이 그 이유를 보인다(stores/authStore.ts 의
      // `sessionFailure`). 그 사이 로그인했으면(되살리는 창의 로그인) 끝난 세션이 없으므로 남기지 않는다.
      if (useAuthStore.getState().accessToken === null) useAuthStore.getState().setSessionFailure(e);
      return null;
    })
    .finally(() => useAuthStore.setState({ restoring: false }));
}

http.interceptors.request.use((config) => {
  const path = config.url ?? '';
  config.baseURL = baseUrlFor(path);
  (config as Retryable)._startedAt = performance.now();

  // 토큰을 명시적으로 지정한 요청(토큰 실험 화면, 무인증 경로)은 건드리지 않는다.
  //
  // **헤더를 떼는 일은 이 분기가 하지 않는다. 측정값이다.** `Authorization: null` 을 준
  // 요청은 여기서 `null` 로 보이므로 위 조건(`undefined`)에 걸리지 않아 **주입을 건너뛰고**,
  // axios 가 null 헤더를 전송하지 않는다. 아래 `delete` 를 지워도 헤더는 붙지 않았다
  // (테스트 26건 그대로 통과) — 의도를 코드에 남기려고 두는 것이고 **없애도 동작은 같다.**
  // 반대로 `{ headers: { Authorization: null } }` 자체를 빼면 `Bearer <만료 토큰>` 이
  // 붙는다(그 양성 대조는 실패한다). 즉 일하는 것은 **호출 측의 null 지정**이다.
  if (config.headers.Authorization === undefined) {
    const { accessToken } = useAuthStore.getState();
    if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  } else if (config.headers.Authorization === null) {
    delete config.headers.Authorization;
  }
  return config;
});

/** 요청 기록을 남긴다. **프로덕션 빌드에서는 모으지 않는다** — 보여줄 패널이 없다(lib/devOnly.ts). */
function log(config: AxiosRequestConfig | undefined, status: number | null, body: unknown, transportError: string | null) {
  if (!DEV_ONLY) return;
  const path = config?.url ?? '';
  const started = (config as Retryable | undefined)?._startedAt;
  const error = (body as ApiResponse<unknown> | undefined)?.error ?? null;
  useApiLogStore.getState().push({
    method: (config?.method ?? 'get').toUpperCase(),
    path,
    service: serviceOf(path),
    status,
    code: error?.code ?? null,
    message: error?.message ?? null,
    fields: (error?.fieldErrors ?? []).map((f) => `${f.field}: ${f.message}`),
    ms: started ? Math.round(performance.now() - started) : 0,
    transportError,
  });
}

http.interceptors.response.use(
  (res) => {
    log(res.config, res.status, res.data, null);
    return res;
  },
  async (error: AxiosError<ApiResponse<unknown>>) => {
    const original = error.config as Retryable | undefined;
    const status = error.response?.status ?? null;
    const code = error.response?.data?.error?.code ?? null;

    // 만료(A003)만 재발급으로 복구한다. A001·A002 는 재발급해도 같은 결과이고,
    // 코드를 가려 버리면 이 저장소의 목적(어느 코드가 왔는지 보는 것)이 사라진다.
    //
    // **재발급 요청 자신의 401 은 복구 대상이 아니다.** `/tokens` 의 수동 재발급은
    // 인터셉터가 달린 이 인스턴스를 쓰므로, 가르지 않으면 그 401 을 "복구할 수 있다" 고
    // 보고 같은 토큰으로 한 번 더 쏜 뒤 세션을 비운다.
    const isReissue = original?.url === REISSUE_PATH;
    if (status === 401 && code === 'A003' && original && !original._retried && !isReissue) {
      original._retried = true;
      // **복구하기 전에 그 401 을 먼저 남긴다.** 재시도가 성공하면 아래 log 에 닿지 못하므로,
      // 여기서 적지 않으면 성공한 복구는 흔적이 없고 실패한 복구만 보인다 — 하필
      // 세 서비스가 엮이는 자리가 패널에서 사라진다.
      log(original, status, error.response?.data, null);
      original._logged = true;
      // 복구를 시작할 때 Refresh Token 이 없으면 이어 갈 세션이 없다 — 그 사이 로그아웃했다. 아래에서 이유를 남기지 않는다.
      const hadSession = useAuthStore.getState().refreshToken !== null;
      try {
        const fresh = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${fresh}`;
        // 재시도는 같은 config 객체로 나간다. 표시를 지우지 않으면 **재시도가 실패해도
        // 그 실패가 기록되지 않는다** — 중복을 막으려다 새 구멍을 내는 자리다.
        original._logged = false;
        return http.request(original);
      } catch {
        // 재발급이 실패했다. 원래의 401 을 아래에서 그대로 돌려준다.
        //
        // 복구를 시작할 때 세션이 있었고 재발급 뒤 Access Token 이 비었으면(비울지는 reissue() 가 정한다) 이 401 을
        // 남긴다. 보호된 화면은 곧 로그인으로 가며 이 오류를 잃으므로 로그인 화면이 이어 보인다(stores/authStore.ts 의
        // `sessionFailure`).
        if (hadSession && useAuthStore.getState().accessToken === null) {
          useAuthStore.getState().setSessionFailure(error);
        }
      }
    }

    // 위에서 이미 적었으면 다시 적지 않는다. 재발급이 **실패한** 경로가 여기로 흘러
    // 같은 401 을 두 번 남기던 결함이다 — 기록을 믿을 수 없게 만든다.
    if (original?._logged) {
      return Promise.reject(error);
    }
    if (error.response) {
      log(original, status, error.response.data, null);
    } else {
      // 응답이 아예 없다 — CORS 거부·연결 거부·타임아웃. 업무 오류와 구별해 적는다.
      log(original, null, null, error.message);
    }
    return Promise.reject(error);
  },
);

/** 서버가 보낸 `error` 를 그대로 꺼낸다. 응답이 없으면 null 이다. */
export function errorOf(e: unknown): ErrorResponse | null {
  if (axios.isAxiosError(e)) {
    return (e.response?.data as ApiResponse<unknown> | undefined)?.error ?? null;
  }
  return null;
}

/** 화면에 보여줄 오류. 그리는 것은 components/ui.tsx 의 `ErrorBox`·`ErrorLine` 이다. */
export interface ErrorView {
  /** 사용자에게 보여줄 문장. */
  text: string;
  /** 보조 정보로 남기는 식별자 — 서버의 코드이고, 오류 본문이 없는 응답이면 HTTP 상태다. 응답이 없거나 화면 쪽 예외면 null. */
  code: string | null;
  recovery: Recovery | null;
  fieldErrors: FieldError[];
  /** 오류 응답의 모양이 아닌 실패의 원문. 사용자에게 보여줄 문장이 아니라서 개발 빌드에서만 그린다. */
  detail: string | null;
}

/**
 * 서버의 `message` 대신 코드마다 정한 문장을 쓴다(errorCodes.ts). **코드와 `fieldErrors` 는 버리지 않는다** —
 * 문장을 다듬어도 코드가 남아야 무엇이 났는지 알 수 있다(AGENTS.md 불변식 9). 사전에 없는 코드는 서버
 * 메시지를 그대로 쓴다.
 *
 * 같은 코드가 엔드포인트마다 다른 뜻이면 그 엔드포인트를 부른 쪽이 `meanings` 를 넘긴다(errorCodes.ts 의
 * `MY_PROFILE`). 넘기지 않으면 기본 뜻이다.
 */
export function describeError(e: unknown, meanings: Meanings = {}): ErrorView {
  const error = errorOf(e);
  if (error) {
    const known = meanings[error.code] ?? ERROR_SENTENCES[error.code];
    return {
      text: known ? known.text : error.message,
      code: error.code,
      recovery: known?.recovery ?? null,
      fieldErrors: error.fieldErrors ?? [],
      detail: null,
    };
  }
  if (axios.isAxiosError(e)) {
    if (!e.response) return { text: NO_RESPONSE, code: null, recovery: null, fieldErrors: [], detail: null };
    return { text: UNEXPECTED, code: `HTTP ${e.response.status}`, recovery: null, fieldErrors: [], detail: e.message };
  }
  return {
    text: UNEXPECTED,
    code: null,
    recovery: null,
    fieldErrors: [],
    detail: e instanceof Error ? e.message : String(e),
  };
}

/** 한 필드의 오류 메시지들. 입력칸 옆에 그린다 — 요약에서 그 필드를 빼는 것은 `ErrorBox` 의 `inlineFields` 다. */
export function fieldMessages(e: unknown, field: string): string[] {
  return (errorOf(e)?.fieldErrors ?? []).filter((f) => f.field === field).map((f) => f.message);
}

/** `ApiResponse` 를 벗긴다. `success=false` 가 2xx 로 오는 경우는 계약에 없다. */
export async function unwrap<T>(p: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  const res = await p;
  if (!res.data.success || res.data.data === null) {
    throw new Error(`계약 위반 응답: success=${res.data.success}, data=${JSON.stringify(res.data.data)}`);
  }
  return res.data.data;
}

export default http;
