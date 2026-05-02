// src/components/curriculum/main
import { useState, useEffect } from 'react';
import StageButton from './StageButton';
import Tooltip from './Tooltip';

const Main = ({section}) => {
  console.log(section)
  // 현재 클릭된 stage의 id를 저장할 state
  const [clickedStageId, setClickedStageId] = useState(null);
  const [closingStageId, setClosingStageId] = useState(null);
  
  useEffect(() => {
    const handleClickOutside = (event) => {
      // 클릭된 요소가 툴팁 영역 내부인지 확인
      const isTooltipArea = event.target.closest('[data-tooltip]');
      // 클릭된 요소가 스테이지 버튼인지 확인
      const isStageButton = event.target.closest('.stage-button');
      
      // 툴팁 영역이나 스테이지 버튼이 아닌 외부를 클릭했을 때만 툴팁 닫기
      if (!isTooltipArea && !isStageButton) {
        // 닫기 애니메이션을 위해 현재 열린 스테이지 ID 저장
        setClosingStageId(clickedStageId);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [clickedStageId]);
  const handleStageClick = (stage) => {
    console.log(stage)
    if (clickedStageId === stage.id) {
      setClosingStageId(stage.id);
    } else {
      setClickedStageId(stage.id);
    }
  }
  return (
    <div 
      className="
        w-full h-[calc(100vh-var(--margin-header))]
        overflow-y-auto
      "
    >
      <div className="">
        {section.units.map((unit) => {
          return (
          <div key={unit.id}>
            <div className="flex justify-center items-center w-full h-[82px] text-[#37464F] text-xl font-bold">
              <div className="flex-1 h-[2px] bg-[#37464F]"></div>
              <h1 className="p-4">{unit.title}</h1>
              <div className="flex-1 h-[2px] bg-[#37464F]"></div>
            </div>
            <div className="flex flex-col">
              {unit.stages.map((stage)=>{
                return (
                <div key={stage.id} className="relative">
                  <StageButton 
                    stage={stage}
                    isActive={clickedStageId === stage.id}
                    onClick={() => handleStageClick(stage)}
                  />
                  {(clickedStageId === stage.id || closingStageId === stage.id) && (
                    <Tooltip 
                      stage={stage}
                      onClose={() => {
                        if (closingStageId === stage.id) {
                          setClickedStageId(null);
                          setClosingStageId(null);
                        }
                      }}
                      isClosing={closingStageId === stage.id}
                      unit_id={unit.id}
                    />
                  )}
                </div>
                )
              })}
            </div>
          </div>
          )
        })}
      </div>
    </div>
  )
}
export default Main;