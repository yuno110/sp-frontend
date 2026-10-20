import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios';
import { baseUrlFor, serviceOf } from './services';
import type { ApiResponse, ErrorResponse, TokenResponse } from './types';
import { useAuthStore } from '@/stores/authStore';
import { useApiLogStore } from '@/stores/apiLogStore';

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

let refreshing: Promise<string> | null = null;

async function reissue(): Promise<string> {
  const { refreshToken, setTokens, clear } = useAuthStore.getState();
  if (!refreshToken) throw new Error('refreshToken 이 없다');
  try {
    const res = await reissueHttp.post<ApiResponse<TokenResponse>>(
      REISSUE_PATH,
      { refreshToken },
      { baseURL: baseUrlFor(REISSUE_PATH), headers: { 'Content-Type': 'application/json' } },
    );
    const token = res.data.data;
    if (!token?.accessToken) throw new Error('재발급 응답에 accessToken 이 없다');
    // Refresh Token 도 회전 발급되므로 둘을 함께 저장한다 — accessToken 만 받으면
    // 회전된 refreshToken 이 유실되고 두 번째 갱신부터 막힌다(api-contract.md §2.1).
    setTokens(token);
    return token.accessToken;
  } catch (e) {
    clear();
    throw e;
  }
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

function log(config: AxiosRequestConfig | undefined, status: number | null, body: unknown, transportError: string | null) {
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
      try {
        refreshing = refreshing ?? reissue();
        const fresh = await refreshing;
        refreshing = null;
        original.headers.Authorization = `Bearer ${fresh}`;
        // 재시도는 같은 config 객체로 나간다. 표시를 지우지 않으면 **재시도가 실패해도
        // 그 실패가 기록되지 않는다** — 중복을 막으려다 새 구멍을 내는 자리다.
        original._logged = false;
        return http.request(original);
      } catch {
        refreshing = null;
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

/** 화면에 띄울 한 줄. 서버 메시지를 다시 쓰지 않는다. */
export function messageOf(e: unknown): string {
  const error = errorOf(e);
  if (error) return `${error.code} ${error.message}`;
  if (axios.isAxiosError(e) && !e.response) {
    return `응답이 없다 (${e.message}) — 서비스가 떠 있는지, CORS 오리진이 맞는지 본다`;
  }
  return e instanceof Error ? e.message : String(e);
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
