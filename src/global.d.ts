import type { ActiveWindowInfo, ScreenCapture } from './types';

declare global {
  interface Window {
    desktopApi: {
      getIdleSeconds: () => Promise<number>;
      captureScreen: () => Promise<ScreenCapture | null>;
      getActiveWindow: () => Promise<ActiveWindowInfo>;
      apiRequest: <T>(request: {
        method?: 'GET' | 'POST';
        path: string;
        query?: Record<string, string | number>;
        bodyType?: 'form' | 'multipart';
        body?: Record<string, string | number>;
        fields?: Record<string, string | number>;
        file?: ScreenCapture;
      }) => Promise<T>;
      log: (payload: { level?: string; message?: string; [k: string]: any }) => void;
      onGlobalInput: (cb: (payload: { type: string }) => void) => void;
    };
  }
}

export {};
