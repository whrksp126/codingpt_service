const { Lesson, GithubRepo, UserGithubRepo } = require('../models');
const githubService = require('./githubService');
const githubConnectionService = require('./githubConnectionService');

// 레슨 완료 시 학습자 GitHub 레포에 산출물을 커밋하는 오케스트레이션.
// 레포는 lesson.meta.github.repoId 가 가리키는 "레포 정의(github_repo)"를 학습자 계정에 생성/재사용한다.
// 파일은 레포 루트 기준 전체 경로(file.path)로 커밋 → 레슨 간 같은 경로 갱신(점진적 빌드).
// 조건 미충족이면 { skipped:true, reason } 반환, 실패는 throw(호출측 fire-and-forget/await).

// 메인 엔트리. (myclassId 는 시그니처 호환용 — 경로 결정에는 더 이상 쓰지 않음)
async function pushLessonForUser(userId, myclassId, lessonId) {
  const token = await githubConnectionService.getDecryptedToken(userId);
  if (!token) return { skipped: true, reason: 'no_github_connection' };

  const lesson = await Lesson.findByPk(lessonId);
  if (!lesson) return { skipped: true, reason: 'lesson_not_found' };

  const github = (lesson.meta && lesson.meta.github) || {};
  const files = Array.isArray(github.files) ? github.files.filter((f) => f && f.path) : [];
  if (!github.enabled || !github.repoId || files.length === 0) {
    return { skipped: true, reason: 'no_deliverables' };
  }

  const repoDef = await GithubRepo.findByPk(github.repoId);
  if (!repoDef) return { skipped: true, reason: 'repo_definition_not_found' };

  // 학습자 계정에 레포 확보 (없으면 생성) + 매핑 upsert
  const repo = await githubService.getOrCreateRepo(token, repoDef.name, {
    description: repoDef.description || `CodingPT - ${repoDef.name}`,
  });

  const [mapping] = await UserGithubRepo.findOrCreate({
    where: { user_id: userId, github_repo_id: repoDef.id },
    defaults: {
      repo_full_name: repo.fullName,
      default_branch: repo.defaultBranch,
      html_url: repo.htmlUrl,
    },
  });
  if (mapping.repo_full_name !== repo.fullName || mapping.default_branch !== repo.defaultBranch) {
    await mapping.update({
      repo_full_name: repo.fullName,
      default_branch: repo.defaultBranch,
      html_url: repo.htmlUrl,
    });
  }

  // 파일 경로 = 레포 루트 기준 전체 경로 (폴더 자동 prefix 없음)
  const result = await githubService.commitFiles(token, {
    owner: repo.owner,
    repo: repo.repo,
    branch: repo.defaultBranch,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    message: `완료: ${lesson.name}`,
  });

  return {
    skipped: false,
    repoFullName: repo.fullName,
    htmlUrl: repo.htmlUrl,
    folderUrl: repo.htmlUrl, // 점진적 빌드: 레포 루트가 곧 결과물
    path: '',
    commitSha: result.commitSha,
    fileCount: files.length,
  };
}

module.exports = { pushLessonForUser };
