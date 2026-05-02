import React from 'react';
import { Info } from '@phosphor-icons/react';

const SettingsPanel = ({ settings, onSettingsChange, settingsSchema }) => {
  const handleChange = (key, value) => {
    onSettingsChange({
      ...settings,
      [key]: value,
    });
  };

  if (!settingsSchema || Object.keys(settingsSchema).length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-gray-700">상세 설정</h3>
        <p className="text-sm text-gray-500">모델을 선택하면 설정 옵션이 표시됩니다.</p>
      </div>
    );
  }

  const renderSetting = (key, schema) => {
    if (!schema || !schema.supported) {
      return null;
    }

    const currentValue = settings[key] !== undefined ? settings[key] : schema.default;

    if (schema.type === 'boolean') {
      return (
        <div key={key} className="flex items-center gap-2 flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <label className="text-xs font-medium text-gray-700 whitespace-nowrap">
              {key === 'use_speaker_boost' ? '화자 부스트' : key}
            </label>
            {schema.description && (
              <div className="group relative">
                <Info size={14} className="text-gray-400 cursor-help" />
                <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                  {schema.description}
                </div>
              </div>
            )}
          </div>
          <input
            type="checkbox"
            checked={currentValue !== false}
            onChange={(e) => handleChange(key, e.target.checked)}
            className="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 ml-auto"
          />
        </div>
      );
    }

    // 숫자 슬라이더
    return (
      <div key={key} className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <label className="text-xs font-medium text-gray-700 whitespace-nowrap">
            {key === 'stability' ? '안정성' :
             key === 'similarity_boost' ? '유사도 부스트' :
             key === 'style' ? '스타일' :
             key === 'speed' ? '속도' : key}
          </label>
          {schema.description && (
            <div className="group relative">
              <Info size={14} className="text-gray-400 cursor-help" />
              <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block w-64 p-2 bg-gray-900 text-white text-xs rounded shadow-lg z-10">
                {schema.description}
              </div>
            </div>
          )}
          <span className="text-xs font-medium text-gray-700 whitespace-nowrap ml-auto">
            {key === 'speed' ? `${currentValue.toFixed(2)}x` : currentValue.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          min={schema.min}
          max={schema.max}
          step={key === 'speed' ? 0.1 : 0.01}
          value={currentValue}
          onChange={(e) => handleChange(key, parseFloat(e.target.value))}
          className="w-full"
        />
        <div className="flex justify-between text-xs text-gray-500 mt-0.5">
          <span className="text-[10px]">{schema.min}{key === 'speed' ? 'x' : ''}</span>
          <span className="text-[10px]">{schema.max}{key === 'speed' ? 'x' : ''}</span>
        </div>
      </div>
    );
  };

  // 설정 키의 우선순위 (표시 순서)
  const settingOrder = ['stability', 'similarity_boost', 'style', 'speed', 'use_speaker_boost'];
  
  // settingsSchema를 순회하여 지원하는 설정만 동적으로 렌더링
  const supportedSettings = Object.keys(settingsSchema)
    .filter(key => settingsSchema[key]?.supported)
    .sort((a, b) => {
      // 우선순위에 따라 정렬 (우선순위에 없는 것은 뒤로)
      const indexA = settingOrder.indexOf(a);
      const indexB = settingOrder.indexOf(b);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });

  return (
    <div>
      <h3 className="text-sm font-medium text-gray-700 mb-3">상세 설정</h3>
      
      {supportedSettings.length === 0 ? (
        <p className="text-sm text-gray-500">이 모델은 추가 설정을 지원하지 않습니다.</p>
      ) : (
        <div className="flex flex-wrap gap-4">
          {/* settingsSchema를 순회하여 지원하는 설정만 동적으로 렌더링 */}
          {supportedSettings.map((key) => {
            const schema = settingsSchema[key];
            return renderSetting(key, schema);
          })}
        </div>
      )}
    </div>
  );
};

export default SettingsPanel;
