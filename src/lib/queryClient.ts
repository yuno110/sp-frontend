import { QueryClient } from '@tanstack/react-query';

/**
 * 재시도를 끈다. 이 저장소의 목적은 서버가 무엇을 답했는지 보는 것이므로,
 * 실패를 자동으로 다시 쳐서 가리지 않는다.
 *
 * App.tsx 와 따로 두는 것은 테스트가 캐시에 남은 값을 보기 위해서다(src/pages/signupWithdrawal.test.tsx 의 비밀번호
 * 검사). App.tsx 가 컴포넌트가 아닌 값을 내보내면 개발 서버의 Fast Refresh 가 그 파일을 갱신하지 못한다.
 */
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
