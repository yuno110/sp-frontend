import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';

/**
 * 재시도를 끈다. 이 저장소의 목적은 서버가 무엇을 답했는지 보는 것이므로,
 * 실패를 자동으로 다시 쳐서 가리지 않는다.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
