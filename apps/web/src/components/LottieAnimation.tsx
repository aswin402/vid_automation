import React, { useEffect, useState } from 'react';
import Lottie from 'lottie-react';

interface LottieAnimationProps {
  src: string;
  className?: string;
  loop?: boolean;
}

type LottieRenderProps = {
  animationData: Record<string, unknown>;
  loop?: boolean;
};

const LottieModule = Lottie as unknown as
  | React.ComponentType<LottieRenderProps>
  | { default: React.ComponentType<LottieRenderProps> };

const LottieComponent: React.ComponentType<LottieRenderProps> =
  typeof LottieModule === 'function' ? LottieModule : LottieModule.default;

export function LottieAnimation({ src, className, loop = true }: LottieAnimationProps) {
  const [loadedState, setLoadedState] = useState<{
    src: string;
    data: Record<string, unknown> | null;
  }>({ src: '', data: null });

  useEffect(() => {
    let cancelled = false;
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to fetch Lottie JSON: ${res.status}`);
        return res.json() as Promise<Record<string, unknown>>;
      })
      .then((data) => {
        if (!cancelled) {
          setLoadedState({ src, data });
        }
      })
      .catch((err) => {
        console.error('Failed to load Lottie animation from URL:', src, err);
        if (!cancelled) {
          setLoadedState({ src, data: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  const isLoading = loadedState.src !== src;
  const animationData = loadedState.src === src ? loadedState.data : null;

  if (isLoading || !animationData) {
    return (
      <div
        className={`w-full h-full min-h-[200px] flex items-center justify-center rounded-2xl bg-muted/20 animate-pulse ${className || ''}`}
      />
    );
  }

  return (
    <div className={className}>
      <LottieComponent animationData={animationData} loop={loop} />
    </div>
  );
}
