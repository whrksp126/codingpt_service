import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { GithubLogo, Plus, X, Trash } from '@phosphor-icons/react';
import * as repoApi from '../utils/githubRepoApi';
import MonacoField from '../components/admin/lesson-editor/modules/_shared/MonacoField';

// 레포 편집 모달 — 이름/설명 + README.md(레포 최초 생성 시 시드) 직접 편집.
const RepoEditModal = ({ initial, onSave, onDelete, onClose }) => {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [readme, setReadme] = useState(
    initial?.readme != null ? initial.readme : `# ${initial?.name || ''}\n\n`,
  );
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await onSave({ name: name.trim(), description: description.trim(), readme });
      onClose();
    } catch (e) {
      alert(e.message);
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!onDelete || !confirm(`"${initial.name}" 레포 정의를 삭제할까요?`)) return;
    setBusy(true);
    try { await onDelete(); onClose(); } catch (e) { alert(e.message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            <GithubLogo size={20} weight="fill" className="text-slate-800" />
            {initial ? '레포 수정' : '새 GitHub 레포'}
          </h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X size={18} weight="bold" /></button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5">
          <label className="block">
            <span className="text-xs text-slate-600">레포 이름 *</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoFocus
              placeholder="예: html-basics"
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 font-mono text-sm focus:border-cyan-500 focus:outline-none" />
          </label>
          <label className="block">
            <span className="text-xs text-slate-600">설명</span>
            <input type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              className="mt-1 w-full rounded border border-slate-200 px-2 py-1.5 text-sm focus:border-cyan-500 focus:outline-none" />
          </label>
          <div className="flex min-h-0 flex-1 flex-col">
            <span className="mb-1 text-xs text-slate-600">README.md <span className="text-slate-400">— 레포 최초 생성 시 이 내용으로 들어갑니다</span></span>
            <div className="min-h-[240px] flex-1">
              <MonacoField value={readme} onChange={setReadme} language="markdown" height={'100%'} disableAutoFormat />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
          {onDelete ? (
            <button type="button" onClick={remove} disabled={busy}
              className="inline-flex items-center gap-1 rounded border border-red-200 bg-white px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50">
              <Trash size={14} weight="bold" /> 삭제
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded border border-slate-200 bg-white px-4 py-1.5 text-sm">취소</button>
            <button type="button" onClick={submit} disabled={busy || !name.trim()}
              className="rounded bg-cyan-500 px-4 py-1.5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:opacity-50">
              {busy ? '저장 중…' : '저장'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

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

  const openCreate = () => setModal({
    initial: null,
    onSave: async (data) => { await repoApi.createRepo(data); await load(); },
  });
  const openEdit = (repo) => setModal({
    initial: repo,
    onSave: async (data) => { await repoApi.updateRepo(repo.id, data); await load(); },
    onDelete: async () => { await repoApi.deleteRepo(repo.id); await load(); },
  });

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="flex h-14 items-center gap-3 border-b border-slate-200 bg-white px-4">
        <Link to="/admin/lessons" className="text-sm text-slate-500 hover:text-slate-900">← 콘텐츠 관리</Link>
        <GithubLogo size={20} weight="fill" className="text-slate-800" />
        <h1 className="text-base font-semibold text-slate-900">GitHub 레포 관리</h1>
        <button type="button" onClick={openCreate}
          className="ml-auto flex items-center gap-1 rounded bg-cyan-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-cyan-600">
          <Plus size={15} weight="bold" /> 레포 생성
        </button>
      </header>

      <main className="mx-auto max-w-3xl p-6">
        <p className="mb-4 text-sm text-slate-500">
          학습자가 레슨을 완료하면 본인 GitHub 계정에 여기서 정의한 이름의 레포가 생성되고, 레슨에서 선택한 레포로 산출물이 푸시됩니다. 레포 생성 시 아래 README.md 가 함께 들어갑니다.
        </p>

        {loading ? (
          <p className="py-12 text-center text-sm text-slate-400">불러오는 중…</p>
        ) : error ? (
          <p className="py-12 text-center text-sm text-red-500">{error}</p>
        ) : repos.length === 0 ? (
          <p className="py-12 text-center text-sm text-slate-400">아직 레포가 없습니다. "레포 생성"으로 추가하세요.</p>
        ) : (
          <ul className="space-y-2">
            {repos.map((repo) => (
              <li key={repo.id} className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-800 text-white"><GithubLogo size={20} weight="fill" /></div>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm font-semibold text-slate-900">{repo.name}</p>
                  {repo.description ? <p className="truncate text-xs text-slate-500">{repo.description}</p> : null}
                </div>
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{repo.visibility || 'public'}</span>
                <button type="button" onClick={() => openEdit(repo)}
                  className="rounded border border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50">설정</button>
              </li>
            ))}
          </ul>
        )}
      </main>

      {modal && <RepoEditModal {...modal} onClose={() => setModal(null)} />}
    </div>
  );
};

export default AdminGithubRepos;
