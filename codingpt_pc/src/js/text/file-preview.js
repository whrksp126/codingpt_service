// 파일 미리보기의 화면 문구. text/index.js 의 규율을 따른다.
//  ⚠ 앱(codingpt_app/src/text/filePreview.ts)에 같은 키·같은 뜻의 사전이 있다(대조 테스트).
export const FILE_PREVIEW_TEXT = {
  ko: {
    asText: '원문 보기',
    asPreview: '미리보기로 보기',
    openAsText: '텍스트로 열기',
    unsupported: '미리보기를 지원하지 않는 형식이에요',
    badJson: 'JSON 형식이 아니에요. 원문 보기로 확인하세요.',
    tableTruncated: '앞부분만 표로 보여요 — 전체는 원문 보기로 확인하세요.',
    loading: '불러오는 중…',
    tooBig: '파일이 커서 미리보기를 건너뛰었어요(8MB 초과)',
    notOnThisDevice: '이 기기에서는 미리볼 수 없는 형식이에요. PC 에서 열어 보세요.',
  },
  en: {
    asText: 'View source',
    asPreview: 'Back to preview',
    openAsText: 'Open as text',
    unsupported: 'Preview is not supported for this format',
    badJson: 'Not valid JSON. Use \u201cView source\u201d instead.',
    tableTruncated: 'Showing the first rows only \u2014 use \u201cView source\u201d for the whole file.',
    loading: 'Loading\u2026',
    tooBig: 'File is too large to preview (over 8MB)',
    notOnThisDevice: 'This format cannot be previewed on this device. Open it on your PC.',
  },
};
