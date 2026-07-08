import FrozenNotice from '@/components/shell/FrozenNotice';

// 웹 채팅 동결(M0) — 에이전트 스택 미참조. 랜딩/구독/내정보는 그대로.
export default function ChatPage() {
  return <FrozenNotice title="채팅은 잠시 쉬어가요" />;
}
