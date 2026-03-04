import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface SettingsState {
  apiKey: string;
  downloadPresetPaths: string[];
  setApiKey: (key: string) => void;
  setDownloadPresetPaths: (paths: string[]) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      apiKey: '',
      downloadPresetPaths: [],
      setApiKey: (apiKey) => set({ apiKey }),
      setDownloadPresetPaths: (paths) => {
        const uniquePaths = Array.from(
          new Set(paths.map((path) => path.trim()).filter((path) => path.length > 0))
        ).slice(0, 8);
        set({ downloadPresetPaths: uniquePaths });
      },
    }),
    {
      name: 'settings-storage',
    }
  )
);
