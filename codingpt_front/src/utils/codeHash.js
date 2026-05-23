// 백엔드/RN 과 동일 알고리즘: sha256(lang + '\n' + code).hex().slice(0, 16)
export const computeCodeHash = async (language, code) => {
  const input = `${String(language || '').toLowerCase()}\n${code || ''}`;
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex.slice(0, 16);
};
