import { useEffect, useRef, useState } from 'react';
import { Player } from '@lordicon/react';
import { useThemeStore } from '@/store/useThemeStore';

interface LordIconProps {
  src: string;
  size?: number;
  trigger?: 'hover' | 'click' | 'loop';
  colors?: string; // e.g. "primary:currentColor,secondary:var(--color-primary)"
  className?: string;
  delay?: number;
}

// Convert any browser-resolved CSS color string (oklch, color(), hsl, rgb) to hex format using a 1x1 canvas
function resolveToHex(colorStr: string, container: HTMLElement): string {
  const temp = document.createElement('div');
  temp.style.color = colorStr;
  container.appendChild(temp);
  const computedColor = window.getComputedStyle(temp).color;
  container.removeChild(temp);

  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '#000000';

  ctx.fillStyle = computedColor;
  ctx.fillRect(0, 0, 1, 1);

  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

export function LordIcon({
  src,
  size = 32,
  trigger = 'hover',
  colors = 'primary:currentColor,secondary:var(--color-primary)',
  className,
  delay = 0,
}: LordIconProps) {
  const playerRef = useRef<Player>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loadedState, setLoadedState] = useState<{
    src: string;
    data: Record<string, unknown> | null;
  }>({ src: '', data: null });
  const [resolvedColors, setResolvedColors] = useState<string | undefined>(undefined);

  const { theme } = useThemeStore();

  const isLoading = loadedState.src !== src;
  const iconData = loadedState.src === src ? loadedState.data : null;

  useEffect(() => {
    let cancelled = false;
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
        return res.json() as Promise<Record<string, unknown>>;
      })
      .then((data) => {
        if (!cancelled) {
          setLoadedState({ src, data });
        }
      })
      .catch((err) => {
        console.error('Failed to load lordicon from url:', src, err);
        if (!cancelled) {
          setLoadedState({ src, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(() => {
    if (!colors || isLoading || !containerRef.current) {
      return;
    }

    const container = containerRef.current;
    const timer = setTimeout(() => {
      const parts = colors.split(',');
      const resolvedParts = parts.map((part) => {
        const [key, value] = part.split(':');
        if (!key || !value) return part;

        const hexColor = resolveToHex(value.trim(), container);
        return `${key}:${hexColor}`;
      });

      setResolvedColors(resolvedParts.join(','));
    }, 50);

    return () => clearTimeout(timer);
  }, [colors, isLoading, theme]);

  useEffect(() => {
    if (!isLoading && iconData && trigger === 'loop') {
      const timer = setTimeout(() => {
        playerRef.current?.play();
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [isLoading, iconData, trigger, delay]);

  const handleMouseEnter = () => {
    if (trigger === 'hover' && !isLoading && playerRef.current) {
      playerRef.current.playFromBeginning();
    }
  };

  const handleClick = () => {
    if (trigger === 'click' && !isLoading && playerRef.current) {
      playerRef.current.playFromBeginning();
    }
  };

  if (isLoading || !iconData) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`inline-flex items-center justify-center rounded-full bg-muted/20 animate-pulse ${className || ''}`}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onClick={handleClick}
      style={{ width: size, height: size }}
      className={`inline-flex items-center justify-center cursor-pointer transition-transform duration-200 hover:scale-110 active:scale-95 ${className || ''}`}
    >
      <Player
        ref={playerRef}
        icon={iconData}
        size={size}
        colors={resolvedColors ?? colors}
        onComplete={() => {
          if (trigger === 'loop' && playerRef.current) {
            playerRef.current.play();
          }
        }}
      />
    </div>
  );
}
