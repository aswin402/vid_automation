import React from 'react';

export const Footer: React.FC = () => {
  return (
    <footer className="border-t border-border/60 py-4 px-6 text-center text-xs text-muted-foreground bg-card/30">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2">
        <span>CelestiaVid AI Video Automation Platform · Guided FFmpeg & ASS Subtitle Pipeline</span>
        <span className="font-mono text-[11px]">MP4 (H.264 / AAC / libass)</span>
      </div>
    </footer>
  );
};
