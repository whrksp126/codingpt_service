const { UserGithubConnection } = require('../models');
const { encrypt, decrypt } = require('../utils/cryptoToken');

// 학습자 GitHub 연동 정보(토큰 포함)의 저장/조회/삭제.
// 토큰은 항상 암호화 상태로 DB 에 보관한다.

async function saveConnection(userId, { accessToken, scope, githubUser }) {
  const payload = {
    user_id: userId,
    github_user_id: githubUser.id,
    github_login: githubUser.login,
    access_token_enc: encrypt(accessToken),
    scope: scope || null,
    avatar_url: githubUser.avatarUrl || null,
    updated_at: new Date(),
  };

  const existing = await UserGithubConnection.findOne({ where: { user_id: userId } });
  if (existing) {
    await existing.update(payload);
    return existing;
  }
  return UserGithubConnection.create(payload);
}

async function getConnection(userId) {
  return UserGithubConnection.findOne({ where: { user_id: userId } });
}

// 평문 access token 반환. 연동이 없으면 null.
async function getDecryptedToken(userId) {
  const conn = await getConnection(userId);
  if (!conn) return null;
  return decrypt(conn.access_token_enc);
}

async function disconnect(userId) {
  return UserGithubConnection.destroy({ where: { user_id: userId } });
}

module.exports = {
  saveConnection,
  getConnection,
  getDecryptedToken,
  disconnect,
};
