import { useEffect } from 'react';

// 새로운 Tooltip 컴포넌트
const Tooltip = ({ stage, onClose, isClosing, unit_id }) => {

  useEffect(() => {
    if (isClosing) {
      

      // 애니메이션 시간(300ms) 후에 onClose 호출
      const timer = setTimeout(() => {
        onClose();
      }, 300);
      
      return () => clearTimeout(timer);
    }
  }, [isClosing, onClose]);
  const handleLessonClick = () => {
    const urlParams = new URLSearchParams(window.location.search);
    const curriculum_id = urlParams.get('curriculum_id');
    const section_id = urlParams.get('section_id');
    window.location.href = `/lesson?curriculum_id=${curriculum_id}&section_id=${section_id}&unit_id=${unit_id}&stage_id=${stage.id}`;
  }
  return (
    <div 
      data-tooltip="true"
      className={`
        transition-all duration-300 ease-in-out
        transform
        ${isClosing ? 'scale-0 opacity-0' : 'scale-100 opacity-100'}
        absolute top-full left-1/2 z-[199]
        brightness-100
        origin-[center_12px]
        ${!isClosing && 'animate-[tooltipShow_.3s_ease-out]'}
      `}
    >
      <div className="
        absolute left-1/2 top-full z-[1]
        w-[295px]
        mt-3
        -translate-x-1/2
      ">
        <div className="
          p-4
          border-0 rounded-[15px]
          text-center leading-[1.4] text-white text-[19px] font-bold
          bg-[#58cc02]
        ">
          <div className="text-start">
            <div>
              <h1 className="text-[19px] font-bold">
                {stage.title}
              </h1>
            </div>
            <p className="text-[17px] font-medium"></p>
            <button 
              onClick={handleLessonClick}
              className="
                relative z-0
                w-full h-[50px]
              px-4 mt-4
              border-solid border-b-4 rounded-2xl
              text-[15px] font-bold
              text-[rgb(88,204,2)]
              outline: none;
              border-transparent 
              select-none

              active:text-[rgb(88,204,2)]
              active:translate-y-[2px]
              active:before:shadow-none
              
              before:content-['']
              before:absolute
              before:right-0
              before:top-0
              before:bottom-0
              before:left-0
              before:-z-[1]
              before:bg-white
              before:rounded-2xl
              before:shadow-[0_4px_0]
              before:text-white/70
              
              before:active:translate-y-[2px]

            ">시작 +10 XP</button>
          </div>
        </div>
        {/* 툴팁 화살표 */}
        <div className="box-border absolute h-[10px] overflow-hidden w-[20px] mx-[15px] -top-[8px] left-[calc(50%-15px)] -translate-x-1/2">
          <div className="bg-[rgb(88,204,2)] border-0 text-white box-border absolute rounded-[2px] content-[''] h-[14.14427157px] left-1/2 translate-z-0 rotate-45 origin-top-left w-[14.14427157px]"></div>
        </div>
      </div>
    </div>
  );
};

export default Tooltip; 