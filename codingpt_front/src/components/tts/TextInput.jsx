import React, { useState } from 'react';

const TextInput = ({ value, onChange }) => {
  const [charCount, setCharCount] = useState(0);

  const handleChange = (e) => {
    const text = e.target.value;
    setCharCount(text.length);
    onChange(text);
  };

  // 감정 표현 제거한 텍스트 (미리보기용)
  const previewText = value.replace(/\[.*?\]/g, '').trim();

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-gray-700 mb-2">
        텍스트 입력
      </label>
      <textarea
        value={value}
        onChange={handleChange}
        placeholder="음성으로 변환할 텍스트를 입력하세요. 감정 표현은 [점점 화나면서] 형식으로 사용할 수 있습니다."
        rows={6}
        className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      <div className="flex justify-between items-center text-xs text-gray-500">
        <span>글자 수: {charCount}</span>
        <span className="text-blue-600">
          감정 표현 안내: [점점 화나면서] 형식 사용 가능
        </span>
      </div>
      {previewText && (
        <div className="mt-2 p-2 bg-gray-50 rounded text-sm">
          <span className="text-gray-600">미리보기: </span>
          <span className="text-gray-800">{previewText}</span>
        </div>
      )}
    </div>
  );
};

export default TextInput;

