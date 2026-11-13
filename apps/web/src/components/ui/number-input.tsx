import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NumberInputProps {
  value: number | '';
  onValueChange: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  fallbackValue?: number;
  allowEmpty?: boolean;
  size?: 'default' | 'sm';
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

function getStepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const str = step.toString();
  if (str.includes('e-')) {
    const [, exp] = str.split('e-');
    return Math.min(6, Number(exp) || 0);
  }
  const dotIdx = str.indexOf('.');
  return dotIdx === -1 ? 0 : Math.min(6, str.length - dotIdx - 1);
}

function roundToStep(val: number, step: number): number {
  const decimals = getStepDecimals(step);
  return Number(val.toFixed(decimals));
}

export function NumberInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  fallbackValue,
  allowEmpty = false,
  size = 'default',
  placeholder,
  ariaLabel,
  id,
  disabled = false,
  className,
}: NumberInputProps) {
  const [draftText, setDraftText] = React.useState<string | null>(null);

  const displayedText =
    draftText !== null ? draftText : value === '' ? '' : String(value);

  const clampValue = (n: number): number => {
    let next = n;
    if (min !== undefined && next < min) next = min;
    if (max !== undefined && next > max) next = max;
    return roundToStep(next, step);
  };

  const stepBy = (direction: 1 | -1) => {
    if (disabled) return;
    const base =
      typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallbackValue ?? min ?? 0;
    const next = clampValue(base + direction * step);
    setDraftText(null);
    onValueChange(next);
  };

  const commitText = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) {
      setDraftText(null);
      if (allowEmpty) {
        onValueChange(null);
      } else {
        onValueChange(clampValue(fallbackValue ?? min ?? 0));
      }
      return;
    }
    const parsed = Number(trimmed);
    setDraftText(null);
    if (Number.isFinite(parsed)) {
      onValueChange(clampValue(parsed));
    }
  };

  const numericCurrent =
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const atMax =
    disabled || (max !== undefined && numericCurrent !== null && numericCurrent >= max);
  const atMin =
    disabled || (min !== undefined && numericCurrent !== null && numericCurrent <= min);

  const isSmall = size === 'sm';

  return (
    <div
      className={cn(
        'group/num inline-flex w-full items-stretch overflow-hidden rounded-lg border border-border bg-card transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/30',
        isSmall ? 'h-6 rounded-md' : 'h-8',
        disabled && 'opacity-50 pointer-events-none',
        className
      )}
    >
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={displayedText}
        onChange={(e) => {
          const raw = e.target.value;
          setDraftText(raw);
          const trimmed = raw.trim();
          if (!trimmed) {
            if (allowEmpty) onValueChange(null);
            return;
          }
          const parsed = Number(trimmed);
          if (Number.isFinite(parsed)) {
            onValueChange(clampValue(parsed));
          }
        }}
        onBlur={() => {
          if (draftText !== null) {
            commitText(draftText);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            stepBy(1);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            stepBy(-1);
          } else if (e.key === 'Enter' && draftText !== null) {
            commitText(draftText);
          }
        }}
        className={cn(
          'min-w-0 flex-1 bg-transparent font-mono tabular-nums text-foreground placeholder:text-muted-foreground focus:outline-none',
          isSmall ? 'px-1.5 text-[10px]' : 'px-2.5 text-xs'
        )}
      />

      <div className="flex flex-col shrink-0 border-l border-border bg-primary/10">
        <button
          type="button"
          tabIndex={-1}
          disabled={atMax}
          onClick={() => stepBy(1)}
          aria-label="Increment value"
          className={cn(
            'flex flex-1 items-center justify-center border-b border-border/80 text-primary transition-colors hover:bg-primary hover:text-primary-foreground active:bg-primary/85 disabled:opacity-30 disabled:pointer-events-none',
            isSmall ? 'w-4' : 'w-6'
          )}
        >
          <ChevronUp className={isSmall ? 'h-2.5 w-2.5 stroke-[2.5]' : 'h-3 w-3 stroke-[2.5]'} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          disabled={atMin}
          onClick={() => stepBy(-1)}
          aria-label="Decrement value"
          className={cn(
            'flex flex-1 items-center justify-center text-primary transition-colors hover:bg-primary hover:text-primary-foreground active:bg-primary/85 disabled:opacity-30 disabled:pointer-events-none',
            isSmall ? 'w-4' : 'w-6'
          )}
        >
          <ChevronDown className={isSmall ? 'h-2.5 w-2.5 stroke-[2.5]' : 'h-3 w-3 stroke-[2.5]'} />
        </button>
      </div>
    </div>
  );
}
