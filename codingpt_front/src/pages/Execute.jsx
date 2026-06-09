import { useState, useRef, useEffect, useCallback } from 'react';
import { executeCode } from '../utils/executeCode';
import { backendUrl } from '../utils/common';

const Execute = () => {
  const [mode, setMode] = useState('execute'); // 'execute' | 's3editor'
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [selectedSample, setSelectedSample] = useState('');
  const [logs, setLogs] = useState([]); // 서버 통신 로그 (log 타입)
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [s3Path, setS3Path] = useState(''); // 파일 불러오기용 S3 경로
  const [previewS3Path, setPreviewS3Path] = useState(''); // 프리뷰용 S3 경로
  const [terminalOutput, setTerminalOutput] = useState(''); // 터미널 출력 내용
  const abortRef = useRef(null);
  const terminalOutputRef = useRef(null); // 스크롤을 위한 ref

  // S3 편집기 관련 state
  const [s3Files, setS3Files] = useState([]); // S3에서 불러온 파일 목록
  const [selectedFile, setSelectedFile] = useState(null); // 현재 선택된 파일
  const [selectedFolder, setSelectedFolder] = useState(null); // 현재 선택된 폴더 (파일/폴더 추가용)
  const [fileContents, setFileContents] = useState({}); // 파일별 내용 { [파일경로]: 내용 }
  const [isLoadingFiles, setIsLoadingFiles] = useState(false); // 파일 목록 로딩 상태
  const [isSavingFile, setIsSavingFile] = useState(false); // 파일 저장 중 상태
  const [previewMode, setPreviewMode] = useState(false); // 프리뷰 모드 토글
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [currentFileContent, setCurrentFileContent] = useState(''); // 현재 편집 중인 파일 내용
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false); // 저장되지 않은 변경사항
  const saveTimeoutRef = useRef(null); // 자동 저장 debounce용
  const [contextMenu, setContextMenu] = useState(null); // 컨텍스트 메뉴 { file, x, y }
  const [invalidationMessage, setInvalidationMessage] = useState(null); // 알림 메시지 (경로 복사 등)
  const [expandedFolders, setExpandedFolders] = useState(new Set()); // 펼쳐진 폴더 경로 Set
  const [fileTree, setFileTree] = useState([]); // 트리 구조로 변환된 파일 목록
  const [isDeleting, setIsDeleting] = useState(false); // 삭제 중 상태
  const [showAddFolderModal, setShowAddFolderModal] = useState(false); // 폴더 추가 모달 표시
  const [newFolderName, setNewFolderName] = useState(''); // 새 폴더 이름
  const [showAddFileModal, setShowAddFileModal] = useState(false); // 파일 추가 모달 표시
  const [newFileName, setNewFileName] = useState(''); // 새 파일 이름
  const [showFileLoader, setShowFileLoader] = useState(false); // 파일 불러오기 영역 표시 여부
  const [liveServerContextMenu, setLiveServerContextMenu] = useState(null); // 라이브 서버 우클릭 메뉴
  const [showOutputPanel, setShowOutputPanel] = useState(false); // 출력 영역 펼침 여부
  const [showRenameModal, setShowRenameModal] = useState(false); // 이름 변경 모달 표시
  const [renameTarget, setRenameTarget] = useState(null); // 이름 변경 대상 파일/폴더
  const [newName, setNewName] = useState(''); // 새 이름
  const [isRenaming, setIsRenaming] = useState(false); // 이름 변경 중 상태
  const [isMoving, setIsMoving] = useState(false); // 이동 중 상태
  const [draggedItem, setDraggedItem] = useState(null); // 드래그 중인 항목
  const [dragOverItem, setDragOverItem] = useState(null); // 드롭 대상 항목
  
  // S3 파일 실행 관련 state
  const [s3ExecuteLogs, setS3ExecuteLogs] = useState([]); // S3 파일 실행 로그
  const [s3TerminalOutput, setS3TerminalOutput] = useState(''); // S3 파일 실행 터미널 출력
  const [s3ExecuteStatus, setS3ExecuteStatus] = useState(''); // S3 파일 실행 상태
  const [isS3Executing, setIsS3Executing] = useState(false); // S3 파일 실행 중 상태
  const s3ExecuteAbortRef = useRef(null); // S3 파일 실행 중단 함수
  const s3TerminalOutputRef = useRef(null); // S3 터미널 출력 스크롤용 ref

  // 언어별 코드 샘플
  const codeSamples = {
    javascript: {
      '기본 출력': `console.log("Hello, World!");
console.log("안녕하세요!");`,
      '변수와 연산': `let a = 10;
let b = 20;
let sum = a + b;
console.log("합계:", sum);
console.log("곱셈:", a * b);`,
      '조건문 (if)': `let score = 85;

if (score >= 90) {
  console.log("A등급");
} else if (score >= 80) {
  console.log("B등급");
} else if (score >= 70) {
  console.log("C등급");
} else {
  console.log("F등급");
}`,
      '반복문 (for)': `// 1부터 10까지 출력
for (let i = 1; i <= 10; i++) {
  console.log(i);
}

// 배열 순회
let fruits = ["사과", "바나나", "오렌지"];
for (let fruit of fruits) {
  console.log(fruit);
}`,
      '반복문 (while)': `let count = 0;
while (count < 5) {
  console.log("카운트:", count);
  count++;
}`,
      '함수': `// 함수 정의
function add(a, b) {
  return a + b;
}

function greet(name) {
  return "안녕하세요, " + name + "님!";
}

// 함수 호출
console.log(add(5, 3));
console.log(greet("홍길동"));`,
      '배열': `let numbers = [1, 2, 3, 4, 5];

console.log("첫 번째 요소:", numbers[0]);
console.log("배열 길이:", numbers.length);

// 배열 메서드
numbers.push(6);
console.log("추가 후:", numbers);

let doubled = numbers.map(n => n * 2);
console.log("2배:", doubled);`,
      '객체': `let person = {
  name: "홍길동",
  age: 25,
  city: "서울"
};

console.log("이름:", person.name);
console.log("나이:", person.age);

// 객체 순회
for (let key in person) {
  console.log(key + ":", person[key]);
}`
    },
    python: {
      '기본 출력': `print("Hello, World!")
print("안녕하세요!")`,
      '변수와 연산': `a = 10
b = 20
sum = a + b
print(f"합계: {sum}")
print(f"곱셈: {a * b}")`,
      '조건문 (if)': `score = 85

if score >= 90:
    print("A등급")
elif score >= 80:
    print("B등급")
elif score >= 70:
    print("C등급")
else:
    print("F등급")`,
      '반복문 (for)': `# 1부터 10까지 출력
for i in range(1, 11):
    print(i)

# 리스트 순회
fruits = ["사과", "바나나", "오렌지"]
for fruit in fruits:
    print(fruit)`,
      '반복문 (while)': `count = 0
while count < 5:
    print(f"카운트: {count}")
    count += 1`,
      '함수': `# 함수 정의
def add(a, b):
    return a + b

def greet(name):
    return f"안녕하세요, {name}님!"

# 함수 호출
print(add(5, 3))
print(greet("홍길동"))`,
      '리스트': `numbers = [1, 2, 3, 4, 5]

print(f"첫 번째 요소: {numbers[0]}")
print(f"리스트 길이: {len(numbers)}")

# 리스트 메서드
numbers.append(6)
print(f"추가 후: {numbers}")

doubled = [n * 2 for n in numbers]
print(f"2배: {doubled}")`,
      '딕셔너리': `person = {
    "name": "홍길동",
    "age": 25,
    "city": "서울"
}

print(f"이름: {person['name']}")
print(f"나이: {person['age']}")

# 딕셔너리 순회
for key, value in person.items():
    print(f"{key}: {value}")`
    }
  };

  // 언어 변경 시 샘플 초기화
  useEffect(() => {
    setSelectedSample('');
    const firstSample = Object.keys(codeSamples[language])[0];
    setCode(codeSamples[language][firstSample]);
  }, [language]);

  // 샘플 선택 시 코드 변경
  const handleSampleChange = (sampleName) => {
    setSelectedSample(sampleName);
    if (sampleName && codeSamples[language][sampleName]) {
      setCode(codeSamples[language][sampleName]);
    }
  };

  // 터미널 출력 자동 스크롤
  useEffect(() => {
    if (terminalOutputRef.current) {
      terminalOutputRef.current.scrollTop = terminalOutputRef.current.scrollHeight;
    }
  }, [terminalOutput]);

  const handleExecute = async () => {
    if (!code.trim()) {
      alert('코드를 입력해주세요.');
      return;
    }

    setIsRunning(true);
    setLogs([]);
    setStatus('실행 중...');
    setTerminalOutput(''); // 터미널 출력 초기화

    const abort = await executeCode(
      code,
      language,
      {
        onLog: (data) => {
          // log 타입: 서버 통신 로그 (로그 영역에 표시)
          const message = data.message || '';
          setLogs((prev) => [...prev, { type: 'log', message, timestamp: new Date() }]);
        },
        onOutput: (data) => {
          // output 타입: 터미널 출력 (실시간으로 추가)
          if (data.data) {
            setTerminalOutput((prev) => prev + data.data);
          }
        },
        onError: (data) => {
          // error 타입: 에러 출력 (빨간색으로 표시)
          if (data.data) {
            setTerminalOutput((prev) => prev + data.data);
          }
          setStatus('에러 발생');
        },
        onClose: (data) => {
          setIsRunning(false);
          const message = data.hasError
            ? `실행 완료 (에러, 종료 코드: ${data.exitCode})`
            : `실행 완료 (종료 코드: ${data.exitCode})`;
          setStatus(message);
          setLogs((prev) => [...prev, { type: 'close', exitCode: data.exitCode, hasError: data.hasError, timestamp: new Date() }]);
        },
      }
    );

    abortRef.current = abort;
  };

  const handleStop = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    setIsRunning(false);
    setStatus('중단됨');
  };

  const handleClear = () => {
    setTerminalOutput('');
    setLogs([]);
    setStatus('');
  };

  // 트리 구조를 평면 배열로 변환 (검색 및 선택용)
  const flattenFileTree = (tree, result = []) => {
    if (!tree || !Array.isArray(tree)) return result;
    
    tree.forEach(node => {
      result.push(node);
      if (node.type === 'directory' && node.files && node.files.length > 0) {
        flattenFileTree(node.files, result);
      }
    });
    
    return result;
  };

  // 폴더 접기/펼치기 토글
  const toggleFolder = (folderPath) => {
    setExpandedFolders(prev => {
      const newSet = new Set(prev);
      if (newSet.has(folderPath)) {
        newSet.delete(folderPath);
      } else {
        newSet.add(folderPath);
      }
      return newSet;
    });
  };

  // 파일 삭제
  const handleDeleteFile = async (file) => {
    if (!file || !file.path) return;

    const confirmMessage = file.type === 'directory' 
      ? `폴더 "${file.name}"와 그 안의 모든 파일을 삭제하시겠습니까?`
      : `파일 "${file.name}"을 삭제하시겠습니까?`;

    if (!window.confirm(confirmMessage)) {
      return;
    }

    setIsDeleting(true);
    setContextMenu(null);

    try {
      // filePath에서 codingpt/execute/ prefix 제거 (백엔드에서 자동 추가)
      let filePath = file.path;
      if (filePath.startsWith('codingpt/execute/')) {
        filePath = filePath.replace('codingpt/execute/', '');
      }

      const response = await fetch(`${backendUrl}/api/s3/file`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filePath: filePath }),
      });

      const data = await response.json();

      if (data.success) {
        // 파일 목록 새로고침
        await handleLoadFiles();
        // 선택된 파일이 삭제된 경우 선택 해제
        if (selectedFile?.path === file.path) {
          setSelectedFile(null);
          setCurrentFileContent('');
        }
        setPreviewError(null);
      } else {
        setPreviewError(data.message || '파일 삭제에 실패했습니다.');
      }
    } catch (err) {
      setPreviewError('파일 삭제 중 오류가 발생했습니다.');
      console.error('파일 삭제 오류:', err);
    } finally {
      setIsDeleting(false);
    }
  };

  // 파일/폴더 이름 변경
  const handleRename = async () => {
    if (!renameTarget || !newName.trim()) {
      return;
    }

    setIsRenaming(true);

    try {
      // 경로에서 codingpt/execute/ prefix 제거
      let oldPath = renameTarget.path;
      if (oldPath.startsWith('codingpt/execute/')) {
        oldPath = oldPath.replace('codingpt/execute/', '');
      }

      // 폴더인 경우 경로 끝에 / 추가
      if (renameTarget.type === 'directory') {
        if (!oldPath.endsWith('/')) {
          oldPath = oldPath + '/';
        }
      }

      const response = await fetch(`${backendUrl}/api/s3/rename`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          oldPath: oldPath,
          newName: newName.trim()
        }),
      });

      const data = await response.json();

      if (data.success) {
        setShowRenameModal(false);
        setRenameTarget(null);
        setNewName('');
        // 파일 목록 새로고침
        await handleLoadFiles();
        // 선택된 파일이 변경된 경우 선택 해제
        if (selectedFile?.path === renameTarget.path) {
          setSelectedFile(null);
          setCurrentFileContent('');
        }
        if (selectedFolder?.path === renameTarget.path) {
          setSelectedFolder(null);
        }
        setPreviewError(null);
      } else {
        setPreviewError(data.message || '이름 변경에 실패했습니다.');
      }
    } catch (err) {
      setPreviewError('이름 변경 중 오류가 발생했습니다.');
      console.error('이름 변경 오류:', err);
    } finally {
      setIsRenaming(false);
    }
  };

  // 파일/폴더 이동
  const handleMove = async (sourceFile, targetPath) => {
    if (!sourceFile || !targetPath) {
      return;
    }

    setIsMoving(true);

    try {
      // 경로에서 codingpt/execute/ prefix 제거
      let sourcePath = sourceFile.path;
      if (sourcePath.startsWith('codingpt/execute/')) {
        sourcePath = sourcePath.replace('codingpt/execute/', '');
      }

      let target = targetPath;
      if (target.startsWith('codingpt/execute/')) {
        target = target.replace('codingpt/execute/', '');
      }

      // 폴더인 경우 경로 끝에 / 추가
      if (sourceFile.type === 'directory') {
        if (!sourcePath.endsWith('/')) {
          sourcePath = sourcePath + '/';
        }
        if (!target.endsWith('/')) {
          target = target + '/';
        }
      }

      const response = await fetch(`${backendUrl}/api/s3/move`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sourcePath: sourcePath,
          targetPath: target
        }),
      });

      const data = await response.json();

      if (data.success) {
        // 파일 목록 새로고침
        await handleLoadFiles();
        // 선택된 파일이 이동된 경우 선택 해제
        if (selectedFile?.path === sourceFile.path) {
          setSelectedFile(null);
          setCurrentFileContent('');
        }
        if (selectedFolder?.path === sourceFile.path) {
          setSelectedFolder(null);
        }
        setPreviewError(null);
      } else {
        setPreviewError(data.message || '이동에 실패했습니다.');
      }
    } catch (err) {
      setPreviewError('이동 중 오류가 발생했습니다.');
      console.error('이동 오류:', err);
    } finally {
      setIsMoving(false);
      setDraggedItem(null);
      setDragOverItem(null);
    }
  };

  // 폴더 추가
  const handleAddFolder = async () => {
    if (!newFolderName.trim()) {
      setPreviewError('폴더 이름을 입력해주세요.');
      return;
    }

    // 폴더 경로 생성
    let folderPath = '';
    if (selectedFolder && selectedFolder.path) {
      // 선택된 폴더가 있으면 그 폴더 안에 생성
      let parentPath = selectedFolder.path.replace(/\/$/, ''); // 끝의 슬래시 제거
      // codingpt/execute/ prefix 제거 (백엔드에서 자동 추가)
      if (parentPath.startsWith('codingpt/execute/')) {
        parentPath = parentPath.replace('codingpt/execute/', '');
      }
      folderPath = `${parentPath}/${newFolderName.trim()}`;
    } else {
      // 없으면 현재 s3Path 기준으로 생성
      folderPath = `${s3Path.trim() || ''}/${newFolderName.trim()}`.replace(/^\/+/, '');
    }

    try {
      const response = await fetch(`${backendUrl}/api/s3/folder`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderPath: folderPath
        }),
      });

      const data = await response.json();

      if (data.success) {
        setShowAddFolderModal(false);
        setNewFolderName('');
        // 파일 목록 새로고침
        await handleLoadFiles();
        setPreviewError(null);
      } else {
        setPreviewError(data.message || '폴더 생성에 실패했습니다.');
      }
    } catch (err) {
      setPreviewError('폴더 생성 중 오류가 발생했습니다.');
      console.error('폴더 생성 오류:', err);
    }
  };

  // 파일 추가
  const handleAddFile = async () => {
    if (!newFileName.trim()) {
      setPreviewError('파일 이름을 입력해주세요.');
      return;
    }

    // 파일 경로 생성
    let filePath = '';
    if (selectedFolder && selectedFolder.path) {
      // 선택된 폴더가 있으면 그 폴더 안에 생성
      let folderPath = selectedFolder.path.replace(/\/$/, ''); // 끝의 슬래시 제거
      // codingpt/execute/ prefix 제거 (백엔드에서 자동 추가)
      if (folderPath.startsWith('codingpt/execute/')) {
        folderPath = folderPath.replace('codingpt/execute/', '');
      }
      filePath = `${folderPath}/${newFileName.trim()}`;
    } else {
      // 없으면 현재 s3Path 기준으로 생성
      const basePath = s3Path.trim() || '';
      filePath = basePath ? `${basePath}/${newFileName.trim()}` : newFileName.trim();
    }

    // codingpt/execute/ prefix 제거 (백엔드에서 자동 추가)
    if (filePath.startsWith('codingpt/execute/')) {
      filePath = filePath.replace('codingpt/execute/', '');
    }

    try {
      // 빈 파일 생성
      const response = await fetch(`${backendUrl}/api/s3/file`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filePath: filePath,
          content: '' // 빈 파일로 시작
        }),
      });

      const data = await response.json();

      if (data.success) {
        const createdFileName = newFileName.trim();
        setShowAddFileModal(false);
        setNewFileName('');
        
        // 파일 목록 새로고침
        await handleLoadFiles();
        
        // 생성된 파일 자동 선택 (새로고침 후 파일 목록에서 찾기)
        // handleLoadFiles가 완료된 후 파일 목록이 업데이트되므로
        // 약간의 지연 후 파일 찾기
        setTimeout(async () => {
          const allFiles = await fetch(`${backendUrl}/api/s3/files`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ s3Path: s3Path.trim() || '' }),
          }).then(res => res.json());
          
          if (allFiles.success && allFiles.files) {
            const createdFile = allFiles.files.find(f => 
              f.name === createdFileName || 
              f.path.includes(createdFileName) ||
              f.path.endsWith(createdFileName)
            );
            if (createdFile) {
              await handleSelectFile(createdFile);
            }
          }
        }, 100);
        
        setPreviewError(null);
      } else {
        setPreviewError(data.message || '파일 생성에 실패했습니다.');
      }
    } catch (err) {
      setPreviewError('파일 생성 중 오류가 발생했습니다.');
      console.error('파일 생성 오류:', err);
    }
  };

  // 파일 목록 불러오기
  const handleLoadFiles = async () => {
    // s3Path가 없어도 요청 가능 (빈 문자열로 전달하면 백엔드가 최상단 경로 처리)
    setIsLoadingFiles(true);
    setPreviewError(null);
    setS3Files([]);
    setSelectedFile(null);
    setSelectedFolder(null); // 폴더 선택도 초기화
    setFileContents({});
    setCurrentFileContent('');

    try {
      const response = await fetch(`${backendUrl}/api/s3/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ s3Path: s3Path.trim() || '' }),
      });

      const data = await response.json();

      if (data.success && data.files) {
        // 백엔드에서 이미 트리 구조로 반환됨
        setFileTree(data.files);
        // 모든 파일을 평면적으로 수집 (검색 및 선택용)
        const allFiles = flattenFileTree(data.files);
        setS3Files(allFiles);
        // 첫 번째 파일 자동 선택 (또는 index.html 우선 선택)
        const indexFile = allFiles.find(f => f.name === 'index.html' && f.type === 'file') || allFiles.find(f => f.type === 'file');
        if (indexFile) {
          await handleSelectFile(indexFile);
        }
      } else {
        setPreviewError(data.message || '파일 목록을 불러올 수 없습니다.');
      }
    } catch (err) {
      setPreviewError('파일 목록 로딩 중 오류가 발생했습니다.');
      console.error('파일 목록 로딩 오류:', err);
    } finally {
      setIsLoadingFiles(false);
    }
  };

  // 파일 선택 및 내용 불러오기
  const handleSelectFile = async (file) => {
    // 저장되지 않은 변경사항이 있으면 경고 (선택적)
    if (hasUnsavedChanges && selectedFile) {
      const confirmSave = window.confirm('저장되지 않은 변경사항이 있습니다. 계속하시겠습니까?');
      if (!confirmSave) return;
    }

    // 이미 로드된 파일이면 캐시에서 가져오기
    if (fileContents[file.path]) {
      setSelectedFile(file);
      setCurrentFileContent(fileContents[file.path]);
      setHasUnsavedChanges(false);
      return;
    }

    try {
      // filePath에서 codingpt/execute/ prefix 제거 (백엔드에서 자동 추가)
      let filePath = file.path;
      if (filePath.startsWith('codingpt/execute/')) {
        filePath = filePath.replace('codingpt/execute/', '');
      }

      const response = await fetch(`${backendUrl}/api/s3/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ filePath: filePath }),
      });

      const data = await response.json();

      if (data.success && data.content !== undefined) {
        setFileContents(prev => ({
          ...prev,
          [file.path]: data.content
        }));
        setSelectedFile(file);
        setCurrentFileContent(data.content);
        setHasUnsavedChanges(false);
      } else {
        setPreviewError(data.message || '파일을 불러올 수 없습니다.');
      }
    } catch (err) {
      setPreviewError('파일 로딩 중 오류가 발생했습니다.');
      console.error('파일 로딩 오류:', err);
    }
  };

  // 파일 저장
  const handleSaveFile = useCallback(async (filePath, content) => {
    if (!filePath) return;

    setIsSavingFile(true);

    try {
      // filePath에서 codingpt/execute/ prefix 제거 (백엔드에서 자동 추가)
      let normalizedPath = filePath;
      if (normalizedPath.startsWith('codingpt/execute/')) {
        normalizedPath = normalizedPath.replace('codingpt/execute/', '');
      }

      const response = await fetch(`${backendUrl}/api/s3/file`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          filePath: normalizedPath,
          content: content
        }),
      });

      const data = await response.json();

      if (data.success) {
        // 성공 시 파일 내용 업데이트 (캐시 키는 원본 경로 사용)
        setFileContents(prev => ({
          ...prev,
          [filePath]: content
        }));
        setHasUnsavedChanges(false);
        console.log('파일 저장 완료');
      } else {
        setPreviewError(data.message || '파일 저장에 실패했습니다.');
      }
    } catch (err) {
      setPreviewError('파일 저장 중 오류가 발생했습니다.');
      console.error('파일 저장 오류:', err);
    } finally {
      setIsSavingFile(false);
    }
  }, []);

  // 파일 내용 변경 핸들러 (자동 저장 with debounce)
  const handleFileContentChange = useCallback((content) => {
    setCurrentFileContent(content);
    setHasUnsavedChanges(true);

    // 기존 타이머 취소
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // 2초 후 자동 저장
    if (selectedFile) {
      saveTimeoutRef.current = setTimeout(() => {
        handleSaveFile(selectedFile.path, content);
      }, 2000);
    }
  }, [selectedFile, handleSaveFile]);

  // 파일 내용 변경 시 자동 저장
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // 프리뷰 API 호출 (파일 경로에서 폴더 경로 추출)
  const handlePreview = async (filePath) => {
    if (!filePath) {
      setPreviewError('파일 경로가 없습니다.');
      return;
    }

    // 파일 경로에서 폴더 경로 추출
    let folderPath = filePath;
    if (folderPath.startsWith('codingpt/execute/')) {
      folderPath = folderPath.replace('codingpt/execute/', '');
    }
    
    // 파일명 제거하여 폴더 경로만 추출
    const pathParts = folderPath.split('/');
    pathParts.pop(); // 파일명 제거
    const s3Path = pathParts.join('/');

    setPreviewLoading(true);
    setPreviewError(null);

    try {
      const response = await fetch(`${backendUrl}/api/executor/preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ s3Path: s3Path }),
      });

      const data = await response.json();

      if (data.success && data.previewUrl) {
        setPreviewUrl(data.previewUrl);
        setPreviewMode(true);
      } else {
        setPreviewError(data.message || '라이브 서버를 열 수 없습니다.');
        setPreviewUrl(null);
      }
    } catch (err) {
      setPreviewError('라이브 서버 요청 중 오류가 발생했습니다.');
      console.error('프리뷰 오류:', err);
    } finally {
      setPreviewLoading(false);
    }
  };

  // S3 파일 실행 함수
  const executeS3File = async (file) => {
    if (!file || !file.path) {
      setPreviewError('실행할 파일을 선택해주세요.');
      return;
    }

    // 파일 경로에서 s3Path와 fileName 추출
    let filePath = file.path;
    if (filePath.startsWith('codingpt/execute/')) {
      filePath = filePath.replace('codingpt/execute/', '');
    }

    const pathParts = filePath.split('/');
    const fileName = pathParts[pathParts.length - 1];
    const s3Path = pathParts.slice(0, -1).join('/');

    // 파일 확장자로 언어 자동 판단
    const getLanguageFromExtension = (filename) => {
      const ext = filename.split('.').pop()?.toLowerCase();
      const languageMap = {
        'js': 'javascript',
        'py': 'python',
        'c': 'c',
        'cpp': 'cpp',
        'cc': 'cpp',
        'cxx': 'cpp',
        'java': 'java'
      };
      return languageMap[ext] || null;
    };

    const language = getLanguageFromExtension(fileName);

    setIsS3Executing(true);
    setS3ExecuteLogs([]);
    setS3TerminalOutput('');
    setS3ExecuteStatus('실행 중...');
    setPreviewError(null);
    // 실행 시작 시 출력 영역 자동 펼침
    setShowOutputPanel(true);

    let reader = null;
    let isAborted = false;

    const abort = () => {
      isAborted = true;
      if (reader) {
        reader.cancel().catch(() => {});
      }
      setIsS3Executing(false);
      setS3ExecuteStatus('중단됨');
    };

    s3ExecuteAbortRef.current = abort;

    try {
      const response = await fetch(`${backendUrl}/api/executor/execute-s3`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          s3Path: s3Path,
          fileName: fileName,
          language: language
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!isAborted) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (isAborted) break;
          if (line.trim() === '') continue;
          
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.substring(6));
              
              switch (data.type) {
                case 'log':
                  setS3ExecuteLogs(prev => [...prev, { type: 'log', message: data.message, timestamp: new Date() }]);
                  break;
                case 'output':
                  if (data.data) {
                    setS3TerminalOutput(prev => prev + data.data);
                  }
                  break;
                case 'error':
                  if (data.data) {
                    setS3TerminalOutput(prev => prev + data.data);
                  }
                  setS3ExecuteStatus('에러 발생');
                  break;
                case 'close':
                  setIsS3Executing(false);
                  const message = data.hasError
                    ? `실행 완료 (에러, 종료 코드: ${data.exitCode})`
                    : `실행 완료 (종료 코드: ${data.exitCode})`;
                  setS3ExecuteStatus(message);
                  setS3ExecuteLogs(prev => [...prev, { type: 'close', exitCode: data.exitCode, hasError: data.hasError, timestamp: new Date() }]);
                  break;
              }
            } catch (err) {
              console.error('SSE 파싱 오류:', err);
            }
          }
        }
      }
    } catch (err) {
      setIsS3Executing(false);
      setS3ExecuteStatus('에러 발생');
      setPreviewError(`파일 실행 중 오류가 발생했습니다: ${err.message}`);
      console.error('S3 파일 실행 오류:', err);
    }
  };

  // S3 파일 실행 중단
  const handleStopS3Execute = () => {
    if (s3ExecuteAbortRef.current) {
      s3ExecuteAbortRef.current();
      s3ExecuteAbortRef.current = null;
    }
    setIsS3Executing(false);
    setS3ExecuteStatus('중단됨');
  };

  // 라이브 서버 종료
  const handleCloseLiveServer = () => {
    setPreviewUrl(null);
    setPreviewMode(false);
    setLiveServerContextMenu(null);
  };

  // 컨텍스트 메뉴 위치 조정 (화면 밖으로 나가지 않도록)
  const adjustContextMenuPosition = (x, y, menuWidth = 200, menuHeight = 200) => {
    const padding = 8; // 화면 가장자리 여백
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;

    let adjustedX = x;
    let adjustedY = y;

    // 오른쪽 경계 체크
    if (x + menuWidth > windowWidth - padding) {
      adjustedX = windowWidth - menuWidth - padding;
    }

    // 왼쪽 경계 체크
    if (adjustedX < padding) {
      adjustedX = padding;
    }

    // 아래쪽 경계 체크
    if (y + menuHeight > windowHeight - padding) {
      adjustedY = windowHeight - menuHeight - padding;
    }

    // 위쪽 경계 체크
    if (adjustedY < padding) {
      adjustedY = padding;
    }

    return { x: adjustedX, y: adjustedY };
  };

  // 컨텍스트 메뉴 닫기 (외부 클릭 시)
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (liveServerContextMenu && !e.target.closest('.live-server-context-menu')) {
        setLiveServerContextMenu(null);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [liveServerContextMenu]);

  // S3 터미널 출력 자동 스크롤
  useEffect(() => {
    if (s3TerminalOutputRef.current) {
      s3TerminalOutputRef.current.scrollTop = s3TerminalOutputRef.current.scrollHeight;
    }
  }, [s3TerminalOutput]);

  // 경로 복사 함수
  const handleCopyPath = async (file) => {
    if (!file || !file.path) return;

    try {
      // codingpt/execute/ prefix 제거 (사용자가 입력하는 경로 형식으로)
      let pathToCopy = file.path;
      if (pathToCopy.startsWith('codingpt/execute/')) {
        pathToCopy = pathToCopy.replace('codingpt/execute/', '');
      }
      
      // 경로 끝의 슬래시 제거 (파일인 경우)
      if (file.type === 'file') {
        pathToCopy = pathToCopy.replace(/\/$/, '');
      }

      await navigator.clipboard.writeText(pathToCopy);
      setContextMenu(null);
      setInvalidationMessage(`경로가 복사되었습니다: ${pathToCopy}`);
      setPreviewError(null);
      setTimeout(() => {
        setInvalidationMessage(null);
      }, 2000);
    } catch (err) {
      setPreviewError('경로 복사에 실패했습니다.');
      console.error('경로 복사 오류:', err);
    }
  };

  // 파일/폴더 우클릭 핸들러
  const handleFileContextMenu = (e, file) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      file: file,
      x: e.clientX,
      y: e.clientY
    });
  };

  // 컨텍스트 메뉴 외부 클릭 시 닫기
  useEffect(() => {
    const handleClickOutside = () => {
      setContextMenu(null);
    };

    if (contextMenu) {
      document.addEventListener('click', handleClickOutside);
      return () => {
        document.removeEventListener('click', handleClickOutside);
      };
    }
  }, [contextMenu]);

  // 파일 트리 렌더링 (재귀적) - 백엔드 트리 구조에 맞게 수정
  const renderFileTree = (nodes, level = 0) => {
    if (!nodes || nodes.length === 0) return null;

    return nodes.map((node) => {
      const isExpanded = expandedFolders.has(node.path);
      const isFileSelected = selectedFile?.path === node.path;
      const isFolderSelected = selectedFolder?.path === node.path;
      const isDirectory = node.type === 'directory';
      const hasChildren = isDirectory && node.files && node.files.length > 0;
      const isSelected = isFileSelected || isFolderSelected;

      return (
        <div key={node.path}>
          <div
            className={`file-tree-item flex items-center text-left px-2 py-1 text-xs font-mono transition-colors cursor-pointer ${
              isSelected
                ? 'bg-[#0e639c] text-white'
                : dragOverItem?.path === node.path && draggedItem?.path !== node.path
                ? 'bg-[#0e639c] bg-opacity-50 border-2 border-[#0e639c] border-dashed'
                : 'text-[#cccccc] hover:bg-[#2a2d2e]'
            }`}
            style={{ paddingLeft: `${8 + level * 16}px` }}
            draggable={true}
            onDragStart={(e) => {
              e.stopPropagation();
              setDraggedItem(node);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (draggedItem && draggedItem.path !== node.path && isDirectory) {
                setDragOverItem(node);
                e.dataTransfer.dropEffect = 'move';
              }
            }}
            onDragLeave={(e) => {
              e.stopPropagation();
              if (dragOverItem?.path === node.path) {
                setDragOverItem(null);
              }
            }}
            onDragEnd={(e) => {
              e.stopPropagation();
              setDraggedItem(null);
              setDragOverItem(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (draggedItem && draggedItem.path !== node.path && isDirectory) {
                // 폴더로 이동
                const targetPath = node.path.endsWith('/') ? node.path : node.path + '/';
                handleMove(draggedItem, targetPath);
              } else {
                setDraggedItem(null);
                setDragOverItem(null);
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (isDirectory) {
                // 폴더 클릭 시 선택 상태로 설정
                setSelectedFolder(node);
                setSelectedFile(null); // 파일 선택 해제
                toggleFolder(node.path);
              } else {
                // 파일 클릭 시 파일 선택
                setSelectedFile(node);
                setSelectedFolder(null); // 폴더 선택 해제
                handleSelectFile(node);
              }
            }}
            onContextMenu={(e) => {
              e.stopPropagation();
              handleFileContextMenu(e, node);
            }}
          >
            {isDirectory ? (
              <>
                <span className="mr-1 w-3 text-center">
                  {hasChildren ? (isExpanded ? '▼' : '▶') : ' '}
                </span>
                <span className="mr-2">📁</span>
              </>
            ) : (
              <span className="mr-2 ml-4">📄</span>
            )}
            <span className="flex-1 truncate">{node.name}</span>
          </div>
          {isDirectory && isExpanded && hasChildren && (
            <div>
              {renderFileTree(node.files, level + 1)}
            </div>
          )}
        </div>
      );
    });
  };


  const logsEndRef = useRef(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  // S3 편집기 모드 진입 시 초기 파일 목록 로드
  useEffect(() => {
    if (mode === 's3editor') {
      // 빈 값으로 파일 목록 조회
      setS3Path('');
      handleLoadFiles();
    }
  }, [mode]);

  return (
    <div className="flex flex-col w-full h-screen bg-[#1e1e1e] overflow-hidden">
      {/* 모드 전환 헤더 */}
      <div className="flex items-center h-10 bg-[#252526] border-b border-[#3e3e3e] px-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMode('execute')}
            className={`px-4 py-1.5 text-xs font-semibold rounded transition-colors font-mono ${
              mode === 'execute'
                ? 'bg-[#0e639c] text-white'
                : 'bg-[#3c3c3c] text-[#cccccc] hover:bg-[#464647]'
            }`}
          >
            코드 실행
          </button>
          <button
            onClick={() => setMode('s3editor')}
            className={`px-4 py-1.5 text-xs font-semibold rounded transition-colors font-mono ${
              mode === 's3editor'
                ? 'bg-[#0e639c] text-white'
                : 'bg-[#3c3c3c] text-[#cccccc] hover:bg-[#464647]'
            }`}
          >
            S3 편집기
          </button>
        </div>
      </div>

      {/* 모드별 컨텐츠 */}
      {mode === 'execute' ? (
        <>
          {/* 코드 실행 모드 헤더 */}
          <div className="flex items-center h-10 bg-[#2d2d2d] border-b border-[#3e3e3e] px-3 flex-shrink-0 overflow-x-auto">
            <div className="flex items-center gap-2 min-w-max">
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isRunning}
                className="px-3 py-1 text-xs bg-[#3c3c3c] border border-[#464647] text-[#cccccc] rounded focus:outline-none focus:border-[#007acc] disabled:opacity-50 disabled:cursor-not-allowed font-mono flex-shrink-0"
              >
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
              </select>
              <select
                value={selectedSample}
                onChange={(e) => handleSampleChange(e.target.value)}
                disabled={isRunning}
                className="px-3 py-1 text-xs bg-[#3c3c3c] border border-[#464647] text-[#cccccc] rounded focus:outline-none focus:border-[#007acc] disabled:opacity-50 disabled:cursor-not-allowed font-mono min-w-[140px] flex-shrink-0"
              >
                <option value="">코드 샘플 선택</option>
                {Object.keys(codeSamples[language]).map((sampleName) => (
                  <option key={sampleName} value={sampleName}>
                    {sampleName}
                  </option>
                ))}
              </select>
              {isRunning && (
                <button
                  onClick={handleStop}
                  className="px-3 py-1 text-xs bg-[#c72e2e] text-white rounded hover:bg-[#d73a3a] transition-colors font-mono flex-shrink-0"
                >
                  중단
                </button>
              )}
              <button
                onClick={handleExecute}
                disabled={isRunning}
                className="px-3 py-1 text-xs bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono flex-shrink-0"
              >
                실행
              </button>
              <button
                onClick={handleClear}
                disabled={isRunning}
                className="px-3 py-1 text-xs bg-[#3c3c3c] text-[#cccccc] rounded hover:bg-[#464647] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono flex-shrink-0"
              >
                지우기
              </button>
            </div>
          </div>

      {/* 코드 에디터 영역 (상단 55%) */}
      <div className="flex flex-col flex-[0.55] min-h-0 border-b border-[#3e3e3e]">
        <div className="flex items-center h-7 bg-[#252526] border-b border-[#3e3e3e] px-3 flex-shrink-0">
          <span className="text-xs text-[#cccccc] font-mono">
            {language === 'javascript' ? 'main.js' : 'main.py'}
          </span>
        </div>
        <div className="flex-1 overflow-hidden">
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={isRunning}
            placeholder={`${language === 'javascript' ? 'console.log("Hello, World!");' : 'print("Hello, World!")'}`}
            className="w-full h-full px-4 py-3 bg-[#1e1e1e] text-[#d4d4d4] text-sm font-mono focus:outline-none disabled:opacity-50 resize-none leading-relaxed"
            style={{ 
              tabSize: 2,
              caretColor: '#007acc'
            }}
          />
        </div>
      </div>

      {/* 서버 통신 로그 영역 (중간 12%) */}
      <div className="flex flex-col flex-[0.12] min-h-0 border-b border-[#3e3e3e] bg-[#1e1e1e]">
        <div className="flex items-center h-6 bg-[#252526] border-b border-[#3e3e3e] px-3 flex-shrink-0">
          <span className="text-xs text-[#858585] font-mono">로그</span>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-1.5 bg-[#1e1e1e]">
          {logs.length === 0 ? (
            <p className="text-[#4a4a4a] text-xs font-mono">서버 통신 로그가 여기에 표시됩니다.</p>
          ) : (
            <div className="space-y-0.5">
              {logs.map((log, index) => (
                <div key={index} className="text-xs font-mono leading-tight">
                  {log.type === 'log' && (
                    <p className="text-[#4ec9b0]">
                      <span className="text-[#858585]">[{log.timestamp.toLocaleTimeString()}]</span> {log.message}
                    </p>
                  )}
                  {log.type === 'close' && (
                    <p className={log.hasError ? 'text-[#f48771]' : 'text-[#4ec9b0]'}>
                      <span className="text-[#858585]">[{log.timestamp.toLocaleTimeString()}]</span> 종료 코드: {log.exitCode} {log.hasError && '(에러)'}
                    </p>
                  )}
                </div>
              ))}
              <div ref={logsEndRef} />
            </div>
          )}
        </div>
      </div>

      {/* 터미널 영역 (하단 33%) - 실시간 출력 */}
      <div className="flex flex-col flex-[0.33] min-h-0 bg-[#1e1e1e]">
        <div className="flex items-center justify-between h-7 bg-[#252526] border-b border-[#3e3e3e] px-3 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#cccccc] font-mono">터미널</span>
            {status && (
              <span className="text-xs text-[#858585] font-mono">• {status}</span>
            )}
          </div>
        </div>
        <div 
          ref={terminalOutputRef}
          className="flex-1 w-full bg-[#1e1e1e] p-3 overflow-y-auto"
          style={{ minHeight: 0 }}
        >
          <pre className="text-xs text-[#d4d4d4] font-mono whitespace-pre-wrap break-words m-0">
            {terminalOutput || <span className="text-[#4a4a4a]">터미널 출력이 여기에 표시됩니다...</span>}
          </pre>
        </div>
      </div>
        </>
      ) : (
        <>
          {/* S3 편집기 모드 */}

          {/* 메인 영역 (좌우 분할 또는 프리뷰) */}
          {previewMode && previewUrl ? (
            /* 프리뷰 모드 */
            <div className="flex-1 min-h-0 bg-[#1e1e1e] flex flex-col">
              <div className="flex items-center h-8 bg-[#252526] border-b border-[#3e3e3e] px-3 flex-shrink-0 gap-3">
                <span className="text-xs text-[#cccccc] font-mono flex-shrink-0">라이브 서버</span>
                <div className="flex-1 flex items-center justify-center">
                  <div className="w-full max-w-2xl px-3 py-1 bg-[#1c1c1c] border border-[#464647] rounded text-[#d4d4d4] text-xs font-mono">
                    {previewUrl || '로딩 중...'}
                  </div>
                </div>
                <button
                  onClick={() => setPreviewMode(false)}
                  className="text-[#cccccc] hover:text-white transition-colors flex-shrink-0"
                  title="라이브 서버 닫기"
                >
                  <svg 
                    width="14" 
                    height="14" 
                    viewBox="0 0 14 14" 
                    fill="none" 
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path 
                      d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" 
                      stroke="currentColor" 
                      strokeWidth="1.5" 
                      strokeLinecap="round" 
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              </div>
              <div className="flex-1 min-h-0">
              <iframe
                src={previewUrl}
                className="w-full h-full border-0"
                title="HTML Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              />
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex">
              {/* 왼쪽: 파일 트리/목록 영역 (30%) */}
              <div className="w-[30%] min-w-[200px] flex flex-col border-r border-[#3e3e3e] bg-[#252526]">
                <div className="flex flex-col bg-[#2d2d2d] border-b border-[#3e3e3e] flex-shrink-0">
                  {/* 파일 탐색기 헤더 */}
                  <div className="flex items-center justify-between h-7 px-3">
                    <span className="text-xs text-[#cccccc] font-mono">파일 탐색기</span>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setShowAddFileModal(true)}
                        className="text-[#cccccc] hover:text-white transition-colors"
                        title="파일 추가"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                          {/* 파일 아이콘 + 추가 아이콘 */}
                          <path d="M4 2H8L10 4V11C10 11.5523 9.55228 12 9 12H4C3.44772 12 3 11.5523 3 11V3C3 2.44772 3.44772 2 4 2Z" stroke="currentColor" strokeWidth="1" fill="none"/>
                          <path d="M8 2V4H10" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
                          <path d="M7 6H7.01M7 8.5H7.01" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                          <circle cx="10.5" cy="3.5" r="1.5" fill="currentColor"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => setShowAddFolderModal(true)}
                        className="text-[#cccccc] hover:text-white transition-colors"
                        title="폴더 추가"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                          {/* 폴더 아이콘 + 추가 아이콘 */}
                          <path d="M2 4C2 3.44772 2.44772 3 3 3H5.5L6.5 4H11C11.5523 4 12 4.44772 12 5V11C12 11.5523 11.5523 12 11 12H3C2.44772 12 2 11.5523 2 11V4Z" stroke="currentColor" strokeWidth="1" fill="none"/>
                          <circle cx="10.5" cy="5.5" r="1.5" fill="currentColor"/>
                        </svg>
                      </button>
                      <button
                        onClick={() => setShowFileLoader(!showFileLoader)}
                        className="text-[#cccccc] hover:text-white transition-colors"
                        title={showFileLoader ? "파일 불러오기 숨기기" : "파일 불러오기 보이기"}
                      >
                        <svg 
                          width="14" 
                          height="14" 
                          viewBox="0 0 14 14" 
                          fill="none" 
                          xmlns="http://www.w3.org/2000/svg"
                          className={`transition-transform ${showFileLoader ? 'rotate-180' : ''}`}
                        >
                          <path 
                            d="M3.5 5.25L7 8.75L10.5 5.25" 
                            stroke="currentColor" 
                            strokeWidth="1.5" 
                            strokeLinecap="round" 
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                  {/* 파일 불러오기 입력 영역 */}
                  {showFileLoader && (
                  <div className="flex items-center gap-2 px-3 pb-2 h-7">
                    <label className="text-xs text-[#cccccc] font-mono whitespace-nowrap flex-shrink-0">
                      파일 불러오기:
                    </label>
                    <input
                      type="text"
                      value={s3Path}
                      onChange={(e) => {
                        setS3Path(e.target.value);
                        setPreviewError(null);
                      }}
                      placeholder="S3 경로 (비어있으면 최상단 경로)"
                      className="flex-1 px-2 py-1 bg-[#1c1c1c] border border-[#464647] rounded text-[#d4d4d4] text-xs font-mono focus:outline-none focus:border-[#007acc] transition-colors"
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && !isLoadingFiles) {
                          handleLoadFiles();
                        }
                      }}
                    />
                  </div>
                  )}
                </div>
                <div
                  className="flex-1 overflow-y-auto"
                >
                  {!fileTree || fileTree.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                      <p className="text-[#858585] text-xs font-mono text-center px-4">
                        {isLoadingFiles ? '파일 목록 로딩 중...' : 'S3 경로를 입력하고 Enter 키를 누르세요.'}
                      </p>
                    </div>
                  ) : (
                    <div className="py-1 relative">
                      {renderFileTree(fileTree, 0)}
                      {/* 컨텍스트 메뉴 */}
                      {contextMenu && (() => {
                        const adjustedPos = adjustContextMenuPosition(contextMenu.x, contextMenu.y, 200, 150);
                        return (
                          <div
                            className="fixed bg-[#252526] border border-[#3e3e3e] rounded shadow-lg z-50 min-w-[200px]"
                            style={{
                              left: `${adjustedPos.x}px`,
                              top: `${adjustedPos.y}px`,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                          <button
                            onClick={() => handleCopyPath(contextMenu.file)}
                            className="w-full text-left px-4 py-2 text-xs text-[#cccccc] hover:bg-[#2a2d2e] font-mono transition-colors"
                          >
                            📋 경로 복사
                          </button>
                          <button
                            onClick={() => {
                              setRenameTarget(contextMenu.file);
                              setNewName(contextMenu.file.name);
                              setShowRenameModal(true);
                              setContextMenu(null);
                            }}
                            className="w-full text-left px-4 py-2 text-xs text-[#cccccc] hover:bg-[#2a2d2e] font-mono transition-colors"
                          >
                            ✏️ 이름 변경
                          </button>
                          <button
                            onClick={() => handleDeleteFile(contextMenu.file)}
                            disabled={isDeleting}
                            className="w-full text-left px-4 py-2 text-xs text-[#f48771] hover:bg-[#2a2d2e] font-mono transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isDeleting ? '삭제 중...' : '🗑️ 삭제'}
                          </button>
                        </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>

              {/* 오른쪽: 파일 편집 영역 (70%) */}
              <div className="flex-1 flex flex-col min-w-0">
                {selectedFile ? (
                  <>
                    {/* 편집 영역 헤더 */}
                    <div className="flex items-center justify-between h-7 bg-[#2d2d2d] border-b border-[#3e3e3e] px-3 flex-shrink-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[#cccccc] font-mono">{selectedFile.name}</span>
                        {hasUnsavedChanges && (
                          <span className="text-xs text-[#f48771] font-mono">• 저장되지 않음</span>
                        )}
                        {isSavingFile && (
                          <span className="text-xs text-[#4ec9b0] font-mono">• 저장 중...</span>
                        )}
                        {!hasUnsavedChanges && !isSavingFile && (
                          <span className="text-xs text-[#858585] font-mono">• 저장됨</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {(() => {
                          // 파일 확장자로 타입 판단
                          const fileExt = selectedFile.name.split('.').pop()?.toLowerCase();
                          const isWebFile = fileExt === 'html' || fileExt === 'css';
                          
                          if (isWebFile) {
                            // HTML/CSS: 라이브 서버 실행
                            return (
                              <>
                                <button
                                  onClick={() => {
                                    if (previewUrl) {
                                      // 이미 열려있으면 다시 열기
                                      setPreviewMode(true);
                                    } else {
                                      // 열려있지 않으면 새로 생성
                                      handlePreview(selectedFile.path);
                                    }
                                  }}
                                  onContextMenu={(e) => {
                                    if (previewUrl) {
                                      e.preventDefault();
                                      setLiveServerContextMenu({
                                        x: e.clientX,
                                        y: e.clientY
                                      });
                                    }
                                  }}
                                  disabled={previewLoading}
                                  className="px-3 py-1 text-xs bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono"
                                >
                                  {previewLoading ? '로딩 중...' : previewUrl ? '라이브 서버 열기' : '라이브 서버'}
                                </button>
                              </>
                            );
                          } else {
                            // JS/PY 등: 일반 실행
                            return (
                              <>
                                <button
                                  onClick={() => executeS3File(selectedFile)}
                                  disabled={isS3Executing}
                                  className="px-3 py-1 text-xs bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono"
                                >
                                  {isS3Executing ? '실행 중...' : '실행'}
                                </button>
                                {isS3Executing && (
                                  <button
                                    onClick={handleStopS3Execute}
                                    className="px-3 py-1 text-xs bg-[#f48771] text-white rounded hover:bg-[#ff6b5a] transition-colors font-mono"
                                  >
                                    중단
                                  </button>
                                )}
                              </>
                            );
                          }
                        })()}
                      </div>
                      {/* 라이브 서버 컨텍스트 메뉴 */}
                      {liveServerContextMenu && (() => {
                        const adjustedPos = adjustContextMenuPosition(liveServerContextMenu.x, liveServerContextMenu.y, 200, 50);
                        return (
                          <div
                            className="fixed bg-[#252526] border border-[#3e3e3e] rounded shadow-lg z-50 min-w-[200px] live-server-context-menu"
                            style={{
                              left: `${adjustedPos.x}px`,
                              top: `${adjustedPos.y}px`,
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={handleCloseLiveServer}
                              className="w-full text-left px-4 py-2 text-xs text-[#f48771] hover:bg-[#2a2d2e] font-mono transition-colors"
                            >
                              🗑️ 종료
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                    {/* 코드 에디터 */}
                    {(() => {
                      // 파일 확장자로 타입 판단
                      const fileExt = selectedFile.name.split('.').pop()?.toLowerCase();
                      const isWebFile = fileExt === 'html' || fileExt === 'css';
                      
                      return (
                        <>
                          <div className={!showOutputPanel ? "flex-1 overflow-hidden flex flex-col" : "flex-[0.5] overflow-hidden flex flex-col"}>
                            <textarea
                              value={currentFileContent}
                              onChange={(e) => handleFileContentChange(e.target.value)}
                              placeholder="파일 내용을 편집하세요..."
                              className="w-full h-full px-4 py-3 bg-[#1e1e1e] text-[#d4d4d4] text-sm font-mono focus:outline-none resize-none leading-relaxed"
                              style={{ 
                                tabSize: 2,
                                caretColor: '#007acc'
                              }}
                            />
                          </div>
                          {/* 출력 영역 - 모든 파일 선택 시 항상 표시 */}
                          <div className={`flex flex-col ${showOutputPanel ? 'flex-[0.5]' : 'flex-shrink-0'} min-h-0 bg-[#1e1e1e] border-t border-[#3e3e3e]`}>
                            <div className="flex items-center justify-between h-7 bg-[#252526] border-b border-[#3e3e3e] px-3 flex-shrink-0">
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-[#cccccc] font-mono">출력</span>
                                {s3ExecuteStatus && (
                                  <span className="text-xs text-[#858585] font-mono">• {s3ExecuteStatus}</span>
                                )}
                              </div>
                              <button
                                onClick={() => setShowOutputPanel(!showOutputPanel)}
                                className="text-[#cccccc] hover:text-white transition-colors"
                                title={showOutputPanel ? "출력 숨기기" : "출력 보이기"}
                              >
                                <svg 
                                  width="14" 
                                  height="14" 
                                  viewBox="0 0 14 14" 
                                  fill="none" 
                                  xmlns="http://www.w3.org/2000/svg"
                                  className={`transition-transform ${showOutputPanel ? '' : 'rotate-180'}`}
                                >
                                  <path 
                                    d="M3.5 5.25L7 8.75L10.5 5.25" 
                                    stroke="currentColor" 
                                    strokeWidth="1.5" 
                                    strokeLinecap="round" 
                                    strokeLinejoin="round"
                                  />
                                </svg>
                              </button>
                            </div>
                            {showOutputPanel && (
                              <div className="flex-1 flex flex-col min-h-0">
                                {/* 로그 영역 */}
                                <div className="flex flex-col flex-[0.4] min-h-0 border-b border-[#3e3e3e]">
                                  <div className="flex-1 overflow-y-auto px-3 py-1.5 bg-[#1e1e1e]">
                                    {s3ExecuteLogs.length === 0 ? (
                                      <span className="text-[#4a4a4a] text-xs font-mono">서버 통신 로그가 여기에 표시됩니다.</span>
                                    ) : (
                                      <div className="space-y-1">
                                        {s3ExecuteLogs.map((log, idx) => (
                                          <div key={idx} className="text-xs font-mono">
                                            {log.type === 'log' && (
                                              <span className="text-[#4ec9b0]">{log.message}</span>
                                            )}
                                            {log.type === 'close' && (
                                              <span className={log.hasError ? 'text-[#f48771]' : 'text-[#4ec9b0]'}>
                                                {log.hasError ? '실행 실패' : '실행 완료'} (종료 코드: {log.exitCode})
                                              </span>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                {/* 터미널 영역 */}
                                <div className="flex flex-col flex-[0.6] min-h-0">
                                  <div 
                                    ref={s3TerminalOutputRef}
                                    className="flex-1 w-full bg-[#1e1e1e] p-3 overflow-y-auto"
                                    style={{ minHeight: 0 }}
                                  >
                                    <pre className="text-xs text-[#d4d4d4] font-mono whitespace-pre-wrap break-words m-0">
                                      {s3TerminalOutput || <span className="text-[#4a4a4a]">터미널 출력이 여기에 표시됩니다...</span>}
                                    </pre>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </>
                      );
                    })()}
                  </>
            ) : (
              <div className="flex items-center justify-center h-full">
                <p className="text-[#858585] text-sm font-mono">
                      파일을 선택하세요.
                </p>
              </div>
            )}
          </div>
            </div>
          )}
        </>
      )}

      {/* 파일 추가 모달 */}
      {showAddFileModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => {
            setShowAddFileModal(false);
            setNewFileName('');
          }}
        >
          <div
            className="bg-[#252526] border border-[#3e3e3e] rounded-lg p-4 min-w-[300px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[#cccccc] font-mono mb-3">새 파일 추가</h3>
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="파일 이름 입력 (예: index.html, script.js)"
              className="w-full px-3 py-2 bg-[#1c1c1c] border border-[#464647] rounded text-[#d4d4d4] text-xs font-mono focus:outline-none focus:border-[#007acc] mb-3"
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleAddFile();
                } else if (e.key === 'Escape') {
                  setShowAddFileModal(false);
                  setNewFileName('');
                }
              }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAddFileModal(false);
                  setNewFileName('');
                }}
                className="px-3 py-1.5 text-xs bg-[#3c3c3c] text-[#cccccc] rounded hover:bg-[#464647] transition-colors font-mono"
              >
                취소
              </button>
              <button
                onClick={handleAddFile}
                disabled={!newFileName.trim()}
                className="px-3 py-1.5 text-xs bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono"
              >
                추가
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 폴더 추가 모달 */}
      {showAddFolderModal && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => {
            setShowAddFolderModal(false);
            setNewFolderName('');
          }}
        >
          <div
            className="bg-[#252526] border border-[#3e3e3e] rounded-lg p-4 min-w-[300px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[#cccccc] font-mono mb-3">새 폴더 추가</h3>
            <input
              type="text"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="폴더 이름 입력"
              className="w-full px-3 py-2 bg-[#1c1c1c] border border-[#464647] rounded text-[#d4d4d4] text-xs font-mono focus:outline-none focus:border-[#007acc] mb-3"
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleAddFolder();
                } else if (e.key === 'Escape') {
                  setShowAddFolderModal(false);
                  setNewFolderName('');
                }
              }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAddFolderModal(false);
                  setNewFolderName('');
                }}
                className="px-3 py-1.5 text-xs bg-[#3c3c3c] text-[#cccccc] rounded hover:bg-[#464647] transition-colors font-mono"
              >
                취소
              </button>
              <button
                onClick={handleAddFolder}
                disabled={!newFolderName.trim()}
                className="px-3 py-1.5 text-xs bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono"
              >
                추가
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 이름 변경 모달 */}
      {showRenameModal && renameTarget && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50"
          onClick={() => {
            setShowRenameModal(false);
            setRenameTarget(null);
            setNewName('');
          }}
        >
          <div
            className="bg-[#252526] border border-[#3e3e3e] rounded-lg p-4 min-w-[300px]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-[#cccccc] font-mono mb-3">
              {renameTarget.type === 'directory' ? '폴더' : '파일'} 이름 변경
            </h3>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="새 이름 입력"
              className="w-full px-3 py-2 bg-[#1c1c1c] border border-[#464647] rounded text-[#d4d4d4] text-xs font-mono focus:outline-none focus:border-[#007acc] mb-3"
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  handleRename();
                } else if (e.key === 'Escape') {
                  setShowRenameModal(false);
                  setRenameTarget(null);
                  setNewName('');
                }
              }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowRenameModal(false);
                  setRenameTarget(null);
                  setNewName('');
                }}
                className="px-3 py-1.5 text-xs bg-[#3c3c3c] text-[#cccccc] rounded hover:bg-[#464647] transition-colors font-mono"
              >
                취소
              </button>
              <button
                onClick={handleRename}
                disabled={!newName.trim() || isRenaming || newName.trim() === renameTarget.name}
                className="px-3 py-1.5 text-xs bg-[#0e639c] text-white rounded hover:bg-[#1177bb] disabled:opacity-50 disabled:cursor-not-allowed transition-colors font-mono"
              >
                {isRenaming ? '변경 중...' : '변경'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Execute;
