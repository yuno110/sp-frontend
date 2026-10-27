import { Navigate, createBrowserRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Layout } from '@/components/Layout';
import { LoginPage } from '@/pages/LoginPage';
import { SignupPage } from '@/pages/SignupPage';
import { PostListPage } from '@/pages/PostListPage';
import { PostDetailPage } from '@/pages/PostDetailPage';
import { PostFormPage } from '@/pages/PostFormPage';
import { MyPostsPage } from '@/pages/MyPostsPage';
import { MyPage } from '@/pages/MyPage';
import { MemberProfilePage } from '@/pages/MemberProfilePage';
import { TokenLabPage } from '@/pages/TokenLabPage';
import { DEV_ONLY } from '@/lib/devOnly';
import { useAuthStore } from '@/stores/authStore';

/**
 * 토큰이 없으면 로그인으로 보낸다. **인가가 아니다** — 판정은 서버가 한다
 * (sp-docs/security.md §5.1). 화면 전환을 줄이는 편의일 뿐이고, 토큰을 들고 있어도
 * 서버가 401·403 을 낼 수 있다.
 */
function RequireToken({ children }: { children: ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  return accessToken ? children : <Navigate to="/login" replace />;
}

/**
 * /posts/mine 과 /posts/new 가 /posts/:id 보다 먼저 선언되어 있다. 라우터는 리터럴을
 * 먼저 보므로 순서와 무관하지만, 서버의 SecurityConfig 는 선언 순서대로 평가한다
 * (api-contract.md §4) — 같은 함정을 프론트에서도 기억하려고 순서를 맞춰 둔다.
 *
 * 서버 쪽 경로는 /api/v1/posts/me 이고 이 화면의 경로만 /posts/mine 이다.
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/posts" replace /> },
      { path: 'login', element: <LoginPage /> },
      { path: 'signup', element: <SignupPage /> },
      { path: 'signup/profile', element: <SignupPage startAt={2} /> },
      {
        path: 'posts/mine',
        element: (
          <RequireToken>
            <MyPostsPage />
          </RequireToken>
        ),
      },
      {
        path: 'posts/new',
        element: (
          <RequireToken>
            <PostFormPage mode="create" />
          </RequireToken>
        ),
      },
      { path: 'posts', element: <PostListPage /> },
      // 서버의 `GET /api/v1/posts/me` 와 같은 꼴을 주소창에 치는 경우를 먼저 잡는다.
      // 잡지 않으면 `posts/:id` 가 `me` 를 글 id 로 받아 **목록 응답을 상세로 그린다** —
      // 200 이라 오류도 뜨지 않고 제목·본문이 빈 화면이 된다(불변식 9 성격).
      { path: 'posts/me', element: <Navigate to="/posts/mine" replace /> },
      { path: 'posts/:id', element: <PostDetailPage /> },
      {
        path: 'posts/:id/edit',
        element: (
          <RequireToken>
            <PostFormPage mode="edit" />
          </RequireToken>
        ),
      },
      // `members/me` 도 같은 이유로 먼저 잡는다 — 서버의 `GET /api/v1/members/me` 는
      // 2키(`MyProfile`)이고 이 화면이 기대하는 것은 4키(`PublicProfile`)다.
      { path: 'members/me', element: <Navigate to="/me" replace /> },
      { path: 'members/:accountId', element: <MemberProfilePage /> },
      {
        path: 'me',
        element: (
          <RequireToken>
            <MyPage />
          </RequireToken>
        ),
      },
      // 개발 빌드에서만 있다. 프로덕션 빌드에서는 이 경로가 아래 `*` 에 걸려 목록으로 간다.
      ...(DEV_ONLY ? [{ path: 'tokens', element: <TokenLabPage /> }] : []),
      { path: '*', element: <Navigate to="/posts" replace /> },
    ],
  },
]);
