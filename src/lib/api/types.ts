/**
 * 공통 응답 형식. 정본은 sp-docs/api-contract.md §7 이다.
 *
 * 세 서비스가 `ApiResponse` 를 각자 복제하지만 모양은 하나다 — 어긋남은
 * sp-docs/plan/integration.md I-04 의 3자 비교가 지킨다.
 */
export interface FieldError {
  field: string;
  message: string;
}

export interface ErrorResponse {
  code: string;
  message: string;
  fieldErrors: FieldError[];
}

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ErrorResponse | null;
}

/** 페이징 응답 (api-contract.md §7.1). 저쪽 jworksuite6 의 PageResponse 와 키가 다르다. */
export interface Page<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  first: boolean;
  last: boolean;
}

/** 로그인·재발급의 응답 (api-contract.md §9.2). 재발급은 로그인과 같은 모양이다. */
export interface TokenResponse {
  grantType: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
}
