import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { restoreSession } from '@/lib/api/client';

/**
 * 재시도를 끈다. 이 저장소의 목적은 서버가 무엇을 답했는지 보는 것이므로,
 * 실패를 자동으로 다시 쳐서 가리지 않는다.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function App() {
  // 새로고침 뒤 세션을 되살린다. 공개 경로는 기다리지 않고, 보호된 경로만 끝날 때까지 판정을
  // 미룬다(router.tsx 의 RequireToken).
  useEffect(() => {
    void restoreSession();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
