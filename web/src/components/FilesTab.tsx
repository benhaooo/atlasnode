import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderPlus,
  Home,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { FileEntry, ServerSnapshot } from '../types';
import { formatBytes, formatDateTime } from '../utils';

interface FilesTabProps {
  snapshot: ServerSnapshot;
  initialPath?: string;
}

export const FilesTab: React.FC<FilesTabProps> = ({ snapshot, initialPath = '/' }) => {
  const [currentPath, setCurrentPath] = useState(initialPath || '/');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  // Editor state
  const [openFile, setOpenFile] = useState<{
    path: string;
    size: number;
    truncated: boolean;
    binary: boolean;
    content: string;
    original: string;
  } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [saveToast, setSaveToast] = useState('');
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  const loadDir = async (dirPath: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await api.listFiles(snapshot.server.id, dirPath);
      setCurrentPath(res.path);
      setEntries(res.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取目录失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setEntries([]);
    setOpenFile(null);
    loadDir(initialPath || (snapshot.server.username === 'root' ? '/root' : `/home/${snapshot.server.username}`));
  }, [snapshot.server.id, initialPath]);

  const handleOpenFile = async (entry: FileEntry) => {
    if (entry.isDir) {
      loadDir(entry.path);
      return;
    }
    setLoadingFile(true);
    setError('');
    try {
      const res = await api.readFile(snapshot.server.id, entry.path);
      setOpenFile({ ...res, original: res.content });
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开文件失败');
    } finally {
      setLoadingFile(false);
    }
  };

  const handleSaveFile = async () => {
    if (!openFile || openFile.binary || openFile.truncated) return;
    setSavingFile(true);
    setError('');
    try {
      await api.writeFile(snapshot.server.id, openFile.path, openFile.content);
      setOpenFile({ ...openFile, original: openFile.content });
      setSaveToast('已保存');
      setTimeout(() => setSaveToast(''), 1800);
      loadDir(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingFile(false);
    }
  };

  const handleMkdir = async () => {
    const name = prompt('新建文件夹名称：');
    if (!name?.trim()) return;
    const target = `${currentPath.replace(/\/$/, '')}/${name.trim()}`;
    try {
      await api.mkdir(snapshot.server.id, target);
      loadDir(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建目录失败');
    }
  };

  const handleDelete = async (entry: FileEntry, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`确认永久删除 "${entry.name}" (${entry.path})？`)) return;
    try {
      await api.deleteFile(snapshot.server.id, entry.path);
      if (openFile?.path === entry.path) setOpenFile(null);
      loadDir(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    }
  };

  const handleUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setError('单次上传文件大小不能超过 50MB');
      return;
    }
    const target = `${currentPath.replace(/\/$/, '')}/${file.name}`;
    setError('');
    try {
      await api.uploadFileStream(snapshot.server.id, target, file);
      loadDir(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败');
    }
    e.target.value = '';
  };

  const homeDir = snapshot.server.username === 'root' ? '/root' : `/home/${snapshot.server.username}`;
  const bookmarks = [
    { label: '主目录', path: homeDir },
    { label: '根目录 /', path: '/' },
    { label: '/etc 配置', path: '/etc' },
    { label: '/opt 应用', path: '/opt' },
    { label: '/var/log 日志', path: '/var/log' },
    ...snapshot.composeDirs.map((cd) => ({ label: `Docker · ${cd.project}`, path: cd.dir })),
  ];

  const breadcrumbs = currentPath.split('/').filter(Boolean);
  const filteredEntries = entries.filter(
    (e) => !filter.trim() || e.name.toLowerCase().includes(filter.trim().toLowerCase())
  );

  const isDirty = openFile && openFile.content !== openFile.original;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[600px]">
      {/* Left Quick-Jump Bookmarks */}
      <aside className="lg:col-span-2 bg-[#0f131b] border border-white/[0.07] rounded-2xl p-3 space-y-1 self-start">
        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
          常用位置
        </div>
        {bookmarks.map((b, idx) => (
          <button
            key={`${b.path}-${idx}`}
            onClick={() => loadDir(b.path)}
            title={b.path}
            className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs truncate flex items-center gap-2 transition-colors cursor-pointer ${
              currentPath === b.path
                ? 'bg-sky-500/15 text-sky-300'
                : 'text-slate-300 hover:bg-white/[0.04]'
            }`}
          >
            {idx === 0 ? <Home className="w-3.5 h-3.5 shrink-0 text-sky-400" /> : <Folder className="w-3.5 h-3.5 shrink-0 text-amber-400/80" />}
            <span className="truncate">{b.label}</span>
          </button>
        ))}
      </aside>

      {/* Center Directory Browser */}
      <section
        className={`${
          openFile ? 'lg:col-span-5' : 'lg:col-span-10'
        } bg-[#0f131b] border border-white/[0.07] rounded-2xl flex flex-col overflow-hidden`}
      >
        {/* Path Bar & Actions */}
        <div className="p-3 border-b border-white/[0.06] space-y-2.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            {/* Breadcrumbs */}
            <div className="flex items-center gap-1 text-xs font-mono flex-wrap">
              <button
                onClick={() => loadDir('/')}
                className="px-1.5 py-0.5 rounded hover:bg-white/[0.07] text-slate-300 cursor-pointer"
              >
                /
              </button>
              {breadcrumbs.map((seg, i) => {
                const segPath = '/' + breadcrumbs.slice(0, i + 1).join('/');
                return (
                  <React.Fragment key={segPath}>
                    <ChevronRight className="w-3 h-3 text-slate-600" />
                    <button
                      onClick={() => loadDir(segPath)}
                      className="px-1.5 py-0.5 rounded hover:bg-white/[0.07] text-slate-200 cursor-pointer"
                    >
                      {seg}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5">
              <input
                ref={uploadInputRef}
                type="file"
                className="hidden"
                onChange={handleUploadChange}
              />
              <button
                onClick={() => uploadInputRef.current?.click()}
                title="上传文件到当前目录"
                className="flex items-center gap-1 text-[11px] bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-200 px-2.5 py-1.5 rounded-lg cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                <span>上传</span>
              </button>
              <button
                onClick={handleMkdir}
                title="新建目录"
                className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => loadDir(currentPath)}
                className="p-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.08] text-slate-300 cursor-pointer"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-sky-400' : ''}`} />
              </button>
            </div>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="过滤当前目录文件..."
              className="w-full bg-[#090b10] border border-white/[0.07] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-sky-400/50 focus:outline-none"
            />
          </div>
        </div>

        {error && (
          <div className="mx-3 mt-3 text-xs text-rose-300 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* File Table */}
        <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
          {currentPath !== '/' && (
            <button
              onClick={() => {
                const parent = currentPath.split('/').slice(0, -1).join('/') || '/';
                loadDir(parent);
              }}
              className="w-full px-4 py-2 text-left text-xs font-mono text-slate-400 hover:bg-white/[0.03] flex items-center gap-2 cursor-pointer"
            >
              <Folder className="w-3.5 h-3.5 text-slate-500" />
              <span>.. (返回上级)</span>
            </button>
          )}

          {filteredEntries.map((entry) => {
            const isSelected = openFile?.path === entry.path;
            return (
              <div
                key={entry.path}
                onClick={() => handleOpenFile(entry)}
                className={`group px-4 py-2 flex items-center justify-between gap-2 text-xs cursor-pointer transition-colors ${
                  isSelected ? 'bg-sky-500/12' : 'hover:bg-white/[0.025]'
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1">
                  {entry.isDir ? (
                    <Folder className="w-4 h-4 text-amber-400/85 shrink-0" />
                  ) : (
                    <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                  <span className="font-mono text-slate-200 truncate">{entry.name}</span>
                </div>

                <div className="flex items-center gap-3 shrink-0 font-mono text-[11px] text-slate-500">
                  {!openFile && (
                    <>
                      <span className="hidden md:inline text-[10px]">{entry.mode}</span>
                      <span className="hidden sm:inline w-28 text-right">
                        {formatDateTime(entry.mtime)}
                      </span>
                    </>
                  )}
                  <span className="w-16 text-right">
                    {entry.isDir ? '—' : formatBytes(entry.size, 1)}
                  </span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {!entry.isDir && (
                      <a
                        href={api.downloadUrl(snapshot.server.id, entry.path)}
                        onClick={(e) => e.stopPropagation()}
                        title="下载"
                        className="p-1 text-slate-400 hover:text-sky-300"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </a>
                    )}
                    <button
                      onClick={(e) => handleDelete(entry, e)}
                      title="删除"
                      className="p-1 text-slate-400 hover:text-rose-400 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {loading && entries.length === 0 && (
            <div className="py-12 flex items-center justify-center gap-2 text-xs text-slate-400">
              <Loader2 className="w-4 h-4 animate-spin text-sky-400" />
              <span>正在读取目录...</span>
            </div>
          )}

          {!loading && filteredEntries.length === 0 && (
            <div className="py-12 text-center text-xs text-slate-500">目录为空</div>
          )}
        </div>
      </section>

      {/* Right Split Editor / Preview */}
      {openFile && (
        <section className="lg:col-span-5 bg-[#0c0f16] border border-white/[0.08] rounded-2xl flex flex-col overflow-hidden">
          <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <FileCode2 className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="text-xs font-mono text-white truncate" title={openFile.path}>
                {openFile.path.split('/').pop()}
              </span>
              {isDirty && <span className="w-2 h-2 rounded-full bg-amber-400" title="有未保存更改" />}
              {saveToast && <span className="text-[11px] text-emerald-400">{saveToast}</span>}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {!openFile.binary && !openFile.truncated && (
                <button
                  onClick={handleSaveFile}
                  disabled={savingFile || !isDirty}
                  className="flex items-center gap-1 text-[11px] bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 font-semibold px-2.5 py-1 rounded-lg cursor-pointer"
                >
                  <Save className="w-3 h-3" />
                  <span>{savingFile ? '保存中' : '保存'}</span>
                </button>
              )}
              <a
                href={api.downloadUrl(snapshot.server.id, openFile.path)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white"
                title="下载文件"
              >
                <Download className="w-3.5 h-3.5" />
              </a>
              <button
                onClick={() => setOpenFile(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="px-4 py-1.5 bg-[#090b10] border-b border-white/[0.05] text-[10px] font-mono text-slate-500 flex items-center justify-between">
            <span className="truncate">{openFile.path}</span>
            <span>{formatBytes(openFile.size)}</span>
          </div>

          {loadingFile ? (
            <div className="flex-1 flex items-center justify-center text-xs text-slate-400 gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>加载文件中...</span>
            </div>
          ) : openFile.binary ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
              <div className="text-xs text-slate-400">二进制文件无法直接在线文本编辑</div>
              <a
                href={api.downloadUrl(snapshot.server.id, openFile.path)}
                className="inline-flex items-center gap-1.5 text-xs bg-sky-500/15 border border-sky-400/30 text-sky-300 px-3.5 py-2 rounded-xl"
              >
                <Download className="w-3.5 h-3.5" />
                <span>下载此文件</span>
              </a>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-[460px]">
              {openFile.truncated && (
                <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-300">
                  文件超过 512KB，当前为只读预览前段内容。
                </div>
              )}
              <textarea
                value={openFile.content}
                readOnly={openFile.truncated}
                spellCheck={false}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                    e.preventDefault();
                    handleSaveFile();
                  }
                }}
                onChange={(e) => setOpenFile({ ...openFile, content: e.target.value })}
                className="flex-1 w-full bg-[#07090d] p-4 font-mono text-xs leading-relaxed text-slate-200 focus:outline-none resize-none"
              />
            </div>
          )}
        </section>
      )}
    </div>
  );
};
