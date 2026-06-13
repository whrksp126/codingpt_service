import { DeviceMobile } from '@phosphor-icons/react';

// 모바일 IDE 연동이 켜진 모듈의 미리보기 헤더 우측에 표시되는 식별용 배지.
// 학습 페이지의 "IDE 열기" 버튼을 미러 — 관리자에서는 식별용(동작 없음)이라 span 으로 둔다.
const IdeOpenBadge = ({ module }) => {
  if (!module?.ide?.enabled) return null;
  return (
    <span
      className="ml-auto flex shrink-0 select-none items-center gap-1 self-center rounded-md bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-white/90"
      title="모바일 IDE 연동됨"
    >
      <DeviceMobile size={12} weight="fill" /> IDE 열기
    </span>
  );
};

export default IdeOpenBadge;
