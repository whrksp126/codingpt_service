const BUILTIN_CHARACTERS = [
  { key: 'student_full', label: '학생 (전신)', shape: 'full' },
  { key: 'student_profile', label: '학생 (프로필)', shape: 'profile' },
  { key: 'teacher_full', label: '선생님 (전신)', shape: 'full' },
  { key: 'teacher_profile', label: '선생님 (프로필)', shape: 'profile' },
];

const OBJECTSTORE_CHARACTERS_PREFIX = 'lesson-assets/images/';

const buildCharacterUrl = (key) => {
  const base = process.env.OBJECTSTORE_PUBLIC_BASE_URL || 'https://objectstore.ghmate.com/codingpt';
  return `${base}/${OBJECTSTORE_CHARACTERS_PREFIX}${key}.png`;
};

const INHERIT_CHARACTER = 'inherit';

module.exports = {
  BUILTIN_CHARACTERS,
  OBJECTSTORE_CHARACTERS_PREFIX,
  INHERIT_CHARACTER,
  buildCharacterUrl,
};
