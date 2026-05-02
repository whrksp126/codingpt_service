// src/components/component/SelectBox
import React from 'react';

const SelectBox = ({ type=1, title=null, text, src=null, onClick = () => {}, isSelected }) => {
  if(type === 1){
    return (
      <li
        className="
          w-full 
        "
      >
        <div 
          className={`
            flex items-center gap-4
            w-full
            px-4 py-2
            border-2 border-b-4 rounded-xl 
            font-semibold
            
            select-none cursor-pointer 
            active:mt-[2px]
            active:border-b-2
            active:border-cyan-400
            active:bg-cyan-50
            ${isSelected ? 'border-cyan-400 text-cyan-500 bg-cyan-50' : ''}
          `}
          onClick={onClick}
        >
          <img src={src} alt={text} />  
          <span>{text}</span>
        </div>
      </li>
    );
  }
  if(type === 2){
    return (
      <li
        className="
          w-full 
        "
      >
        <div 
          className={`
            flex items-center justify-between gap-4 
            w-full
            px-4 py-2
            border-2 border-b-4 rounded-xl 
            font-semibold
            
            select-none cursor-pointer 
            active:mt-[2px]
            active:border-b-2
            active:border-cyan-400
            active:bg-cyan-50
            ${isSelected ? 'border-cyan-400 text-cyan-500 bg-cyan-50' : ''}
          `}
          onClick={onClick}
        >
          <span>{title}</span>
          <span className={`
            py-2  
          `}>
            {text}
          </span>
        </div>
      </li>
    );
  }
  if(type === 3){
    return (
      <li
        className="
          w-full 
        "
      >
        <div 
          className={`
            flex gap-4
            w-full
            px-4 py-2
            border-2 border-b-4 rounded-xl 
            font-semibold
            
            select-none cursor-pointer 
            active:mt-[2px]
            active:border-b-2
            active:border-cyan-400
            active:bg-cyan-50
            ${isSelected ? 'border-cyan-400 text-cyan-500 bg-cyan-50' : ''}
          `}
          onClick={onClick}
        >
          <img 
            className={`
              w-20
            `}
            src={src} 
            alt={text} 
          />
          <div>
            <div
              className={`
                text-lg font-bold
              `}
            >
              {title}
            </div>
            <div
              className={`
                text-base
              `}
            >
              {text}
            </div>
          </div>
  
          
        </div>
      </li>
    );
  }
};


export default SelectBox;