import { useEffect } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { restoreSession } from '@/lib/api/client';
import { queryClient } from '@/lib/queryClient';

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
