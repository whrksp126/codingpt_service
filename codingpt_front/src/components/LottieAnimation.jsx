// src/components/LottieAnimation.js
import React from 'react';
import Lottie from 'react-lottie';
import home_main from '../animations/home_main.json';
import welcome_main from '../animations/welcome_main.json';

// 애니메이션 데이터를 객체로 묶어서 관리
const animations = {
  home_main: home_main,
  welcome_main: welcome_main,
};

const LottieAnimation = ({ width,  height, animationKey  }) => {
  const selectedAnimation = animations[animationKey] || home_main; // 기본값으로 animationData1을 사용
  
  const defaultOptions = {
    loop: true,
    autoplay: true,
    animationData: selectedAnimation,
    rendererSettings: {
      preserveAspectRatio: 'xMidYMid slice',
    },
  };

  return <Lottie width={width} height={height} options={defaultOptions} />;
};

export default LottieAnimation;