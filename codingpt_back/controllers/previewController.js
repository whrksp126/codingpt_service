// const http = require('http');
// const { URL } = require('url');
// const s3Service = require('../services/s3Service');

// /**
//  * S3 HTML 프리뷰 URL 생성
//  * fileName 필드 제거: 자동으로 index.html을 찾거나 첫 번째 HTML 파일을 사용
//  */
// const createPreview = async (req, res) => {
//   const { s3Path } = req.body;
//   // s3Path 예: "codingpt/execute/class-id-00000006" (디렉토리 경로만)
//   // fileName 필드는 더 이상 사용하지 않음 - 자동으로 index.html 찾기

//   if (!s3Path || typeof s3Path !== 'string') {
//     return res.status(400).json({
//       success: false,
//       message: 'S3 경로가 필요합니다. (예: codingpt/execute/class-id-00000006)'
//     });
//   }

//   // fileName이 없으면 자동으로 index.html 찾기
//   let fileName = null;
//   try {
//     fileName = await s3Service.findIndexHtml(s3Path);
    
//     if (!fileName) {
//       return res.status(404).json({
//         success: false,
//         message: 'HTML 파일을 찾을 수 없습니다. index.html 또는 다른 HTML 파일이 필요합니다.',
//         s3Path: s3Path
//       });
//     }
//   } catch (error) {
//     console.error('[PreviewController] index.html 찾기 오류:', error);
//     return res.status(500).json({
//       success: false,
//       message: '파일 목록을 조회하는 중 오류가 발생했습니다.',
//       error: error.message
//     });
//   }

//   const executorUrl = process.env.CODE_EXECUTOR_URL || 'http://code-executor:5200';
//   const url = new URL(`${executorUrl}/preview`);

//   // 찾은 fileName을 executor 서버에 전달
//   const postData = JSON.stringify({ s3Path, fileName });

//   const options = {
//     hostname: url.hostname,
//     port: url.port || 5200,
//     path: url.pathname,
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       'Content-Length': Buffer.byteLength(postData)
//     }
//   };

//   const executorReq = http.request(options, (executorRes) => {
//     let data = '';

//     executorRes.on('data', (chunk) => {
//       data += chunk.toString();
//     });

//     executorRes.on('end', () => {
//       try {
//         const result = JSON.parse(data);
//         res.status(executorRes.statusCode).json(result);
//       } catch (err) {
//         console.error('[PreviewController] 응답 파싱 오류:', err);
//         res.status(500).json({
//           success: false,
//           message: '프리뷰 서버 응답을 파싱할 수 없습니다.'
//         });
//       }
//     });
//   });

//   executorReq.on('error', (err) => {
//     console.error('[PreviewController] 코드 실행 서버 연결 오류:', err);
//     res.status(500).json({
//       success: false,
//       message: `코드 실행 서버 연결 실패: ${err.message}. 서버가 실행 중인지 확인하세요.`
//     });
//   });

//   executorReq.write(postData);
//   executorReq.end();
// };

// module.exports = {
//   createPreview
// };

