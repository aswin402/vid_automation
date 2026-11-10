import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Clapperboard, LayoutGrid } from 'lucide-react';
import { ThemeToggleButton } from './ThemeToggleButton';

export const Navbar: React.FC = () => {
  const location = useLocation();

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-16 bg-background/85 backdrop-blur-md border-b border-border">
      <div className="max-w-7xl mx-auto h-full px-4 sm:px-6 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="h-9 w-9 rounded-xl bg-indigo-600 flex items-center justify-center text-white shadow-sm group-hover:bg-indigo-500 transition-colors">
            <Clapperboard className="h-5 w-5" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight block leading-none">
              CelestiaVid Studio
            </span>
            <span className="text-[10px] text-muted-foreground font-mono">
              AI Video Automation Platform
            </span>
          </div>
        </Link>

        <div className="flex items-center gap-3">
          <Link
            to="/"
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              location.pathname === '/'
                ? 'bg-indigo-600/15 text-indigo-400 border border-indigo-500/30'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Projects Dashboard
          </Link>
          <ThemeToggleButton />
        </div>
      </div>
    </header>
  );
};
