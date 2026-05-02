import { Star } from '@phosphor-icons/react';

const StageButton = ({ stage, isActive, onClick }) => {
  return (
    <div className="flex justify-center mt-4">
      <button 
        onClick={onClick}
        className={`
          stage-button
          flex justify-center items-center
          w-[70px] h-[65px] 
          rounded-[50%]
          
          after:content-['']
          after:absolute
          after:bg-[#93D333]
          after:rounded-[50%]
          
          after:shadow-[0_8px_0_rgba(0,0,0,0.2),0_8px_0_#93D333]
          after:h-[57px]
          after:w-[70px]
          after:top-0
          relative

          transition-all duration-[.075s] ease-in-out
          after:transition-all after:duration-[.075s] after:ease-in-out

          ${isActive ? 'translate-y-2 after:shadow-none' : ''}
          active:translate-y-2
          active:after:shadow-none
        `}
      >
        <Star 
          size={42} 
          color="#fff" 
          weight="fill" 
          className="absolute top-2 z-10 pointer-events-none"
        />
      </button>
    </div>
  );
};

export default StageButton; 