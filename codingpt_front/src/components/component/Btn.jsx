// src/components/home/main
import React from 'react';

import { motion } from "framer-motion";

const Btn = ({ text, color='cyan', onClick=()=>{}, disabled }) => {
  let buttonColorClass;
  if(color === 'cyan'){
    buttonColorClass = 'text-[#131f24] active:text-[#131f24] before:bg-[#93d333] before:shadow-[0_4px_0_#79b933]';
  }
  if(color === 'white'){
    buttonColorClass = 'bg-white text-[#93d333] active:bg-gray-50 ';
  }
  if(color === 'red'){
    buttonColorClass = 'text-[#131f24] active:text-[#131f24] before:bg-[#e55] before:shadow-[0_4px_0_#d84848]'
  }
  if(disabled) {
    buttonColorClass = 'text-[#52656d] before:bg-[#37464f] before:shadow-none'
  }
  return (
    <div className="
      
      flex 
      w-full h-12 
    ">
      
      <button 
        className={`
          relative z-0
          w-full h-[50px]
          px-4 
          border-solid border-b-4 rounded-2xl
          text-[15px] font-bold
          
          outline: none;
          border-transparent
          select-none


          
          active:translate-y-[2px]
          active:before:shadow-none
          
          before:content-['']
          before:absolute
          before:right-0
          before:top-0
          before:bottom-0
          before:left-0
          before:-z-[1]
          
          before:rounded-2xl
          before:shadow-[0_4px_0]
          before:text-white/70
          
          before:active:translate-y-[2px]

          ${buttonColorClass}
          ${disabled ? 'cursor-not-allowed pointer-events-none' : ``}
        `}
        disabled={disabled}
        onClick={onClick}
      >
        {text}
      </button>

      {/* <motion.button
        className={`
          z-0
          h-12 w-full
          border-b-4 rounded-xl 
          ${buttonColorClass} font-semibold
          
          active:h-11 
          active:mt-1 
          active:border-b-0
          select-none
          ${disabled ? 'cursor-not-allowed pointer-events-none' : ``}

        `}
        disabled={disabled} 
        onClick={onClick}
      >
        {text}
      </motion.button> */}
    </div>
  );
}

export default Btn;