import React from 'react';
import type { AnchorPosition } from '@/types/video';

const POSITIONS: Array<{ id: AnchorPosition; label: string }> = [
  { id: 'top-left', label: 'Top Left' },
  { id: 'top-center', label: 'Top Center' },
  { id: 'top-right', label: 'Top Right' },
  { id: 'middle-left', label: 'Middle Left' },
  { id: 'center', label: 'Center' },
  { id: 'middle-right', label: 'Middle Right' },
  { id: 'bottom-left', label: 'Bottom Left' },
  { id: 'bottom-center', label: 'Bottom Center' },
  { id: 'bottom-right', label: 'Bottom Right' },
];

interface PositionGridPickerProps {
  value: AnchorPosition;
  customCoordinatesActive?: boolean;
  onChange: (pos: AnchorPosition) => void;
  label?: string;
}

export const PositionGridPicker: React.FC<PositionGridPickerProps> = ({
  value,
  customCoordinatesActive = false,
  onChange,
  label = '9-Anchor Position Grid',
}) => {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-xs font-mono text-indigo-400">
          {customCoordinatesActive ? 'Custom Drag' : value}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid grid-cols-3 gap-1.5 p-2 rounded-xl bg-muted/40 border border-border w-36"
      >
        {POSITIONS.map((pos) => {
          const selected = !customCoordinatesActive && value === pos.id;
          return (
            <button
              key={pos.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={pos.label}
              title={pos.label}
              onClick={() => onChange(pos.id)}
              className={`h-8 rounded-lg flex items-center justify-center border transition-all ${
                selected
                  ? 'bg-indigo-600 border-indigo-400 text-white shadow-sm'
                  : 'bg-card/70 border-border/60 hover:border-indigo-500/50 text-muted-foreground'
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${
                  selected ? 'bg-white' : 'bg-muted-foreground/50'
                }`}
              />
            </button>
          );
        })}
      </div>
    </div>
  );
};
