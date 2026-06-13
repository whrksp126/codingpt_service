import { useState } from 'react';
import { DeviceMobile } from '@phosphor-icons/react';
import { Switch } from './SharedFields';
import MobileIdePanel from '../../MobileIdePanel';

// 모듈(code/terminal/codeFillTheGapV2) FormView 에 삽입하는 "모바일 IDE 연동" 필드.
// value = module.ide ({ enabled, projectName, projectId, entryFile }), onChange(nextIde).
// 켜면 projectId 를 생성하고, "IDE 소스 관리"로 objectstore 프로젝트 소스를 편집한다.

const genId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const IdeIntegrationField = ({ value, onChange }) => {
  const ide = value || {};
  const [open, setOpen] = useState(false);
  const enabled = !!ide.enabled;

  const toggle = (on) => {
    if (on) {
      onChange({
        ...ide,
        enabled: true,
        projectId: ide.projectId || genId(),
        projectName: ide.projectName || '',
        entryFile: ide.entryFile || '',
      });
    } else {
      onChange({ ...ide, enabled: false });
    }
  };

  return (
    <div className="mb-3 rounded-lg border border-slate-200">
      <label className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">모바일 IDE 연동</span>
        <Switch checked={enabled} onChange={toggle} size="sm" />
      </label>
      {enabled && (
        <div className="border-t border-slate-200 p-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!ide.projectId}
            className="flex items-center gap-1.5 rounded bg-slate-800 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-40"
          >
            <DeviceMobile size={15} weight="fill" /> IDE 소스 관리
          </button>
          {ide.projectId && (
            <p className="mt-1 text-[11px] text-slate-400">프로젝트 ID: {ide.projectId}</p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
            소스 관리 모달에서 <b>열어둔 탭(순서·활성 탭)</b>과 <b>하이라이트</b>(에디터에서 영역 선택 후 우클릭 → 하이라이트 추가)가
            저장되어 학습자 IDE에 그대로 표시됩니다.
          </p>
        </div>
      )}
      {open && ide.projectId && (
        <MobileIdePanel
          projectId={ide.projectId}
          projectName={ide.projectName}
          entryFile={ide.entryFile}
          initialTabs={ide.initialTabs}
          activeTab={ide.activeTab}
          highlights={ide.highlights}
          onChangeMeta={(patch) => onChange({ ...ide, ...patch })}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};

export default IdeIntegrationField;
