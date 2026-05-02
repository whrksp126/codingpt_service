// src/components/curriculumList/Header.jsx
import { X } from "@phosphor-icons/react";

const Header = () => {
  return (
    <div className="
      fixed top-0
      w-full
      border-b-1 border-main
      text-white
    ">
      <div className="h-8 w-full"></div>
      <div className="
        relative
        flex justify-between items-center
        h-14 w-full
        px-4
      ">
        <button onClick={() => {window.history.back();}}><X size={34} /></button>
        <h1
          className="
            absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2
            text-xl font-bold
          "
        >커리큘럼</h1>
        <div></div>
      </div>
    </div>
    

  );
};

export default Header;
