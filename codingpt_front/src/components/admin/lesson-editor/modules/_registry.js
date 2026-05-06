import paragraph from './paragraph.jsx';
import image from './image.jsx';
import webview from './webview.jsx';
import characterSpeechBubble from './characterSpeechBubble.jsx';
import missionList from './missionList.jsx';
import missionCard from './missionCard.jsx';
import conceptCard from './conceptCard.jsx';
import tagDescriptionList from './tagDescriptionList.jsx';
import iconBadge from './iconBadge.jsx';
import card from './card.jsx';
import code from './code.jsx';
import terminal from './terminal.jsx';
import { multipleChoice, trueFalseChoice } from './multipleChoice.jsx';
import clickSequenceQuiz from './clickSequenceQuiz.jsx';
import codeFillTheGapV2 from './codeFillTheGapV2.jsx';
import dragAndDropQuiz from './dragAndDropQuiz.jsx';
import lottie from './lottie.jsx';
import { actionButton, actionButtons } from './actionButton.jsx';
import highlightParagraph from './highlightParagraph.jsx';

const allDefinitions = [
  paragraph,
  image,
  webview,
  characterSpeechBubble,
  missionList,
  missionCard,
  conceptCard,
  tagDescriptionList,
  iconBadge,
  card,
  code,
  terminal,
  multipleChoice,
  trueFalseChoice,
  clickSequenceQuiz,
  codeFillTheGapV2,
  dragAndDropQuiz,
  lottie,
  actionButton,
  actionButtons,
  highlightParagraph,
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

export const MODULES_BY_CATEGORY = CATEGORIES.map((cat) => ({
  ...cat,
  modules: allDefinitions.filter((d) => d.category === cat.key),
}));

export const getModuleDefinition = (type) => MODULE_REGISTRY[type];
