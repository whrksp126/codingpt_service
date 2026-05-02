// ID : 1
const HTML_1 = {
  "lessons": [
    {
      "id": 1,
      "title": "웹은 어떻게 생겼을까?🧐",
      "isCompleted": false,
      "sliders": [
        {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요👋 \n## 오늘은 HTML을 맛보기로 알아봐요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/001_반가워요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "HTML은 뼈대🦴, 태그는 이름표🔖",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/1/1/1/image/002_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## 웹페이지는 제목·그림·버튼 같은 블록이\n## 모여 만들어져요.",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/002_웹페이지는_블록이_모여_만들어져요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "HTML은 **웹의 뼈대🦴**이고,\n  태그(tag)는 `< >` **안에 적는 🔖이름표**에요.",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/003_HTML은_웹의_뼈대.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 3,
              "type": "paragraph",
              "content": "큰 제목은 `<h1>`, 문단은 `<p>`, 이미지는 `<img>` 등\n **다양한 태그**의 종류가 있어요.",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/004_다양한_종류의_태그가_있어요.mp3",
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 2,
          "title": "제목 태그는 뭘까?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/005_가장_큰_제목을_나타내는_태그는_뭘까.mp3",
              "questions": [
                {
                  "title": "가장 큰 제목을 나타내는 태그🔖는 뭘까?",
                  "interactionOptions": [
                    { "label": "<p>" },
                    { "label": "<img>" },
                    { "label": "<h1>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 잘했어요!\n제목은 h1~h6 계열 태그를 사용하고,\n  그중 **<h1>이 가장 커요.**",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/006_잘했어요_제목은_h_계열_태그를_사용.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `<h1>`이에요.\n**<p>**는 문단, **<img>**는 이미지 태그입니다!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/007_정답은_h1_태그에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 코드와 브라우저를 보면서 제목 태그를\n 더 자세히 알아봐요! 🤓",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/008_제목_태그를_더_알아봐요.mp3",
              "height": 180,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>Hellow world</h1>\n<h2>Hellow world</h2>\n<h3>Hellow world</h3>\n<h4>Hellow world</h4>\n<h5>Hellow world</h5>\n<h6>Hellow world</h6>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>결과보기</title><style>body{font-family:system-ui;padding:16px}</style></head><body><h1>Hellow world</h1><h2>Hellow world</h2><h3>Hellow world</h3><h4>Hellow world</h4><h5>Hellow world</h5><h6>Hellow world</h6></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 3,
          "title": "🪄 문장을 하나의 덩어리로 묶는 태그",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/009_문장을_하나의_덩어리로_묶는_태그는_뭘까.mp3",
              "questions": [
                {
                  "title": "문장을 하나의 덩어리로 묶는 태그는 뭘까?",
                  "interactionOptions": [
                    { "label": "<div>" },
                    { "label": "<p>" },
                    { "label": "<span>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답!\n`<p>`는 paragraph(문단)의 약자예요 🤓",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/010_정답이에요_p태그는_paragraph의_약자로_문단이라는_뜻이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `<p>`이에요.\n`<div>`는 문단, `<span>`은 텍스트 덩어리입니다! 😊",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/011_정답은_p태그에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 코드와 브라우저를 보면서 문단 태그를\n 더 자세히 알아봐요! 🧑‍💻",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/012_문단_태그를_더_알아봐요.mp3",
              "height": 120,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>문단 예시</h1>\n<p>안녕하세요! 이것은 첫 번째 문단입니다.</p>\n<p>HTML의 p 태그는 이렇게 문장을 하나의 단락으로 묶어줘요.</p>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>결과보기</title><style>body{font-family:system-ui;padding:16px}</style></head><body><h1>문단 예시</h1><p>안녕하세요! 이것은 첫 번째 문단입니다.</p><p>HTML의 p 태그는 이렇게 문장을 하나의 단락으로 묶어줘요.</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 4,
          "title": "👩‍💻 코드 빈칸 채우기: 인사 페이지 만들기",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "빈칸을 채워서 간단한 인사 페이지를 만들어봐요! ✨",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/013_빈칸을_채워_간단한_인사_페이지를_만들어봐요.mp3",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "",
                  "url": "/code/1",
                  "height": 85,
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "<h1>", "disabled": false },
                    { "id": "option-2", "value": "</h1>", "disabled": false },
                    { "id": "option-3", "value": "<p>", "disabled": false },
                    { "id": "option-4", "value": "</p>", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "<h1>", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "</p>", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 정답이에요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/014_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## **틀렸어요**🥹\n **제목은** `<h1>`, **문단은** `<p>`를 사용해요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/015_틀렸어요_제목은_h1태그_문단은_p태그를_사용해요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                
                ]
              }
            },
            {
              "id": 1,
              "type": "webview",
              "title": "🧑‍💻 아래 완성된 페이지를 볼까요?",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/018_아래_완성된_페이지를_볼까요.mp3",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>결과보기</title><style>body{font-family:system-ui;padding:16px}</style></head><body><h1>안녕하세요.</h1><p>저는 HTML을 배우고 있어요!🤓</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 5,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 🎯 오늘 배운 내용 정리\n- **HTML=뼈대🦴**\n- **태그=이름표🔖**\n- 제목: `<h1>`, 문단: `<p>`",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/016_오늘_배운_내용_정리_html은_뼈대_태그는_이름표.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "## 다음 레슨에서 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/017_다음_레슨에서_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 2
const HTML_2 = {
  "lessons": [
    {
      "id": 2,
      "title": "문서의 뼈대 🧱",
      "isCompleted": false,
      "sliders": [
        {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요👋 \n## 오늘은 HTML 문서의 뼈대를\n## 만들어봐요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/001_반가워요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "HTML의 뼈대🦴",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/1/1/1/image/002_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## 문서의 시작(doctype) → 전체 상자(html) \n## → 머리(head) → 몸(body) 순서로\n## 가볍게 익혀봐요 🙌",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/002_html의_구조.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "1) **`<!DOCTYPE html>`**:\n“이 문서는 HTML5!” 라고 **선언**하는 한 줄",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/003_doctype_html_태그_선언.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 3,
              "type": "paragraph",
              "content": "2) **`<html>…</html>`**: **문서 전체 상자**",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/004_html_태그는_문서_전체_상자에요.mp3",
              "visibility": { "type": "step", "value": 3 }
            },
            {
              "id": 4,
              "type": "paragraph",
              "content": "3) **`<head>…</head>`**: 화면에 **안 보이는 정보**",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/005_head_태그는_화면에_안_보이는_정보를_넣어요.mp3",
              "visibility": { "type": "step", "value": 4 }
            },
            {
              "id": 5,
              "type": "paragraph",
              "content": "4) **`<body>…</body>`**: 화면에 **보이는 내용**",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/006_body_태그는_화면에_보이는_내용을_넣어요.mp3",
              "visibility": { "type": "step", "value": 5 }
            }
          ]
        },
        {
          "id": 2,
          "title": "브라우저에 보이는 부분은 어디일까?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/007_브라우저에_보이는_부분은_어디일까.mp3",
              "questions": [
                {
                  "title": "브라우저에 보이는 내용이 들어가는 곳은 어디일까?",
                  "interactionOptions": [
                    { "label": "<head>" },
                    { "label": "<body>" },
                    { "label": "<html>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답!\n`<body>`는 화면에 **보이는 요소**들이 들어가요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/008_정답이에요_body_태그는_화면에_보이는_내용을_넣어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `<body>`예요.\n - **`<head>`**: 화면에 안 보이는 정보\n - **`<html>`**: 문서 전체 상자",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/009_정답은_body_태그예요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "아래 코드와 브라우저를 보면서 `<body>`를 더 자세히\n 알아봐요! ✨",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/010_body_태그를_더_알아봐요.mp3",
              "height": 150,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<body>\n  <h1>안녕하세요! 👋</h1>\n  <p>여기는 <strong>body</strong> 안에 있는 내용이에요.</p>\n  <button>버튼도 만들 수 있어요!</button>\n</body>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>body 태그 예시</title></head><body><h1>안녕하세요! 👋</h1><p>여기는 <strong>body</strong> 안에 있는 내용이에요.</p><button>버튼도 만들 수 있어요!</button></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 3,
          "title": "페이지 제목은 어디에 넣을까요?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/011_페이지_제목은_어디에_넣을까요.mp3",
              "questions": [
                {
                  "title": "브라우저 탭에 보이는 페이지 제목은 어디에 들어가야\n할까?",
                  "interactionOptions": [
                    { "label": "<head>" },
                    { "label": "<body>" },
                    { "label": "<doctype>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답!\n`<head>` 안에 페이지 제목이 들어가요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/012_정답이에요_head_태그_안에_페이지_제목이_들어가요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `<head>`예요.\n `<body>`는 화면에 보이는 내용이 들어가요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/013_정답은_head_태그예요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 코드와 브라우저를 보면서 `<head>`를\n더 자세히 알아봐요! 🧑‍💻",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/014_head_태그를_더_알아봐요.mp3",
              "height": 120,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<head>\n  <meta charset='UTF-8'>\n  <title>페이지 제목</title>\n</head>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>페이지 제목</title></head><body><h1>본문 내용은 여기 👇</h1><p>여기는 body 안에 표시돼요.</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 4,
          "title": "👩‍💻 코드 빈칸 채우기: html 문서 만들기",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "빈칸을 채워서 간단한 html 문서를 만들어봐요! ✨",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/015_빈칸을_채워_간단한_html_문서를_만들어봐요.mp3",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "",
                  "url": "/code/6",
                  "height": 265,
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "<body>", "disabled": false },
                    { "id": "option-2", "value": "</body>", "disabled": false },
                    { "id": "option-3", "value": "<head>", "disabled": false },
                    { "id": "option-4", "value": "</head>", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "<head>", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "<body>", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 **정답이에요!**\n문서의 뼈대가 올바르게 들어갔어요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/016_정답이에요_문서의_뼈대가_올바르게_들어갔어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## **틀렸어요**🥹\n**문서의 뼈대는** `<html>`, **머리는** `<head>`,\n**몸은** `<body>`를 사용해요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/017_틀렸어요_문서의_뼈대는_html_머리는_head_몸은_body를_사용해요_.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                
                ]
              }
            },
            {
              "id": 1,
              "type": "webview",
              "title": "🧑‍💻 아래 완성된 페이지를 볼까요?",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/018_아래_완성된_페이지를_볼까요.mp3",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>내 첫 페이지</title><style>body{font-family:system-ui;padding:16px}</style></head><body><h1>한 줄 소개</h1><p>저는 HTML을 재미있게 배우는 중이에요!</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 5,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 🎯 오늘 배운 내용 정리\n- **`<!DOCTYPE html>`**: HTML5 선언\n- **`<html>`**: 문서 전체 + 언어\n- **`<head>`**: 정보(제목/문자셋)\n- **`<body>`**: 화면에 보이는 내용",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/019_오늘_배운_내용_정리.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "## 다음 레슨에서 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/2/audio/020_다음_레슨에서_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 3
const HTML_3 = {
  "lessons": [
    {
      "id": 3,
      "title": "제목과 문단 ✍️",
      "isCompleted": false,
      "sliders": [
        {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요👋 \n## 오늘은 HTML 문서의 뼈대를\n## 만들어봐요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/001_반가워요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "HTML의 뼈대🦴",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/1/1/1/image/001_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## 문서의 시작(doctype) → 전체 상자(html) \n## → 머리(head) → 몸(body) 순서로\n## 가볍게 익혀봐요 🙌",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/002_웹페이지는_블록이_모여_만들어져요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "1) **`<!DOCTYPE html>`**:\n“이 문서는 HTML5!” 라고 **선언**하는 한 줄",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/003_HTML은_웹의_뼈대.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 3,
              "type": "paragraph",
              "content": "2) **`<html>…</html>`**: **문서 전체 상자**",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/004_다양한_종류의_태그가_있어요.mp3",
              "visibility": { "type": "step", "value": 3 }
            },
            {
              "id": 4,
              "type": "paragraph",
              "content": "3) **`<head>…</head>`**: 화면에 **안 보이는 정보**",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/004_다양한_종류의_태그가_있어요.mp3",
              "visibility": { "type": "step", "value": 4 }
            },
            {
              "id": 5,
              "type": "paragraph",
              "content": "4) **`<body>…</body>`**: 화면에 **보이는 내용**",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/004_다양한_종류의_태그가_있어요.mp3",
              "visibility": { "type": "step", "value": 5 }
            }
          ]
        },
        {
          "id": 2,
          "title": "화면에 보이는 부분은 어디일까?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/005_가장_큰_제목을_나타내는_태그는_뭘까.mp3",
              "questions": [
                {
                  "title": "**화면에 보이는 내용**이 들어가는 곳은 어디일까?",
                  "interactionOptions": [
                    { "label": "<head>" },
                    { "label": "<body>" },
                    { "label": "<html>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답!\n`<body>`는 화면에 **보이는 요소**들이 들어가요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/006_잘했어요_제목은_h_계열_태그를_사용.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `<body>`예요.\n**<head>**는 화면에 안 보이는 정보,\n**<html>**는 문서 전체 상자입니다!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/007_정답은_h1_태그에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "아래 코드와 브라우저를 보면서\n **<body>**를 더 자세히 알아봐요! ✨",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/008_제목_태그를_더_알아봐요.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "code",
              "title": "<body> 예시",
              "height": 150,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<body>\n  <h1>안녕하세요! 👋</h1>\n  <p>여기는 <strong>body</strong> 안에 있는 내용이에요.</p>\n  <button>버튼도 만들 수 있어요!</button>\n</body>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>body 태그 예시</title></head><body><h1>안녕하세요! 👋</h1><p>여기는 <strong>body</strong> 안에 있는 내용이에요.</p><button>버튼도 만들 수 있어요!</button></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "페이지 제목은 어디에 넣을까요?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/009_문장을_하나의_덩어리로_묶는_태그는_뭘까.mp3",
              "questions": [
                {
                  "title": "브라우저 탭에 보이는 **페이지 제목**은 어디에 들어가야 할까?",
                  "interactionOptions": [
                    { "label": "<head>" },
                    { "label": "<body>" },
                    { "label": "<doctype>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답!\n`<head>` 안에 페이지 제목이 들어가요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/010_정답이에요_p태그는_paragraph의_약자로_문단이라는_뜻이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `<head>`예요.\n`<body>`는 화면에 보이는 내용이 들어가요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/011_정답은_p태그에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "👇아래 코드와 브라우저를 보면서 \n **<head>**를 더 자세히 알아봐요! 🧑‍💻",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/012_문단_태그를_더_알아봐요.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "code",
              "title": "<head> 예시",
              "height": 120,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<head>\n  <meta charset='UTF-8'>\n  <title>이것이 브라우저 탭 제목!</title>\n</head>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>이것이 브라우저 탭 제목!</title></head><body><h1>본문 내용은 여기 👇</h1><p>여기는 body 안에 표시돼요.</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "👩‍💻 코드 빈칸 채우기: html 문서 만들기",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "빈칸을 채워서 간단한 html 문서를 만들어봐요! ✨",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/013_빈칸을_채워_간단한_인사_페이지를_만들어봐요.mp3",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "",
                  "url": "/code/6",
                  "height": 265,
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "<body>", "disabled": false },
                    { "id": "option-2", "value": "</body>", "disabled": false },
                    { "id": "option-3", "value": "<head>", "disabled": false },
                    { "id": "option-4", "value": "</head>", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "<head>", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "<body>", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 **멋져요!**\n문서의 뼈대가 올바르게 들어갔어요. \n🧑‍💻 아래 **내가 만든 html 문서**를 볼까요?",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/014_멋져요_제목과_문단이_올바르게_들어갔어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## **틀렸어요**🥹\n**문서의 뼈대는** `<html>`, **머리는** `<head>`,\n**몸은** `<body>`를 사용해요.\n\n👇 이제 아래 **결과 브라우저**를 볼까요?",
                    "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/015_틀렸어요_제목은_h1_태그_문단은_p_태그를_사용해요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                
                ]
              }
            },
            {
              "id": 1,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>내 첫 페이지</title><style>body{font-family:system-ui;padding:16px}</style></head><body><h1>한 줄 소개</h1><p>저는 HTML을 재미있게 배우는 중이에요!</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 5,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 🎯 오늘 배운 내용 정리\n- **`<!DOCTYPE html>`**: HTML5 선언\n- **`<html>`**: 문서 전체 + 언어\n- **`<head>`**: 정보(제목/문자셋)\n- **`<body>`**: 화면에 보이는 내용",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/016_오늘_배운_내용_정리_html은_뼈대_태그는_이름표.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "## 다음 레슨에서 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/1/1/1/audio/017_다음_레슨에서_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 4
const HTML_4 = {
  "lessons": [
    {
      "id": 3,
      "title": "폼(Forms) 입문",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 폼(Forms)에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "폼 기본 구조: <form>, <label>, <input>",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧭 폼의 뼈대\n- `<form>`: 입력을 **묶어** 서버로 전송하는 컨테이너\n- `<label for=\"...\">`: 레이블을 **특정 입력과 연결**(접근성↑)\n- `<input>`: 실제 사용자 **입력 필드**",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "레이블과 입력을 연결하려면 레이블에는 `for`, 입력에는 어떤 속성이 같은 값으로 있어야 할까요?",
                  "interactionOptions": [
                    { "label": "name" },
                    { "label": "id" },
                    { "label": "value" },
                    { "label": "class" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! `<label for>` ↔ `<input id>`가 같아야 연결됩니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `for`는 레이블, `id`는 입력. 두 값이 같아야 클릭 시 포커스가 이동해요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<form>\n  <label {{BLANK-1}}=\"email\">이메일</label>\n  <input {{BLANK-2}}=\"email\" type=\"email\" name=\"email\" />\n</form>",
                  "url": "/code/21",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "id", "disabled": false },
                    { "id": "option-2", "value": "for", "disabled": false },
                    { "id": "option-3", "value": "placeholder", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "for", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "id", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 잘했어요! 레이블-입력 연결이 완성됐습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `label for`와 `input id`는 값이 같아야 합니다. 접근성에 꼭 필요해요!",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}label{display:block;margin-bottom:6px}input{padding:8px;border:1px solid #ccc;border-radius:8px}</style></head><body><form><label for=\"email\">이메일</label><input id=\"email\" type=\"email\" name=\"email\" /></form></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "입력 타입 기본: text / email / password",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🔤 입력 타입\n- `type=\"text\"`: 일반 텍스트\n- `type=\"email\"`: 이메일 형식 기본 검사\n- `type=\"password\"`: 비밀번호(가려진 표시)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "이메일 형식을 기본적으로 체크하는 입력 타입은?",
                  "interactionOptions": [
                    { "label": "text" },
                    { "label": "email" },
                    { "label": "password" },
                    { "label": "search" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 맞아요! `email` 타입은 기본 검증이 들어갑니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 정답은 `email`입니다. 형식 검사와 모바일 키보드 최적화가 됩니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<form>\n  <input type=\"{{BLANK-1}}\" name=\"username\" />\n  <input type=\"{{BLANK-2}}\" name=\"email\" />\n  <input type=\"{{BLANK-3}}\" name=\"password\" />\n</form>",
                  "url": "/code/22",
                  "isInteractive": true,
                  "inputLength": 3,
                  "interactionOptions": [
                    { "id": "option-1", "value": "text", "disabled": false },
                    { "id": "option-2", "value": "name", "disabled": false },
                    { "id": "option-3", "value": "password", "disabled": false },
                    { "id": "option-4", "value": "email", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "text", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "email", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "password", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 좋습니다! 기본 타입 3종 세팅 완료!",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `text`/`email`/`password`의 용도를 다시 확인해 주세요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}input{display:block;margin:6px 0;padding:8px;border:1px solid #ccc;border-radius:8px}</style></head><body><form><input type=\"text\" name=\"username\" /><input type=\"email\" name=\"email\" /><input type=\"password\" name=\"password\" /></form></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "placeholder와 required",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ✒️ 힌트와 필수 입력\n- `placeholder`: 입력 전 **도움말 텍스트**\n- `required`: 제출 전 **빈값 금지**(기본 검증)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "입력 칸에 흐릿한 안내 문구를 보여주는 속성은?",
                  "interactionOptions": [
                    { "label": "label" },
                    { "label": "placeholder" },
                    { "label": "title" },
                    { "label": "hint" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 맞아요! `placeholder`는 입력 전 힌트를 제공합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 정답은 `placeholder`입니다. 필수 입력은 `required`로 지정해요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<form>\n  <input type=\"email\" name=\"email\" {{BLANK-1}}=\"이메일\" {{BLANK-2}} />\n</form>",
                  "url": "/code/23",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "maxlength", "disabled": false },
                    { "id": "option-2", "value": "required", "disabled": false },
                    { "id": "option-3", "value": "placeholder", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "placeholder", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "required", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 잘했어요! 힌트와 필수 조건을 모두 적용했습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `placeholder`는 힌트, `required`는 필수 입력을 위한 속성입니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}input{padding:8px;border:1px solid #ccc;border-radius:8px}</style></head><body><form><input type=\"email\" name=\"email\" placeholder=\"이메일\" required /></form></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "한 개만 고르기/여러 개 선택: radio / checkbox",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ✅ 선택 입력\n- `radio`: **하나만** 선택, 같은 `name` 공유\n- `checkbox`: **여러 개** 선택 가능(각자 독립적으로 체크)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "두 옵션 중 **하나만** 선택하도록 만들 때 적합한 입력 타입은?",
                  "interactionOptions": [
                    { "label": "checkbox" },
                    { "label": "radio" },
                    { "label": "text" },
                    { "label": "select" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! `radio`는 같은 `name`을 공유할 때 하나만 선택됩니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `radio`는 단일 선택, `checkbox`는 복수 선택에 사용합니다. `name` 공유 여부가 핵심!",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<form>\n  <label for=\"lv-basic\">Basic</label>\n  <input type=\"{{BLANK-1}}\" id=\"lv-basic\" {{BLANK-2}}=\"level\" value=\"basic\" />\n  <label for=\"lv-pro\">Pro</label>\n  <input type=\"{{BLANK-1}}\" id=\"lv-pro\" {{BLANK-2}}=\"level\" value=\"pro\" />\n</form>",
                  "url": "/code/24",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "radio", "disabled": false },
                    { "id": "option-2", "value": "checkbox", "disabled": false },
                    { "id": "option-3", "value": "name", "disabled": false },
                    { "id": "option-4", "value": "value", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "radio", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "name", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 잘했어요! 같은 `name`을 공유해 단일 선택이 동작합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `radio` + 같은 `name` 조합이 단일 선택의 핵심입니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}label{margin-right:8px}</style></head><body><form><label for=\"lv-basic\">Basic</label><input type=\"radio\" id=\"lv-basic\" name=\"level\" value=\"basic\" /><label for=\"lv-pro\">Pro</label><input type=\"radio\" id=\"lv-pro\" name=\"level\" value=\"pro\" /></form></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "여러 줄 입력과 선택: textarea / select",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📝 멀티라인 & 목록 선택\n- `<textarea>`: 여러 줄 텍스트 입력\n- `<select><option>`: 목록에서 선택(단일/다중은 `multiple`로 제어)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "여러 줄의 텍스트를 입력받기에 적절한 태그는?",
                  "interactionOptions": [
                    { "label": "<input type=\"text\">" },
                    { "label": "<textarea>" },
                    { "label": "<select>" },
                    { "label": "<output>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! 여러 줄은 `<textarea>`가 적합합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 정답은 `<textarea>`입니다. `<input type=\"text\">`는 한 줄 입력이에요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<form>\n  <{{BLANK-1}} name=\"city\">\n    <option>Seoul</option>\n    <option>Busan</option>\n  </{{BLANK-1}}>\n  <{{BLANK-2}} rows=\"3\" cols=\"30\">메모</{{BLANK-2}}>\n</form>",
                  "url": "/code/25",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "select", "disabled": false },
                    { "id": "option-2", "value": "option", "disabled": false },
                    { "id": "option-3", "value": "datalist", "disabled": false },
                    { "id": "option-4", "value": "textarea", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "select", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "textarea", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 좋습니다! 선택과 여러 줄 입력을 함께 구성했어요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `<select>`와 `<textarea>`의 역할을 구분해 주세요. 둘 다 닫는 태그가 필요합니다!",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}select,textarea{display:block;margin:6px 0;padding:8px;border:1px solid #ccc;border-radius:8px}</style></head><body><form><select name=\"city\"><option>Seoul</option><option>Busan</option></select><textarea rows=\"3\" cols=\"30\">메모</textarea></form></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "폼 제출: action, method, submit 버튼",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📮 제출의 기본\n- `action`: 데이터를 보낼 **주소(URL)**\n- `method`: 전송 방식(`GET`은 URL에 노출, `POST`는 본문으로 전송)\n- `<button type=\"submit\">`: 제출 트리거 버튼",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "데이터가 URL에 붙어 전송되는 방식은?",
                  "interactionOptions": [
                    { "label": "GET" },
                    { "label": "POST" },
                    { "label": "PUT" },
                    { "label": "PATCH" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! 간단 조회/검색 폼에 자주 쓰입니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 정답은 `GET`입니다. 민감한 정보는 `POST`로 보내는 게 안전해요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<form action=\"/signup\" method=\"{{BLANK-1}}\">\n  <input type=\"text\" name=\"username\" placeholder=\"이름\" required />\n  <button type=\"{{BLANK-2}}\">가입</button>\n</form>",
                  "url": "/code/26",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "get", "disabled": false },
                    { "id": "option-2", "value": "post", "disabled": false },
                    { "id": "option-3", "value": "submit", "disabled": false },
                    { "id": "option-4", "value": "button", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "post", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "submit", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 잘했습니다! 전송 방식과 제출 버튼의 역할을 구분했어요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `method`는 `get`/`post` 중 하나, 버튼 제출은 `type=\"submit\"`을 사용합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}input,button{padding:8px;border:1px solid #ccc;border-radius:8px}button{margin-left:6px}</style></head><body><form action=\"/signup\" method=\"get\"><input type=\"text\" name=\"username\" placeholder=\"이름\" required /><button type=\"submit\">가입</button></form></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 5
const HTML_5 = {
  "lessons": [
    {
      "id": 5,
      "title": "이미지와 미디어",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 이미지와 미디어에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "img의 필수: src와 alt",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🖼️ 이미지 기본\n- `<img src=\"...\" alt=\"...\">`\n- `src`: 이미지 **경로**\n- `alt`: 이미지 **대체 텍스트**(이미지 로드 실패/스크린리더용)\n> 장식용 이미지는 빈 `alt=\"\"`로 표기하면 스크린리더가 건너뜁니다.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "접근성을 위해 콘텐츠 이미지에 **반드시** 제공해야 하는 속성은?",
                  "interactionOptions": [
                    { "label": "title" },
                    { "label": "width" },
                    { "label": "alt" },
                    { "label": "loading" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! `alt`는 이미지 의미를 텍스트로 전달합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 정답은 `alt`입니다. 시각 정보를 텍스트로 보완해 줍니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<p>우리 팀 로고</p>\n<img {{BLANK-1}}=\"/images/team-logo.png\" {{BLANK-2}}=\"팀 로고\"/>",
                  "url": "/code/33",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "href", "disabled": false },
                    { "id": "option-2", "value": "src", "disabled": false },
                    { "id": "option-3", "value": "alt", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "src", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "alt", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 잘했어요! `src`와 `alt`가 올바르게 채워졌습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 링크는 `href`, 이미지는 `src`입니다. 의미 설명은 `alt`로 제공하세요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}img{height:48px}</style></head><body><p>우리 팀 로고</p><img src=\"/images/team-logo.png\" alt=\"팀 로고\"/></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "크기 지정: width/height 속성",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📐 크기 지정\n- HTML 속성 `width`/`height`로 **본래 크기**(픽셀) 지정\n- CSS로도 스타일 가능(예: `img{width:100%}`)\n> HTML 속성으로 가로·세로를 지정하면 레이아웃이 안정적입니다.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "HTML에서 이미지 가로·세로를 속성으로 직접 지정하려면?",
                  "interactionOptions": [
                    { "label": "width / height" },
                    { "label": "size / ratio" },
                    { "label": "w / h" },
                    { "label": "cols / rows" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 맞아요! `width`와 `height` 속성을 사용합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 정답은 `width`/`height`입니다. 다른 표기는 표준 속성이 아니에요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<img src=\"/images/profile.jpg\" {{BLANK-1}}=\"200\" {{BLANK-2}}=\"150\" alt=\"프로필\"/>",
                  "url": "/code/34",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "size", "disabled": false },
                    { "id": "option-2", "value": "height", "disabled": false },
                    { "id": "option-3", "value": "width", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "width", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "height", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 좋아요! 가로·세로가 속성으로 정확히 지정되었습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 올바른 속성 이름은 `width`/`height`입니다. 철자와 위치를 확인하세요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}img{object-fit:cover}</style></head><body><img src=\"/images/profile.jpg\" width=\"200\" height=\"150\" alt=\"프로필\"/></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "figure/figcaption으로 캡션 제공",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧩 이미지+설명 묶기\n- `<figure>`: 미디어와 설명을 **하나의 단위**로 묶음\n- `<figcaption>`: 이미지/도표에 대한 **설명(캡션)**",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "이미지 설명(캡션)에 사용하는 태그는?",
                  "interactionOptions": [
                    { "label": "<caption>" },
                    { "label": "<figcaption>" },
                    { "label": "<summary>" },
                    { "label": "<legend>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! `<figcaption>`이 이미지/도표 캡션 표준입니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `<figcaption>`을 사용해 캡션을 제공합니다. `<caption>`은 표(`<table>`)의 제목이에요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<figure>\n  <img src=\"/images/mountain.jpg\" alt=\"산 풍경\"/>\n  <{{BLANK-1}}>여름의 한라산 전경</{{BLANK-1}}>\n</figure>",
                  "url": "/code/35",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "<caption>", "disabled": false },
                    { "id": "option-2", "value": "<figcaption>", "disabled": false },
                    { "id": "option-3", "value": "<summary>", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "<figcaption>", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 잘했어요! 이미지와 캡션이 의미 있게 묶였습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 캡션은 `<figcaption>`으로 제공해야 시맨틱 구조가 맞습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}figure{margin:0}figcaption{color:#555;font-size:14px;margin-top:6px}</style></head><body><figure><img src=\"/images/mountain.jpg\" alt=\"산 풍경\"/><figcaption>여름의 한라산 전경</figcaption></figure></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "picture/source로 반응형 이미지",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧠 상황별 이미지 교체\n- `<picture><source ...><img ...></picture>`\n- `media`/`type`/`srcset`으로 뷰포트·포맷에 맞는 이미지를 제공\n- 마지막 `<img>`는 **폴백**(기본 이미지)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "뷰포트 크기에 따라 다른 이미지를 제공하려면 어떤 요소 조합이 적절할까요?",
                  "interactionOptions": [
                    { "label": "<picture> + <source> + <img>" },
                    { "label": "<figure> + <figcaption>" },
                    { "label": "<div> + background-image" },
                    { "label": "<img> + <caption>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! `<picture>` 구문을 사용하면 조건별 이미지를 제공할 수 있어요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 반응형 이미지는 `<picture>`와 `<source>` 조합을 사용합니다. `<img>` 하나만으로는 어렵습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<picture>\n  <source {{BLANK-1}}=\"(min-width: 600px)\" {{BLANK-2}}=\"/images/banner-large.jpg\">\n  <img src=\"/images/banner.jpg\" alt=\"프로모션 배너\"/>\n</picture>",
                  "url": "/code/36",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "media", "disabled": false },
                    { "id": "option-2", "value": "srcset", "disabled": false },
                    { "id": "option-3", "value": "sizes", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "media", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "srcset", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 좋아요! 뷰포트 조건과 이미지 후보를 제대로 지정했습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `source`에는 조건(`media`)과 이미지 후보(`srcset`)를 지정합니다. 폴백 `<img>`도 꼭 포함하세요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;margin:0}img{width:100%;display:block}</style></head><body><picture><source media=\"(min-width: 600px)\" srcset=\"/images/banner-large.jpg\"><img src=\"/images/banner.jpg\" alt=\"프로모션 배너\"/></picture></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "이미지 포맷 고르기: JPG/PNG/SVG/WebP",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧪 포맷 선택 가이드\n- **JPG**: 사진/그라데이션에 적합(손실압축)\n- **PNG**: 투명/아이콘(무손실, 또렷함)\n- **SVG**: 로고/아이콘 **벡터**(확대에도 선명)\n- **WebP/AVIF**: 최신 고압축(브라우저 지원 확인)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "확대/축소해도 **선명함**이 유지되어 로고에 가장 알맞은 포맷은?",
                  "interactionOptions": [
                    { "label": "JPG" },
                    { "label": "PNG" },
                    { "label": "SVG" },
                    { "label": "GIF" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! 로고·아이콘에는 벡터 기반인 `SVG`가 최적입니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 로고/아이콘은 크기 변화에 강한 `SVG`가 적합합니다. 사진은 보통 `JPG`가 좋아요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<img src=\"/images/logo.{{BLANK-1}}\" alt=\"회사 로고\"/>",
                  "url": "/code/37",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "jpg", "disabled": false },
                    { "id": "option-2", "value": "svg", "disabled": false },
                    { "id": "option-3", "value": "gif", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "svg", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 좋아요! 로고는 `SVG`로 선명하게 표시됩니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 로고/아이콘에는 `SVG`를 우선 고려하세요. 비트맵은 확대 시 깨질 수 있어요.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title></head><body><img src=\"/images/logo.svg\" alt=\"회사 로고\"/></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "이미지에 링크 걸기(a > img)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🔗 이미지 클릭 이동\n- 이미지를 링크로 만들려면 `<a>`로 **감싼다**: `<a href=\"...\"><img ...></a>`\n- 링크 텍스트가 없다면 `alt`가 설명을 대신합니다(접근성 고려).",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "이미지를 클릭하면 상세 페이지로 이동하게 하려면 올바른 마크업은?",
                  "interactionOptions": [
                    { "label": "<a><img ...></a>" },
                    { "label": "<img><a ...></a>" },
                    { "label": "<button alt=\"link\">" },
                    { "label": "<link><img ...></link>" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 정답! 링크는 `<a>` 요소이고, 이미지를 그 안에 넣습니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ `<a>`가 링크 요소입니다. `<img>` 바깥에서 감싸야 클릭 영역이 전체 이미지가 됩니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<a href=\"/products/1\">\n  <{{BLANK-1}} src=\"/images/p1.jpg\" alt=\"상품 1 미리보기\"/>\n</a>",
                  "url": "/code/38",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "media", "disabled": false },
                    { "id": "option-2", "value": "image", "disabled": false },
                    { "id": "option-3", "value": "img", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "img", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "🎉 좋아요! 이미지 전체가 링크로 동작합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "❌ 이미지 링크는 `<a>`로 감싸고 내부에 `<img>`를 배치해야 합니다.",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}img{height:100px;border-radius:10px}</style></head><body><a href=\"/products/1\"><img src=\"/images/p1.jpg\" alt=\"상품 1 미리보기\"/></a></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 6
const HTML_6 = {
  "lessons": [
    {
      "id": 6,
      "title": "시맨틱 레이아웃(헤더/내비/메인/푸터)",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 시맨틱 레이아웃에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "시맨틱 레이아웃은 문서의 의미를 명확히 드러냅니다. <header>는 머리글, <nav>는 내비게이션, <main>은 페이지 핵심 콘텐츠, <section>/<article>은 구획/독립 글, <aside>는 보조, <footer>는 바닥글을 나타내어 검색·보조기기·협업에 유리합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 7
const HTML_7 = {
  "lessons": [
    {
      "id": 7,
      "title": "목록과 표(Table) 기초",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 목록과 표에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "<ul>/<ol>/<li>로 목록을, <dl>/<dt>/<dd>로 용어/설명을 표현합니다. 표는 <table> 안에 <thead>/<tbody>를 나누고, 행/헤더/셀(<tr>/<th>/<td>)을 올바르게 배치해 의미 있는 데이터 구조를 만듭니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 8
const HTML_8 = {
  "lessons": [
    {
      "id": 8,
      "title": "폼 심화—유효성 검증과 접근성",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 폼(Forms)에 대해 더 자세히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "폼 심화에서는 브라우저 기본 유효성(required, min/max, pattern)을 활용하고, <label>과의 정확한 연결, <fieldset>/<legend>로 그룹을 명확히 하며 aria-describedby 등으로 힌트를 제공합니다. placeholder는 라벨 대체가 아님에 유의합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 9
const HTML_9 = {
  "lessons": [
    {
      "id": 9,
      "title": "멀티미디어 심화—오디오/비디오/캡션",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 멀티미디어에 대해 더 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "<video>/<audio>는 controls로 조작을 제공하고, 자동재생은 사용자 경험을 위해 muted 조건을 권장합니다. <track kind=\"captions\">로 자막/캡션을 제공해 접근성을 높이고, poster로 로딩 전 썸네일을 지정할 수 있습니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 10
const HTML_10 = {
  "lessons": [
    {
      "id": 10,
      "title": "문서 메타데이터와 SEO 기초",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 문서 메타데이터와 SEO에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "<meta charset>와 <meta name=\"viewport\">로 기본을 갖추고, <title>과 meta description으로 검색 스니펫 품질을 높입니다. 파비콘(link rel=\"icon\"), Open Graph/Twitter Card 메타를 설정해 공유 미리보기까지 깔끔히 구성합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 11
const CSS_1 = {
  "lessons": [
    {
      "id": 11,
      "title": "CSS는 옷 갈아입기 👗",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요 👋\n## 오늘은 HTML 위에 **👗옷을 입히는 CSS**를 배워요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/001_반가워요_오늘은_html_위에_옷을_입히는_css을_배워요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "HTML은 뼈대🦴, CSS는 옷👕",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/3/5/11/image/001_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## HTML은 **뼈대**🦴 \n## CSS는 꾸미는 법(스타일)🎨",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/002_html은_뼈대이고_css는_스타일이에요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "- 글자 색: `color`\n- 배경 색: `background-color`\n- 글자 크기: `font-size`\n위 세 가지만 알아도 웹이 확 살아나요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/003_글자_색을_바꾸는_css_속성은_무엇일까.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 2,
          "title": "글자 색 바꾸는 속성은 뭘까?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/004_글자_색을_바꾸는_css_속성은_무엇일까.mp3",
              "questions": [
                {
                  "title": "글자 색을 바꾸는 CSS 속성은 무엇일까?",
                  "interactionOptions": [
                    { "label": "color" },
                    { "label": "background-color" },
                    { "label": "font-size" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 잘했어요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/005_잘했어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `color`입니다! \n💡 `background-color`: 바탕색, `font-size`: 글자 크기",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/006_정답은_color입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보면서 color 속성을\n 더 자세히 알아봐요! ✨",
              "tts": "https://s3.ghmate.com/codingpt/class/3/5/11/audio/007_아래_예시_코드와_브라우저를_보면서_color_속성을_더_자세히_알아봐요.mp3",
              "height": 150,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>CSS color 속성 연습</h1>\n<p class='red-text'>이 문장은 빨간색이에요.</p>\n<p class='blue-text'>이 문장은 파란색이에요.</p>\n<p class='green-text'>이 문장은 초록색이에요.</p>"
                },
                {
                  "name": "style.css",
                  "language": "css",
                  "content": ".red-text{color:red;}\n.blue-text{color:blue;}\n.green-text{color:green;}"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width, initial-scale=1'><title>결과보기</title><style>body{font-family:system-ui;padding:16px}h1{margin:0 0 12px}p{margin:6px 0}.red-text{color:red}.blue-text{color:blue}.green-text{color:green}</style></head><body><h1>CSS color 속성 연습</h1><p class='red-text'>이 문장은 빨간색이에요.</p><p class='blue-text'>이 문장은 파란색이에요.</p><p class='green-text'>이 문장은 초록색이에요.</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 3,
          "title": "배경 색 바꾸는 속성은 뭘까?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/008_파란_배경이_되는_올바른_css_속성은_무엇일까.mp3",
              "questions": [
                {
                  "title": "파란 배경이 되는 올바른 CSS 속성은 무엇일까?",
                  "interactionOptions": [
                    { "label": "bg-color: blue" },
                    { "label": "background-color: blue" },
                    { "label": "color: blue" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답이에요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/009_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `background-color: blue`에요.\n💡 `color`는 글자색을 바꿔요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/010_정답은_background_color_blue에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보면서\nbackground-color 속성을 더 알아봐요! ✨",
              "tts": "https://s3.ghmate.com/codingpt/class/3/5/11/audio/011_아래_예시_코드와_브라우저를_보면서_background_color_속성을_더_알아봐요.mp3",
              "height": 130,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>배경색 연습</h1>\n<p class='box-purple'>보라색 배경</p>\n<p class='box-tomato'>토마토색 배경</p>\n<p class='box-blue'>파란색 배경</p>"
                },
                {
                  "name": "style.css",
                  "language": "css",
                  "content": ".box-purple { background-color: purple; color: white; } \n.box-tomato { background-color: tomato; color: white } \n.box-blue { background-color: blue; color: white }"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>배경색 연습</title><style>body{font-family:system-ui;padding:16px}h1{margin-bottom:12px}.box-purple{background-color:purple;color:white;padding:8px;border-radius:6px}.box-tomato{background-color:tomato;color:white;padding:8px;border-radius:6px}.box-blue{background-color:blue;color:white;padding:8px;border-radius:6px}</style></head><body><h1>배경색 연습</h1><p class='box-purple'>보라색 배경</p><p class='box-tomato'>토마토색 배경</p><p class='box-blue'>파란색 배경</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 4,
          "title": "글자 크기를 크게 하려면?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/012_글자_크기를_크게_하는_속성은.mp3",
              "questions": [
                {
                  "title": "글자 크기를 크게 하는 속성은?",
                  "interactionOptions": [
                    { "label": "line-height" },
                    { "label": "font-weight" },
                    { "label": "font-size" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답이에요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/009_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `font-size`입니다. \n💡 `font-weight`: 굵기, `line-height`: 줄 간격",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/013_정답은_font_size입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보며\nfont-size에 대해 자세히 알아봐요! ✨",
              "tts": "https://s3.ghmate.com/codingpt/class/3/5/11/audio/014_아래_예시_코드와_브라우저를_보며_font_size에_대해_자세히_알아봐요.mp3",
              "height": 150,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>글자 크기 연습</h1>\n<p class='small-text'>이 문장은 작은 글씨(12px)</p>\n<p class='medium-text'>이 문장은 중간 크기(16px)</p>\n<p class='large-text'>이 문장은 큰 글씨(24px)</p>\n<p class='xlarge-text'>이 문장은 아주 큰 글씨(32px)</p>"
                },
                {
                  "name": "style.css",
                  "language": "css",
                  "content": ".small-text { font-size: 12px; } \n.medium-text { font-size: 16px; } \n.large-text { font-size: 24px; } \n.xlarge-text { font-size: 32px; }"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>글자 크기 연습</title><style>body{font-family:system-ui;padding:16px}.small-text{font-size:12px}.medium-text{font-size:16px}.large-text{font-size:24px}.xlarge-text{font-size:32px}</style></head><body><h1>글자 크기 연습</h1><p class='small-text'>이 문장은 작은 글씨(12px)</p><p class='medium-text'>이 문장은 중간 크기(16px)</p><p class='large-text'>이 문장은 큰 글씨(24px)</p><p class='xlarge-text'>이 문장은 아주 큰 글씨(32px)</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 5,
          "title": "👩‍💻 코드 빈칸 채우기: 첫 꾸미기 놀이터",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "아래 빈칸을 채워서 [배경=노랑], [글자색=빨강],\n[제목 크기=32px]으로 만들어보세요! ✨",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/015_아래_빈칸을_채워서_배경_노랑_글자색_빨강_제목_크기_32px으로_만들어보세요.mp3",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "",
                  "url": "/code/2",
                  "height": 110,
                  "isInteractive": true,
                  "inputLength": 0,
                  "interactionOptions": [],
                  "answers": []
                },
                {
                  "name": "style.css",
                  "language": "css",
                  "content": "",
                  "url": "/code/3",
                  "height": 110,
                  "isInteractive": true,
                  "inputLength": 3,
                  "interactionOptions": [
                    { "id": "option-1", "value": "background-color", "disabled": false },
                    { "id": "option-2", "value": "font-size", "disabled": false },
                    { "id": "option-3", "value": "color", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "background-color", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "color", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "font-size", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 잘했어요!\n분리한 **style.css** 덕분에 HTML과 스타일이 깔끔히 나뉘었어요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/016_잘했어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 틀렸어요 🥹\n💡배경=**background-color**, \n글자색=**color**, 글자 크기=**font-size**",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/017_틀렸어요_배경_background_color_글자색_color_글자_크기_font_size.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "webview",
              "title": "🧑‍💻 아래 결과 브라우저를 볼까요?",
              "tts": "https://s3.ghmate.com/codingpt/class/3/5/11/audio/018_아래_결과_브라우저를_볼까요.mp3",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>결과화면</title><style>body{font-family:system-ui}body{background-color:yellow}p{color:red}h1{font-size:32px}</style></head><body><h1>안녕 CSS!</h1><p>색과 글자 크기를 바꿨어요!</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 6,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 오늘은 CSS로 글자색, 배경색, \n# 글자 크기를 바꿔봤어요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/019_오늘은_css로_글자색_배경색_글자_크기를_바꿔봤어요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "`color`: blue; ➡️ 글자색: 파랑\n`backgroud-color`: yellow; ➡️ 배경색: 노랑\n`font-size`: 32px; ➡️ 글자 크기: 32px",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 3,
              "type": "paragraph",
              "content": "## 다음 레슨에서 또 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/11/audio/020_다음_레슨에서_또_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 12
const CSS_2 = {
  "lessons": [
    {
      "id": 12,
      "title": "색 놀이 🌈",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요 👋\n## 오늘은 색상을 표현하는 세 가지 방법에 대해\n## 배워볼까요? 🌈",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/001_반가워요_오늘은_색상을_표현하는_세_가지_방법에_대해_배워볼까요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "🎨 색을 표현하는 세 가지 방법",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/3/5/11/image/001_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## 🎨 색을 표현하는 세 가지 방법",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/002_색을_표현하는_세_가지_방법.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "**이름**: 🟥`red`, 🟦`blue`, 🟩`green` 처럼 쉽고 직관적이에요",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/003_이름_쉽고_직관적이에요.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 3,
              "type": "paragraph",
              "content": "**색상코드**: `#ff0000`(빨강), `#0000ff`(파랑)처럼 색상코드로\n 더 많은 색을 표현해요.",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/004_색상코드로_더_많은_색을_표현해요.mp3",
              "visibility": { "type": "step", "value": 3 }
            },
            {
              "id": 4,
              "type": "paragraph",
              "content": "**RGB**: 🟥`rgb(255, 0, 0)`, 🟦`rgb(0, 0, 255)`처럼\nRGB 값으로 더 많은 색을 표현해요.",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/005_rgb_값으로_더_많은_색을_표현해요.mp3",
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "📌 색상코드로 글자색 변경하기",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/006_글자색을_빨강색으로_바꾸는_올바른_코드는_무엇일까.mp3",
              "questions": [
                {
                  "title": "글자색을 빨강색으로 바꾸는 올바른 코드는 무엇일까?",
                  "interactionOptions": [
                    { "label": "color: #ff0000" },
                    { "label": "background-color: #ff0000" },
                    { "label": "font-color: #ff0000" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 잘했어요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/007_잘했어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 **color: #ff0000**입니다! \n`background-color`는 **배경색**을 설정해요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/008_정답은_color_ff0000입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보면서 **color 속성**을\n 더 자세히 알아봐요! ✨",
              "tts": "",
              "height": 100,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<p class='red-text'>이 문장은 빨간색이에요 🔴</p>"
                },
                {
                  "name": "style.css",
                  "language": "css",
                  "content": ".red-text { color: #ff0000; }"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>글자색 예시</title></head><body><p style='color:#ff0000'>이 문장은 빨간색이에요 🔴</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 3,
          "title": "👩‍💻 코드 빈칸 채우기: 버튼 색 바꾸기",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "아래 조건을 만족하도록 빈칸을 채워요 ✨\n- 버튼 배경: 빨간색(색상코드)\n- 안내 박스 배경: 파랑색 50% 투명(반투명)",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/009_아래_조건을_만족하도록_빈칸을_채워요.mp3",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "",
                  "url": "/code/7",
                  "height": 265,
                  "isInteractive": true,
                  "inputLength": 0,
                  "interactionOptions": [],
                  "answers": []
                },
                {
                  "name": "style.css",
                  "language": "css",
                  "content": "",
                  "url": "/code/8",
                  "height": 265,
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "#ff0000", "disabled": false },
                    { "id": "option-2", "value": "blue", "disabled": false },
                    { "id": "option-3", "value": "rgba(0,0,255,0.5)", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "#ff0000", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "rgba(0,0,255,0.5)", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 잘했어요!\n 버튼 배경은 **색상코드**로, 안내 박스 배경은 **RGBA**로\n투명도를 표현했어요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/010_잘했어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 틀렸어요 🥹\n- 빨간색 색상코드 → `#ff0000`\n- 파랑색 50% 투명 → `rgba(0,0,255,0.5)`",
                    "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/011_틀렸어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "webview",
              "title": "🧑‍💻 아래 결과 브라우저를 확인해봐요!",
              "tts": "https://s3.ghmate.com/codingpt/class/3/5/12/audio/012_아래_결과_브라우저를_확인해봐요.mp3",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>결과 화면</title><style>.cta{background:#ff0000;color:#ffffff;padding:10px 14px}.note{background:rgba(0,0,255,0.5);padding:8px;margin-top:10px}</style></head><body style='font-family:system-ui;padding:16px'><button class='cta'>색 바뀐 버튼</button><p class='note'>이 박스는 반투명 배경이에요</p></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 4,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 오늘은 🎨 색상을 표현하는 세 가지 방법에\n# 대해 배워봤어요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/013_오늘은_색상을_표현하는_세_가지_방법에_대해_배워봤어요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "1) **이름**: 🟥`red`, 🟦`blue``\n2) **색상코드**: `#ff0000`(빨강), `#0000ff`(파랑)\n3) **RGB**: 🟥`rgb(255, 0, 0)`, 🟦`rgb(0, 0, 255)`",
              "tts" : "",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 3,
              "type": "paragraph",
              "content": "## 다음 레슨에서 또 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/3/5/12/audio/014_다음_레슨에서_또_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 13
const CSS_3 = {
  "lessons": [
    {
      "id": 13,
      "title": "Flexbox 입문",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# Flexbox에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "Flexbox 시작: display:flex와 축 이해",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧭 Flexbox의 기본\n- 컨테이너에 `display: flex`를 주면 **플렉스 컨테이너**가 됩니다.\n- **주축(main axis)**: 아이템이 배치되는 기본 축(기본은 가로 `row`)\n- **교차축(cross axis)**: 주축에 수직인 축(기본은 세로)\n- 주축 방향은 `flex-direction`으로 바꿀 수 있어요(`row`/`column`).",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "Flexbox를 **활성화**하는 올바른 선언은?",
                  "interactionOptions": [
                    { "label": "display: block" },
                    { "label": "display: grid" },
                    { "label": "display: flex" },
                    { "label": "position: relative" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 컨테이너에 `display: flex`를 주면 플렉스 레이아웃이 시작돼요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `display: flex`가 컨테이너를 플렉스 컨테이너로 만듭니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.list{ display: {{BLANK-1}}; gap:8px } .item{ background:#e0f2fe; padding:10px 14px; border-radius:8px }</style></head><body><div class=\"list\"><div class=\"item\">A</div><div class=\"item\">B</div><div class=\"item\">C</div></div></body></html>",
                  "url": "/code/51",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "flex", "disabled": false },
                    { "id": "option-2", "value": "block", "disabled": false },
                    { "id": "option-3", "value": "inline", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "flex", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 이제 플렉스 컨테이너가 되었어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 컨테이너의 `display` 값을 `flex`로 지정해야 아이템들이 플렉스 규칙으로 배치됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.list{display:flex;gap:8px}.item{background:#e0f2fe;padding:10px 14px;border-radius:8px}</style></head><body><div class=\"list\"><div class=\"item\">A</div><div class=\"item\">B</div><div class=\"item\">C</div></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "방향 바꾸기: flex-direction (row/column)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ↕️ 주축 바꾸기\n- `flex-direction: row`(기본): 가로 방향 배치\n- `flex-direction: column`: 세로 방향 배치(주축이 세로로 변경)\n- 방향이 바뀌면 **주축/교차축**도 함께 바뀝니다.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "아이템을 **세로로 쌓이게** 만들고 싶을 때 알맞은 값은?",
                  "interactionOptions": [
                    { "label": "row" },
                    { "label": "column" },
                    { "label": "wrap" },
                    { "label": "inline" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `flex-direction: column`이면 세로로 배치돼요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 세로 배치는 `flex-direction: column`을 사용해야 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.list{ display:flex; flex-direction: {{BLANK-1}}; gap:6px } .item{ background:#d1fae5; padding:8px 12px; border-radius:8px }</style></head><body><div class=\"list\"><div class=\"item\">1</div><div class=\"item\">2</div><div class=\"item\">3</div></div></body></html>",
                  "url": "/code/52",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "row", "disabled": false },
                    { "id": "option-2", "value": "column", "disabled": false },
                    { "id": "option-3", "value": "straight", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "column", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 세로 방향으로 쌓이도록 설정했습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 값은 `row` 또는 `column`을 사용합니다. 리스트는 세로 방향으로 `column`이 정답이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.list{display:flex;flex-direction:column;gap:6px}.item{background:#d1fae5;padding:8px 12px;border-radius:8px}</style></head><body><div class=\"list\"><div class=\"item\">1</div><div class=\"item\">2</div><div class=\"item\">3</div></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "주축 정렬: justify-content",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ↔️ 주축 방향 정렬\n- `justify-content`: **주축(main axis)** 정렬/간격\n- 자주 쓰는 값: `flex-start`, `center`, `flex-end`, `space-between`, `space-around`\n- `row`일 땐 가로 정렬, `column`일 땐 세로 정렬에 해당합니다.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`row` 방향에서 양 끝에 붙이고 **사이를 고르게** 벌리려면?",
                  "interactionOptions": [
                    { "label": "center" },
                    { "label": "space-between" },
                    { "label": "space-around" },
                    { "label": "flex-start" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `space-between`은 양 끝 고정 + 사이 균등 간격입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `space-between`이 정답입니다. `center`는 가운데로 모읍니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.nav{ display:flex; justify-content: {{BLANK-1}}; background:#f1f5f9; padding:10px; border-radius:10px } .nav a{ background:#fff; padding:8px 12px; border-radius:8px; text-decoration:none; color:#111 }</style></head><body><nav class=\"nav\"><a href=\"#\">Home</a><a href=\"#\">Docs</a><a href=\"#\">About</a></nav></body></html>",
                  "url": "/code/53",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "flex", "disabled": false },
                    { "id": "option-2", "value": "justify-content", "disabled": false },
                    { "id": "option-3", "value": "align-items", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "justify-content", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 아이템 사이 간격이 균등해졌습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `justify-content`는 주축 정렬입니다. 이번엔 `space-between`이 목적에 맞아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px} .nav{display:flex;justify-content:space-between;background:#f1f5f9;padding:10px;border-radius:10px} .nav a{background:#fff;padding:8px 12px;border-radius:8px;text-decoration:none;color:#111}</style></head><body><nav class=\"nav\"><a href=\"#\">Home</a><a href=\"#\">Docs</a><a href=\"#\">About</a></nav></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "교차축 정렬: align-items",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ↕️ 교차축 방향 정렬\n- `align-items`: **교차축(cross axis)** 정렬\n- 자주 쓰는 값: `stretch`(기본), `flex-start`, `center`, `flex-end`\n- `row` 기준 교차축은 **세로**, `column` 기준 교차축은 **가로**입니다.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`row` 방향에서 아이템을 **세로 가운데** 정렬하려면?",
                  "interactionOptions": [
                    { "label": "align-items: center" },
                    { "label": "justify-content: center" },
                    { "label": "text-align: center" },
                    { "label": "place-items: center" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 교차축 정렬은 `align-items`가 담당합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 주축 정렬은 `justify-content`, 교차축 정렬은 `align-items`를 사용합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.bar{ display:flex; align-items: {{BLANK-1}}; height:120px; background:#fafaf9; padding:10px; gap:8px } .item{ background:#fee2e2; padding:8px 12px; border-radius:8px }</style></head><body><div class=\"bar\"><div class=\"item\">상단</div><div class=\"item\">가운데</div><div class=\"item\">하단</div></div></body></html>",
                  "url": "/code/54",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "front", "disabled": false },
                    { "id": "option-2", "value": "middle", "disabled": false },
                    { "id": "option-3", "value": "center", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "center", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 세로(교차축) 가운데 정렬이 적용되었습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `row`에서 세로 가운데는 `align-items: center`가 맞아요. `justify-content`는 가로 정렬입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.bar{display:flex;align-items:center;height:120px;background:#fafaf9;padding:10px;gap:8px;border-radius:10px}.item{background:#fee2e2;padding:8px 12px;border-radius:8px}</style></head><body><div class=\"bar\"><div class=\"item\">상단</div><div class=\"item\">가운데</div><div class=\"item\">하단</div></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "아이템 간 간격: gap",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧱 간격 주기\n- `gap`: 플렉스 **아이템 사이 간격**을 한 번에 지정\n- 마진을 하나하나 주는 대신 컨테이너에 `gap`을 주면 간편해요\n- `row-gap`, `column-gap`으로 축별 지정도 가능해요.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "마진 대신 컨테이너에서 **아이템 사이 간격**을 통일해 주는 속성은?",
                  "interactionOptions": [
                    { "label": "gap" },
                    { "label": "space-between" },
                    { "label": "padding" },
                    { "label": "border-spacing" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `gap`은 단순하고 예측 가능해요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `space-between`은 정렬 방식이고, 실제 간격 값 지정은 `gap`으로 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.wrap{ display:flex; {{BLANK-1}}: {{BLANK-2}}; } .box{ background:#fef9c3; padding:10px 12px; border-radius:8px }</style></head><body><div class=\"wrap\"><div class=\"box\">A</div><div class=\"box\">B</div><div class=\"box\">C</div></div></body></html>",
                  "url": "/code/55",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "gap", "disabled": false },
                    { "id": "option-2", "value": "row-gap", "disabled": false },
                    { "id": "option-3", "value": "justify-content", "disabled": false },
                    { "id": "option-4", "value": "space-between", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "gap", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 간격을 컨테이너 한 줄로 깔끔하게 지정했어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `gap: 12px;`처럼 속성과 값을 함께 지정해 주세요. `space-between`은 정렬 방식이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.wrap{display:flex;gap:12px}.box{background:#fef9c3;padding:10px 12px;border-radius:8px}</style></head><body><div class=\"wrap\"><div class=\"box\">A</div><div class=\"box\">B</div><div class=\"box\">C</div></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "아이템 크기 비율: flex-grow / flex",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📈 남는 공간 나누기\n- `flex-grow`: 남는 공간을 **얼마나 차지**할지 비율로 지정(0은 확장 안 함)\n- `flex` 단축: `flex: grow shrink basis` (`flex: 1`은 `1 1 0%`와 동일)\n- 같은 `flex-grow` 값이면 공간을 **같이** 나눠 가집니다.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "여유 공간을 **비율대로 확장**하도록 만드는 속성은?",
                  "interactionOptions": [
                    { "label": "flex-grow" },
                    { "label": "order" },
                    { "label": "z-index" },
                    { "label": "width" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `flex-grow` 값이 클수록 더 많은 남은 공간을 차지합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 공간 확장은 `flex-grow`로 제어합니다. `order`는 순서, `z-index`는 쌓임 맥락이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.row{ display:flex; gap:8px } .item{ background:#e9d5ff; padding:10px; border-radius:8px } .grow{ {{BLANK-1}}: 1; }</style></head><body><div class=\"row\"><div class=\"item grow\">A</div><div class=\"item\">B</div><div class=\"item\">C</div></div></body></html>",
                  "url": "/code/56",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "flex-grow", "disabled": false },
                    { "id": "option-2", "value": "flex-shrink", "disabled": false },
                    { "id": "option-3", "value": "order", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "flex-grow", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 첫 번째 아이템이 남는 가로 공간을 확장해 차지합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `flex-grow: 1;`을 지정하면 아이템이 남는 공간을 나눠 가집니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.row{display:flex;gap:8px}.item{background:#e9d5ff;padding:10px;border-radius:8px}.grow{flex-grow:1}</style></head><body><div class=\"row\"><div class=\"item grow\">A</div><div class=\"item\">B</div><div class=\"item\">C</div></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 14
const CSS_4 = {
  "lessons": [
    {
      "id": 14,
      "title": "Position(위치 지정) 입문",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# Position(위치 지정)에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "position 개요와 offset(top/left...)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧭 위치 지정 기본\n- `position` 값: `static`(기본), `relative`, `absolute`, `fixed`, `sticky`\n- `top/right/bottom/left` **오프셋**은 `static`이 **아닌** 경우에 동작\n- `relative`: 문서 흐름을 유지하면서 **원래 위치 기준**으로 살짝 이동",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "문서 흐름은 유지하면서 원래 자리 기준으로 **조금 이동**시키는 값은?",
                  "interactionOptions": [
                    { "label": "static" },
                    { "label": "relative" },
                    { "label": "absolute" },
                    { "label": "fixed" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `relative`는 원래 위치를 기준으로 살짝 이동합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `relative`가 원래 위치 기준 이동입니다. `static`은 오프셋이 적용되지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.box{ position: {{BLANK-1}}; top:10px; left:8px; background:#e0f2fe; padding:10px 14px; border-radius:8px; }</style></head><body><div class=\"box\">relative 이동</div></body></html>",
                  "url": "/code/57",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "inherit", "disabled": false },
                    { "id": "option-2", "value": "static", "disabled": false },
                    { "id": "option-3", "value": "relative", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "relative", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 원래 자리에서 살짝 이동합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `position: relative`일 때만 `top/left`가 적용됩니다. `static`에는 적용되지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.box{position:relative;top:10px;left:8px;background:#e0f2fe;padding:10px 14px;border-radius:8px;display:inline-block}</style></head><body><div class='box'>relative 이동</div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "relative vs absolute: 기준이 되는 조상",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🎯 absolute의 기준\n- `absolute`는 **가장 가까운** `position`이 `static`이 **아닌** 조상을 기준으로 정렬\n- 그런 조상이 없으면 **뷰포트가 아닌** 문서 루트(html) 기준이 아닌 **페이지(초기 포함 블록)** 기준으로 배치됨(대부분 body와 유사)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`position: absolute` 요소의 **기준**은 무엇인가요?",
                  "interactionOptions": [
                    { "label": "항상 브라우저 화면(viewport)" },
                    { "label": "가장 가까운 `position != static` 조상" },
                    { "label": "항상 `<body>`" },
                    { "label": "항상 문서 최상단(0,0)" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 조상 중 `relative`/`absolute`/`fixed`/`sticky` 등 **positioned** 요소를 찾습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `absolute`는 가장 가까운 **positioned 조상**을 기준으로 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><style>.wrap{ position: {{BLANK-1}}; width:220px; height:120px; background:#f1f5f9; border-radius:10px } .tip{ position: {{BLANK-2}}; right:8px; top:8px; background:#fde68a; padding:6px 8px; border-radius:8px; }</style></head><body><div class='wrap'><span class='tip'>툴팁</span></div></body></html>",
                  "url": "/code/58",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "static", "disabled": false },
                    { "id": "option-2", "value": "relative", "disabled": false },
                    { "id": "option-3", "value": "absolute", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "relative", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "absolute", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 툴팁이 래퍼의 오른쪽 위 모서리에 고정됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 부모를 `position: relative`로 만들어 기준을 잡고, 자식에 `absolute`를 지정하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.wrap{position:relative;width:220px;height:120px;background:#f1f5f9;border-radius:10px}.tip{position:absolute;right:8px;top:8px;background:#fde68a;padding:6px 8px;border-radius:8px}</style></head><body><div class='wrap'><span class='tip'>툴팁</span></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "fixed: 화면 기준 고정 버튼 만들기",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📌 fixed 포지셔닝\n- 화면(뷰포트)을 **기준**으로 위치 고정\n- 스크롤되어도 같은 자리 유지(예: 플로팅 액션 버튼, 상단 고정바)\n- 흔한 조합: `position: fixed; bottom: 16px; right: 16px;`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "스크롤해도 화면 오른쪽 아래에 **계속 보이는 버튼**을 만들 때 알맞은 값은?",
                  "interactionOptions": [
                    { "label": "relative" },
                    { "label": "absolute" },
                    { "label": "fixed" },
                    { "label": "sticky" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `fixed`는 뷰포트 기준으로 고정돼요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `fixed`가 화면 기준 고정입니다. `absolute`는 조상 기준이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><style>.fab{ {{BLANK-1}}: {{BLANK-2}}; bottom:16px; right:16px; background:#22c55e; color:#fff; border-radius:9999px; width:56px; height:56px; display:flex; align-items:center; justify-content:center; box-shadow:0 6px 16px rgba(0,0,0,.15) }</style></head><body><p style='height:700px'>스크롤 테스트 영역</p><button class='fab'>+</button></body></html>",
                  "url": "/code/59",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "flex", "disabled": false },
                    { "id": "option-2", "value": "fixed", "disabled": false },
                    { "id": "option-3", "value": "absolute", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "fixed", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 화면 우하단에 고정 버튼이 완성됐습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `position: fixed;` 조합이 필요합니다. `absolute`는 조상 기준이라 스크롤에 따라 움직일 수 있어요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title><style>body{font-family:system-ui;margin:0;height:1200px}.fab{position:fixed;bottom:16px;right:16px;background:#22c55e;color:#fff;border-radius:9999px;width:56px;height:56px;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 16px rgba(0,0,0,.15)}</style></head><body><div style='height:1000px;padding:16px'>스크롤 영역</div><button class='fab'>+</button></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "sticky: 스크롤 임계점에서 고정하기",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧷 sticky 포지셔닝\n- 스크롤 **특정 지점**(예: `top: 0`)을 지나면 그 위치에 **고정**\n- 부모 영역을 벗어나면 더 이상 고정되지 않음\n- 사용 예: 섹션 헤더, 목차 바 등",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`position: sticky`가 효과를 내기 위해 **필수로 지정**해야 하는 속성은?",
                  "interactionOptions": [
                    { "label": "z-index" },
                    { "label": "top 또는 bottom 등 임계 오프셋" },
                    { "label": "opacity" },
                    { "label": "overflow" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `top: 0` 같은 임계 오프셋이 있어야 고정 위치를 알 수 있어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `sticky`는 `top`/`bottom` 같은 임계 오프셋이 필요합니다. 없으면 동작하지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><style>.hd{ position: {{BLANK-1}}; top: {{BLANK-2}}; background:#fef9c3; padding:10px 12px; } .space{ height:1200px }</style></head><body><div class='hd'>섹션 헤더</div><div class='space'></div></body></html>",
                  "url": "/code/60",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "fixed", "disabled": false },
                    { "id": "option-2", "value": "sticky", "disabled": false },
                    { "id": "option-3", "value": "0", "disabled": false },
                    { "id": "option-4", "value": "16px", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "sticky", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "0", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 스크롤 상단에 닿으면 헤더가 고정됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `position: sticky; top: 0;`가 기본 패턴입니다. 필요하면 `z-index`로 위로 올리세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title><style>body{font-family:system-ui;margin:0}.hd{position:sticky;top:0;background:#fef9c3;padding:10px 12px;border-bottom:1px solid #e5e7eb}.space{height:1200px}</style></head><body><div class='hd'>섹션 헤더</div><div class='space'></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "z-index: 쌓임 순서 제어",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🗂️ z-index 기본\n- **큰 값일수록 위로** 쌓임(같은 쌓임 맥락 내에서)\n- 보통 `position`이 `static`이 **아닌** 요소에 의미 있게 적용\n- 오버레이(딤) 위에 모달을 띄울 때 유용",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`z-index`가 의도대로 동작하려면 보통 어떤 조건이 필요한가요?",
                  "interactionOptions": [
                    { "label": "요소가 position: static" },
                    { "label": "요소가 positioned(예: relative/absolute/...) 상태" },
                    { "label": "요소에 width가 있어야 함" },
                    { "label": "요소가 inline이어야 함" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 보통 `positioned` 요소에서 쌓임 제어를 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 대개 `relative/absolute/fixed/sticky` 등 **positioned** 요소에서 `z-index`가 유효합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><style>.dim{ position: fixed; inset:0; background: rgba(0,0,0,.4); z-index: {{BLANK-1}}; } .modal{ position: fixed; inset:auto 0 0 auto; right:16px; bottom:16px; background:#fff; padding:12px 14px; border-radius:10px; z-index: {{BLANK-2}}; }</style></head><body><div class='dim'></div><div class='modal'>모달</div></body></html>",
                  "url": "/code/61",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "999", "disabled": false },
                    { "id": "option-2", "value": "100", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "100", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "999", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 딤(z-index:100) 아래, 모달(z-index:999)이 위에 보입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 딤보다 모달의 `z-index`가 커야 위에 표시됩니다. 값의 크기를 비교해 보세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title><style>body{font-family:system-ui;margin:0;height:100vh}.dim{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100}.modal{position:fixed;right:16px;bottom:16px;background:#fff;padding:12px 14px;border-radius:10px;z-index:999}</style></head><body><div class='dim'></div><div class='modal'>모달</div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "정중앙 배치: absolute + transform 트릭",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🎯 가운데 정렬 레시피\n- 부모를 `position: relative`\n- 자식을 `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%)`\n- 어떤 크기든 **진짜 정중앙**에 배치 가능",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "박스를 컨테이너 **딱 정중앙**에 놓는 조합으로 가장 적절한 것은?",
                  "interactionOptions": [
                    { "label": "top: 0; left: 0;" },
                    { "label": "top: 50%; left: 50%; transform: translate(-50%, -50%)" },
                    { "label": "margin: 0 auto;" },
                    { "label": "justify-content: center;" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 크기에 상관없이 요소를 정확히 가운데 둘 수 있어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `margin: 0 auto`는 블록의 **가로** 가운데 정렬만, Flex 정렬은 컨테이너 전체 세팅이 필요해요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><style>.wrap{ position: relative; height:160px; background:#f1f5f9; border-radius:10px } .center{ position:absolute; top: {{BLANK-1}}; left: {{BLANK-2}}; transform: translate(-50%, -50%); background:#60a5fa; color:#fff; padding:10px 12px; border-radius:8px }</style></head><body><div class='wrap'><div class='center'>정중앙</div></div></body></html>",
                  "url": "/code/62",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "top", "disabled": false },
                    { "id": "option-2", "value": "bottom", "disabled": false },
                    { "id": "option-3", "value": "left", "disabled": false },
                    { "id": "option-4", "value": "right", "disabled": false, "valueAlias": "50%" }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "top", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "left", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 어떤 크기여도 요소가 정확히 가운데 배치됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 정중앙 배치는 `top/left: 50%`와 `translate(-50%, -50%)` 조합이 핵심입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.wrap{position:relative;height:160px;background:#f1f5f9;border-radius:10px}.center{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#60a5fa;color:#fff;padding:10px 12px;border-radius:8px}</style></head><body><div class='wrap'><div class='center'>정중앙</div></div></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 15
const CSS_5 = {
  "lessons": [
    {
      "id": 15,
      "title": "Grid 레이아웃 입문",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# Grid 레이아웃에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "Grid 시작: display:grid와 열 정의",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧱 Grid 기본\n- 컨테이너에 `display: grid` → **그리드 컨테이너**\n- 열/행 정의: `grid-template-columns`, `grid-template-rows`\n- 예) `grid-template-columns: 100px 1fr 100px`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "Grid 레이아웃을 **활성화**하는 속성/값 조합은?",
                  "interactionOptions": [
                    { "label": "display: block" },
                    { "label": "display: grid" },
                    { "label": "position: grid" },
                    { "label": "grid-template: on" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 컨테이너에 `display: grid`를 선언해야 해요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `display: grid`가 그리드를 시작합니다. 다른 옵션은 유효하지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><style>.grid{ display: {{BLANK-1}}; grid-template-columns: 100px 1fr 100px; gap:8px } .cell{ background:#e0f2fe; padding:10px; border-radius:8px }</style></head><body><div class=\\\"grid\\\"><div class=\\\"cell\\\">A</div><div class=\\\"cell\\\">B</div><div class=\\\"cell\\\">C</div></div></body></html>",
                  "url": "/code/63",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "block", "disabled": false },
                    { "id": "option-2", "value": "grid", "disabled": false },
                    { "id": "option-3", "value": "flex", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "grid", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! Grid 컨테이너가 생성되었습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `display: grid;`로 설정해야 열/행 정의가 동작해요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.grid{display:grid;grid-template-columns:100px 1fr 100px;gap:8px}.cell{background:#e0f2fe;padding:10px;border-radius:8px}</style></head><body><div class=\"grid\"><div class=\"cell\">A</div><div class=\"cell\">B</div><div class=\"cell\">C</div></div></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "트랙 크기와 fr 단위",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📏 fr 단위\n- `fr`은 **남는 공간**을 비율로 나눌 때 사용하는 단위\n- 예) `1fr 2fr 1fr` → 1:2:1 비율로 남는 공간 분배\n- 고정(px)과 혼합 가능: `200px 1fr 1fr`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "남는 공간을 **비율대로** 나누는 단위는?",
                  "interactionOptions": [
                    { "label": "px" },
                    { "label": "%" },
                    { "label": "fr" },
                    { "label": "em" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `fr`은 Grid에서 남는 공간 분배용 단위예요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `fr` 단위를 사용하면 비율로 공간을 나눌 수 있어요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\\\"ko\\\"><head><style>.grid{ display:grid; grid-template-columns: {{BLANK-1}} {{BLANK-2}} {{BLANK-3}}; gap:10px } .cell{ background:#d1fae5; padding:10px; border-radius:8px }</style></head><body><div class=\\\"grid\\\"><div class=\\\"cell\\\">1</div><div class=\\\"cell\\\">2</div><div class=\\\"cell\\\">3</div></div></body></html>",
                  "url": "/code/64",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "1fr 2fr 1fr", "disabled": false },
                    { "id": "option-2", "value": "1rf 2rf 1rf", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "1fr 2fr 1fr", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 1:2:1 비율로 남는 공간이 분배됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `grid-template-columns: 1fr 2fr 1fr;` 형태를 기억하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.grid{display:grid;grid-template-columns:1fr 2fr 1fr;gap:10px}.cell{background:#d1fae5;padding:10px;border-radius:8px}</style></head><body><div class=\"grid\"><div class=\"cell\">1</div><div class=\"cell\">2</div><div class=\"cell\">3</div></div></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "아이템 배치: grid-column / grid-row",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🎯 셀 병합/배치\n- 특정 아이템을 가로/세로로 **여러 칸** 차지: `grid-column`, `grid-row`\n- 예) `grid-column: 1 / span 2`(1번 선부터 **두 칸** 확장)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "아이템이 가로로 **두 칸** 차지하도록 설정하는 데 쓰는 속성은?",
                  "interactionOptions": [
                    { "label": "grid-row" },
                    { "label": "grid-column" },
                    { "label": "justify-items" },
                    { "label": "columns" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 가로 폭(열 수)을 제어하려면 `grid-column`을 사용해요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `grid-column`이 가로 칸 수, `grid-row`는 세로 칸 수를 제어합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\\\"ko\\\"><head><style>.grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:8px } .cell{ background:#fee2e2; padding:10px; border-radius:8px } .feature{ {{BLANK-1}}: 1 / {{BLANK-2}}; }</style></head><body><div class=\\\"grid\\\"><div class=\\\"cell feature\\\">가로 2칸</div><div class=\\\"cell\\\">B</div><div class=\\\"cell\\\">C</div><div class=\\\"cell\\\">D</div></div></body></html>",
                  "url": "/code/65",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "grid-column", "disabled": false },
                    { "id": "option-2", "value": "grid-row", "disabled": false },
                    { "id": "option-3", "value": "span 2", "disabled": false },
                    { "id": "option-4", "value": "span", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "grid-column", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "span 2", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 아이템이 가로로 두 칸을 차지합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `grid-column: 1 / span 2;`처럼 시작선과 span 값을 함께 지정하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.cell{background:#fee2e2;padding:10px;border-radius:8px}.feature{grid-column:1 / span 2}</style></head><body><div class=\"grid\"><div class=\"cell feature\">가로 2칸</div><div class=\"cell\">B</div><div class=\"cell\">C</div><div class=\"cell\">D</div></div></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "간격 주기: gap / row-gap / column-gap",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🔌 간격 컨트롤\n- Grid에서도 `gap`으로 **셀 사이 간격**을 통일 지정\n- 축별로 `row-gap`, `column-gap` 가능\n- 마진 없이 간단히 간격만 조절할 때 유용",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "셀들 사이 간격을 **컨테이너 한 줄**로 지정하려면?",
                  "interactionOptions": [
                    { "label": "margin" },
                    { "label": "gap" },
                    { "label": "padding" },
                    { "label": "space-between" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `gap`은 Grid/Flex 모두에서 간격을 다룹니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `gap` 속성으로 간격을 간단히 지정할 수 있어요. `space-between`은 정렬 방식이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\\\"ko\\\"><head><style>.grid{ display:grid; grid-template-columns: repeat(3, 1fr); {{BLANK-1}}: {{BLANK-2}}; }</style></head><body><div class=\\\"grid\\\"><div style=\\\"background:#fef3c7;height:50px;border-radius:8px\\\"></div><div style=\\\"background:#fef3c7;height:50px;border-radius:8px\\\"></div><div style=\\\"background:#fef3c7;height:50px;border-radius:8px\\\"></div></div></body></html>",
                  "url": "/code/66",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "space-between", "disabled": false },
                    { "id": "option-2", "value": "row-gap", "disabled": false },
                    { "id": "option-3", "value": "12px", "disabled": false },
                    { "id": "option-4", "value": "gap", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "gap", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "12px", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! `gap: 12px;`로 셀 간격이 통일됐어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 간격 값은 픽셀/퍼센트 등으로 지정합니다. 이번엔 `12px`이 정답이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}</style></head><body><div class=\"grid\"><div style=\"background:#fef3c7;height:50px;border-radius:8px\"></div><div style=\"background:#fef3c7;height:50px;border-radius:8px\"></div><div style=\"background:#fef3c7;height:50px;border-radius:8px\"></div></div></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "repeat()와 minmax(): 반응형 열 구성",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🔁 반응형 패턴\n- 반복: `repeat(n, 1fr)` 또는 `repeat(auto-fit, minmax(...))`\n- `minmax(최소, 최대)`: 칸이 너무 작아지지 않도록 하면서 늘릴 땐 넓게\n- `auto-fit`/`auto-fill`: 가능한 만큼 칸을 자동으로 채움",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "가로 폭에 따라 **4등분** 동일 폭 열을 만들려면?",
                  "interactionOptions": [
                    { "label": "grid-template-columns: 1fr 1fr 1fr 1fr" },
                    { "label": "grid-template-columns: repeat(4, 1fr)" },
                    { "label": "grid-template-columns: 25% 25% 25% 25%" },
                    { "label": "grid-template-columns: auto auto auto auto" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `repeat(4, 1fr)`이 가장 간결하고 의미가 분명해요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 여러 방법이 가능하지만, 반복에는 `repeat(4, 1fr)`이 표준적이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\\\"ko\\\"><head><style>.grid{ display:grid; grid-template-columns: repeat({{BLANK-1}}, minmax(120px, {{BLANK-2}})); gap:8px }</style></head><body><div class=\\\"grid\\\"><div style=\\\"background:#e9d5ff;height:60px;border-radius:8px\\\"></div><div style=\\\"background:#e9d5ff;height:60px;border-radius:8px\\\"></div><div style=\\\"background:#e9d5ff;height:60px;border-radius:8px\\\"></div><div style=\\\"background:#e9d5ff;height:60px;border-radius:8px\\\"></div></div></body></html>",
                  "url": "/code/67",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "auto-fit", "disabled": false },
                    { "id": "option-2", "value": "auto-fill", "disabled": false },
                    { "id": "option-3", "value": "1fr", "disabled": false },
                    { "id": "option-4", "value": "2fr", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "auto-fit", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "1fr", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 컨테이너 너비에 맞춰 칸 수가 자동으로 변합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `repeat(auto-fit, minmax(120px, 1fr))` 패턴을 기억해 두세요(카드 그리드에 유용).", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}</style></head><body><div class=\"grid\"><div style=\"background:#e9d5ff;height:60px;border-radius:8px\"></div><div style=\"background:#e9d5ff;height:60px;border-radius:8px\"></div><div style=\"background:#e9d5ff;height:60px;border-radius:8px\"></div><div style=\"background:#e9d5ff;height:60px;border-radius:8px\"></div></div></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "정렬: justify-items / align-items / place-items",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🎯 셀 내부 정렬\n- `justify-items`: **가로(인라인 축)** 정렬\n- `align-items`: **세로(블록 축)** 정렬\n- 한 번에: `place-items: 가로/세로` 또는 `place-items: center`(양축 중앙)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "각 셀 안에서 **가로·세로 모두 중앙**으로 배치하려면?",
                  "interactionOptions": [
                    { "label": "justify-items: center" },
                    { "label": "align-items: center" },
                    { "label": "place-items: center" },
                    { "label": "text-align: center" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `place-items: center`는 양축 중앙 정렬의 단축형이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 각각 지정하려면 `justify-items`와 `align-items`를 쓰고, 둘 다 중앙은 `place-items: center`가 간단해요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html><html lang=\\\"ko\\\"><head><style>.grid{ display:grid; grid-template-columns: repeat(2, 1fr); {{BLANK-1}}: {{BLANK-2}}; height:140px; gap:8px } .cell{ background:#c7d2fe; border-radius:8px; padding:8px }</style></head><body><div class=\\\"grid\\\"><div class=\\\"cell\\\">A</div><div class=\\\"cell\\\">B</div><div class=\\\"cell\\\">C</div><div class=\\\"cell\\\">D</div></div></body></html>",
                  "url": "/code/68",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "place-items", "disabled": false },
                    { "id": "option-2", "value": "align-items", "disabled": false },
                    { "id": "option-3", "value": "center", "disabled": false },
                    { "id": "option-4", "value": "middle", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "place-items", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "center", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 모든 셀이 가로·세로 중앙 정렬됐습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `place-items: center;`가 양축 중앙 정렬의 가장 간단한 방법이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"UTF-8\"><title>미리보기</title><style>body{font-family:system-ui;padding:16px}.grid{display:grid;grid-template-columns:repeat(2,1fr);place-items:center;height:140px;gap:8px}.cell{background:#c7d2fe;border-radius:8px;padding:8px}</style></head><body><div class=\"grid\"><div class=\"cell\">A</div><div class=\"cell\">B</div><div class=\"cell\">C</div><div class=\"cell\">D</div></div></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 16
const CSS_6 = {
  "lessons": [
    {
      "id": 16,
      "title": "선택자 심화와 특이성",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 선택자 심화와 특이성에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "선택자 심화에서는 결합자(>, +, ~, 공백), 속성 선택자([type='text']), 가상 클래스(:hover, :focus, :nth-child)와 가상 요소(::before, ::after)를 다룹니다. 특이성은 인라인 > ID > 클래스/속성/가상 > 태그 순이며, 동일 특이성일 때는 나중 규칙이 우선합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 17
const CSS_7 = {
  "lessons": [
    {
      "id": 17,
      "title": "단위·컬러·타이포그래피",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 단위·컬러·타이포그래피에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "반응형을 염두에 둔 rem/vw 사용법과, 가독성을 위한 line-height, 글꼴 스택(font-family)을 다룹니다. 컬러는 #HEX/rgb()/hsl()을 상황에 맞게 선택하고 대비(Contrast)와 접근성을 고려합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 18
const CSS_8 = {
  "lessons": [
    {
      "id": 18,
      "title": "반응형 디자인과 미디어 쿼리",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반응형 디자인과 미디어 쿼리에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "모바일 퍼스트로 기본 스타일을 잡고, `@media (min-width: 768px)` 같은 쿼리로 점진적 향상을 적용합니다. 이미지/그리드/폰트 크기를 분기해 단말별 체감을 개선합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 19
const CSS_9 = {
  "lessons": [
    {
      "id": 19,
      "title": "트랜지션·트랜스폼·애니메이션",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 트랜지션·트랜스폼·애니메이션에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "`transition: property duration easing delay`를 이해하고, `transform: translate/scale/rotate`로 합성 애니메이션을 구성합니다. `@keyframes`와 `animation` 속성으로 반복/왕복 효과를 만듭니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 20
const CSS_10 = {
  "lessons": [
    {
      "id": 21,
      "title": "CSS 변수와 테마",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# CSS 변수와 테마에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "`:root { --primary: #4f46e5; }`처럼 변수를 선언하고 `var(--primary)`로 사용합니다. 테마 전환은 루트 클래스 토글(.theme-dark)이나 환경설정(`prefers-color-scheme`)을 활용해 일관된 색 체계를 유지합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 21
const JS_1 = {
  "lessons": [
    {
      "id": 22,
      "title": "JS는 움직이는 힘 💪",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요 👋\n## 오늘은 웹을 움직이게 하는 힘,\n## JavaScript(JS)에 대해 알아볼까요?",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/001_반가워요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "JS는 웹의 엔진 🚗",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/6/10/22/image/001_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## HTML이 뼈대🦴\n## CSS가 옷👗\n## JS는 움직이는 힘(엔진⚡)",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/002_html_css_js.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 2,
          "title": "JS의 역할은?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/003_js의_역할은.mp3",
              "questions": [
                {
                  "title": "다음 중 JavaScript의 역할은 뭘까?",
                  "interactionOptions": [
                    { "label": "웹 구조 만들기" },
                    { "label": "웹 꾸미기" },
                    { "label": "웹을 움직이게 하기" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 잘했어요!\nJS는 웹에 **움직임과 반응**을 줘요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/004_잘했어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 '웹을 움직이게 하기'입니다.\n구조는 HTML, 꾸미기는 CSS",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/005_정답은_웹을_움직이게_하기입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보면서\n더 자세히 알아봐요!",
              "tts": "https://s3.ghmate.com/codingpt/class/6/10/22/audio/006_아래_예시_코드와_브라우저를_보면서_더_자세히_알아봐요.mp3",
              "height": 300,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>JS 동작 맛보기</h1>\n<button id='btn'>눌러보세요</button>\n<p id='text'>아직 버튼을 누르지 않았습니다.</p>\n\n<script src='script.js'></script>"
                },
                {
                  "name": "script.js",
                  "language": "javascript",
                  "content": "let count = 0; // 버튼 클릭 횟수 저장 변수\n\ndocument.getElementById('btn').addEventListener('click', function() {\n  count++; // 버튼 클릭 시 횟수 증가\n\n  // 클릭 횟수에 따라 출력 내용 변경\n  if (count === 1) {\n    document.getElementById('text').textContent = '버튼을 눌렀어요! 🎉';\n  } else {\n    document.getElementById('text').textContent = '버튼을 눌렀어요! 🎉: (+${count}번 클릭);\n  }\n});"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>JS 동작 맛보기</title></head><body><h1>JS 동작 맛보기</h1><button id='btn'>눌러보세요</button><p id='text'>아직 버튼을 누르지 않았습니다.</p><script>let count=0;document.getElementById('btn').addEventListener('click',function(){count++;if(count===1){document.getElementById('text').textContent='버튼을 눌렀어요! 🎉';}else{document.getElementById('text').textContent=`버튼을 눌렀어요! 🎉 (+${count}번 클릭)`;}});</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 3,
          "title": "JS 첫 인사",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/007_브라우저에서_알림을_띄우는_코드는_뭘까.mp3",
              "questions": [
                {
                  "title": "브라우저에서 알림을 띄우는 코드는 뭘까?",
                  "interactionOptions": [
                    { "label": "alert('안녕 JS!');" },
                    { "label": "console.log('안녕 JS!');" },
                    { "label": "console.log" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답이에요!\n`console.log`는 콘솔 출력이에요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/008_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `alert('안녕 JS!');`입니다.\n`console.log`는 콘솔 출력이에요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/009_정답은_alert_안녕_JS_입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보면서\nalert() 함수를 더 자세히 알아봐요! ✨",
              "tts": "https://s3.ghmate.com/codingpt/class/6/10/22/audio/010_아래_예시_코드와_브라우저를_보면서_alert_함수를_더_자세히_알아봐요.mp3",
              "height": 130,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>JS 첫 인사</h1>\n<button id='btn'>눌러보세요!</button>\n\n<script src='script.js'></script>"
                },
                {
                  "name": "script.js",
                  "language": "javascript",
                  "content": "document.getElementById('btn').addEventListener('click', function () {\n  alert('안녕 JS!');\n});"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>alert 예시</title><style>body{font-family:system-ui;padding:16px}button{padding:10px 20px;background:#58CC02;color:#fff;border:none;border-radius:6px;cursor:pointer}</style></head><body><h1>버튼을 눌러보세요</h1><button onclick='alert(\"안녕 JS!\")'>알림 띄우기</button></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 4,
          "title": "👩‍💻 코드 빈칸 채우기: 숫자 계산하기",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "👉 아래 빈칸을 채워 1+1=2 계산이 나오도록 해보세요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/011_아래_빈칸을_채워_덧셈_계산이_나오도록_해보세요.mp3",
              "files": [
                {
                  "name": "script.js",
                  "language": "javascript",
                  "content": "",
                  "url": "/code/5",
                  "height": 85,
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "-", "disabled": false },
                    { "id": "option-2", "value": "+", "disabled": false },
                    { "id": "option-3", "value": "*", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "+", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 **정답!**\n자바스크립트로 계산에 성공했어요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/012_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 틀렸어요 🥹\n덧셈 연산자는 `+`, 뺄셈 연산자는 `-`, 곱셈 연산자는 `*`",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/013_틀렸어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "### 🧑‍💻 아래 터미널에서 결과를 확인해볼까요?",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/014_아래_터미널에서_결과를_확인해볼까요.mp3",
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "terminal",
              "height": 120,
              "files": [
                {
                  "name": "JS Terminal",
                  "language": "js",
                  "script": [
                    { "type": "input", "text": "const two = 1 + 1;" },
                    { "type": "input", "text": "> console.log(two);" },
                    { "type": "output", "text": "2" }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 5,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 오늘은 자바스크립트(JS)가\n# 웹을 움직이게 하는 힘⚡을 알았어요.",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/015_오늘은_자바스크립트_JS가_웹을_움직이게_하는_힘을_알았어요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "## 다음 레슨에서 또 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/22/audio/016_다음_레슨에서_또_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 22
const JS_2 = {
  "lessons": [
    {
      "id": 23,
      "title": "변수는 이름표 상자 📦",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "role": "🎬 오프닝",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "CodingDevelio",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 반가워요 👋\n## 오늘은 변수(Variables)에 대해 알아봐요!",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/001_반가워요.mp3",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        },
        {
          "id": 1,
          "title": "JS는 웹의 엔진 🚗",
          "role": "📖 개념",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/class/6/10/22/image/001_concept.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "## 변수는 값을 담아두는 이름표 달린 상자📦",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/002_변수는_값을_담아두는_이름표_달린_상자.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "`let`은 값을 **바꿀 수 있는 변수** \n`const`는 값을 **바꾸지 않는 상수**",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/003_let_const.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 2,
          "title": "어떤 선언을 쓸까?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/004_한_번_정하면_바꾸지_않을_값을_만들_때_알맞은_키워드는.mp3",
              "questions": [
                {
                  "title": "한 번 정하면 바꾸지 않을 값을 만들 때 알맞은 키워드는?",
                  "interactionOptions": [
                    { "label": "let" },
                    { "label": "const" },
                    { "label": "var" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 잘했어요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/005_잘했어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 'const'입니다.\n **let**은 값을 **바꿀 수 있는 변수**\n **var**는 옛날 방식이라 초보자는 **지양**해요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/006_정답은_const입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "👇아래 예시 코드와 브라우저를 보면서\n더 자세히 알아봐요!",
              "tts": "https://s3.ghmate.com/codingpt/class/6/10/23/audio/007_아래_예시_코드와_브라우저를_보면서_더_자세히_알아봐요.mp3",
              "height": 300,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>const 간단 예시</h1>\n<button id='runBtn'>실행</button>\n<p id='out'>아직 실행 전</p>\n\n<script src='script.js'></script>"
                },
                {
                  "name": "script.js",
                  "language": "javascript",
                  "content": "// 한 번 정하면 바꾸지 않을 값 → const\nconst MAX_HEARTS = 5;\n\ntry {\n  // ❌ const 재할당 시도 → 에러 발생\n  MAX_HEARTS = 10;\n} catch (e) {\n  msg += `const는 재할당 불가! (${e.name})`;\n}\n\n document.getElementById('out').textContent = msg;\n};"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>const 예시</title></head><body style='font-family:system-ui;padding:16px'><button id='runBtn'>실행</button><p id='out'>아직 실행 전</p><script>const MAX_HEARTS=5;document.getElementById('runBtn').onclick=function(){var msg='MAX_HEARTS 초기값 = '+MAX_HEARTS;try{MAX_HEARTS=10;}catch(e){ msg+='const는 재할당 불가!';}document.getElementById('out').textContent=msg;};</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 3,
          "title": "올바른 변수 이름은 무엇?",
          "role": "✏️ 실습",
          "modules": [
            {
              "id": 0,
              "type": "multipleChoice",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/008_올바른_변수_이름을_골라보자.mp3",
              "questions": [
                {
                  "title": "올바른 변수 이름을 골라보자!",
                  "interactionOptions": [
                    { "label": "2count" },
                    { "label": "user-name" },
                    { "label": "userName" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🙆‍♀️ 정답이에요!",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/009_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 🙅‍♀️ 정답은 `userName`입니다. \n변수는 숫자로 시작하거나, `-`이 들어가면 안 돼요.",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/010_정답은_userName입니다.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "code",
              "title": "아래 예시 코드와 브라우저를 보며 더 알아봐요! ✨",
              "tts": "https://s3.ghmate.com/codingpt/class/6/10/23/audio/011_아래_예시_코드와_브라우저를_보며_더_알아봐요.mp3",
              "height": 300,
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<h1>잘못된 변수 사용 예시</h1>\n<button id='runBtn'>실행</button>\n<p id='out'>아직 실행 전</p>\n\n<script src='script.js'></script>"
                },
                {
                  "name": "script.js",
                  "language": "javascript",
                  "content": "const 2count = 5;\nconst user-name = 'mina';\n\ndocument.getElementById('runBtn').onclick = function () {\n  try {\n    const msg = `2count = ${2count}, user-name = ${user-name}`;\n    document.getElementById('out').textContent = msg;\n  } catch (e) {\n    msg += `에러 발생! (${e.name})`;\n    document.getElementById('out').textContent = msg;\n  }\n};"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            },
            {
              "id": 2,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>잘못된 변수 사용 예시</title></head><body style='font-family:system-ui;padding:16px'><h1>잘못된 변수 사용 예시</h1><button id='runBtn'>실행</button><p id='out'>아직 실행 전</p><script>document.getElementById('runBtn').onclick=function(){var out=document.getElementById('out'),msg='';try{eval('const 2count=5;');msg+='2count 선언 성공? ';}catch(e){msg+='2count 오류: '+e.name+'. ';}try{eval('const user-name=1;');msg+='user-name 선언 성공? ';}catch(e){msg+='user-name 오류: '+e.name+'. ';}out.textContent=msg;};</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 3 }
            }
          ]
        },
        {
          "id": 4,
          "title": "👩‍💻 코드 빈칸 채우기: 내 점수 관리",
          "role": "🎮 실습",
          "modules": [
            {
              "id": 0,
              "type": "codeFillTheGap",
              "title": "👉 조건에 맞게 변수를 선언하고 값을 넣어보세요\n- 점수(score)는 바뀔 수 있음\n- 별명(nick)은 바뀌지 않음",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/012_조건에_맞게_변수를_선언하고_값을_넣어보세요.mp3",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "",
                  "url": "/code/9",
                  "height": 200,
                  "isInteractive": true,
                  "inputLength": 0,
                  "interactionOptions": [],
                  "answers": []
                },
                {
                  "name": "script.js",
                  "language": "javascript",
                  "content": "",
                  "url": "/code/10",
                  "height": 200,
                  "isInteractive": true,
                  "inputLength": 3,
                  "interactionOptions": [
                    { "id": "option-1", "value": "let", "disabled": false },
                    { "id": "option-2", "value": "const", "disabled": false },
                    { "id": "option-3", "value": "=", "disabled": false },
                    { "id": "option-4", "value": "var", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "let", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "=", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "const", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 1 },
              "result": {
                "totalStep": 1,
                "modules": [
                  {
                    "id": 0,
                    "type": "paragraph",
                    "content": "## 🎉 정답!\n`let`은 바뀌는 값, `const`는 고정 값, `=`는 값 대입",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/013_정답이에요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "correct"
                  },
                  {
                    "id": 1,
                    "type": "paragraph",
                    "content": "## 틀렸어요 🥹\n바뀌는 값 → **let**, 고정 값 → **const**\n값을 넣을 때 → **=**",
                    "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/014_틀렸어요.mp3",
                    "visibility": { "type": "step", "value": 1 },
                    "condition": "wrong"
                  }
                ]
              }
            },
            {
              "id": 1,
              "type": "webview",
              "title": "🧑‍💻 아래 결과 브라우저를 볼까요?",
              "tts": "https://s3.ghmate.com/codingpt/class/6/10/23/audio/015_아래_결과_브라우저를_볼까요.mp3",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>변수 미리보기</title><style>body{font-family:system-ui;padding:16px}button{padding:8px 14px;background:#58CC02;color:#fff;border:none;border-radius:6px;cursor:pointer}</style></head><body><h1>변수 연습</h1><p id='out'>아직 실행 전이에요. 버튼을 눌러보세요!</p><button id='runBtn'>실행</button><script>let score = 10; const nick = '코딩스타'; document.getElementById('runBtn').addEventListener('click',function(){score = score + 5; document.getElementById('out').textContent = nick + '의 점수는 ' + score + '점!';});</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 6,
          "title": "🎯 오늘 배운 것 정리",
          "role": "🎉 엔딩",
          "modules": [
            {
              "id": 0,
              "type": "lottie",
              "src": "BusinessPlan",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 👌3가지만 기억해요!\n1) **변수는 값 상자**: 이름 붙여 관리\n2) **let/const**: 바뀌는 값 vs 고정 값\n3) **=**: 값을 변수에 대입",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/016_3가지만_기억해요.mp3",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 2,
              "type": "paragraph",
              "content": "## 다음 레슨에서 또 만나요! 🚀",
              "tts" : "https://s3.ghmate.com/codingpt/class/6/10/23/audio/017_다음_레슨에서_또_만나요.mp3",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 23
const JS_3 = {
  "lessons": [
    {
      "id": 24,
      "title": "객체, 메서드, map·filter, DOM, 이벤트",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 객체, 메서드, map·filter, DOM, 이벤트에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "객체 리터럴과 프로퍼티 접근(점/대괄호)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧱 객체 기초\n- 생성: `const user = { name: 'Eun', age: 21 }`\n- **점 표기**: `user.name`\n- **대괄호 표기**: `user['home-city']`, `user[key]`(키가 변수일 때 유용)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "다음 중 **변수에 들어있는 키 이름**으로 프로퍼티에 접근하는 올바른 방법은?(예: `const key = 'age'`)",
                  "interactionOptions": [
                    { "label": "user.key" },
                    { "label": "user['key']" },
                    { "label": "user[key]" },
                    { "label": "user.get(key)" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 변수 키 접근은 `user[key]` 형태를 사용합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 점 표기는 **문자 그대로**의 이름만 접근합니다. 변수 키는 `user[key]`처럼 대괄호를 사용하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const user={name:'Eun',age:21}; const key='age'; const value = user[{{BLANK-1}}]; document.getElementById('out').textContent = value;</script></body></html>",
                  "url": "/code/81",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "(key)", "disabled": false },
                    { "id": "option-2", "value": "'key'", "disabled": false },
                    { "id": "option-3", "value": "[key]", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "[key]", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 변수 `key`에 담긴 'age'를 사용해 값 21을 얻었습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 변수에 담긴 키 이름으로 접근하려면 `user[key]`처럼 **대괄호 표기**를 사용해야 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const user={name:'Eun',age:21}; const key='age'; const value=user[key]; document.getElementById('out').textContent=value;</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "객체 메서드와 this(간단 버전)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🙋 메서드와 this\n- 메서드: 객체 안에 정의된 함수\n- `this`는 **해당 객체**를 가리킵니다(메서드 호출 맥락에서)\n- 권장 표기: `greet(){ return 'Hi ' + this.name }`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "객체 자신의 `name`을 사용해 인사말을 만드는 **올바른 메서드 정의**는?",
                  "interactionOptions": [
                    { "label": "greet(){ return 'Hi ' + this.name }" },
                    { "label": "greet: () => 'Hi ' + this.name" },
                    { "label": "greet(name){ return 'Hi ' + name }" },
                    { "label": "greet: function() { return 'Hi ' + window.name }" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 메서드에서 `this`는 보통 해당 객체를 가리켜요(화살표 함수는 제외).", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 화살표 함수는 `this`가 다르게 동작할 수 있어요. 메서드는 일반 함수/축약 표기가 안전합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const user={ name:'Eun', greet(){ return 'Hi ' + {{BLANK-1}}.name; } }; document.getElementById('out').textContent = user.greet();</script></body></html>",
                  "url": "/code/82",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "self", "disabled": false },
                    { "id": "option-2", "value": "user", "disabled": false },
                    { "id": "option-3", "value": "this", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "this", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! `user.greet()`가 'Hi Eun'을 반환합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 메서드 내부에서 객체 자신을 가리키려면 `this`를 사용하세요(일반 함수 문법 권장).", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const user={name:'Eun',greet(){return 'Hi '+this.name;}}; document.getElementById('out').textContent=user.greet();</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "배열 가공: map으로 새 배열 만들기",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🗺️ map\n- 각 요소를 **변환**해 **새 배열**을 반환\n- 원본 배열은 바뀌지 않음\n- 예: `[1,2,3].map(n => n*2) // [2,4,6]`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "배열의 각 숫자를 **2배**한 **새 배열**을 만들려면?",
                  "interactionOptions": [
                    { "label": "arr.map(n => n * 2)" },
                    { "label": "arr.forEach(n => n * 2)" },
                    { "label": "arr.push(n * 2)" },
                    { "label": "arr.double()" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `map`은 변환 결과로 **새 배열**을 돌려줘요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `forEach`는 반환값이 `undefined`예요. 변환에는 `map`을 사용하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const nums=[1,2,3]; const doubled = nums.{{BLANK-1}}(n => n*2); document.getElementById('out').textContent = doubled.join(',');</script></body></html>",
                  "url": "/code/83",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "forEach", "disabled": false },
                    { "id": "option-2", "value": "map", "disabled": false },
                    { "id": "option-3", "value": "filter", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "map", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 결과는 `2,4,6` 입니다. 원본은 유지돼요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 변환 후 새 배열이 필요하면 `map`을 사용해야 합니다. `forEach`는 새 배열을 반환하지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const nums=[1,2,3]; const doubled=nums.map(n=>n*2); document.getElementById('out').textContent=doubled.join(',');</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "배열 선별: filter로 조건 통과 요소만",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🔎 filter\n- **조건을 만족**하는 요소만 모아 **새 배열** 반환\n- 예: `[1,2,3,4].filter(n => n%2===0) // [2,4]`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "짝수만 남기려면 어떤 식이 올바를까요?",
                  "interactionOptions": [
                    { "label": "arr.map(n => n % 2 === 0)" },
                    { "label": "arr.filter(n => n % 2 === 0)" },
                    { "label": "arr.forEach(n => n % 2 === 0)" },
                    { "label": "arr.find(n => n % 2 === 0 && all)" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `filter`는 조건을 통과한 요소만 모읍니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 변환은 `map`, 선별은 `filter`를 사용합니다. 개념을 구분해 보세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const nums=[1,2,3,4]; const even = nums.{{BLANK-1}}(n => {{BLANK-2}}); document.getElementById('out').textContent = even.join(',');</script></body></html>",
                  "url": "/code/84",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "filter", "disabled": false },
                    { "id": "option-2", "value": "map", "disabled": false },
                    { "id": "option-3", "value": "n % 2 === 0", "disabled": false },
                    { "id": "option-4", "value": "n % 2 == 1", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "filter", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "n % 2 === 0", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 결과는 `2,4` 입니다. 조건을 만족한 요소만 남았어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `filter(판별함수)`로 조건을 넘긴 요소만 모읍니다. 조건식은 `n % 2 === 0`이었죠!", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const nums=[1,2,3,4]; const even=nums.filter(n=>n%2===0); document.getElementById('out').textContent=even.join(',');</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "DOM 선택과 텍스트 변경(querySelector, textContent)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧷 DOM 조작 기초\n- **선택**: `document.querySelector('#title')` (CSS 선택자 기반)\n- **텍스트 변경**: `el.textContent = '새 제목'`\n- 비슷한 API: `getElementById('id')`(ID 전용)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "CSS 선택자 방식으로 ID가 `title`인 요소 하나를 선택하는 코드로 알맞은 것은?",
                  "interactionOptions": [
                    { "label": "document.getElementById('title')" },
                    { "label": "document.querySelector('#title')" },
                    { "label": "document.query('#title')" },
                    { "label": "window.select('#title')" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `querySelector`는 CSS 선택자를 그대로 사용합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `querySelector('#id')` 형태를 사용하세요. `getElementById`도 가능하지만 질문은 **CSS 선택자 방식**이었습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><h1 id='title'>원래 제목</h1><script>const el = document.{{BLANK-1}}('#title'); el.{{BLANK-2}} = '변경된 제목';</script></body></html>",
                  "url": "/code/85",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "querySelector", "disabled": false },
                    { "id": "option-2", "value": "getElementById", "disabled": false },
                    { "id": "option-3", "value": "textContent", "disabled": false },
                    { "id": "option-4", "value": "innerHTML", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "querySelector", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "textContent", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 제목이 '변경된 제목'으로 바뀌었습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 선택은 `querySelector('#title')`, 텍스트 변경은 `textContent`가 간단하고 안전해요(HTML 파싱 불필요).", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><h1 id='title'>원래 제목</h1><script>const el=document.querySelector('#title'); el.textContent='변경된 제목';</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "이벤트 처리: 클릭 시 카운터 증가(addEventListener)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🖱️ 이벤트 기본\n- 등록: `el.addEventListener('click', handler)`\n- 핸들러에서 DOM 업데이트하기\n- 인라인 `onclick`보다 명시적이고 분리가 쉬움",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "버튼 클릭 시 함수를 연결하는 표준적인 방법은?",
                  "interactionOptions": [
                    { "label": "btn.addEventListener('click', handler)" },
                    { "label": "btn.onClick(handler)" },
                    { "label": "btn.attachEvent('onclick', handler)" },
                    { "label": "click(btn, handler)" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `addEventListener`가 표준이에요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 표준 방식은 `addEventListener`입니다. 다른 방식은 구식이거나 존재하지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><button id='btn'>+1</button> <span id='count'>0</span><script>const btn=document.getElementById('btn'); let n=0; btn.{{BLANK-1}}('click', ()=>{ n++; document.getElementById('count').textContent = n; });</script></body></html>",
                  "url": "/code/86",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "addEventListener", "disabled": false },
                    { "id": "option-2", "value": "onClick", "disabled": false },
                    { "id": "option-3", "value": "attachEvent", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "addEventListener", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 클릭할 때마다 숫자가 1씩 증가합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 표준 이벤트 등록은 `el.addEventListener('click', fn)` 패턴을 사용하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><button id='btn'>+1</button> <span id='count'>0</span><script>const btn=document.getElementById('btn'); let n=0; btn.addEventListener('click',()=>{n++; document.getElementById('count').textContent=n;});</script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 24
const JS_4 = {
  "lessons": [
    {
      "id": 25,
      "title": "구조분해, 스프레드/레스트, 기본값, 축약 표기",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 구조분해, 스프레드/레스트, 기본값, 축약 표기에 대해 간단히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "배열 구조 분해 할당",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧩 배열 구조 분해\n- `const [a, b] = [10, 20]` → a=10, b=20\n- 건너뛰기: `const [first, , third] = arr`\n- 기본값: `const [x=0, y=0] = []` → x=0, y=0",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`const arr=[10,20,30]`에서 앞의 두 값을 x,y로 꺼내려면?",
                  "interactionOptions": [
                    { "label": "const x=arr(0), y=arr(1)" },
                    { "label": "const [x, y] = arr" },
                    { "label": "const {x,y} = arr" },
                    { "label": "let x=arr.0; let y=arr.1" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 배열은 대괄호 `[]`로 구조 분해합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 객체 구조 분해는 `{}`이고, 배열은 `[]`를 사용해요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang=\\\"ko\\\"><head><meta charset=\\\"UTF-8\\\"></head><body style=\\\"font-family:system-ui;padding:16px\\\"><p id=\\\"out\\\"></p><script>const nums=[1,2,3]; const [first, second] = {{BLANK-1}}; document.getElementById(\\u0027out\\u0027).textContent = first + \\u0027-\\u0027 + second;<\\/script></body></html>",
                  "url": "/code/87",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "nums", "disabled": false },
                    { "id": "option-2", "value": "[1,2]", "disabled": false },
                    { "id": "option-3", "value": "{nums}", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "nums", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! `first=1`, `second=2`가 됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 배열 변수 `nums` 자체를 구조 분해해야 합니다. 리터럴 `[1,2]`는 값이 달라요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\\u0027ko\\u0027><head><meta charset=\\u0027UTF-8\\u0027><title>미리보기</title></head><body style=\\u0027font-family:system-ui;padding:16px\\u0027><p id=\\u0027out\\u0027></p><script>const nums=[1,2,3]; const [first,second]=nums; document.getElementById(\\u0027out\\u0027).textContent=first+\\u0027-\\u0027+second;<\\/script></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "객체 구조 분해(이름 변경/기본값)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧱 객체 구조 분해\n- 이름 변경: `const { name: n } = user`\n- 기본값: `const { age = 0 } = user`\n- 둘 다: `const { name: n, age = 0 } = user`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`user.name`을 변수 `n`으로 꺼내는 구문은?",
                  "interactionOptions": [
                    { "label": "const { n } = user" },
                    { "label": "const n = user{name}" },
                    { "label": "const { name: n } = user" },
                    { "label": "const [name: n] = user" }
                  ],
                  "answer": { "isCorrect": null, "answer": 2, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `키:새이름` 형태로 변경합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 객체 구조 분해에서 이름 변경은 `const { 원래키: 새이름 }` 문법을 사용해요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang=\\\"ko\\\"><head><meta charset=\\\"UTF-8\\\"></head><body style=\\\"font-family:system-ui;padding:16px\\\"><p id=\\\"out\\\"></p><script>const user={name:\\u0027Mina\\u0027}; const { name: {{BLANK-1}}, age = {{BLANK-2}} } = user; document.getElementById(\\u0027out\\u0027).textContent = n + \\u0027/\\u0027 + age;<\\/script></body></html>",
                  "url": "/code/88",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "name", "disabled": false },
                    { "id": "option-2", "value": "0", "disabled": false },
                    { "id": "option-3", "value": "n", "disabled": false },
                    { "id": "option-4", "value": "null", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "n", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "0", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! `n=\\u0027Mina\\u0027`, `age=0`으로 표시됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 이름 변경은 `name: n`, 기본값은 `age = 0` 형태로 작성해야 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\\u0027ko\\u0027><head><meta charset=\\u0027UTF-8\\u0027><title>미리보기</title></head><body style=\\u0027font-family:system-ui;padding:16px\\u0027><p id=\\u0027out\\u0027></p><script>const user={name:\\u0027Mina\\u0027}; const {name:n, age=0}=user; document.getElementById(\\u0027out\\u0027).textContent=n+\\u0027/\\u0027+age;<\\/script></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "스프레드(...)로 배열 복사/합치기",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📦 스프레드 연산자\n- 복사: `const copy = [...arr]` (얕은 복사)\n- 결합: `const merged = [...a, ...b]`\n- 주의: 중첩 객체/배열은 **얕게**만 복사됨",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`arr`의 **독립적인 복사본**을 만드는 코드로 올바른 것은?",
                  "interactionOptions": [
                    { "label": "const clone = arr" },
                    { "label": "const clone = [...arr]" },
                    { "label": "const clone = { ...arr }" },
                    { "label": "arr.clone()" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `[...]`는 새로운 배열을 만듭니다(얕은 복사).", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `const clone = arr`는 **같은 참조**를 가리킵니다. 독립 복사는 스프레드를 쓰세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang=\\\"ko\\\"><head><meta charset=\\\"UTF-8\\\"></head><body style=\\\"font-family:system-ui;padding:16px\\\"><p id=\\\"out\\\"></p><script>const a=[1,2], b=[3,4]; const merged = [...a, {{BLANK-1}}]; document.getElementById(\\u0027out\\u0027).textContent = merged.join(\\u0027,\\u0027);<\\/script></body></html>",
                  "url": "/code/89",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "b", "disabled": false },
                    { "id": "option-2", "value": "...b", "disabled": false },
                    { "id": "option-3", "value": "[b]", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "...b", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 결과는 `1,2,3,4` 입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 배열을 펼쳐 넣으려면 `...b`처럼 **스프레드**를 사용해야 합니다. 그냥 `b`는 중첩 배열이 돼요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\\u0027ko\\u0027><head><meta charset=\\u0027UTF-8\\u0027><title>미리보기</title></head><body style=\\u0027font-family:system-ui;padding:16px\\u0027><p id=\\u0027out\\u0027></p><script>const a=[1,2], b=[3,4]; const merged=[...a, ...b]; document.getElementById(\\u0027out\\u0027).textContent=merged.join(\\u0027,\\u0027);<\\/script></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "레스트 파라미터(...args)와 합계",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 📥 레스트 파라미터\n- 임의 개수의 인자를 배열로 받기: `function sum(...nums){}`\n- 배열처럼 순회 가능: `for (const n of nums) { ... }`\n- 스프레드와 표기가 같지만 **의미가 다름**(펼치기 vs 모으기)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "아래 중 임의 개수의 숫자를 **배열로 수집**하는 함수 헤더는?",
                  "interactionOptions": [
                    { "label": "function sum(nums...)" },
                    { "label": "function sum(...nums)" },
                    { "label": "function sum(args[])" },
                    { "label": "function sum(*nums)" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `...매개변수명`이 레스트 파라미터입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 괄호 안 **앞쪽**에 `...`을 붙여 `function sum(...nums)`처럼 작성해야 해요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang=\\\"ko\\\"><head><meta charset=\\\"UTF-8\\\"></head><body style=\\\"font-family:system-ui;padding:16px\\\"><p id=\\\"out\\\"></p><script>function sum({{BLANK-1}}){ let total=0; for(const n of nums){ total+=n; } return total; } document.getElementById(\\u0027out\\u0027).textContent = sum(1,2,3);<\\/script></body></html>",
                  "url": "/code/90",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "...nums", "disabled": false },
                    { "id": "option-2", "value": "nums...", "disabled": false },
                    { "id": "option-3", "value": "args...", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "...nums", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! `sum(1,2,3)`의 결과는 6입니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 레스트 파라미터 표기는 `...식별자` 순서입니다. 뒤에 점을 쓰면 문법 오류예요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\\u0027ko\\u0027><head><meta charset=\\u0027UTF-8\\u0027><title>미리보기</title></head><body style=\\u0027font-family:system-ui;padding:16px\\u0027><p id=\\u0027out\\u0027></p><script>function sum(...nums){let t=0; for(const n of nums){t+=n;} return t;} document.getElementById(\\u0027out\\u0027).textContent=sum(1,2,3);<\\/script></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "기본값 매개변수",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧷 기본값 파라미터\n- `function greet(name=\\u0027게스트\\u0027){...}`\n- 인자를 생략하거나 `undefined`를 전달하면 기본값 사용\n- 다른 매개변수/표현식도 가능: `f(a=1,b=a+1)`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "레벨이 없으면 1로 처리하는 정의는?",
                  "interactionOptions": [
                    { "label": "function setLevel(level=1){}" },
                    { "label": "function setLevel(level||1){}" },
                    { "label": "function setLevel(level?1:0){}" },
                    { "label": "function setLevel(level==1){}" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 매개변수 자리에서 바로 기본값을 줄 수 있어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 기본값은 함수 선언의 **매개변수** 위치에서 `=`로 지정합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang=\\\"ko\\\"><head><meta charset=\\\"UTF-8\\\"></head><body style=\\\"font-family:system-ui;padding:16px\\\"><p id=\\\"out\\\"></p><script>function greet(name={{BLANK-1}}){ return \\`안녕, \\${name}\\`; } document.getElementById(\\u0027out\\u0027).textContent = greet();<\\/script></body></html>",
                  "url": "/code/91",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "'게스트'", "disabled": false },
                    { "id": "option-2", "value": "게스트", "disabled": false },
                    { "id": "option-3", "value": "[게스트]", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "'게스트'", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 인자를 생략하면 \\u0027안녕, 게스트\\u0027가 출력됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 문자열 리터럴은 따옴표로 감싸야 합니다. `\\u0027게스트\\u0027` 또는 `\\\"게스트\\\"`를 사용하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\\u0027ko\\u0027><head><meta charset=\\u0027UTF-8\\u0027><title>미리보기</title></head><body style=\\u0027font-family:system-ui;padding:16px\\u0027><p id=\\u0027out\\u0027></p><script>function greet(name=\\u0027게스트\\u0027){return \\`안녕, \\${name}\\`;} document.getElementById(\\u0027out\\u0027).textContent=greet();<\\/script></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "객체 리터럴 축약 & 계산된 프로퍼티",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ✨ 모던 객체 문법\n- 축약 표기: 변수명이 키와 같다면 `{name, age}`\n- 계산된 키: `const obj={ [key]: value }`\n- 스프레드로 복사/확장: `const next={ ...prev, active:true }`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`name`과 `age` 변수를 같은 이름의 프로퍼티로 갖는 `user`를 만드는 코드?",
                  "interactionOptions": [
                    { "label": "const user = { name: name, age: age }" },
                    { "label": "const user = { name, age }" },
                    { "label": "const user = (name, age)" },
                    { "label": "const user = [ name, age ]" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! 변수명이 키와 같을 때는 `{name, age}`로 축약 가능합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 객체 리터럴의 축약 표기를 사용하면 코드를 줄이고 가독성을 높일 수 있어요: `{name, age}`.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang=\\\"ko\\\"><head><meta charset=\\\"UTF-8\\\"></head><body style=\\\"font-family:system-ui;padding:16px\\\"><p id=\\\"out\\\"></p><script>const key=\\u0027level\\u0027; const obj = { [{{BLANK-1}}]: {{BLANK-2}} }; document.getElementById(\\u0027out\\u0027).textContent = obj.level;<\\/script></body></html>",
                  "url": "/code/92",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "key", "disabled": false },
                    { "id": "option-2", "value": "'level'", "disabled": false },
                    { "id": "option-3", "value": "1", "disabled": false },
                    { "id": "option-4", "value": "'1'", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "key", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "1", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 계산된 키로 `{ level: 1 }` 객체가 만들어졌어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 대괄호 `[]` 안에 **식별자 `key`**를 넣어 동적으로 키 이름을 만들고, 값은 숫자 `1`을 사용해야 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                { "type": "html", "content": "<!DOCTYPE html><html lang=\\u0027ko\\u0027><head><meta charset=\\u0027UTF-8\\u0027><title>미리보기</title></head><body style=\\u0027font-family:system-ui;padding:16px\\u0027><p id=\\u0027out\\u0027></p><script>const key=\\u0027level\\u0027; const obj={ [key]:1 }; document.getElementById(\\u0027out\\u0027).textContent=obj.level;<\\/script></body></html>" }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 25
const JS_5 = {
  "lessons": [
    {
      "id": 26,
      "title": "동기와 비동기",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 동기와 비동기에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "동기 vs 비동기, setTimeout",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ⏱️ 동기/비동기 기초\\n- **동기(Sync)**: 위에서 아래로 **즉시** 실행\\n- **비동기(Async)**: 나중에 실행(대기, 네트워크, 타이머 등)\\n- `setTimeout(fn, ms)`: **ms 후** `fn`을 1회 실행\\n- 이벤트 루프 때문에 `setTimeout(..., 0)`도 **다음 틱**에 실행돼요.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "일정 시간 후 콜백을 **한 번** 실행하는 API는?",
                  "interactionOptions": [
                    { "label": "setTimeout" },
                    { "label": "setInterval" },
                    { "label": "Promise" },
                    { "label": "alert" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `setTimeout`은 지연 후 **1회** 실행합니다(0ms도 다음 틱).", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `setInterval`은 **반복** 실행입니다. 한 번만 실행하려면 `setTimeout`을 사용하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const out=document.getElementById('out'); const log=t=>out.textContent+=t+' '; log('A'); {{BLANK-1}}(()=>log('B'), {{BLANK-2}}); log('C');<\\/script></body></html>",
                  "url": "/code/93",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "setInterval", "disabled": false },
                    { "id": "option-2", "value": "setTimeout", "disabled": false },
                    { "id": "option-3", "value": "0", "disabled": false },
                    { "id": "option-4", "value": "1000", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "setTimeout", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "0", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 잘했어요! 화면에는 `A C B` 순서로 출력돼요(비동기 큐).", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `setTimeout(fn, 0)`은 **즉시**가 아니라 다음 틱에 실행돼 `A C B`가 됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>const out=document.getElementById('out'); const log=t=>out.textContent+=t+' '; log('A'); setTimeout(()=>log('B'),0); log('C');<\\/script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 2,
          "title": "콜백 함수 패턴",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ☎️ 콜백 기본\\n- 콜백: **나중에 실행**할 함수를 인자로 전달\\n- 예: `doAfter(1000, () => console.log('done'))`\\n- 즉시 실행되는 `console.log('done')`을 **그대로 전달하면 안 됨**(함수 자체를 넘겨야 함)",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "콜백을 **올바르게 전달**한 예시는?",
                  "interactionOptions": [
                    { "label": "doAfter(1000, () => console.log('done'))" },
                    { "label": "doAfter(1000, console.log('done'))" },
                    { "label": "doAfter(1000, alert('done'))" },
                    { "label": "doAfter(() => 'done', 1000)" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! **함수 자체**를 인자로 전달해야 나중에 실행됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `console.log('done')`는 즉시 실행돼 반환값을 넘겨버립니다. 콜백은 `() => ...`처럼 **함수**를 넘기세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'>대기 중...</p><script>function doAfter(ms, {{BLANK-1}}){ setTimeout({{BLANK-2}}, ms); } const out=document.getElementById('out'); doAfter(300, ()=>{ out.textContent='완료'; });<\\/script></body></html>",
                  "url": "/code/94",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "fn", "disabled": false },
                    { "id": "option-2", "value": "callback", "disabled": false },
                    { "id": "option-3", "value": "cb", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "cb", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 300ms 후 '완료'가 표시됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 콜백 인자 이름과 `setTimeout`에 넘기는 **콜백 참조**가 일치해야 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'>대기 중...</p><script>function doAfter(ms, cb){ setTimeout(cb, ms); } const out=document.getElementById('out'); doAfter(300, ()=>{ out.textContent='완료'; });<\\/script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 3,
          "title": "Promise 기초: resolve와 then",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🤝 Promise 시작\\n- `new Promise((resolve, reject)=>{...})`\\n- **성공**은 `resolve(value)`, **실패**는 `reject(error)`\\n- 결과 받기: `promise.then(onFulfilled)` / 오류: `promise.catch(onRejected)`",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "Promise의 **성공 결과**를 처리하는 메서드는?",
                  "interactionOptions": [
                    { "label": "then" },
                    { "label": "catch" },
                    { "label": "finally" },
                    { "label": "await" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `then`은 성공 값을 전달받아 처리합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 오류 처리는 `catch`, 마무리 콜백은 `finally`예요. 성공은 `then`을 사용하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'>대기...</p><script>const out=document.getElementById('out'); const work=new Promise((resolve)=>{ setTimeout(()=>{{BLANK-1}}('OK'),300); }); work.{{BLANK-2}}(v=>{ out.textContent=v; });<\\/script></body></html>",
                  "url": "/code/95",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "then", "disabled": false },
                    { "id": "option-2", "value": "reject", "disabled": false },
                    { "id": "option-3", "value": "resolve", "disabled": false },
                    { "id": "option-4", "value": "catch", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "resolve", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "then", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 300ms 뒤에 'OK'가 표시됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 성공 콜백은 `resolve`, 처리 메서드는 `then`이에요. 둘을 혼동하지 마세요!", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'>대기...</p><script>const out=document.getElementById('out'); const work=new Promise(res=>{setTimeout(()=>res('OK'),300);}); work.then(v=>{out.textContent=v;});<\\/script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 4,
          "title": "Promise 체이닝과 catch",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### ⛓️ 체이닝 & 에러 처리\\n- `then`은 **새 Promise**를 반환 → 연속 처리 가능\\n- 오류는 아래로 전파되며 `catch`에서 한 번에 처리 가능\\n- `finally`는 성공/실패와 무관하게 마지막에 호출",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "체인에서 발생한 에러를 **처리**하는 메서드는?",
                  "interactionOptions": [
                    { "label": "then" },
                    { "label": "catch" },
                    { "label": "map" },
                    { "label": "finally" }
                  ],
                  "answer": { "isCorrect": null, "answer": 1, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `catch`는 에러를 받아 처리합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `finally`는 정리용 콜백일 뿐, 에러 객체를 받지 않아요. 에러 처리는 `catch`에서 하세요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>Promise.resolve(2).then(n=>n*2).then(n=>{ if(n===4) throw new Error('boom'); return n; }).{{BLANK-1}}(e=>{ document.getElementById('out').textContent='에러 처리'; });<\\/script></body></html>",
                  "url": "/code/96",
                  "isInteractive": true,
                  "inputLength": 1,
                  "interactionOptions": [
                    { "id": "option-1", "value": "handle", "disabled": false },
                    { "id": "option-2", "value": "catch", "disabled": false },
                    { "id": "option-3", "value": "error", "disabled": false },
                    { "id": "option-4", "value": "finally", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "catch", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 던진 에러를 잡아 '에러 처리'를 표시했습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ 에러는 `catch`에서 처리해야 합니다. `finally`는 정리 단계이며 에러 인자를 받지 않아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'></p><script>Promise.resolve(2).then(n=>n*2).then(n=>{ if(n===4) throw new Error('boom'); return n; }).catch(()=>{ document.getElementById('out').textContent='에러 처리'; });<\\/script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 5,
          "title": "async/await 기본",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 💤 async/await\\n- `async function f(){}`: 항상 **Promise** 반환\\n- `await promise`: Promise가 해결될 때까지 **대기** 후 값 받기\\n- 비동기 코드를 동기처럼 읽기 쉽게 만들어 줌",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "비동기 함수를 **선언**하는 키워드는?",
                  "interactionOptions": [
                    { "label": "async" },
                    { "label": "await" },
                    { "label": "defer" },
                    { "label": "promise" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `async`로 선언하고 내부에서 `await`을 사용합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `await`은 **사용** 키워드고, 선언은 `async`가 맞아요.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'>대기...</p><script>const out=document.getElementById('out'); const wait=ms=>new Promise(r=>setTimeout(r,ms)); {{BLANK-1}} function run(){ {{BLANK-2}} wait(200); out.textContent='끝'; } run();<\\/script></body></html>",
                  "url": "/code/97",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "async", "disabled": false },
                    { "id": "option-2", "value": "defer", "disabled": false },
                    { "id": "option-3", "value": "await", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "async", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "await", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 200ms 대기 후 '끝'이 출력됩니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `await`은 **async 함수 내부**에서만 사용 가능합니다. `async function` 선언을 잊지 마세요!", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'>대기...</p><script>const out=document.getElementById('out'); const wait=ms=>new Promise(r=>setTimeout(r,ms)); async function run(){ await wait(200); out.textContent='끝'; } run();<\\/script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        },
        {
          "id": 6,
          "title": "async/await 에러 처리(try/catch)",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "### 🧯 에러 다루기\\n- `await` 중 에러 → 예외 발생\\n- 처리: `try { ... } catch (e) { ... }`\\n- 실패한 Promise를 던지는 함수와 함께 실습해 봐요.",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "multipleChoice",
              "questions": [
                {
                  "title": "`await`하는 비동기 호출에서 발생한 예외를 **잡으려면** 무엇을 사용하나요?",
                  "interactionOptions": [
                    { "label": "try/catch" },
                    { "label": "if/else" },
                    { "label": "switch" },
                    { "label": "throw만 사용" }
                  ],
                  "answer": { "isCorrect": null, "answer": 0, "userAnswer": null }
                }
              ],
              "visibility": { "type": "step", "value": 2 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 정답! `try/catch`로 예외를 안전하게 처리할 수 있어요.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `await` 중 예외는 `try/catch`로 감싸서 처리해야 합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 2,
              "type": "codeFillTheGap",
              "files": [
                {
                  "name": "index.html",
                  "language": "html",
                  "content": "<!DOCTYPE html>\\n<html lang='ko'><head><meta charset='UTF-8'></head><body style='font-family:system-ui;padding:16px'><p id='out'>시도 중...</p><script>function fail(){ return new Promise((_,reject)=>setTimeout(()=>reject(new Error('x')),200)); } async function run(){ try { const v = {{BLANK-1}} fail(); document.getElementById('out').textContent=v; } {{BLANK-2}}(e){ document.getElementById('out').textContent='실패'; } } run();<\\/script></body></html>",
                  "url": "/code/98",
                  "isInteractive": true,
                  "inputLength": 2,
                  "interactionOptions": [
                    { "id": "option-1", "value": "await", "disabled": false },
                    { "id": "option-2", "value": "then", "disabled": false },
                    { "id": "option-3", "value": "catch", "disabled": false },
                    { "id": "option-4", "value": "error", "disabled": false }
                  ],
                  "answers": [
                    { "isCorrect": null, "answer": "await", "userAnswer": null, "optionElIndex": null },
                    { "isCorrect": null, "answer": "catch", "userAnswer": null, "optionElIndex": null }
                  ]
                }
              ],
              "visibility": { "type": "step", "value": 3 },
              "result": {
                "totalStep": 1,
                "modules": [
                  { "id": 0, "type": "paragraph", "content": "🎉 좋아요! 예외를 잡아 '실패'로 안전하게 표시했습니다.", "visibility": { "type": "step", "value": 1 }, "condition": "correct" },
                  { "id": 1, "type": "paragraph", "content": "❌ `await`은 값을 **기다렸다가** 받지만, 실패 시 예외를 던지므로 `catch`가 필요합니다.", "visibility": { "type": "step", "value": 1 }, "condition": "wrong" }
                ]
              }
            },
            {
              "id": 3,
              "type": "webview",
              "tabs": [
                {
                  "type": "html",
                  "content": "<!DOCTYPE html><html lang='ko'><head><meta charset='UTF-8'><title>미리보기</title></head><body style='font-family:system-ui;padding:16px'><p id='out'>시도 중...</p><script>function fail(){return new Promise((_,reject)=>setTimeout(()=>reject(new Error('x')),200));} async function run(){ try{ const v=await fail(); document.getElementById('out').textContent=v; } catch(e){ document.getElementById('out').textContent='실패'; } } run();<\\/script></body></html>"
                }
              ],
              "visibility": { "type": "step", "value": 4 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 26
const JS_6 = {
  "lessons": [
    {
      "id": 27,
      "title": "배열 메서드 심화",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 배열 메서드에 대해 자세히 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "`reduce`로 합계/최댓값/빈도수를 계산하고, `find`(첫 일치), `some`(하나라도), `every`(모두), `sort`(주의: 원본 변경)를 다룹니다. 불변 패턴(`[...arr].sort(...)`)을 습관화하세요.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 27
const JS_7 = {
  "lessons": [
    {
      "id": 28,
      "title": "문자열·정규표현식 입문",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 문자열·정규표현식에 대해 가볍게 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "문자열 탐색/자르기/치환 기본과 함께 `/패턴/gi` 문법, 특수문자 이스케이프(`\\.` 등), `RegExp.test()`/`String.match()` 사용법을 익힙니다. 사용자 입력 검증의 기초가 돼요.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 28
const JS_8 = {
  "lessons": [
    {
      "id": 29,
      "title": "JSON과 Fetch API(비동기 데이터)",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# JSON과 Fetch API(비동기 데이터)에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "REST API 호출 흐름(요청→응답→파싱)을 이해하고 로딩/에러 상태를 관리합니다. `JSON.stringify/parse`로 직렬화/역직렬화하고, 헤더/메서드/쿼리 등 요청 옵션을 맛봅니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 29
const JS_9 = {
  "lessons": [
    {
      "id": 30,
      "title": "Web Storage와 쿠키",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# Web Storage와 쿠키에 대해 알아볼까?",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "`localStorage`(영구)/`sessionStorage`(세션) 차이를 이해하고, 저장 용량·동기 API 특성을 고려합니다. 쿠키는 `expires`/`max-age`/`secure`/`SameSite` 등 속성으로 제어합니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}

// ID : 30
const JS_10 = {
  "lessons": [
    {
      "id": 31,
      "title": "ES Modules(import/export)와 프로젝트 구조",
      "isCompleted": false,
      "sliders": [
	      {
          "id": 0,
          "title": "🎯 레벨업 시작하기",
          "modules": [
            {
              "id": 0,
              "type": "image",
              "src": "https://s3.ghmate.com/codingpt/lessons/intro_img.png",
              "size": "lg",
              "visibility": { "type": "step", "value": 1 }
            },
            {
              "id": 1,
              "type": "paragraph",
              "content": "# 마지막으로 ES Modules(import/export)와 프로젝트 구조에 대해 알아보자!",
              "visibility": { "type": "step", "value": 2 }
            }
          ]
        },
        {
          "id": 1,
          "title": "개요",
          "modules": [
            {
              "id": 0,
              "type": "paragraph",
              "content": "모듈 간 인터페이스를 설계하고, 순환 의존을 피하는 구조를 생각합니다. 브라우저 모듈 경로, 상대/절대 임포트, 초기 번들링 개념까지 가볍게 다룹니다.",
              "visibility": { "type": "step", "value": 1 }
            }
          ]
        }
      ]
    }
  ]
}