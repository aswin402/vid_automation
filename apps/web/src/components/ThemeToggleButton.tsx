import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HintTooltip } from '@/components/ui/tooltip';
import { useThemeStore } from '../store/useThemeStore';

export function ThemeToggleButton() {
  const { theme, setTheme } = useThemeStore();

  const cycleTheme = () => {
    setTheme(theme === 'light' ? 'dark' : 'light');
  };

  return (
    <HintTooltip
      label={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
      detail="60-30-10 studio palette"
      side="bottom"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={cycleTheme}
        aria-label="Toggle color theme"
        className="relative text-muted-foreground hover:text-foreground"
      >
        <Sun
          className={`h-4 w-4 transition-all ${
            theme === 'light' ? 'rotate-0 scale-100' : 'rotate-90 scale-0'
          }`}
        />
        <Moon
          className={`absolute h-4 w-4 transition-all ${
            theme === 'dark' ? 'rotate-0 scale-100' : '-rotate-90 scale-0'
          }`}
        />
      </Button>
    </HintTooltip>
  );
}
