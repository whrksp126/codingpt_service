import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import * as repoApi from '../utils/githubRepoApi';
import SimpleEditModal from '../components/admin/content/SimpleEditModal';

// 관리자 GitHub 레포 정의 관리 페이지.
// 여기서 "레포"를 만들어두면, 각 레슨의 GitHub 산출물 패널에서 이 레포를 선택해 푸시 대상으로 지정한다.
const AdminGithubRepos = () => {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const data = await repoApi.listRepos();
      setRepos(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setModal({
      title: '새 GitHub 레포',
      initialName: '',
      initialDescription: '',
      showDescription: true,
      onSave: async (data) => { await repoApi.createRepo(data); await load(); },
    });
  };

  const openEdit = (repo) => {
    setModal({
      title: 'GitHub 레포 수정',
      initialName: repo.name,
      initialDescription: repo.description || '',
      showDescription: true,
      onSave: async (data) => { await repoApi.updateRepo(repo.id, data); await load(); },
      onDelete: async () => { await repoApi.deleteRepo(repo.id); await load(); },
    });
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <Link to="/admin/lessons" className="text-sm text-slate-500 hover:text-slate-900">← 콘텐츠 관리</Link>
        <h1 className="text-base font-semibold text-slate-900">GitHub 레포 관리</h1>
        <button
          type="button"
          onClick={openCreate}
          className="ml-auto rounded bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-600"
        >
          + 레포 생성
        </button>
      </header>

      <main className="mx-auto max-w-3xl p-6">
        <p className="mb-4 text-sm text-slate-500">
          학습자가 레슨을 완료하면 본인 GitHub 계정에 여기서 정의한 이름의 레포가 생성되고, 레슨에서 선택한 레포로 산출물이 푸시됩니다.
        </p>

        {loading ? (
          <p className="py-12 text-center text-sm text-slate-400">불러오는 중…</p>
        ) : error ? (
          <p className="py-12 text-center text-sm text-red-500">{error}</p>
        ) : repos.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-400">
            아직 레포가 없습니다. "레포 생성"으로 추가하세요.
          </p>
        ) : (
          <ul className="space-y-2">
            {repos.map((repo) => (
              <li
                key={repo.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">GH</div>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm font-semibold text-slate-900">{repo.name}</p>
                  {repo.description ? (
                    <p className="truncate text-xs text-slate-500">{repo.description}</p>
                  ) : null}
                </div>
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                  {repo.visibility || 'public'}
                </span>
                <button
                  type="button"
                  onClick={() => openEdit(repo)}
                  className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50"
                >
                  설정
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>

      {modal && (
        <SimpleEditModal
          {...modal}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
};

export default AdminGithubRepos;
