export type LoginResponse =
  | {
      id: number;
      user_name: string;
      user_auth_key: string;
      first_name: string;
      last_name: string;
      success_message: string;
    }
  | {
      error_va: number;
      error_message: string;
    };

export type Task = {
  id: number;
  title: string;
  status: number;
  project_id: number;
  task_total_hours?: string;
  task_total_hours_today?: string;
};

export type Project = {
  id: number;
  title: string;
  user_id: number;
  tasks?: Record<string, Task>;
  tasks_completed?: Record<string, Task>;
};

export type Employer = {
  emp_id: number;
  company_name: string;
  company_time: string;
  worker_site_visit?: number;
  worker_app_process?: number;
  projects?: Record<string, Project>;
};

export type TrackerData = {
  id: number;
  user_name: string;
  user_auth_key: string;
  first_name: string;
  last_name: string;
  title?: string;
  profile_url?: string;
  hours_work_today?: string;
  interval_send_data?: number;
  interval_send_screen_capture?: number;
  minute_idle_time?: number;
  employers?: Record<string, Employer> | null;
  error_va_code?: number;
  error_message?: string;
};

export type TrackingSelection = {
  employer: Employer;
  project: Project;
  task: Task;
};

export type ActiveWindowInfo = {
  processId: number;
  windowHandle: string;
  windowTitle: string;
  moduleName: string;
  moduleFilename: string;
  memoryUsage: number;
  pagedMemorySize: number;
};

export type ScreenCapture = {
  filename: string;
  mimeType: string;
  dataUrl: string;
};

declare global {
  interface Window {
    desktopApi: {
      getIdleSeconds: () => Promise<number>;
      captureScreen: () => Promise<ScreenCapture | null>;
      getActiveWindow: () => Promise<ActiveWindowInfo>;
      apiRequest: <T = any>(request: any) => Promise<T>;
      log: (payload: { level?: string; message: string }) => void;
      onGlobalInput: (cb: (payload: { type: string }) => void) => void;
      openExternal?: (url: string) => Promise<any>;
      pingApi?: () => Promise<{ ok: boolean; status?: number; error?: string }>;
    };
  }
}

export type ConnectionStatus = 'connected' | 'offline' | 'checking';
