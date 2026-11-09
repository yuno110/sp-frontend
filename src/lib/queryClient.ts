import {
  MutationCache,
  QueryCache,
  QueryClient,
  type QueryClientConfig,
} from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';

/**
 * 재시도를 끈다. 이 저장소의 목적은 서버가 무엇을 답했는지 보는 것이므로,
 * 실패를 자동으로 다시 쳐서 가리지 않는다.
 *
 * 캐시를 여기 두는 것은 클라이언트를 바꿔도 캐시가 하나이게 하기 위해서다(아래 `newQueryClient`).
 */
const config: QueryClientConfig = {
  queryCache: new QueryCache(),
  mutationCache: new MutationCache(),
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
};

/**
 * App.tsx 와 따로 두는 것은 테스트가 캐시에 남은 값을 보기 위해서다(src/pages/signupWithdrawal.test.tsx 의 비밀번호
 * 검사). App.tsx 가 컴포넌트가 아닌 값을 내보내면 개발 서버의 Fast Refresh 가 그 파일을 갱신하지 못한다.
 */
export const queryClient = new QueryClient(config);

/**
 * **캐시의 수명은 세션이다.** 세션이 바뀌면(stores/authStore.ts 의 `sessionGeneration`) 앞 세션이 받은 것을 지운다 — 내 프로필 같은
 * 조회의 키에는 계정이 없어(`['member', 'me']`) 남겨 두면 다음 세션의 화면에 나온다. 지운 쿼리의 조회는 취소되어 늦게 온 답이 어디에도
 * 들어가지 않는다. 재발급은 같은 세션이 이어지는 것이라 지우지 않는다.
 *
 * 토큰 없이 있다가 토큰 없이 끝난 세션(되살리지 못한 새로고침)은 지우지 않는다 — 토큰 없이 받은 것은 어느 세션의 것도 아니고, 지우면 공개
 * 화면이 같은 조회를 다시 보낸다. 글 상세는 조회할 때마다 조회수가 오른다.
 */
useAuthStore.subscribe((now, before) => {
  if (now.sessionGeneration === before.sessionGeneration) return;
  if (before.accessToken === null && now.accessToken === null) return;
  queryClient.clear();
});

/**
 * 같은 캐시를 보는 새 클라이언트. 캐시를 지워도 화면의 관찰자는 지운 쿼리에 남고 알림도 받지 않는다 — 스토어를 읽지 않는 화면은 앞 세션의
 * 데이터를 그대로 그린다. 컨텍스트 값이 바뀌면 쿼리를 쓰는 컴포넌트가 모두 같은 커밋에서 다시 그려져 새 쿼리로 옮긴다(App.tsx).
 */
export const newQueryClient = () => new QueryClient(config);
