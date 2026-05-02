// program < curriculum < section < unit < stages < lesson < problem
// 지금은 학습 데이터가 충분하지 않아 stage 별 하나의 lesson만 사용한다.
// 데이터 확보 후 stage에 다양한 lesson을 추가해야함.
import lesson_html_1_1 from '../../../lesson_dummy/HTML/1. HTML과 태그 알아보기/1.json';
import lesson_html_1_2 from '../../../lesson_dummy/HTML/1. HTML과 태그 알아보기/2.json';

import lesson_html_2_1 from '../../../lesson_dummy/HTML/2. 태그로 텍스트 구조화하기/1.json';

import lesson_html_3_1 from '../../../lesson_dummy/HTML/3. 버튼 만들기/1.json';

import lesson_html_4_1 from '../../../lesson_dummy/HTML/4. HTML 기초 1/1.json';

import lesson_html_5_1 from '../../../lesson_dummy/HTML/5. 링크 만들기/1.json';

import lesson_html_6_1 from '../../../lesson_dummy/HTML/6. 이미지 추가하기/1.json';

import lesson_html_7_1 from '../../../lesson_dummy/HTML/7. HTML 기초 2/1.json';

const stage_html_1 = {
  "id": 1,
  "title": "HTML 태그",
  "lessons": [

    {
      "id": 1,
      "title": "HTML 태그", 
      "content": lesson_html_1_1,

    },
  ]
}
const stage_html_2 = {
  "id": 2,
  "title": "텍스트와 제목",
  "lessons": [
    {
      "id": 1,
      "title": "텍스트와 제목",
      "content": lesson_html_1_2,
    },
  ]
}
const unit_html_1 = {
  "id": 1,
  "title": "HTML과 태그 알아보기",
  "stages": [
    stage_html_1,
    stage_html_2,
  ]
}
const stage_html_3 = {
  "id": 3,
  "title": "줄바꿈, 강조와 중요도",
  "lessons": [
    {
      "id": 1,  
      "title": "줄바꿈, 강조와 중요도", 
      "content": lesson_html_2_1,
    },
  ]
}
const unit_html_2 = { 
  "id": 2,
  "title": "태그로 텍스트 구조화하기",
  "stages": [
    stage_html_3,
  ]
} 
const stage_html_4 = {
  "id": 4,
  "title": "버튼",
  "lessons": [
    {
      "id": 1,    
      "title": "버튼",
      "content": lesson_html_3_1,
    },
  ]
} 
const unit_html_3 = { 
  "id": 3,
  "title": "버튼 만들기",
  "stages": [
    stage_html_4,
  ]
}  
const stage_html_5 = {
  "id": 5,
  "title": "HTML 기초 1",
  "lessons": [
    {
      "id": 1,      
      "title": "HTML 기초 1",
      "content": lesson_html_4_1,
    },
  ]
}  
const unit_html_4 = {  
  "id": 4,
  "title": "HTML 기초 1",
  "stages": [
    stage_html_5,
  ]
}   
const stage_html_6 = {
  "id": 6,
  "title": "링크와 속성",
  "lessons": [
    {
      "id": 1,        
      "title": "링크와 속성",
      "content": lesson_html_5_1,
    },
  ]
}   
const unit_html_5 = {  
  "id": 5,
  "title": "링크 만들기",
  "stages": [
    stage_html_6,
  ]
}    
const stage_html_7 = {
  "id": 7,
  "title": "이미지",
  "lessons": [
    {
      "id": 1,        
      "title": "이미지",
      "content": lesson_html_6_1,
    },
  ]
}   
const unit_html_6 = {  
  "id": 6,
  "title": "이미지 추가하기",
  "stages": [
    stage_html_7,
  ]
}
const stage_html_8 = {
  "id": 8,
  "title": "HTML 기초 2",
  "lessons": [
    {
      "id": 1,  
      "title": "HTML 기초 2",
      "content": lesson_html_7_1,
    },
  ]
}
const unit_html_7 = {
  "id": 7,
  "title": "HTML 기초 2",
  "stages": [
    stage_html_8,
  ]
}
const section_html_1 = {
  "id": 1,
  "title": "HTML 기초",
  "units": [
    unit_html_1,
    unit_html_2,
    unit_html_3,
    unit_html_4,
    unit_html_5,
    unit_html_6,
    unit_html_7,
  ]
}













import lesson_javascript_1_1 from '../../../lesson_dummy/JavaScript/1. 변수 만들기/1.json';
import lesson_javascript_1_2 from '../../../lesson_dummy/JavaScript/1. 변수 만들기/2.json';
import lesson_javascript_1_3 from '../../../lesson_dummy/JavaScript/1. 변수 만들기/3.json';
import lesson_javascript_1_4 from '../../../lesson_dummy/JavaScript/1. 변수 만들기/4.json';

import lesson_javascript_2_1 from '../../../lesson_dummy/JavaScript/2. 변수 사용하기/1.json';
import lesson_javascript_2_2 from '../../../lesson_dummy/JavaScript/2. 변수 사용하기/2.json';
import lesson_javascript_2_3 from '../../../lesson_dummy/JavaScript/2. 변수 사용하기/3.json';

import lesson_javascript_3_1 from '../../../lesson_dummy/JavaScript/3. 참과 거짓 사용하기/1.json';
import lesson_javascript_3_2 from '../../../lesson_dummy/JavaScript/3. 참과 거짓 사용하기/2.json';

import lesson_javascript_4_1 from '../../../lesson_dummy/JavaScript/4. 숫자 비교하기/1.json';
import lesson_javascript_4_2 from '../../../lesson_dummy/JavaScript/4. 숫자 비교하기/2.json';

import lesson_javascript_5_1 from '../../../lesson_dummy/JavaScript/5. JavaScript 기초/1.json';
import lesson_javascript_5_2 from '../../../lesson_dummy/JavaScript/5. JavaScript 기초/2.json';

const stage_javascript_1 = {
  "id": 1,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_javascript_1_1,
    },
  ]
}
const stage_javascript_2 = {
  "id": 2,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_javascript_1_2,
    },
  ]
}
const stage_javascript_3 = {
  "id": 3,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_javascript_1_3,
    },
  ]
}
const stage_javascript_4 = {
  "id": 4,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_javascript_1_4,

    },
  ]
}
const unit_javascript_1 = {
  "id": 1,
  "title": "변수 만들기",
  "stages": [
    stage_javascript_1,
    stage_javascript_2,
    stage_javascript_3,
    stage_javascript_4,
  ]
}
const stage_javascript_5 = {
  "id": 5,
  "title": "변수 사용하기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 사용하기",
      "content": lesson_javascript_2_1,
    },
  ]
}
const stage_javascript_6 = {
  "id": 6,
  "title": "변수 사용하기",
  "lessons": [
    {
      "id": 1,  
      "title": "변수 사용하기",
      "content": lesson_javascript_2_2,
    },
  ]
} 
const stage_javascript_7 = {
  "id": 7,
  "title": "변수 사용하기",
  "lessons": [
    {
      "id": 1,  
      "title": "변수 사용하기",
      "content": lesson_javascript_2_3,
    },
  ]
} 
const unit_javascript_2 = { 
  "id": 2,
  "title": "변수 사용하기",
  "stages": [
    stage_javascript_5,
    stage_javascript_6,
    stage_javascript_7,
  ]
}
const stage_javascript_8 = {
  "id": 8,
  "title": "참과 거짓 사용하기",
  "lessons": [

    {
      "id": 1,  
      "title": "참과 거짓 사용하기",
      "content": lesson_javascript_3_1,
    },

  ]
} 
const stage_javascript_9 = {
  "id": 9,
  "title": "참과 거짓 사용하기",
  "lessons": [
    {
      "id": 1,  
      "title": "참과 거짓 사용하기",
      "content": lesson_javascript_3_2,
    },

  ]
}  
const unit_javascript_3 = {
  "id": 3,
  "title": "참과 거짓 사용하기",
  "stages": [
    stage_javascript_8,
    stage_javascript_9,
  ]
} 
const stage_javascript_10 = {
  "id": 10,
  "title": "숫자 비교하기",
  "lessons": [  
    {
      "id": 1,  
      "title": "숫자 비교하기",
      "content": lesson_javascript_4_1,
    },
  ]
}  
const stage_javascript_11 = {
  "id": 11,
  "title": "숫자 비교하기",
  "lessons": [
    {
      "id": 1,    
      "title": "숫자 비교하기",
      "content": lesson_javascript_4_2,
    },
  ]
}  
const unit_javascript_4 = { 
  "id": 4,
  "title": "숫자 비교하기",
  "stages": [
    stage_javascript_10,
    stage_javascript_11,
  ]
}   
const stage_javascript_12 = {
  "id": 12,
  "title": "자바스크립트 기초",
  "lessons": [
    {
      "id": 1,    
      "title": "자바스크립트 기초",
      "content": lesson_javascript_5_1,
    },
  ]
}  
const stage_javascript_13 = { 
  "id": 13,
  "title": "자바스크립트 기초",
  "lessons": [
    {
      "id": 1,  
      "title": "자바스크립트 기초", 
      "content": lesson_javascript_5_2,
    },
  ]
}  
const unit_javascript_5 = { 
  "id": 5,
  "title": "자바스크립트 기초", 
  "stages": [
    stage_javascript_12,
    stage_javascript_13,
  ]
}   
const section_javascript_1 = {
  "id": 1,
  "title": "자바스크립트 기초",
  "units": [
    unit_javascript_1,
    unit_javascript_2,
    unit_javascript_3,
    unit_javascript_4,
    unit_javascript_5,
  ]
}















import lesson_python_1_1 from '../../../lesson_dummy/Python/1. 변수 만들기/1.json';
import lesson_python_1_2 from '../../../lesson_dummy/Python/1. 변수 만들기/2.json';
import lesson_python_1_3 from '../../../lesson_dummy/Python/1. 변수 만들기/3.json';

import lesson_python_2_1 from '../../../lesson_dummy/Python/2. 변수 사용하기/1.json';
import lesson_python_2_2 from '../../../lesson_dummy/Python/2. 변수 사용하기/2.json';
import lesson_python_2_3 from '../../../lesson_dummy/Python/2. 변수 사용하기/3.json';

import lesson_python_3_1 from '../../../lesson_dummy/Python/3. 참과 거짓 사용하기/1.json';
import lesson_python_3_2 from '../../../lesson_dummy/Python/3. 참과 거짓 사용하기/2.json';

import lesson_python_4_1 from '../../../lesson_dummy/Python/4. 숫자 비교하기/1.json';
import lesson_python_4_2 from '../../../lesson_dummy/Python/4. 숫자 비교하기/2.json';

import lesson_python_5_1 from '../../../lesson_dummy/Python/5. 문자열 포맷팅/1.json';

import lesson_python_6_1 from '../../../lesson_dummy/Python/6. Python 기초/1.json';

const stage_python_1 = {
  "id": 1,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_python_1_1,
    },
  ]
} 
const stage_python_2 = {
  "id": 2,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_python_1_2,
    },
  ]
} 
const stage_python_3 = {
  "id": 3,
  "title": "변수 만들기",
  "lessons": [
    {
      "id": 1,
      "title": "변수 만들기",
      "content": lesson_python_1_3,
    },
  ]
} 
const unit_python_1 = {
  "id": 1,
  "title": "변수 사용하기",
  "stages": [
    stage_python_1,
    stage_python_2,
    stage_python_3,
  ]
}
const stage_python_4 = {
  "id": 4,
  "title": "변수 사용하기",
  "lessons": [
    {
      "id": 1,  
      "title": "변수 사용하기",
      "content": lesson_python_2_1,
    },
  ]
}  
const stage_python_5 = {
  "id": 5,
  "title": "변수 사용하기",
  "lessons": [
    {
      "id": 1,  
      "title": "변수 사용하기",
      "content": lesson_python_2_2,
    },
  ]
}   
const stage_python_6 = {
  "id": 6,
  "title": "변수 사용하기",
  "lessons": [
    {
      "id": 1,    
      "title": "변수 사용하기",
      "content": lesson_python_2_3,
    },
  ]
}    
const unit_python_2 = {
  "id": 2,
  "title": "변수 사용하기",
  "stages": [
    stage_python_4,
    stage_python_5,
    stage_python_6,
  ]
}
const stage_python_7 = {
  "id": 7,
  "title": "참과 거짓",  
  "lessons": [
    {
      "id": 1,  
      "title": "참과 거짓",
      "content": lesson_python_3_1,
    },
  ]
} 
const stage_python_8 = {
  "id": 8,
  "title": "참과 거짓",
  "lessons": [
    {
      "id": 1,    
      "title": "참과 거짓",
      "content": lesson_python_3_2,
    },
  ]
} 
const unit_python_3 = {
  "id": 3,
  "title": "참과 거짓",
  "stages": [
    stage_python_7,
    stage_python_8,
  ]
} 
const stage_python_9 = {
  "id": 9,
  "title": "숫자 비교하기",
  "lessons": [
    {
      "id": 1,    
      "title": "숫자 비교하기",
      "content": lesson_python_4_1,
    },
  ]
}  
const stage_python_10 = {
  "id": 10,
  "title": "숫자 비교하기",
  "lessons": [
    {
      "id": 1,      
      "title": "숫자 비교하기",
      "content": lesson_python_4_2,
    },
  ]
}  
const unit_python_4 = { 
  "id": 4,
  "title": "숫자 비교하기",
  "stages": [
    stage_python_9,
    stage_python_10,
  ]
} 
const stage_python_11 = {
  "id": 11,
  "title": "문자열 포맷팅",
  "lessons": [
    {
      "id": 1,    
      "title": "문자열 포맷팅",
      "content": lesson_python_5_1,
    },
  ]
} 
const unit_python_5 = {
  "id": 5,
  "title": "문자열 포맷팅",
  "stages": [
    stage_python_11,
  ]
}  
const stage_python_12 = { 
  "id": 12,
  "title": "파이썬 기초",
  "lessons": [
    {
      "id": 1,    
      "title": "파이썬 기초",
      "content": lesson_python_6_1,
    },
  ]
}  
const unit_python_6 = {
  "id": 6,
  "title": "파이썬 기초",
  "stages": [
    stage_python_12,
  ]
}  
const section_python_1 = {
  "id": 1,
  "title": "파이썬 기초",
  "units": [
    unit_python_1,
    unit_python_2,
    unit_python_3,
    unit_python_4,
    unit_python_5,
    unit_python_6,
  ]
}


export const curriculumList = [
  {
    "id": 1,
    "title": "HTML",
    "description": "HTML은 웹 페이지의 구조를 정의하는 마크업 언어입니다.",
    "image": "/src/assets/images/curriculumList/html.png",
    "sections": [
      section_html_1,
    ],
  },
  {
    "id": 2,
    "title": "JavaScript",
    "description": "JavaScript는 웹 페이지의 동작을 제어하는 프로그래밍 언어입니다.",
    "image": "/src/assets/images/curriculumList/js.png",
    "sections": [
      section_javascript_1,
    ],
  },
  {
    "id": 3,
    "title": "Python",
    "description": "Python은 쉽고 강력한 범용 프로그래밍 언어입니다.",
    "image": "/src/assets/images/curriculumList/python.png",
    "sections": [
      section_python_1,
    ],

  },

]

