// // src/pages/Lesson.js
// import {useRef, useState} from 'react';
// import { Navigate, useLocation } from 'react-router-dom';
// import Btn from '../components/component/Btn';
// import Iframe from '../components/component/Iframe';
// // import LottieAnimation from '../components/LottieAnimation';
// import { curriculumList } from '../assets/lesson_dummy/curriculumList';

// import ReactMarkdown from 'react-markdown';
// import Header from '../components/lesson/Header';

// const urlParams = new URLSearchParams(window.location.search);
// const curriculumId = urlParams.get('curriculum_id');
// const sectionId = urlParams.get('section_id');
// const unitId = urlParams.get('unit_id');
// const stageId = urlParams.get('stage_id');

// const curriculum = curriculumList.find((curriculum) => curriculum.id === Number(curriculumId));
// const section = curriculum.sections.find((section)=>section.id === Number(sectionId));
// const unit = section.units.find((unit)=>unit.id === Number(unitId));
// const stage = unit.stages.find((stage)=>stage.id === Number(stageId));

// stage.lessons[0].content.pageProps.lessons.forEach((dummy)=>{
//   if(dummy?.interactionModule?.interactionOptions){
//     const values = dummy.interactionModule.interactionOptions.map(({value})=>{return value})
//     dummy.options = [...dummy.interactionModule.wrongOptions, ...values];
//     function shuffleArray(array) {
//       for (let i = array.length - 1; i > 0; i--) {
//         const randomIndex = Math.floor(Math.random() * (i + 1));
//         [array[i], array[randomIndex]] = [array[randomIndex], array[i]]; // Swap
//       }
//       return array;
//     }
//     dummy.options = shuffleArray(dummy.options);
//   }
// })

// const Lesson = () => {
  
//   const inputRefs = useRef([]);
//   const [disabledOptions, setDisabledOptions] = useState([]); // 비활성화된 옵션 상태
//   const [allInputsFilled, setAllInputsFilled] = useState(false); // 모든 input이 채워졌는지 상태 확인

//   const location = useLocation();
//   const searchParams = new URLSearchParams(location.search);

//   const [stepsData, setStepsData] = useState(stage.lessons[0].content.pageProps.lessons);
//   const [lessonStep, setLessonStep] = useState(parseInt(searchParams.get('lessonStep')) || 0);
//   const [languageNav, setLanguageNav] = useState(0);

//   const currentStepData = stepsData.find((step) => step.index === lessonStep);
//   const [isCorrect, setIsCorrect] = useState(null);
//   const [, forceUpdate] = useState({});  // 강제 리렌더링을 위한 state 추가

//   const resetInputRefs = () => {
//     // 기존 참조 초기화
//     inputRefs.current.forEach((inputRef) => {
//       if (inputRef) {
//         inputRef.value = ""; // 값 제거
//       }
//     });
//     inputRefs.current = []; // 완전히 새로운 배열로 초기화
//   };


//   const handleClick = () => {
    
//     if(["codeFillTheGap", "codeValidatedInput"].includes(currentStepData?.interactionModule?.type)) {
//       if(currentStepData?.interactionModule?.type === "codeValidatedInput") {
//         const interactionOption = currentStepData?.interactionModule?.interactionOption
//         if(interactionOption){
//           const hasIncorrectAnswer = interactionOption.value !== inputRefs.current[0]?.value;
//           if(hasIncorrectAnswer){
//             setIsCorrect(false);
//           }else{
//             setIsCorrect(true);
//             setLanguageNav(currentStepData.interactionModule.files.length);
//           }
//         }
//       }
//       if(currentStepData?.interactionModule?.type === "codeFillTheGap"){
        
//         const codeLanguage = currentStepData?.interactionModule?.files[0].codeLanguage
//         if(codeLanguage === "python"){
//           console.log("python")
//         }
//         if(codeLanguage === "javascript"){
//           console.log("javascript")
//         }
//         if(codeLanguage === "html"){
//           console.log("html")
//         }

//         const interactionOptions = currentStepData?.interactionModule?.interactionOptions
//         if(interactionOptions){
//           const hasIncorrectAnswer = interactionOptions.some((option, index) => option.value !== inputRefs.current[index]?.value);
//           // const postInteractionModules = currentStepData?.postInteractionModules
//           if(hasIncorrectAnswer){
//             // const content = postInteractionModules.find((postInteractionModule)=>postInteractionModule.visibleIf === "wrong");
//             // console.log(content)
//             setIsCorrect(false);
//           }else{
//             // const content = postInteractionModules.find((postInteractionModule)=>postInteractionModule.visibleIf === "correct");
//             // console.log(content)
//             setIsCorrect(true); 
//             setLanguageNav(currentStepData.interactionModule.files.length);
//           }
//         }
//       }
//       if(isCorrect !== null){
//         resetInputRefs();
//         setIsCorrect(null);
//         const nextStep = lessonStep + 1;
//         nextStep === stepsData.length ? Navigate('/lesson') : setLessonStep(nextStep);
//         setLanguageNav(0);
//         setDisabledOptions([]);
//         setAllInputsFilled(false);
//       }
//     }else if(currentStepData?.interactionModule?.type === "multipleChoice") {
//       setIsCorrect(currentStepData?.interactionModule.items[disabledOptions[0]].correct);
//       if(isCorrect !== null){
//         resetInputRefs();
//         setIsCorrect(null);
//         const nextStep = lessonStep + 1;
//         nextStep === stepsData.length ? Navigate('/lesson') : setLessonStep(nextStep);
//         setLanguageNav(0);
//         setDisabledOptions([]);
//         setAllInputsFilled(false);
//       }
//     }else{
//       const nextStep = lessonStep + 1;
//       nextStep === stepsData.length ? Navigate('/lesson') : setLessonStep(nextStep);
//     }
    
//   };

//   // const handleSelect = (option) => {
//   //   setStepsData((prevSteps) =>
//   //     prevSteps.map((step) =>
//   //       step.step === lessonStep
//   //         ? { ...step, user_select_data: option }
//   //         : step
//   //     )
//   //   );
//   // };

//   // 프로그래밍 네브 아이템 클릭 시
//   const clickProgrammingLanguageNav = (event) => {
//     const index = Number(event.target.dataset.index); 
//     setLanguageNav(index)
//   }

//   // option 클릭 시
//   const clickOptionItem = (event, index) => {
//     const selectedValue = event.target.textContent; 
//     if(currentStepData?.interactionModule?.type === "codeFillTheGap") {
//       const emptyInputIndex = inputRefs.current.findIndex((input) => input && !input.value);
//       const emptyInput = inputRefs.current[emptyInputIndex];
//       if (emptyInput) {
//         currentStepData.interactionModule.interactionOptions[emptyInputIndex].userValue = selectedValue;
//         emptyInput.value = selectedValue; 

//         // optionIndex > 사용자가 정답을 선택한 옵션 인덱스
//         emptyInput.dataset.optionIndex = index; 
//         // inputIndex > 사용자가 선택한 정답을 입력한 인풋 인덱스
//         emptyInput.dataset.inputIndex = emptyInputIndex;
        

//         emptyInput.dispatchEvent(new Event("input", { bubbles: true })); 
//         setDisabledOptions((prev) => [...prev, parseInt(index)]);
//       }
//       checkAllInputsFilled();
//     }
//     if(currentStepData?.interactionModule?.type === "multipleChoice") {
      
//       setDisabledOptions([Number(index)]);
//       setAllInputsFilled(true);
//     }    
//   };
//   // input value 제거
//   const clearInputValue = (event) => {
//     const input = event.currentTarget.querySelector('input');
//     // optionIndex > 사용자가 정답을 선택한 옵션 인덱스
//     const optionIndex = input.dataset.optionIndex; 
//     // inputIndex > 사용자가 선택한 정답을 입력한 인풋 인덱스
//     const inputIndex = input.dataset.inputIndex; 
//     if (optionIndex !== undefined) {
//       delete input.dataset.optionIndex;
//       currentStepData.interactionModule.interactionOptions[inputIndex].userValue = "";
//       // 해당 옵션 활성화
//       setDisabledOptions((prev) =>
//         prev.filter((index) => index !== parseInt(optionIndex))
//       );
//     }
//     checkAllInputsFilled();
//   };
//   // 모두 정답 입력된 상태 확인
//   const checkAllInputsFilled = () => {
//     const allFilled = inputRefs.current.every((input) => input && input.value);
//     setAllInputsFilled(allFilled); // 상태 업데이트
//   };
//   // JSON 데이터를 기반으로 옵션 `<button>` 태그 생성 및 랜덤 섞기
//   const generateOptionBtns = (options) => {
//     const elements = [];
//     options.forEach((option, index) => {
//       elements.push(
//         <button
//           key={`option-${index}`}
//           data-index={index}
//           onClick={(event) => clickOptionItem(event, index)}
//           className={`
//             flex items-center 
//             h-8 
//             px-3
//             border border-b-2 rounded-lg border-[#37464f]
//             font-normal text-sm 
//             ${
//             disabledOptions.includes(index)
//               ? "text-gray-500 cursor-not-allowed bg-[#37464f] border-[#37464f]"
//               : "border-product2-border-secondary text-white text-product2-content-primary"
//             }
//           `}
//           disabled={disabledOptions.includes(index)} // 비활성화 상태
//         >
//           {option}
//         </button>
//       );
//     });

//     return elements;
//   };

//   // 사용자 입력값으로 코드 완성하기
//   const combineUserInputsWithTemplate = () => {
//     const type = currentStepData.interactionModule.type;
//     const isInteractive = currentStepData.interactionModule.files[0].isInteractive;
//     const content = currentStepData.interactionModule.files[0].content;
//     const lines = content.split("\n");
//     const elements = [];
//     lines.forEach((line, lineIndex) => {
//       let lineElements = [];
//       let lastIndex = 0;
//       if(!isInteractive){
//         lineElements.push(line)
//       }else{
//         if(type == "codeValidatedInput"){
//           const option = currentStepData.interactionModule.interactionOption;
//           const { startLine, startPos, length, userValue } = option;
//           if(startLine == lineIndex){
//             if (startPos > lastIndex) {
//               lineElements.push(line.slice(lastIndex, startPos));
//               lastIndex = startPos + length; 
//             }
//             lineElements.push(userValue || "");
//             lastIndex = startPos + length; 
//           }
//         }
//         if(type == "codeFillTheGap"){
//           const options = currentStepData.interactionModule.interactionOptions
//           const lineOptions = options.filter((option) => option.startLine === lineIndex);
//           lineOptions.forEach((option) => {
//             const { startPos, length, userValue } = option;
//             if (startPos > lastIndex) {
//               lineElements.push(line.slice(lastIndex, startPos));
//               lastIndex = startPos + length;
//             }
//             lineElements.push(userValue || "");
//             lastIndex = startPos + length;
//           })
//         }
//       }
//       if (lastIndex < content.length) {
//         lineElements.push(line.slice(lastIndex));
//       }
//       elements.push(lineElements.join(''))
//     })
//     console.log(elements.join(''))
//     return elements.join('');
//   }
  
//   // JSON 데이터를 기반으로 Browser `<Iframe>` 태그를 생성
//   const generateBrowswer = () => {
//     // TODO : Iframe 영역에서 터미널, 콘솔, 뷰 해당 언어 결과 리턴에 맞는 화면 출력
//     return <Iframe content={combineUserInputsWithTemplate()} />;
//   }

//   const postModule = currentStepData.postInteractionModules.find(
//     ({ visibleIf }) => visibleIf === (isCorrect ? "correct" : "wrong")
//   );

//   // 코드 에디터 세팅
//   const getCodeEditor = (type, isInteractive, content, options) => {
//     const lines = content.split("\n");
//     const elements = [];
//     if(!isInteractive){
//       lines.forEach((line, lineIndex) => {
//         elements.push(
//           <div key={`line-${lineIndex}`} className="flex items-center">
//             <code key={`code-${lineIndex}-0`} className={`${lineIndex.length != 0 && 'ml-1'} text-white`}>
//               {line}
//             </code>
//           </div>
//         );
//       });
//     }else{
//       lines.forEach((line, lineIndex) => {
//         let lineEls = [];
//         let lastIndex = 0;
//         if(type == "codeValidatedInput"){
//           const { startPos, startLine, endIndex, length, value, userValue } = options[0];
//           if(startLine == lineIndex){
//             if (startPos > lastIndex) {
//               lineEls.push(
//                 <code key={`code-${lineIndex}-0`} className={`${lineEls.length != 0 && 'ml-1'} text-white`}>
//                   {line.slice(lastIndex, startPos)}
//                 </code>
//               );
//               lastIndex = startPos + length;
//             }
            
//             lineEls.push(
//               <input
//                 key={`input-${lineIndex}-0`}
//                 ref={(el) => {
//                   if (el) {
//                     // 중복 방지 및 null 값 제외
//                     if (!inputRefs.current.includes(el)) {
//                       inputRefs.current.push(el);
//                     }
//                   } else {
//                     // 요소가 삭제되면 배열에서 제거
//                     inputRefs.current = inputRefs.current.filter((ref) => ref !== null);
//                   }
//                 }}
//                 className={`
//                   h-5 
//                   ${lineEls.length != 0 ? 'ml-1' : ''} 
//                   min-w-[21px] 
//                   border border-[#282828] rounded-md 
                  
//                   text-center text-sm text-white 
//                   caret-blue-400 
//                   bg-[#282828]
//                   focus:border-blue-500 
//                   focus:ring 
//                   focus:ring-blue-300 
//                   focus:outline-none
//                 `}
//                 style={{ width: `calc(${length}ch + 12px)` }}
//                 value={userValue ? userValue : ""}
//                 onChange={(event) => {
//                   const input = event.target;
//                   currentStepData.interactionModule.interactionOption.userValue = input.value;
//                   forceUpdate({})
//                   checkAllInputsFilled()
//                 }}
//               /> 
//             )
//             lastIndex = startPos + length;
//           }
//         }
//         if(type == "codeFillTheGap"){
//           const lineOptions = options.filter((option) => option.startLine === lineIndex);
//           lineOptions.forEach((option, optionIndex) => {
//             const { startIndex, endIndex, startPos, length, value, userValue } = option;           
//             // `<code>` 태그 추가 (startPos 이전의 텍스트)
//             if (startIndex > lastIndex) {
//               lineEls.push(
//                 <code key={`code-${lineIndex}-${optionIndex}`} className={`${lineEls.length != 0 && 'ml-1'} text-white`}>
//                   {line.slice(lastIndex, startPos)}
//                 </code>
//               );
//               lastIndex = startPos + length;
  
//             }
//             // `<input>` 태그 추가
//             lineEls.push(
//               <label key={`input-${lineIndex}-${optionIndex}`}onClick={(event) => clearInputValue(event)}>
//                 <span className={`
//                   h-5 
//                   ${lineEls.length != 0 ? 'ml-1' : ''} px-1.5
//                   min-w-[21px] 
//                   border border-[#282828] rounded-md 
//                   bg-[#282828]
//                   ${userValue ? 'block' : 'hidden'}
//                 `}>
//                   {userValue}
//                 </span>
//                   <input
//                     hidden={userValue ? true : false}
//                     ref={(el) => {
//                       if (el) {
//                         // 중복 방지 및 null 값 제외
//                         if (!inputRefs.current.includes(el)) {
//                           inputRefs.current.push(el);
//                         }
//                       } else {
//                         // 요소가 삭제되면 배열에서 제거
//                         inputRefs.current = inputRefs.current.filter((ref) => ref !== null);
//                       }
//                     }}
//                     className={`
//                       h-5 
//                       ${lineEls.length != 0 ? 'ml-1' : ''} 
//                       min-w-[21px] 
//                       border border-[#282828] rounded-md 
                      
//                       text-center text-sm text-white 
//                       caret-blue-400 
//                       bg-[#282828]
//                       focus:outline-none
//                     `}
//                     style={{ width: `calc(${length}ch + 12px)` }}
//                     readOnly
//                     value={userValue ? userValue : ""}
//                   />
//                 </label>
//             );
//             lastIndex = startPos + length;
//           });
//         }      
//         // 마지막 `<code>` 태그 처리
//         if (lastIndex < line.length) {
//           lineEls.push(
//             <code key={`code-last-${lineIndex}`} className={`text-white ml-1`}>
//               {line.slice(lastIndex)}
//             </code>
//           );
//         }
//         elements.push(
//           <div key={`line-${lineIndex}`} className="flex items-center">
//             {lineEls}
//           </div>
//         );
//       });
//     }
//     return elements;
//   }

//   return (
//     <div className="relative flex flex-col items-center justify-center max-w-96 h-screen mx-auto">
//       <div
//         className="
//           flex flex-col
//           w-full h-screen
          
//         "
//       >
//         <Header />
        
//         <div className={`flex-1 px-4 flex flex-col items-center justify-start pb-24 overflow-auto`}>
//           {/* title */}
//           {/* <h1 className={`text-2xl font-bold`}>{currentStepData.title}</h1> */}
//           {currentStepData.type === "Interactive" && 
//           <div className={`flex gap-4 flex-col w-full`}>
//             {/* preInteractionModules */}
//             <div className="flex flex-1 items-center h-full">
//               <div className={`flex flex-col text-center gap-4 w-full text-[#f1f7fb] font-semibold`}>
//                 {currentStepData.preInteractionModules.map((data, index)=> {
//                 return (
//                 <div key={index}>
//                   {data.type === "image" && <img src={`https://images.getmimo.com/images/${data.src}`} alt="Lesson Content" className="rounded-lg" />}
//                   {data.type === "paragraph" && <ReactMarkdown>{data.content}</ReactMarkdown>}
//                   {data.type === "codeNone" && 
//                   <div className={`min-w-[300px] max-w-[664px] flex-1`}>
//                     <div className={`
//                     relative 
//                     flex flex-col 
//                     max-h-[440px] w-full 
//                     rounded-[4px] border border-[#181818]
//                     overflow-hidden
//                     `}>
//                       <div className={`    
//                         flex flex-shrink-0 
//                         h-10 
//                         bg-[#1f1f1f]
//                         overflow-x-auto 
//                         `}>
//                         {data.files.map((file, index)=>{ return (
//                         <button 
//                           key={index}
//                           className={`
//                             flex items-center justify-center 
//                           h-full 
//                           space-x-2 
//                           px-4 
//                           whitespace-nowrap 
//                           text-xs font-semibold text-white
//                           bg-[#1c1c1c] border border-[#2b2b2b] border-b-0 border-t-[#49c0f8]
//                           `}
//                         >
//                         {file.name}
//                         </button>
//                         )})}
//                       </div>
                      
//                       {languageNav == data.files.length ? 
//                       <div className="max-h-56 overflow-y-auto bg-[#fff]">
//                         {generateBrowswer()}
//                       </div>
//                       :
//                       data.files.map((file, index)=>{
//                         const type = data.type;
//                         const isInteractive = file.isInteractive;
//                         const content = file.content;
//                         const options = [];
//                         return (
//                         <pre key={`preInteractionModules_${index}`} className="max-h-56 overflow-y-auto bg-[#1c1c1c] px-4 py-3 text-sm text-white">
//                           {getCodeEditor(type, isInteractive, content, options)}
//                         </pre>
//                         )
//                       })
//                       }
//                     </div>
//                   </div>
//                   }
//                   {data.type === "webview" && 
//                   <div className={`min-w-[300px] max-w-[664px] flex-1`}>
//                     <div className={`
//                     relative 
//                     flex flex-col 
//                     max-h-[440px] w-full 
//                     rounded-[4px] border border-[#181818]
//                     overflow-hidden
//                     `}>
//                       <div className={`    
//                         flex flex-shrink-0 
//                         h-10 
//                         bg-[#1f1f1f]
//                         overflow-x-auto 
//                         `}>
//                         <button 
//                           className={`
//                             flex items-center justify-center 
//                             h-full 
//                             space-x-2 
//                             px-4 
//                             whitespace-nowrap 
//                             text-xs font-semibold text-white
//                             bg-[#1c1c1c] border border-[#2b2b2b] border-b-0 border-t-[#49c0f8]
//                           `}>
//                           Browser
//                         </button>
//                       </div>
//                       <div className="max-h-56 h-full overflow-y-auto bg-[#fff]">
//                         <Iframe 
//                           content={data.content}
//                           className="w-full h-full flex-grow bg-product-background-primary-light"
//                         />
//                       </div>
//                     </div>

//                   </div>
//                   }
                  
//                 </div>
//                 )})}
//               </div>
//             </div>
//             {/* interactionModule */}
//             {currentStepData.interactionModule !== null && 
//             <div className={`flex w-full justify-center`}>
//               {currentStepData.interactionModule.type === 'codeValidatedInput' && 
//               <div className={`min-w-[300px] max-w-[664px] flex-1`}>
//                 <div className={`relative flex flex-col`}>
//                   <div className={`
//                     relative 
//                     flex flex-col 
//                     max-h-[440px] w-full 
//                     rounded-[4px] border border-[#181818]
//                     overflow-hidden
//                     `}>
//                     {/* programming language nav */}
//                     <div className={`
//                       flex flex-shrink-0 
//                       h-10 
//                       bg-[#1f1f1f]
//                       overflow-x-auto 
//                       `}>
//                       {currentStepData.interactionModule.files.map((file, index)=>{return (
//                       <button 
//                         data-index={index}
//                         onClick={(event) => clickProgrammingLanguageNav(event)}
//                         key={index} 
//                         className={`
//                           flex items-center justify-center space-x-2 
//                           h-full 
//                           px-4 
//                           whitespace-nowrap 
//                           font-semibold text-xs text-white
//                           ${languageNav == index ? "bg-[#1c1c1c] border border-[#2b2b2b] border-b-0 border-t-[#49c0f8]" : ""}
                          
//                         `}
//                       >{file.name}</button>
//                       )})}
//                       {isCorrect === true &&
//                       <button 
//                         data-index={currentStepData.interactionModule.files.length}
//                         onClick={(event) => clickProgrammingLanguageNav(event)}
//                         className={`
//                           flex items-center justify-center 
//                           h-full 
//                           space-x-2 
//                           px-4 
//                           whitespace-nowrap 
//                           text-xs font-semibold text-white
//                           ${languageNav == currentStepData.interactionModule.files.length ? "bg-[#1c1c1c] border border-[#2b2b2b] border-b-0 border-t-[#49c0f8]" : ""} 
//                         `}>
//                         Browser
//                       </button>
//                       }
//                     </div>
//                     {/* programming language */}
//                     {languageNav == currentStepData.interactionModule.files.length ? 
//                     <div className="max-h-56 overflow-y-auto bg-[#fff]">
//                       {generateBrowswer()}
//                     </div>
//                     :
//                     currentStepData.interactionModule.files.map((file, index)=>{
//                       const type = currentStepData.interactionModule.type;
//                       const isInteractive = file.isInteractive;
//                       const content = file.content;
//                       const options = [currentStepData.interactionModule.interactionOption];
//                       return (
//                       <pre key={`pre_${index}`} className="max-h-56 overflow-y-auto bg-[#1c1c1c] px-4 py-3 text-sm text-white">
//                         {getCodeEditor(type, isInteractive, content, options)}
//                       </pre>
//                       )
//                     })
//                     }
//                   </div>
//                 </div>
//               </div>
//               }
//               {currentStepData.interactionModule.type === 'codeFillTheGap' &&
//               <div className={`min-w-[300px] max-w-[664px] flex-1`}>
//                 <div className={`relative flex flex-col`}>
//                   <div className={`
//                     relative 
//                     flex flex-col 
//                     max-h-[440px] w-full 
//                     rounded-[4px] border border-[#181818]
//                     overflow-hidden
//                     `}>
//                     {/* programming language nav */}
//                     <div className={`
//                       flex flex-shrink-0 
//                       h-10 
//                       bg-[#1f1f1f]
//                       overflow-x-auto 
//                       `}>
//                       {currentStepData.interactionModule.files.map((file, index)=>{return (
//                       <button 
//                         data-index={index}
//                         onClick={(event) => clickProgrammingLanguageNav(event)}
//                         key={index} 
//                         className={`
//                           flex items-center justify-center space-x-2 
//                           h-full 
//                           px-4 
//                           whitespace-nowrap 
//                           font-semibold text-xs text-white
//                           ${languageNav == index ? "bg-[#1c1c1c] border border-[#2b2b2b] border-b-0 border-t-[#49c0f8]" : ""}
                          
//                         `}
//                       >{file.name}</button>
//                       )})}
//                       {isCorrect === true &&
//                       <button 
//                         data-index={currentStepData.interactionModule.files.length}
//                         onClick={(event) => clickProgrammingLanguageNav(event)}
//                         className={`
//                           flex items-center justify-center 
//                           h-full 
//                           space-x-2 
//                           px-4 
//                           whitespace-nowrap 
//                           text-xs font-semibold text-white
//                           ${languageNav == currentStepData.interactionModule.files.length ? "bg-[#1c1c1c] border border-[#2b2b2b] border-b-0 border-t-[#49c0f8]" : ""} 
//                         `}>
//                         Browser
//                       </button>
//                       }
//                     </div>
//                     {/* programming language */}
//                     {languageNav == currentStepData.interactionModule.files.length ? 
//                     <div className="max-h-56 h-full overflow-y-auto bg-[#fff]">
//                       {generateBrowswer()}
//                     </div>
//                     :
//                     currentStepData.interactionModule.files.map((file, index)=>{
//                       const type = currentStepData.interactionModule.type;
//                       const isInteractive = file.isInteractive;
//                       const content = file.content;
//                       const options = currentStepData.interactionModule.interactionOptions;
//                       return (
//                       <pre key={`pre_${index}`} className="max-h-56 overflow-y-auto bg-[#1c1c1c] px-4 py-3 text-sm text-white">
//                         {getCodeEditor(type, isInteractive, content, options)}
//                       </pre>
//                       )
//                     })
//                     }
//                   </div>
//                   {/* programming Options */}
//                   <div className={`mt-8 flex flex-wrap items-center justify-center gap-y-2 space-x-4`}>
//                     {generateOptionBtns(currentStepData.options)}  
//                   </div>
//                 </div>
//               </div>
//               }
              
//               {currentStepData.interactionModule.type === 'multipleChoice' && 
//               <div className="max-w-[664px] flex-1">
//                 <div className="z-20 flex w-full flex-col items-center">
//                   {currentStepData.interactionModule.items.map((item, index) => (
//                   <div key={index} className="relative w-full max-w-[480px]">
//                     <button 
//                       data-index={index}
//                       onClick={(event) => clickOptionItem(event, index)}
//                       className={`
//                         flex items-center justify-between space-x-2 
//                         min-h-10 w-full 
//                         py-2 pl-3 pr-2 mb-3 
//                         border-[2px] border-b-[4px] border-[#37464f] rounded-lg 
//                         text-left font-semibold text-base text-[#f1f7fb]
//                         bg-[#151f24]
                    
//                         ${disabledOptions[0] == index ? 'border-[#1899d5] bg-[#131f24]  text-[#1899d5]' : 'border-gray-400'}
//                         hover:border-[#1899d5]
//                         hover:bg-[#131f24] 
//                         hover:text-[#1899d5]
//                       `}
//                     >
//                       <ReactMarkdown>
//                         {item.text}
//                       </ReactMarkdown>
                      
//                     </button>
//                   </div>
//                   ))}
//                 </div>
//               </div>
//               }            
//             </div>
//             }
//           </div>
//           }
//         </div>
//         <div 
//           className={`fixed bottom-0 left-0 right-0 px-4 py-6 
//             bg-[#131f24]/40 backdrop-blur-md
//             `}
//           >
//           {isCorrect !== null ? 
//           <div className={`
//             absolute bottom-0 left-0 right-0
//             flex justify-between items-center
//             px-4 pb-20 pt-6 
//             ${isCorrect ? "bg-[#202f36]" : "bg-[#202f36]"}

            
//             after:content-[""]
//             after:absolute after:top-full after:left-0 after:right-0
//             after:w-full after:h-screen
//             after:bg-inherit
//           `}>
//             <div className={`flex flex-col gap-2`}>
//               <h2 className={`
//                 text-2xl font-bold 
//                 ${isCorrect ? "text-[#79b933]" : "text-red-500"}
                
//               `}>
//                 {isCorrect ? "완벽합니다! 잘했어요!" : "뭔가 잘못됐어"}
//               </h2>
//               <div className={`
//                 ${isCorrect ? "text-[#79b933]" : "text-red-500"}
//                 text-sm
//               `}>
//                 <ReactMarkdown>
//                   {postModule?.type === "paragraph" && postModule?.content}
//                 </ReactMarkdown>
//               </div>
//             </div>
//             {/* <div>
//               <LampPendant size={24} className={`
//                 ${isCorrect ? "text-cyan-500" : "text-red-500"}
//               `} />
//             </div> */}
//           </div> 
//           : ``}
          
//           <Btn 
//             text={isCorrect === null ? "확인" : "계속하기"} 
//             color={isCorrect === null || isCorrect ? "cyan" : "red"} 
//             onClick={handleClick} 
//             disabled={(currentStepData.interactionModule !== null ? !allInputsFilled  : false)}
//           />
//           {/* <Btn 
//             text={isCorrect === null ? "확인" : "계속하기"} 
//             color={isCorrect === null || isCorrect ? "cyan" : "red"} 
//             onClick={handleClick} 
//             disabled={!currentStepData.free_next && !currentStepData.user_select_data}
//           /> */}
//         </div>
//       </div>
//     </div>
//   );
// };

// export default Lesson;
