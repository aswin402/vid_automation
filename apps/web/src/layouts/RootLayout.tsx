import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Navbar } from '@/components/Navbar';
import { Footer } from '@/components/Footer';
import { ThemeProvider } from '@/components/ThemeProvider';
import { TooltipProvider } from '@/components/ui/tooltip';
import Lenis from 'lenis';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

export function RootLayout() {
  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: true,
    });
    lenis.on('scroll', ScrollTrigger.update);
    return () => {
      lenis.destroy();
    };
  }, []);

  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={180}>
        <div className="min-h-screen flex flex-col bg-background text-foreground transition-colors duration-200">
          <Navbar />
          <main className="pt-14 flex-grow">
            <Outlet />
          </main>
          <Footer />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}
