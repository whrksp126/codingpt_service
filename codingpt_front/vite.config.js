// import { defineConfig } from 'vite';
// import react from '@vitejs/plugin-react';
// import monacoEditorPlugin from 'vite-plugin-monaco-editor';

// export default defineConfig({
//   plugins: [
//     react(),
//     monacoEditorPlugin.default({
//       languageWorkers: ['editorWorkerService', 'typescript', 'css', 'html', 'json'],
//     }),
//   ],
//   server: {
//     mimeTypes: {
//       'application/javascript': ['js', 'mjs', 'worker.js'],
//     },
//   },
//   resolve: {
//     extensions: ['.js', '.jsx'], // .jsx 확장자를 명시적으로 추가
//   },
// });



import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';
import path from 'path';

// 환경 변수 설정 (production, staging, development, local)
const NODE_ENV = process.env.NODE_ENV || 'local';
const VITE_BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:8000';
// 도메인별 허용 리스트 설정
const allowedHosts = ['localhost'];
console.log("VITE_BACKEND_URL,,",VITE_BACKEND_URL);
if (NODE_ENV === 'development') {
  allowedHosts.push('dev-heyvoca-front.ghmate.com');
} else if (NODE_ENV === 'staging') {
  allowedHosts.push('stg-heyvoca-front.ghmate.com');
} else if (NODE_ENV === 'production') {
  allowedHosts.push('heyvoca-front.ghmate.com');
}

export default defineConfig({
  plugins: [
    react(),
    monacoEditorPlugin.default({
      languageWorkers: ['editorWorkerService', 'typescript', 'css', 'html', 'json'],
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared/lessonSchema': path.resolve(__dirname, '../codingpt_back/services/lessonSchema'),
    },
  },
  base: NODE_ENV === 'production' ? '/' : '/',
  server: {
    watch: {
      usePolling: true,
      interval: 300,
    },
    host: '0.0.0.0',
    strictPort: true,
    port: 3300,
    cors: true,
    allowedHosts,
  },
  build: {
    outDir: 'dist',
  },
  css: {
    postcss: './postcss.config.cjs'
  },
});
