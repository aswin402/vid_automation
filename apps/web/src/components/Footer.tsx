import React from 'react';
import { useLocation } from 'react-router-dom';

export const Footer: React.FC = () => {
  const { pathname } = useLocation();
  const isStudioRoute =
    pathname.startsWith('/batches/') || pathname.startsWith('/projects/');

  if (isStudioRoute) {
    return null;
  }

  return (
    <footer className="border-t border-border/60 py-4 text-[11px] text-muted-foreground">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between gap-2">
        <span>CelestiaVid</span>
        <span className="font-mono">FFmpeg · Whisper · Local-first</span>
      </div>
    </footer>
  );
};
