import React from 'react';

const Header = () => {
  return (
    <header className="w-full bg-white border-b border-gray-200 py-4 px-6">
      <h1 className="text-2xl font-bold text-gray-900">TTS 음성 생성</h1>
      <p className="text-sm text-gray-600 mt-1">
        ElevenLabs API를 이용한 AI 음성 생성 및 관리
      </p>
    </header>
  );
};

export default Header;

