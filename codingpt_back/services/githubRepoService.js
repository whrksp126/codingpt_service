const { GithubRepo, sequelize } = require('../models');

// 레포 정의(github_repo) CRUD. 관리자 전용.

async function list() {
  return GithubRepo.findAll({ order: [['created_at', 'DESC']] });
}

async function getById(id) {
  return GithubRepo.findByPk(id);
}

async function create({ name, description, visibility, readme }) {
  if (!name || !String(name).trim()) {
    const err = new Error('레포 이름은 필수입니다.');
    err.statusCode = 400;
    throw err;
  }
  return GithubRepo.create({
    name: String(name).trim(),
    description: description || null,
    visibility: visibility || 'public',
    readme: readme || null,
  });
}

async function update(id, { name, description, visibility, readme }) {
  const repo = await GithubRepo.findByPk(id);
  if (!repo) {
    const err = new Error('레포 정의를 찾을 수 없습니다.');
    err.statusCode = 404;
    throw err;
  }
  if (name !== undefined) repo.name = String(name).trim();
  if (description !== undefined) repo.description = description || null;
  if (visibility !== undefined) repo.visibility = visibility || 'public';
  if (readme !== undefined) repo.readme = readme || null;
  await repo.save();
  return repo;
}

// 이 레포 정의를 참조하는 레슨 수 (lesson.meta.github.repoId)
async function countReferencingLessons(id) {
  const [rows] = await sequelize.query(
    `SELECT COUNT(*)::int AS cnt FROM lesson WHERE (meta->'github'->>'repoId')::int = :id`,
    { replacements: { id } }
  );
  return rows[0] ? rows[0].cnt : 0;
}

async function remove(id) {
  const repo = await GithubRepo.findByPk(id);
  if (!repo) {
    const err = new Error('레포 정의를 찾을 수 없습니다.');
    err.statusCode = 404;
    throw err;
  }
  const refCount = await countReferencingLessons(id);
  if (refCount > 0) {
    const err = new Error(`이 레포를 사용하는 레슨이 ${refCount}개 있어 삭제할 수 없습니다. 먼저 레슨에서 레포 선택을 해제하세요.`);
    err.statusCode = 409;
    throw err;
  }
  await repo.destroy();
  return { id };
}

// "직전 레슨 소스 불러오기": 같은 repoId 를 참조하는 레슨들을 커리큘럼 순서
// (섹션 order_no, 레슨 order_no)로 정렬해, 현재 레슨 직전 레슨의 산출물 files 를 반환.
// 없으면 빈 배열. (여러 섹션 소속 시 최소 섹션 order 기준 — best-effort)
async function getPreviousLessonFiles(lessonId, repoId) {
  const [rows] = await sequelize.query(
    `SELECT l.id, l.name, l.order_no AS lesson_order, l.meta,
            COALESCE(MIN(s.order_no), 9999) AS section_order
       FROM lesson l
       LEFT JOIN section_lesson_map slm ON slm.lesson_id = l.id
       LEFT JOIN section s ON s.id = slm.section_id
      WHERE l.id = :lessonId OR (l.meta->'github'->>'repoId')::int = :repoId
      GROUP BY l.id, l.name, l.order_no, l.meta`,
    { replacements: { lessonId, repoId } }
  );

  rows.sort(
    (a, b) =>
      a.section_order - b.section_order ||
      a.lesson_order - b.lesson_order ||
      a.id - b.id
  );

  const idx = rows.findIndex((r) => Number(r.id) === Number(lessonId));
  if (idx < 0) return { lessonId: null, lessonName: null, files: [] };

  for (let i = idx - 1; i >= 0; i--) {
    const g = rows[i].meta && rows[i].meta.github;
    if (g && Number(g.repoId) === Number(repoId) && Array.isArray(g.files) && g.files.length) {
      return { lessonId: rows[i].id, lessonName: rows[i].name, files: g.files };
    }
  }
  return { lessonId: null, lessonName: null, files: [] };
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
  countReferencingLessons,
  getPreviousLessonFiles,
};
