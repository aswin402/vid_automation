/**
 * Formats integer milliseconds into HH:MM:SS.mmm or MM:SS.mmm using Euclidean division.
 */
export function formatTimecode(ms: number | null | undefined, includeHours = false): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) {
    return includeHours ? '00:00:00.000' : '00:00.000';
  }
  const clamped = Math.max(0, Math.round(ms));
  const millis = clamped % 1000;
  const totalSec = Math.floor(clamped / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hours = Math.floor(totalMin / 60);

  const mm = String(min).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  if (includeHours || hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}.${mmm}`;
  }
  return `${mm}:${ss}.${mmm}`;
}

/**
 * Formats milliseconds into a human-friendly short duration e.g. "1m 24.5s" or "12.4s"
 */
export function formatFriendlyDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '0.0s';
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    return `${totalSec.toFixed(1)}s`;
  }
  const mins = Math.floor(totalSec / 60);
  const remSec = (totalSec % 60).toFixed(1);
  return `${mins}m ${remSec}s`;
}

/**
 * Parses a sexagesimal timecode string (HH:MM:SS.mmm, MM:SS.mmm, or SS.mmm)
 * into integer milliseconds using Horner's polynomial evaluation in base 60:
 *   seconds = (...((p_0 * 60 + p_1) * 60 + p_2)...)
 */
export function parseTimecodeToMs(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(':');
  if (parts.length === 0 || parts.length > 3) return null;

  const numericParts = parts.map((p) => (p.trim() === '' ? Number.NaN : Number(p)));
  if (numericParts.some((n) => Number.isNaN(n) || n < 0)) {
    return null;
  }

  const totalSeconds = numericParts.reduce((acc, val) => acc * 60 + val, 0);
  return Math.round(totalSeconds * 1000);
}

/**
 * Formats byte counts using base-1024 logarithmic scaling.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
