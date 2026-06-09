import type { ActiveWindowInfo, LoginResponse, ScreenCapture, TrackerData, TrackingSelection } from './types';

export const API_BASE_URL = 'https://www.va4hire.ph/app/api/';

type HeartbeatInput = {
  authtoken: string;
  trackerId?: number;
  selection: TrackingSelection;
  timeInOut: 0 | 1;
  idleStatus: number;
  remark: string;
  keystroke: number;
  mouseclick: number;
  mousemove: number;
  activeWindow: ActiveWindowInfo;
};

export async function login(userName: string, password: string): Promise<LoginResponse> {
  return window.desktopApi.apiRequest<LoginResponse>({
    method: 'POST',
    path: 'login/',
    bodyType: 'form',
    body: {
      user_name: userName,
      password,
    },
  });
}

export async function pingApi(): Promise<boolean> {
  try {
    if (window.desktopApi.pingApi) {
      const result = await window.desktopApi.pingApi();
      return Boolean(result.ok);
    }
    const result = await window.desktopApi.apiRequest<{ network_error?: boolean }>({ path: 'data/' });
    return !result.network_error;
  } catch {
    return false;
  }
}

export async function getTrackerData(authtoken: string): Promise<TrackerData> {
  return window.desktopApi.apiRequest<TrackerData>({
    path: 'data/',
    query: { authtoken },
  });
}

type UnrelatedDetectionInput = {
  authtoken: string;
  trackerId?: number;
  selection: TrackingSelection;
  keywords: string[];
  activeWindow: ActiveWindowInfo;
  keystroke?: number;
  mouseclick?: number;
  mousemove?: number;
};

export async function postUnrelatedDetection(input: UnrelatedDetectionInput) {
  return postHeartbeat({
    authtoken: input.authtoken,
    trackerId: input.trackerId,
    selection: input.selection,
    timeInOut: 1,
    idleStatus: 0,
    remark: `UNRELATED:${input.keywords.join(',')}`,
    keystroke: input.keystroke ?? 0,
    mouseclick: input.mouseclick ?? 0,
    mousemove: input.mousemove ?? 0,
    activeWindow: input.activeWindow,
  });
}

export async function postHeartbeat(input: HeartbeatInput) {
  const trackerId = input.trackerId ?? 0;

  return window.desktopApi.apiRequest<{
    message?: string;
    id?: number;
    time_in_out?: number;
    hours_work_today?: string;
    interval_send_data?: number;
    interval_send_screen_capture?: number;
    error_va_code?: number;
    error_message?: string;
  }>({
    method: 'POST',
    path: 'postdata/',
    query: { authtoken: input.authtoken },
    bodyType: 'form',
    body: {
      'Timetracker[id]': trackerId,
      'Timetracker[task_id]': input.selection.task.id,
      'Timetracker[time_in_out]': input.timeInOut,
      'Timetracker[u_lat]': '0',
      'Timetracker[u_long]': '0',
      'Timetracker[idle_status]': input.idleStatus,
      'Timetracker[remark]': input.remark,
      'Process[process_id]': input.activeWindow.processId,
      'Process[window_handle]': input.activeWindow.windowHandle,
      'Process[window_title]': input.activeWindow.windowTitle,
      'Process[module_name]': input.activeWindow.moduleName,
      'Process[module_filename]': input.activeWindow.moduleFilename,
      'Process[mem_usage]': input.activeWindow.memoryUsage,
      'Process[paged_memorysize]': input.activeWindow.pagedMemorySize,
    },
  });
}

export async function uploadScreenshot(params: {
  authtoken: string;
  trackerId: number;
  capture: ScreenCapture;
  keystroke: number;
  mouseclick: number;
  mousemove: number;
}) {
  return window.desktopApi.apiRequest({
    method: 'POST',
    path: 'postdata/',
    query: {
      authtoken: params.authtoken,
      type: 'capture',
      tracker_id: params.trackerId,
      keystroke: params.keystroke,
      mouseclick: params.mouseclick,
      mousemove: params.mousemove,
    },
    bodyType: 'multipart',
    file: params.capture,
  });
}

export async function addTask(authtoken: string, projectId: number | string, title: string) {
  return window.desktopApi.apiRequest<{
    message?: string;
    id?: number;
    error_va_code?: number;
    error_message?: string;
  }>({
    method: 'POST',
    path: 'addtask/',
    query: { authtoken },
    bodyType: 'form',
    body: {
      'Task[project_id]': String(projectId),
      'Task[title]': title,
    },
  });
}

export async function updateTaskStatus(authtoken: string, taskId: number | string, status: number) {
  return window.desktopApi.apiRequest<{
    message?: string;
    error_va_code?: number;
    error_message?: string;
  }>({
    method: 'POST',
    path: 'updatetask/',
    query: { authtoken },
    bodyType: 'form',
    body: {
      'Task[id][]': String(taskId),
      'Task[status][]': String(status),
    },
  });
}
