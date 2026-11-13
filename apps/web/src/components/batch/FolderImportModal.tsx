import React, { useMemo, useRef, useState } from 'react';
import {
  FolderOpen,
  Film,
  CheckSquare,
  Square,
  Upload,
  HardDrive,
  Search,
  Loader2,
  X,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { extractApiError, isTauriDesktop, videoApi } from '@/api/videoApi';
import type { BatchDetail, ScannedFolderItem } from '@/types/video';

interface BrowserDiscoveredVideo {
  id: string;
  file: File;
  relativePath: string;
  sizeBytes: number;
  selected: boolean;
}

interface ScannedSelectableVideo extends ScannedFolderItem {
  selected: boolean;
}

interface FolderImportModalProps {
  batchId: string;
  onClose: () => void;
  onImported: (updatedBatch?: BatchDetail) => void;
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm', 'mkv', 'm4v']);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isSupportedVideoFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return VIDEO_EXTENSIONS.has(ext);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const FolderImportModal: React.FC<FolderImportModalProps> = ({
  batchId,
  onClose,
  onImported,
}) => {
  const desktopMode = isTauriDesktop();
  const [mode, setMode] = useState<'browser' | 'local_path'>(
    desktopMode ? 'local_path' : 'browser'
  );

  // Browser folder picker state
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const [browserFiles, setBrowserFiles] = useState<BrowserDiscoveredVideo[]>([]);
  const [uploadingBrowser, setUploadingBrowser] = useState(false);
  const [uploadProgressText, setUploadProgressText] = useState<string | null>(null);

  // Local path zero-copy scan state
  const [folderPath, setFolderPath] = useState('');
  const [recursiveScan, setRecursiveScan] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scannedItems, setScannedItems] = useState<ScannedSelectableVideo[]>([]);
  const [importingLocal, setImportingLocal] = useState(false);

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleBrowserFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    const list = e.target.files;
    if (!list || list.length === 0) return;

    const discovered: BrowserDiscoveredVideo[] = [];
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      if (!f || f.size === 0 || f.name.startsWith('.')) continue;
      if (!isSupportedVideoFile(f.name)) continue;
      const rel =
        (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      discovered.push({
        id: `${rel}-${f.size}-${i}`,
        file: f,
        relativePath: rel,
        sizeBytes: f.size,
        selected: true,
      });
    }

    discovered.sort((a, b) => collator.compare(a.relativePath, b.relativePath));
    setBrowserFiles(discovered);
    if (discovered.length === 0) {
      setErrorMsg(
        'No supported video files (.mp4, .mov, .webm, .mkv, .m4v) were found in that folder.'
      );
    }
    e.target.value = '';
  };

  const handleScanLocalPath = async (overridePath?: string) => {
    const target = (overridePath ?? folderPath).trim();
    if (!target) {
      setErrorMsg('Enter or choose a folder path to scan.');
      return;
    }
    setErrorMsg(null);
    setScanning(true);
    try {
      const resp = await videoApi.scanLocalFolder(target, recursiveScan, 'source');
      const videosOnly: ScannedSelectableVideo[] = resp.items
        .filter((item) => isSupportedVideoFile(item.filename))
        .map((item) => ({
          ...item,
          selected: true,
        }));
      setScannedItems(videosOnly);
      if (videosOnly.length === 0) {
        setErrorMsg(
          'No supported video files (.mp4, .mov, .webm, .mkv, .m4v) were found in that folder.'
        );
      }
    } catch (err) {
      setErrorMsg(extractApiError(err, 'Failed to scan folder.'));
    } finally {
      setScanning(false);
    }
  };

  const handleBrowseNativeFolder = async () => {
    const picked = await videoApi.pickLocalFolderPath('Select Videos Folder');
    if (picked) {
      setFolderPath(picked);
      await handleScanLocalPath(picked);
    }
  };

  const selectedBrowserFiles = useMemo(
    () => browserFiles.filter((f) => f.selected),
    [browserFiles]
  );

  const selectedScannedItems = useMemo(
    () => scannedItems.filter((f) => f.selected),
    [scannedItems]
  );

  const selectedTotal =
    mode === 'browser' ? selectedBrowserFiles.length : selectedScannedItems.length;

  const handleImportBrowserSelection = async () => {
    if (selectedBrowserFiles.length === 0) return;
    setErrorMsg(null);
    setUploadingBrowser(true);
    try {
      for (let i = 0; i < selectedBrowserFiles.length; i += 1) {
        const entry = selectedBrowserFiles[i];
        setUploadProgressText(
          `Importing video ${i + 1} of ${selectedBrowserFiles.length}: ${entry.file.name}`
        );
        await videoApi.uploadBatchPoolAsset(batchId, 'source', entry.file);
      }
      const updated = await videoApi.getBatch(batchId);
      onImported(updated);
      onClose();
    } catch (err) {
      setErrorMsg(extractApiError(err, 'Failed while importing videos from folder.'));
    } finally {
      setUploadingBrowser(false);
      setUploadProgressText(null);
    }
  };

  const handleImportLocalSelection = async () => {
    if (selectedScannedItems.length === 0) return;
    setErrorMsg(null);
    setImportingLocal(true);
    try {
      const resp = await videoApi.importFolderItemsToBatch(
        batchId,
        selectedScannedItems.map((i) => ({ path: i.path, kind: 'source' }))
      );
      if (resp.skipped_errors.length > 0 && resp.imported_count === 0) {
        setErrorMsg(resp.skipped_errors.join(' | '));
        return;
      }
      onImported(resp.batch);
      onClose();
    } catch (err) {
      setErrorMsg(extractApiError(err, 'Failed to import selected videos.'));
    } finally {
      setImportingLocal(false);
    }
  };

  const directoryInputProps = {
    webkitdirectory: '',
    directory: '',
  } as unknown as React.InputHTMLAttributes<HTMLInputElement>;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[88vh] rounded-3xl bg-card border border-indigo-500/35 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-2xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <FolderOpen className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold">Import Multiple Videos from Folder</h2>
              <p className="text-xs text-muted-foreground">
                Select which videos from the folder to add into your batch queue
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl hover:bg-muted text-muted-foreground hover:text-foreground"
            aria-label="Close modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {/* Source Mode Switch */}
          <div className="inline-flex p-1 rounded-xl bg-muted border border-border">
            <button
              type="button"
              onClick={() => setMode('browser')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                mode === 'browser'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              Pick Folder
            </button>
            <button
              type="button"
              onClick={() => setMode('local_path')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                mode === 'local_path'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <HardDrive className="h-3.5 w-3.5" />
              Local Folder Path
            </button>
          </div>

          {mode === 'browser' ? (
            <div className="space-y-4">
              <input
                ref={folderInputRef}
                type="file"
                multiple
                onChange={handleBrowserFolderChange}
                className="hidden"
                {...directoryInputProps}
              />

              <div className="rounded-2xl border-2 border-dashed border-indigo-500/35 bg-indigo-950/15 p-6 text-center space-y-2.5">
                <FolderOpen className="h-7 w-7 text-indigo-400 mx-auto" />
                <p className="text-xs text-muted-foreground">
                  Choose any folder containing MP4, MOV, WebM, MKV, or M4V clips
                </p>
                <button
                  type="button"
                  onClick={() => folderInputRef.current?.click()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm cursor-pointer"
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Choose Videos Folder...
                </button>
              </div>

              {browserFiles.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setBrowserFiles((prev) =>
                            prev.map((f) => ({ ...f, selected: true }))
                          )
                        }
                        className="inline-flex items-center gap-1 text-indigo-400 hover:underline font-medium"
                      >
                        <CheckSquare className="h-3.5 w-3.5" />
                        Select All ({browserFiles.length})
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setBrowserFiles((prev) =>
                            prev.map((f) => ({ ...f, selected: false }))
                          )
                        }
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <Square className="h-3.5 w-3.5" />
                        None
                      </button>
                    </div>
                    <span className="font-mono text-muted-foreground">
                      {selectedBrowserFiles.length} selected
                    </span>
                  </div>

                  <div className="rounded-2xl border border-border divide-y divide-border/60 max-h-60 overflow-y-auto bg-background/50">
                    {browserFiles.map((item) => (
                      <label
                        key={item.id}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-muted/30 cursor-pointer"
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={item.selected}
                            onChange={(e) =>
                              setBrowserFiles((prev) =>
                                prev.map((f) =>
                                  f.id === item.id
                                    ? { ...f, selected: e.target.checked }
                                    : f
                                )
                              )
                            }
                            className="rounded border-border text-indigo-600"
                          />
                          <Film className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                          <span className="truncate font-medium">
                            {item.relativePath}
                          </span>
                        </span>
                        <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                          {formatBytes(item.sizeBytes)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3.5">
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={folderPath}
                  onChange={(e) => setFolderPath(e.target.value)}
                  placeholder="e.g. ./sample or /home/user/Videos/campaign"
                  className="flex-1 rounded-xl bg-background border border-border px-3.5 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                {desktopMode && (
                  <button
                    type="button"
                    onClick={handleBrowseNativeFolder}
                    className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-xl bg-muted hover:bg-muted/80 border border-border text-xs font-semibold"
                  >
                    <FolderOpen className="h-3.5 w-3.5 text-indigo-400" />
                    Browse...
                  </button>
                )}
                <button
                  type="button"
                  disabled={scanning}
                  onClick={() => handleScanLocalPath()}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer"
                >
                  {scanning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Search className="h-3.5 w-3.5" />
                  )}
                  Scan Folder
                </button>
              </div>

              <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={recursiveScan}
                  onChange={(e) => setRecursiveScan(e.target.checked)}
                  className="rounded border-border text-indigo-600"
                />
                Include nested subfolders
              </label>

              {scannedItems.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() =>
                          setScannedItems((prev) =>
                            prev.map((f) => ({ ...f, selected: true }))
                          )
                        }
                        className="inline-flex items-center gap-1 text-indigo-400 hover:underline font-medium"
                      >
                        <CheckSquare className="h-3.5 w-3.5" />
                        Select All ({scannedItems.length})
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setScannedItems((prev) =>
                            prev.map((f) => ({ ...f, selected: false }))
                          )
                        }
                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                      >
                        <Square className="h-3.5 w-3.5" />
                        None
                      </button>
                    </div>
                    <span className="font-mono text-muted-foreground">
                      {selectedScannedItems.length} selected
                    </span>
                  </div>

                  <div className="rounded-2xl border border-border divide-y divide-border/60 max-h-60 overflow-y-auto bg-background/50">
                    {scannedItems.map((item) => (
                      <label
                        key={item.path}
                        className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs hover:bg-muted/30 cursor-pointer"
                      >
                        <span className="flex items-center gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            checked={item.selected}
                            onChange={(e) =>
                              setScannedItems((prev) =>
                                prev.map((f) =>
                                  f.path === item.path
                                    ? { ...f, selected: e.target.checked }
                                    : f
                                )
                              )
                            }
                            className="rounded border-border text-indigo-600"
                          />
                          <Film className="h-3.5 w-3.5 text-indigo-400 shrink-0" />
                          <span className="truncate font-medium" title={item.path}>
                            {item.relative_path}
                          </span>
                        </span>
                        <span className="text-[11px] text-muted-foreground font-mono shrink-0">
                          {formatBytes(item.size_bytes)}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {uploadProgressText && (
            <div className="rounded-xl bg-indigo-500/10 border border-indigo-500/30 p-3 flex items-center gap-2.5 text-xs text-indigo-300">
              <Loader2 className="h-4 w-4 animate-spin shrink-0" />
              <span>{uploadProgressText}</span>
            </div>
          )}

          {errorMsg && (
            <div className="rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 flex items-center gap-2 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border bg-muted/30 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-indigo-300 font-semibold">
            <Film className="h-3.5 w-3.5" />
            {selectedTotal} video{selectedTotal === 1 ? '' : 's'} ready to import
          </span>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl border border-border text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selectedTotal === 0 || uploadingBrowser || importingLocal}
              onClick={
                mode === 'browser'
                  ? handleImportBrowserSelection
                  : handleImportLocalSelection
              }
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-bold shadow-md cursor-pointer"
            >
              {uploadingBrowser || importingLocal ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Importing...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  Import Videos ({selectedTotal})
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
