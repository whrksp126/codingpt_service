const axios = require('axios');

// GitHub OAuth App + REST API 통합 서비스 (axios 기반 — 컨테이너 Node18 호환).
// - OAuth 인가/토큰교환: github.com 엔드포인트
// - 레포 생성/조회 및 다중 파일 커밋: api.github.com (Git Data API)

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GITHUB_OAUTH_CALLBACK_URL = process.env.GITHUB_OAUTH_CALLBACK_URL;
// 공개 레포만 다루므로 public_repo scope 사용 (사용자 권한 허용 부담 최소화)
const GITHUB_SCOPE = process.env.GITHUB_SCOPE || 'public_repo';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';

// 토큰 인증 + GitHub 권장 헤더가 적용된 axios 인스턴스
function api(token) {
  return axios.create({
    baseURL: API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'CodingPT',
    },
  });
}

// OAuth 인가 페이지 URL 생성. state 는 호출측에서 서명한 값(사용자 식별 + CSRF 방지).
function getAuthorizeUrl(state) {
  if (!GITHUB_CLIENT_ID) throw new Error('GITHUB_CLIENT_ID 환경변수가 없습니다.');
  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    scope: GITHUB_SCOPE,
    state,
    allow_signup: 'true',
  });
  if (GITHUB_OAUTH_CALLBACK_URL) params.set('redirect_uri', GITHUB_OAUTH_CALLBACK_URL);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

// 인가 코드 → user-to-server access token 교환
async function exchangeCodeForToken(code) {
  const { data } = await axios.post(
    TOKEN_URL,
    {
      client_id: GITHUB_CLIENT_ID,
      client_secret: GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: GITHUB_OAUTH_CALLBACK_URL,
    },
    { headers: { Accept: 'application/json' } }
  );
  if (data.error || !data.access_token) {
    throw new Error(`GitHub 토큰 교환 실패: ${data.error_description || data.error || 'unknown'}`);
  }
  return { accessToken: data.access_token, scope: data.scope };
}

// 인증된 GitHub 사용자 정보 조회
async function getGithubUser(token) {
  const { data } = await api(token).get('/user');
  return { id: data.id, login: data.login, avatarUrl: data.avatar_url };
}

// 레포 조회 → 없으면 생성. 반환: { owner, repo, fullName, defaultBranch, htmlUrl }
async function getOrCreateRepo(token, repoName, { description } = {}) {
  const client = api(token);
  const me = await client.get('/user');
  const owner = me.data.login;

  try {
    const { data } = await client.get(`/repos/${owner}/${repoName}`);
    return {
      owner,
      repo: data.name,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      htmlUrl: data.html_url,
      created: false,
    };
  } catch (err) {
    if (!err.response || err.response.status !== 404) throw err;
  }

  // auto_init: true → 기본 브랜치/초기 커밋이 생성되어 이후 Git Data API 가 동작
  const { data } = await client.post('/user/repos', {
    name: repoName,
    private: false,
    auto_init: true,
    description: description || 'CodingPT 학습 산출물',
  });
  return {
    owner,
    repo: data.name,
    fullName: data.full_name,
    defaultBranch: data.default_branch || 'main',
    htmlUrl: data.html_url,
    created: true,
  };
}

// 여러 파일을 단일 커밋으로 푸시 (Git Data API).
// files: [{ path, content }]  path 는 레포 루트 기준 전체 경로 (basePath 생략 시).
// basePath 가 주어지면 그 하위 상대경로로 취급(하위호환).
async function commitFiles(token, { owner, repo, branch, basePath = '', files, message }) {
  const client = api(token);
  const repoBase = `/repos/${owner}/${repo}`;

  // 현재 브랜치 ref → 최신 커밋 → 트리
  const refRes = await client.get(`${repoBase}/git/ref/heads/${branch}`);
  const latestCommitSha = refRes.data.object.sha;
  const commitRes = await client.get(`${repoBase}/git/commits/${latestCommitSha}`);
  const baseTreeSha = commitRes.data.tree.sha;

  // 각 파일을 blob 으로 생성
  const treeItems = await Promise.all(
    files.map(async (f) => {
      const blobRes = await client.post(`${repoBase}/git/blobs`, {
        content: Buffer.from(f.content ?? '', 'utf8').toString('base64'),
        encoding: 'base64',
      });
      const fullPath = joinRepoPath(basePath, f.path);
      return { path: fullPath, mode: '100644', type: 'blob', sha: blobRes.data.sha };
    })
  );

  const treeRes = await client.post(`${repoBase}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeItems,
  });

  const newCommitRes = await client.post(`${repoBase}/git/commits`, {
    message,
    tree: treeRes.data.sha,
    parents: [latestCommitSha],
  });

  await client.patch(`${repoBase}/git/refs/heads/${branch}`, { sha: newCommitRes.data.sha });

  return { commitSha: newCommitRes.data.sha, htmlUrl: `https://github.com/${owner}/${repo}` };
}

// 레포/폴더/파일명을 GitHub 경로로 안전하게 변환.
// 한글 허용, 경로구분자/제어문자/선행점 제거, 공백→_.
function slugifySegment(name, fallback = 'untitled') {
  let s = String(name || '').trim();
  s = s.replace(/[\\/:*?"<>| -]/g, ''); // 경로/제어 문자 제거
  s = s.replace(/\s+/g, '_');
  s = s.replace(/^[.]+/, ''); // 선행 점 제거
  s = s.slice(0, 100);
  return s || fallback;
}

// 레포 이름은 GitHub 규칙상 영문/숫자/-/_/. 만 허용 → 그 외 문자는 -로 치환
function slugifyRepoName(name, fallback = 'codingpt-class') {
  let s = String(name || '').trim().toLowerCase();
  s = s.replace(/[^a-z0-9._-]+/g, '-');
  s = s.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  s = s.slice(0, 100);
  return s || fallback;
}

function joinRepoPath(...parts) {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== '')
    .join('/')
    .replace(/\/+/g, '/')
    .replace(/^\//, '');
}

module.exports = {
  getAuthorizeUrl,
  exchangeCodeForToken,
  getGithubUser,
  getOrCreateRepo,
  commitFiles,
  slugifySegment,
  slugifyRepoName,
  joinRepoPath,
};
