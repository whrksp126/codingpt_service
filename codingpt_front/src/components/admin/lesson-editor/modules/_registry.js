import paragraph from './paragraph.jsx';
import quote from './quote.jsx';
import image from './image.jsx';
import webview from './webview.jsx';
import characterSpeechBubble from './characterSpeechBubble.jsx';
import missionList from './missionList.jsx';
import tagDescriptionList from './tagDescriptionList.jsx';
import code from './code.jsx';
import terminal from './terminal.jsx';
import simpleTerminal from './simpleTerminal.jsx';
import { multipleChoice, trueFalseChoice } from './multipleChoice.jsx';
import codeFillTheGapV2 from './codeFillTheGapV2.jsx';
import lottie from './lottie.jsx';
import { actionButton, actionButtons } from './actionButton.jsx';

const allDefinitions = [
  paragraph,
  quote,
  image,
  webview,
  characterSpeechBubble,
  missionList,
  tagDescriptionList,
  code,
  terminal,
  simpleTerminal,
  multipleChoice,
  trueFalseChoice,
  codeFillTheGapV2,
  lottie,
  actionButton,
  actionButtons,
];

export const MODULE_REGISTRY = Object.fromEntries(allDefinitions.map((d) => [d.type, d]));

export const CATEGORIES = [
  { key: 'text', label: '텍스트' },
  { key: 'media', label: '미디어' },
  { key: 'character', label: '캐릭터' },
  { key: 'structure', label: '구조/카드' },
  { key: 'code', label: '코드' },
  { key: 'quiz', label: '퀴즈' },
  { key: 'action', label: '액션' },
];

// 모듈 추가 팔레트에 노출되는 모듈만 — hiddenFromPalette: true 인 모듈은 다른 모듈의 종속 모듈이므로 숨김
// (e.g. codeRunResult 는 코드 모듈의 "결과 모듈 추가" 버튼으로만 생성)
export const MODULES_BY_CATEGORY = CATEGORIES.map((cat) => ({
  ...cat,
  modules: allDefinitions.filter((d) => d.category === cat.key && !d.hiddenFromPalette),
}));

export const getModuleDefinition = (type) => MODULE_REGISTRY[type];
