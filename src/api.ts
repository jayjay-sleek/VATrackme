import type { ActiveWindowInfo, LoginResponse, ScreenCapture, TrackerData, TrackingSelection } from './types';
import packageJson from '../package.json';

export const APP_VERSION = packageJson.version;

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

  const raw = await window.desktopApi.apiRequest<Record<string, unknown>>({
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
      'Timetracker[version]': APP_VERSION,
      'Process[process_id]': input.activeWindow.processId,
      'Process[window_handle]': input.activeWindow.windowHandle,
      'Process[window_title]': input.activeWindow.windowTitle,
      'Process[module_name]': input.activeWindow.moduleName,
      'Process[module_filename]': input.activeWindow.moduleFilename,
      'Process[mem_usage]': input.activeWindow.memoryUsage,
      'Process[paged_memorysize]': input.activeWindow.pagedMemorySize,
    },
  });

  return parseHeartbeatResponse(raw);
}

export function parseHeartbeatResponse(res: Record<string, unknown>) {
  const nested = (res.Task ?? res.task) as Record<string, unknown> | undefined;
  const pick = (value: unknown) => {
    if (value == null) return undefined;
    const text = String(value).trim();
    return text || undefined;
  };

  return {
    message: pick(res.message),
    id: Number(res.id ?? nested?.id ?? 0) || undefined,
    time_in_out: Number(res.time_in_out ?? 0) || undefined,
    hours_work_today: pick(res.hours_work_today),
    task_total_hours: pick(res.task_total_hours ?? nested?.task_total_hours),
    task_total_hours_today: pick(res.task_total_hours_today ?? nested?.task_total_hours_today),
    interval_send_data: Number(res.interval_send_data ?? 0) || undefined,
    interval_send_screen_capture: Number(res.interval_send_screen_capture ?? 0) || undefined,
    error_va_code: Number(res.error_va_code ?? 0) || undefined,
    error_message: pick(res.error_message),
  };
}

export async function uploadScreenshot(params: {
  authtoken: string;
  trackerId: number;
  capture: ScreenCapture;
  keystroke: number;
  mouseclick: number;
  mousemove: number;
  is_unrelated?: 0 | 1;
  remark?: string;
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
      is_unrelated: params.is_unrelated ?? 0,
      remark: params.remark ?? '',
    },
    bodyType: 'multipart',
    file: params.capture,
  });
}

export async function addTask(authtoken: string, projectId: number | string, title: string) {
  return window.desktopApi.apiRequest<{
    message?: string;
    id?: number;
    task_id?: number;
    title?: string;
    status?: number;
    task_total_hours?: string;
    task_total_hours_today?: string;
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
