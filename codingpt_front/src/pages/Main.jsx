import React from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Gear, 
  Code, 
  Play, 
  Microphone 
} from '@phosphor-icons/react';

const Main = () => {
  const navigate = useNavigate();

  const routes = [
    {
      path: '/admin',
      title: 'Admin',
      description: '관리자 페이지',
      icon: Gear,
      color: 'bg-purple-500 hover:bg-purple-600',
      iconColor: 'text-purple-100',
    },
    {
      path: '/code/1',
      title: 'Code Editor',
      description: '코드 편집 및 작성',
      icon: Code,
      color: 'bg-blue-500 hover:bg-blue-600',
      iconColor: 'text-blue-100',
    },
    {
      path: '/execute',
      title: 'Execute',
      description: '코드 실행 및 테스트',
      icon: Play,
      color: 'bg-green-500 hover:bg-green-600',
      iconColor: 'text-green-100',
    },
    {
      path: '/tts',
      title: 'TTS',
      description: 'AI 음성 생성',
      icon: Microphone,
      color: 'bg-pink-500 hover:bg-pink-600',
      iconColor: 'text-pink-100',
    },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center p-4">
      <div className="max-w-6xl w-full">
        {/* 헤더 */}
        <div className="text-center mb-12">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            CodingPT
          </h1>
          <p className="text-xl text-gray-600">
            원하는 기능을 선택하세요
          </p>
        </div>

        {/* 라우트 카드 그리드 */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {routes.map((route) => {
            const IconComponent = route.icon;
            return (
              <button
                key={route.path}
                onClick={() => navigate(route.path)}
                className={`
                  ${route.color}
                  rounded-2xl p-8
                  shadow-lg hover:shadow-xl
                  transform hover:scale-105
                  transition-all duration-300
                  flex flex-col items-center justify-center
                  space-y-4
                  text-white
                  group
                `}
              >
                <div className={`
                  ${route.iconColor}
                  bg-white/20
                  rounded-full p-6
                  group-hover:bg-white/30
                  transition-all duration-300
                `}>
                  <IconComponent size={48} weight="duotone" />
                </div>
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">
                    {route.title}
                  </h2>
                  <p className="text-sm opacity-90">
                    {route.description}
                  </p>
                </div>
                <div className="
                  mt-2
                  text-xs
                  opacity-75
                  group-hover:opacity-100
                  transition-opacity
                ">
                  클릭하여 이동 →
                </div>
              </button>
            );
          })}
        </div>

        {/* 푸터 */}
        <div className="mt-12 text-center text-gray-500 text-sm">
          <p>각 기능을 클릭하여 해당 페이지로 이동합니다</p>
        </div>
      </div>
    </div>
  );
};

export default Main;

