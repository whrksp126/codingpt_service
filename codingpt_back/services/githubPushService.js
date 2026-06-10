const {
  MyClass,
  Lesson,
  Section,
  Class,
  ProductClassMap,
  ClassSectionMap,
  SectionLessonMap,
  UserClassRepo,
} = require('../models');
const githubService = require('./githubService');
const githubConnectionService = require('./githubConnectionService');

// 레슨 완료 시 학습자 GitHub 레포에 산출물을 커밋하는 오케스트레이션.
// 어떤 단계든 조건 미충족이면 조용히 skip 하고, 실패는 throw 한다(호출측에서 fire-and-forget).

// myclass.product_id 기준으로, 해당 lesson 을 포함하는 (class, section) 을 찾는다.
async function resolveClassAndSection(productId, lessonId) {
  const pcMaps = await ProductClassMap.findAll({ where: { product_id: productId }, attributes: ['class_id'] });
  const classIds = pcMaps.map((m) => m.class_id);
  if (classIds.length === 0) return null;

  const csMaps = await ClassSectionMap.findAll({ where: { class_id: classIds }, attributes: ['class_id', 'section_id'] });
  if (csMaps.length === 0) return null;
  const sectionToClass = new Map(csMaps.map((m) => [m.section_id, m.class_id]));
  const sectionIds = [...sectionToClass.keys()];

  // 이 레슨을 포함하는 섹션 (해당 상품 범위 내)
  const slMap = await SectionLessonMap.findOne({
    where: { lesson_id: lessonId, section_id: sectionIds },
    attributes: ['section_id'],
  });
  if (!slMap) return null;

  const sectionId = slMap.section_id;
  const classId = sectionToClass.get(sectionId);

  const [klass, section] = await Promise.all([
    Class.findByPk(classId),
    Section.findByPk(sectionId),
  ]);
  if (!klass || !section) return null;
  return { klass, section };
}

function buildRepoName(klass) {
  const slug = githubService.slugifyRepoName(klass.name, '');
  return slug ? `codingpt-${slug}-c${klass.id}` : `codingpt-class-${klass.id}`;
}

// klass 레포의 섹션/레슨 폴더 경로
function buildBasePath(section, lesson) {
  const secFolder = `${section.order_no}-${githubService.slugifySegment(section.name, 'section')}`;
  const lessonFolder = `${lesson.order_no}-${githubService.slugifySegment(lesson.name, 'lesson')}`;
  return githubService.joinRepoPath(secFolder, lessonFolder);
}

// 메인 엔트리. 연동/산출물 정의가 없으면 { skipped: true, reason } 반환.
async function pushLessonForUser(userId, myclassId, lessonId) {
  const token = await githubConnectionService.getDecryptedToken(userId);
  if (!token) return { skipped: true, reason: 'no_github_connection' };

  const lesson = await Lesson.findByPk(lessonId);
  if (!lesson) return { skipped: true, reason: 'lesson_not_found' };

  const github = (lesson.meta && lesson.meta.github) || {};
  const files = Array.isArray(github.files) ? github.files.filter((f) => f && f.path) : [];
  if (!github.enabled || files.length === 0) {
    return { skipped: true, reason: 'no_deliverables' };
  }

  const myclass = await MyClass.findByPk(myclassId);
  if (!myclass) return { skipped: true, reason: 'myclass_not_found' };

  const resolved = await resolveClassAndSection(myclass.product_id, lessonId);
  if (!resolved) return { skipped: true, reason: 'class_section_not_resolved' };
  const { klass, section } = resolved;

  // 레포 확보 (없으면 생성) + 매핑 upsert
  const repoName = buildRepoName(klass);
  const repo = await githubService.getOrCreateRepo(token, repoName, {
    description: `CodingPT - ${klass.name}`,
  });

  const [mapping] = await UserClassRepo.findOrCreate({
    where: { user_id: userId, class_id: klass.id },
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

  const basePath = buildBasePath(section, lesson);
  const result = await githubService.commitFiles(token, {
    owner: repo.owner,
    repo: repo.repo,
    branch: repo.defaultBranch,
    basePath,
    files: files.map((f) => ({ path: f.path, content: f.content })),
    message: `완료: ${lesson.name}`,
  });

  return {
    skipped: false,
    repoFullName: repo.fullName,
    htmlUrl: repo.htmlUrl,
    path: basePath,
    commitSha: result.commitSha,
    fileCount: files.length,
  };
}

module.exports = { pushLessonForUser };
