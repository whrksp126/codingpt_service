import FrozenNotice from '@/components/shell/FrozenNotice';

// 웹 IDE(워크스페이스 상세) 동결(M0) — 에이전트/IDE 스택 미참조.
export default function WorkspacePage() {
  return <FrozenNotice title="워크스페이스는 잠시 쉬어가요" />;
}
