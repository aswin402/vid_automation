import React, { useRef, useState } from 'react';
import {
  UploadCloud,
  Film,
  Image as ImageIcon,
  CheckCircle2,
  Trash2,
  AlertCircle,
  Volume2,
  VolumeX,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { extractApiError, isTauriDesktop, videoApi } from '@/api/videoApi';
import { formatBytes, formatFriendlyDuration } from '@/lib/timecode';
import type { Asset } from '@/types/video';

interface UploadStepProps {
  projectId: string;
  assets: Asset[];
  onAssetsChanged: () => void;
  onNext: () => void;
}

interface DropCardProps {
  kind: 'source' | 'logo' | 'outro';
  title: string;
  badge: string;
  required?: boolean;
  accept: string;
  formatHint: string;
  asset: Asset | undefined;
  projectId: string;
  onUploaded: () => void;
}

const AssetDropCard: React.FC<DropCardProps> = ({
  kind,
  title,
  badge,
  required,
  accept,
  formatHint,
  asset,
  projectId,
  onUploaded,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    setProgress(5);
    try {
      await videoApi.uploadAssetWithSignedUrl(projectId, kind, file, (pct) => {
        setProgress(pct);
      });
      onUploaded();
    } catch (err: unknown) {
      setError(
        extractApiError(
          err,
          'Upload or media verification failed. Please check the file format.'
        )
      );
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const handleSelectClick = async () => {
    if (isTauriDesktop()) {
      setError(null);
      setUploading(true);
      setProgress(35);
      try {
        const imported = await videoApi.pickAndImportLocalAsset(projectId, kind);
        if (imported) {
          onUploaded();
        }
      } catch (err: unknown) {
        setError(
          extractApiError(
            err,
            'Media inspection failed. Please select a valid video or image file.'
          )
        );
      } finally {
        setUploading(false);
        setProgress(0);
      }
      return;
    }
    inputRef.current?.click();
  };

  const handleDelete = async () => {
    if (!asset) return;
    setError(null);
    try {
      await videoApi.deleteAsset(asset.id);
      onUploaded();
    } catch (err: any) {
      setError('Failed to remove asset.');
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) handleFile(f);
      }}
      className={`rounded-2xl border p-5 transition-all flex flex-col justify-between ${
        dragOver
          ? 'border-indigo-500 bg-indigo-500/10'
          : asset?.status === 'ready'
          ? 'border-emerald-500/40 bg-card/90'
          : 'border-border bg-card/60 hover:border-border/90'
      }`}
    >
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="flex items-center gap-2">
            {kind === 'logo' ? (
              <ImageIcon className="h-5 w-5 text-indigo-400" />
            ) : (
              <Film className="h-5 w-5 text-indigo-400" />
            )}
            <h3 className="font-semibold text-sm">{title}</h3>
          </div>
          <span
            className={`text-[11px] font-medium px-2.5 py-0.5 rounded-full ${
              required
                ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {badge}
          </span>
        </div>

        <p className="text-xs text-muted-foreground mb-4">{formatHint}</p>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-xl bg-rose-500/10 border border-rose-500/30 p-3 text-xs text-rose-300 flex items-start gap-2"
          >
            <AlertCircle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {uploading && (
          <div className="mb-4 space-y-2 rounded-xl bg-muted/50 p-3 border border-border">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5 font-medium text-indigo-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {progress < 100 ? 'Uploading via signed URL...' : 'Probing with FFprobe...'}
              </span>
              <span className="font-mono">{progress}%</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all duration-200"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {asset && asset.status === 'ready' && !uploading && (
          <div className="mb-4 rounded-xl bg-muted/40 border border-border p-3.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
                <span className="text-xs font-medium truncate" title={asset.original_filename}>
                  {asset.original_filename}
                </span>
              </div>
              {kind !== 'source' && (
                <button
                  type="button"
                  onClick={handleDelete}
                  aria-label={`Remove ${title}`}
                  className="text-muted-foreground hover:text-rose-400 p-1 rounded-md transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {kind === 'logo' && asset.stream_url && (
              <div className="h-16 rounded-lg bg-black/40 border border-border/60 flex items-center justify-center p-2">
                <img
                  src={asset.stream_url}
                  alt="Uploaded logo preview"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-1.5 text-[11px] text-muted-foreground pt-1">
              <div>
                <span className="text-foreground/70">Dimensions:</span>{' '}
                <span className="font-mono text-foreground">
                  {asset.width}×{asset.height}
                </span>
              </div>
              <div>
                <span className="text-foreground/70">Size:</span>{' '}
                <span className="font-mono text-foreground">{formatBytes(asset.size_bytes)}</span>
              </div>
              {asset.duration_ms && (
                <div>
                  <span className="text-foreground/70">Duration:</span>{' '}
                  <span className="font-mono text-foreground">
                    {formatFriendlyDuration(asset.duration_ms)}
                  </span>
                </div>
              )}
              {kind !== 'logo' && (
                <div className="flex items-center gap-1">
                  {asset.has_audio ? (
                    <>
                      <Volume2 className="h-3 w-3 text-emerald-400" />
                      <span className="text-emerald-400">Audio Ready</span>
                    </>
                  ) : (
                    <>
                      <VolumeX className="h-3 w-3 text-amber-400" />
                      <span className="text-amber-400">No Audio (Auto-pad)</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div>
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
        <button
          type="button"
          disabled={uploading}
          onClick={handleSelectClick}
          className="w-full py-2.5 px-4 rounded-xl border border-dashed border-indigo-500/40 hover:border-indigo-500 bg-indigo-500/5 hover:bg-indigo-500/10 text-xs font-semibold text-indigo-300 flex items-center justify-center gap-2 transition-all cursor-pointer"
        >
          <UploadCloud className="h-4 w-4" />
          {asset?.status === 'ready' ? `Replace ${title}` : `Select or Drop ${title}`}
        </button>
      </div>
    </div>
  );
};

export const UploadStep: React.FC<UploadStepProps> = ({
  projectId,
  assets,
  onAssetsChanged,
  onNext,
}) => {
  const sourceAsset = assets.find((a) => a.kind === 'source' && a.status === 'ready');
  const logoAsset = assets.find((a) => a.kind === 'logo' && a.status === 'ready');
  const outroAsset = assets.find((a) => a.kind === 'outro' && a.status === 'ready');

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h2 className="text-lg font-bold">Step 1: Upload Media Assets</h2>
          <p className="text-xs text-muted-foreground">
            Upload your primary source video along with an optional brand logo and outro clip. All files are verified with FFprobe.
          </p>
        </div>
        <button
          type="button"
          disabled={!sourceAsset}
          onClick={onNext}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-semibold transition-all shadow-sm"
        >
          Continue to Trim
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <AssetDropCard
          kind="source"
          title="Source Video"
          badge="Required"
          required
          accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          formatHint="MP4, MOV, or WebM video up to 500 MB (max 30 minutes). Probed for frame rate, dimensions, and audio."
          asset={sourceAsset}
          projectId={projectId}
          onUploaded={onAssetsChanged}
        />

        <AssetDropCard
          kind="logo"
          title="Brand Logo"
          badge="Optional"
          accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
          formatHint="Transparent PNG, WebP, or JPEG image (16×16 to 4096×4096 px). Applied to the main trimmed segment."
          asset={logoAsset}
          projectId={projectId}
          onUploaded={onAssetsChanged}
        />

        <AssetDropCard
          kind="outro"
          title="Outro Video"
          badge="Optional"
          accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          formatHint="MP4 or MOV outro clip. Automatically normalized to match your main video's resolution, FPS, and audio."
          asset={outroAsset}
          projectId={projectId}
          onUploaded={onAssetsChanged}
        />
      </div>
    </div>
  );
};
