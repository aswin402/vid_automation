import React from 'react';
import { HintTooltip } from '@/components/ui/tooltip';
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
  label = 'Anchor',
}) => {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-[11px] font-mono text-primary">
          {customCoordinatesActive ? 'custom x/y' : value}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={label}
        className="grid grid-cols-3 gap-1 p-1.5 rounded-xl bg-muted/50 border border-border w-32"
      >
        {POSITIONS.map((pos) => {
          const selected = !customCoordinatesActive && value === pos.id;
          return (
            <HintTooltip
              key={pos.id}
              label={`Snap ${pos.label}`}
              side="top"
            >
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={pos.label}
                onClick={() => onChange(pos.id)}
                className={`h-7 rounded-md flex items-center justify-center border transition-all ${
                  selected
                    ? 'bg-primary border-primary text-primary-foreground shadow-xs'
                    : 'bg-card border-border/70 hover:border-primary/50 text-muted-foreground'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    selected ? 'bg-primary-foreground' : 'bg-muted-foreground/50'
                  }`}
                />
              </button>
            </HintTooltip>
          );
        })}
      </div>
    </div>
  );
};
