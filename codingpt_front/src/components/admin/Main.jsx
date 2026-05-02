// src/components/home/main
import React from 'react';
import { useNavigate } from 'react-router-dom';
import LottieAnimation from '../LottieAnimation';
import Btn from '../component/Btn';
import * as common from '../../utils/common';
console.log(common.backendUrl)

const Main = () => {
  const navigate = useNavigate();
  const handleStartClick = () => {
    navigate('/register');
  };
  
  return (
    <div className="
      flex flex-col
      max-w-96 h-screen
      p-3
      pb-5
      
    ">
    </div>
  )
}
export default Main;