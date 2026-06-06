import { useState, useRef } from 'react';
import { Folder, FileText, File as FileIcon, Play, Pause, SpeakerHigh } from '@phosphor-icons/react';
import { isAcceptedFile, keyToUrl } from '../../../../../../utils/objectStoreApi';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'ogg', 'mpeg']);
const getExt = (name) => (name.split('.').pop() || '').toLowerCase();

const UsageOverlay = ({ usages, isUsed }) => (
  <div className="pointer-events-none absolute inset-0 flex flex-col justify-end rounded bg-gradient-to-t from-black/85 via-black/55 to-black/0 p-2 opacity-0 transition-opacity group-hover:opacity-100">
    <div className="mb-1 flex items-center gap-1">
      <span className={'inline-block h-2 w-2 rounded-full ' + (isUsed ? 'bg-emerald-400' : 'bg-slate-300')} />
      <span className={'text-[11px] font-semibold ' + (isUsed ? 'text-emerald-300' : 'text-slate-300')}>
        {isUsed ? `사용 중 · ${usages.length}곳` : '미사용'}
      </span>
    </div>
    {isUsed && (
      <ul className="space-y-0.5">
        {usages.slice(0, 4).map((u, idx) => (
          <li key={idx} className="truncate text-[10px] leading-tight text-white">
            <span className="opacity-80">{u.lessonName || '(레슨 없음)'}</span>
            {u.slideTitle && <span className="opacity-60"> · {u.slideTitle}</span>}
          </li>
        ))}
        {usages.length > 4 && <li className="text-[10px] text-white/70">+ {usages.length - 4}곳 더…</li>}
      </ul>
    )}
  </div>
);

const FileCard = ({
  item,
  index,
  accept,
  onEnterFolder,
  onSelectFile,
  onContextMenu,
  onItemClick,
  onDragStart,
  onDragEnd,
  onFolderDrop,
  isSelected,
  isDragging,
  isOtherDragging,
  isCut,
  usages,
}) => {
  const [isOver, setIsOver] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const audioElRef = useRef(null);
  const isFolder = item.isDirectory;
  const ext = isFolder ? '' : getExt(item.name);
  const isImage = !isFolder && IMAGE_EXT.has(ext);
  const isAudio = !isFolder && AUDIO_EXT.has(ext);

  const toggleAudio = (e) => {
    e.stopPropagation();
    let a = audioElRef.current;
    if (!a) {
      a = new Audio(keyToUrl(item.displayKey));
      a.onended = () => setAudioPlaying(false);
      a.onpause = () => setAudioPlaying(false);
      audioElRef.current = a;
    }
    if (a.paused) { a.play(); setAudioPlaying(true); } else { a.pause(); setAudioPlaying(false); }
  };
  const accepted = isFolder ? true : isAcceptedFile(item.name, accept);
  const isUsed = !isFolder && usages && usages.length > 0;

  const handleClick = (e) => {
    e.stopPropagation();
    onItemClick(item, index, e);
  };
  const handleDoubleClick = (e) => {
    e.stopPropagation();
    if (isFolder) onEnterFolder(item);
    else if (accepted) onSelectFile(item);
  };
  const handleContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(e, item);
  };

  // 폴더 카드는 drop target
  const handleDragEnter = (e) => {
    if (!isFolder) return;
    if (!isOtherDragging) return;
    e.preventDefault();
    setIsOver(true);
  };
  const handleDragOver = (e) => {
    if (!isFolder) return;
    if (!isOtherDragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const handleDragLeave = () => setIsOver(false);
  const handleDrop = (e) => {
    setIsOver(false);
    if (!isFolder) return;
    onFolderDrop(item, e);
  };

  return (
    <div
      data-card="true"
      data-key={item.displayKey}
      draggable
      onDragStart={(e) => onDragStart(item, e)}
      onDragEnd={onDragEnd}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={[
        'group relative flex cursor-pointer flex-col gap-1 rounded-lg border p-2 transition select-none',
        isSelected
          ? 'border-cyan-500 bg-cyan-50 ring-2 ring-cyan-300'
          : 'border-slate-200 bg-white hover:border-cyan-300 hover:bg-cyan-50/30',
        !accepted && !isFolder ? 'opacity-40' : '',
        isDragging ? 'opacity-50' : '',
        isCut ? 'opacity-50 grayscale' : '',
        isOver && isFolder ? 'border-cyan-500 bg-cyan-100 ring-2 ring-cyan-400' : '',
      ].join(' ')}
      title={accepted ? item.name : `${item.name} (호환되지 않는 형식)`}
    >
      {!isFolder && (
        <span
          className={
            'absolute right-1.5 top-1.5 z-10 inline-block h-2.5 w-2.5 rounded-full ring-2 ring-white ' +
            (isUsed ? 'bg-emerald-500' : 'bg-slate-300')
          }
        />
      )}
      <div className="relative flex h-32 w-full items-center justify-center overflow-hidden rounded bg-slate-50">
        {isFolder ? (
          <Folder size={48} weight="fill" className="text-amber-400" />
        ) : isImage ? (
          <img
            src={keyToUrl(item.displayKey)}
            alt={item.name}
            loading="lazy"
            draggable={false}
            className="h-full w-full object-contain"
            onError={(e) => { e.target.style.display = 'none'; }}
          />
        ) : isAudio ? (
          <button
            type="button"
            onClick={toggleAudio}
            className="flex h-12 w-12 items-center justify-center rounded-full bg-cyan-600 text-white shadow hover:bg-cyan-700"
            title="미리듣기"
          >
            {audioPlaying ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}
          </button>
        ) : ext === 'txt' || ext === 'md' || ext === 'json' ? (
          <FileText size={40} className="text-slate-400" />
        ) : (
          <FileIcon size={40} className="text-slate-400" />
        )}
        {!isFolder && <UsageOverlay usages={usages || []} isUsed={isUsed} />}
      </div>
      <div className="w-full truncate text-center text-[11px] text-slate-700" title={item.name}>
        {item.name}
      </div>
    </div>
  );
};

const FileGrid = ({
  items,
  accept,
  onEnterFolder,
  onSelectFile,
  onContextMenu,
  onItemClick,
  onBackgroundClick,
  onCardDragStart,
  onCardDragEnd,
  onFolderDrop,
  draggingOver,
  draggingInternal,
  loading,
  currentValueKey,
  usageMap,
  selectedKeys,
  cutKeys,
}) => {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-400">
        불러오는 중…
      </div>
    );
  }

  if (!items.length) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center gap-2 text-sm text-slate-400" onClick={onBackgroundClick}>
        <span>비어 있는 폴더입니다.</span>
        <span className="text-xs">파일을 끌어 놓거나 업로드 버튼을 사용하세요.</span>
        {draggingOver && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-cyan-500 bg-cyan-50/80 text-cyan-700">
            <span className="text-sm font-medium">여기에 놓아 업로드</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-y-auto p-3" onClick={onBackgroundClick}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {items.map((item, idx) => {
          const isSelected = selectedKeys && selectedKeys.has(item.displayKey);
          return (
            <FileCard
              key={item.displayKey}
              item={item}
              index={idx}
              accept={accept}
              onEnterFolder={onEnterFolder}
              onSelectFile={onSelectFile}
              onContextMenu={onContextMenu}
              onItemClick={onItemClick}
              onDragStart={onCardDragStart}
              onDragEnd={onCardDragEnd}
              onFolderDrop={onFolderDrop}
              isSelected={!!isSelected || (currentValueKey && currentValueKey === item.displayKey)}
              isDragging={draggingInternal && isSelected}
              isOtherDragging={draggingInternal}
              isCut={!!(cutKeys && cutKeys.has(item.displayKey))}
              usages={usageMap && usageMap.get(item.displayKey)}
            />
          );
        })}
      </div>
      {draggingOver && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-cyan-500 bg-cyan-50/70 text-cyan-700">
          <span className="text-sm font-semibold">여기에 놓아 업로드</span>
        </div>
      )}
    </div>
  );
};

export default FileGrid;
