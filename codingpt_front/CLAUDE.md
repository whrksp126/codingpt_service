# Frontend Web Rules (`codingpt_front/`)

React 18 + Vite 웹앱. 페이지 기반 라우팅.

---

## 스타일링

- Tailwind CSS utility class 사용 (`className="..."`)
- 인라인 스타일 / 별도 CSS 파일 신규 생성 지양
- 커스텀 설정: `tailwind.config.js`

---

## 컴포넌트 구조

- `src/components/` — 기능별 폴더 (admin, curriculum, lesson, tts 등)
- `src/pages/` — 페이지 레벨 컴포넌트 (Main, Code, Execute, Lesson, Admin, TTS)
- `Execute.jsx` — 의도적으로 대형 단일 컴포넌트 (코드 미리보기 + 실행), 분리 요청 없으면 유지

---

## 코드 에디터

- Monaco Editor 사용 (`@monaco-editor/react`)
- Vite 빌드 설정에서 Monaco 워커 처리 포함 (`vite.config.js` 참조)

---

## 환경 설정

- 개발 서버 포트: **3300** (`vite.config.js`)
- 환경변수: `VITE_BACKEND_URL` 등 `VITE_` 접두사
- 환경 파일: `.env.local`, `.env.dev`, `.env.stg`, `.env`
