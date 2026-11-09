import { useEffect, useMemo } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { restoreSession } from '@/lib/api/client';
import { newQueryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/stores/authStore';

export function App() {
  // 새로고침 뒤 세션을 되살린다. 공개 경로는 기다리지 않고, 보호된 경로만 끝날 때까지 판정을
  // 미룬다(router.tsx 의 RequireToken).
  useEffect(() => {
    void restoreSession();
  }, []);

  // 세션이 바뀌면 클라이언트를 바꿔 쿼리를 쓰는 화면을 모두 다시 그린다(lib/queryClient.ts). `key` 로 다시 마운트하지 않는다 — 그 자리에
  // 머무는 화면의 입력과 실패 안내가 함께 사라진다. 재발급은 세대를 올리지 않으므로 클라이언트가 그대로다.
  const generation = useAuthStore((s) => s.sessionGeneration);
  const client = useMemo(() => newQueryClient(), [generation]);

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
