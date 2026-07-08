import FrozenNotice from '@/components/shell/FrozenNotice';

// 웹 워크스페이스 목록 동결(M0) — 에이전트 스택 미참조.
export default function AppHome() {
  return <FrozenNotice title="워크스페이스는 잠시 쉬어가요" />;
}
