import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { cspPlugin } from './csp.ts';

/**
 * 포트는 3000 이다. 세 서비스의 `cors.allowed-origins` 가 이미
 * `http://localhost:3000` 으로 설정되어 있어 백엔드를 고치지 않아도 된다
 * (sp-docs/security.md §1.1 — 오리진은 환경이 정하고 기본값이 없다).
 *
 * 프록시는 VITE_API_MODE=proxy 일 때만 쓰는 비상구다. 기본값(direct)에서는
 * 브라우저가 8081·8082·8083 을 직접 호출하므로 preflight 가 실제로 날아간다.
 */
export default defineConfig({
  // CSP 는 프로덕션 빌드에만 넣는다(csp.ts).
  plugins: [react(), cspPlugin()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/api/v1/auth': { target: 'http://localhost:8083', changeOrigin: true },
      '/api/v1/accounts': { target: 'http://localhost:8083', changeOrigin: true },
      '/api/v1/members': { target: 'http://localhost:8081', changeOrigin: true },
      '/api/v1/posts': { target: 'http://localhost:8082', changeOrigin: true },
      '/api/v1/comments': { target: 'http://localhost:8082', changeOrigin: true },
    },
  },
  // 브라우저 테스트가 프로덕션 빌드를 띄우는 자리다(playwright.config.ts). preview 는 `server.port` 를 물려받지 않으므로
  // 3000 번을 여기에도 둔다 — 세 서비스의 CORS 오리진이다.
  preview: {
    port: 3000,
    strictPort: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // 브라우저 테스트(e2e/)는 Playwright 가 돌린다(`pnpm test:e2e`).
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
