import JsonField from './_shared/JsonField';

const FormView = ({ value, onChange }) => (
  <>
    <p className="mb-2 rounded bg-amber-50 p-2 text-[11px] text-amber-700">
      드래그앤드롭 퀴즈는 JSON으로 직접 편집하세요.
    </p>
    <JsonField label="quiz data" value={value} onChange={(v) => onChange(v)} />
  </>
);

// 어드민 미리보기는 placeholder 톤만 매칭, 실제 인터랙션은 RN에서 검증.
const PreviewView = () => (
  <div
    className="rounded-[12px] p-4 text-center"
    style={{
      background: '#F5F6F9',
      border: '1px dashed #C8CCD6',
      color: '#6B7280',
      fontSize: 12,
    }}
  >
    🤏 드래그앤드롭 퀴즈
    <div className="mt-1" style={{ fontSize: 10, color: '#9CA3AF' }}>
      실기기 미리보기 권장
    </div>
  </div>
);

export default {
  type: 'dragAndDropQuiz',
  category: 'quiz',
  label: '드래그앤드롭',
  description: '항목을 드래그해서 맞추기',
  icon: '🤏',
  defaultValue: () => ({ type: 'dragAndDropQuiz' }),
  FormView,
  PreviewView,
};
