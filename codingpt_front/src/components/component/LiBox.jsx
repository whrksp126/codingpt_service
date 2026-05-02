// src/components/component/LiBox
import React from 'react';

const LiBox = ({ title, text, src, isLast }) => {
  return (
    <li 
      className={`
        flex gap-4 items-start
        py-8
        ${!isLast ? 'border-b-2 border-gray-200' : ''}
      `}
    >
      <img src={src} alt="" />
      <div >
        <div 
          className={`
            mb-2
            text-xl font-bold
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
    </li>
  );
};


export default LiBox;