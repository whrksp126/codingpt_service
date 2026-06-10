const jwt = require('jsonwebtoken');
const githubService = require('../services/githubService');
const githubConnectionService = require('../services/githubConnectionService');
const githubPushService = require('../services/githubPushService');
const { successResponse, errorResponse } = require('../utils/response');

const ACCESS_SECRET = process.env.ACCESS_SECRET;

// OAuth state: 사용자 식별 + CSRF 방지용 단기 서명 토큰
function signState(userId) {
  return jwt.sign({ gh_state: true, userId }, ACCESS_SECRET, { expiresIn: '10m' });
}
function verifyState(state) {
  const decoded = jwt.verify(state, ACCESS_SECRET);
  if (!decoded.gh_state || !decoded.userId) throw new Error('invalid state');
  return decoded.userId;
}

// 콜백 후 앱 WebView 가 감지/표시할 간단한 결과 페이지
function resultPage({ ok, message }) {
  const title = ok ? 'GitHub 연결 완료' : 'GitHub 연결 실패';
  const color = ok ? '#22c55e' : '#ef4444';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="codingpt-github" content="${ok ? 'connected' : 'error'}">
<title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;background:#0f172a;color:#fff}
.card{text-align:center;padding:32px}.dot{width:56px;height:56px;border-radius:50%;background:${color};
margin:0 auto 16px}h1{font-size:20px;margin:0 0 8px}p{color:#94a3b8;font-size:14px}</style></head>
<body><div class="card"><div class="dot"></div><h1>${title}</h1><p>${message}</p>
<p>이 창은 닫으셔도 됩니다.</p></div></body></html>`;
}

// GET /api/github/authorize  (auth) → 인가 URL 반환
const authorize = async (req, res) => {
  try {
    const state = signState(req.user.id);
    const url = githubService.getAuthorizeUrl(state);
    successResponse(res, { authorizeUrl: url });
  } catch (error) {
    console.error('GitHub authorize URL 생성 오류:', error);
    errorResponse(res, error, 500);
  }
};

// GET /api/github/callback?code=&state=  → 토큰 교환 + 연동 저장 + 결과 HTML
const callback = async (req, res) => {
  const { code, state, error: oauthError } = req.query;
  try {
    if (oauthError) throw new Error(`GitHub 인가 거부: ${oauthError}`);
    if (!code || !state) throw new Error('code/state 가 없습니다.');

    const userId = verifyState(state);
    const { accessToken, scope } = await githubService.exchangeCodeForToken(code);
    const githubUser = await githubService.getGithubUser(accessToken);
    await githubConnectionService.saveConnection(userId, { accessToken, scope, githubUser });

    res.status(200).send(resultPage({ ok: true, message: `@${githubUser.login} 계정이 연결되었습니다.` }));
  } catch (error) {
    console.error('GitHub callback 오류:', error);
    res.status(400).send(resultPage({ ok: false, message: error.message || '연결에 실패했습니다.' }));
  }
};

// GET /api/github/status  (auth)
const status = async (req, res) => {
  try {
    const conn = await githubConnectionService.getConnection(req.user.id);
    if (!conn) {
      return successResponse(res, { connected: false });
    }
    successResponse(res, {
      connected: true,
      login: conn.github_login,
      avatarUrl: conn.avatar_url,
      connectedAt: conn.connected_at,
    });
  } catch (error) {
    console.error('GitHub status 오류:', error);
    errorResponse(res, error, 500);
  }
};

// DELETE /api/github/disconnect  (auth)
const disconnect = async (req, res) => {
  try {
    await githubConnectionService.disconnect(req.user.id);
    successResponse(res, { connected: false });
  } catch (error) {
    console.error('GitHub disconnect 오류:', error);
    errorResponse(res, error, 500);
  }
};

// POST /api/github/push  (auth) — 수동 재푸시 (디버그/재시도)
const push = async (req, res) => {
  try {
    const { myclass_id, lesson_id } = req.body;
    if (!myclass_id || !lesson_id) throw new Error('myclass_id, lesson_id 가 필요합니다.');
    const result = await githubPushService.pushLessonForUser(req.user.id, myclass_id, lesson_id);
    successResponse(res, result);
  } catch (error) {
    console.error('GitHub push 오류:', error);
    errorResponse(res, error, 500);
  }
};

module.exports = { authorize, callback, status, disconnect, push };
