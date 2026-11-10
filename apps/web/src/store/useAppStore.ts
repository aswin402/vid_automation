import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface AppState {
  user: { name: string; email: string } | null;
  setUser: (user: { name: string; email: string } | null) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      user: null,
      setUser: (user) => set({ user }),
      isLoading: false,
      setIsLoading: (isLoading) => set({ isLoading }),
    }),
    {
      name: 'app-storage',
    }
  )
);
