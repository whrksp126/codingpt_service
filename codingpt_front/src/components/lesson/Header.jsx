// src/components/lesson/Header.jsx
import { X, Star } from "@phosphor-icons/react";

const Header = () => {
  return (
    <div className="
      w-full
    ">
      <div className="
        fixed top-0
        w-full
        text-white
      ">
        <div className="h-8 w-full"></div>
        <div className="
          relative
          flex justify-between items-center gap-2
          h-14 w-full
          px-4
        ">
            <button onClick={() => {window.history.back();}}>
              <X size={34} />
            </button>
            <div className="flex w-full h-4 rounded-xl bg-[#37464f]"></div>
            <div className="
              flex gap-1 items-center
              text-lg text-amber-400 font-bold
              "
            >
              <Star size={24} weight="fill" />
              <span>5</span>
            </div>
        </div>
      </div>
      
      <div className="h-header"></div>  
    </div>

  );
};

export default Header;
