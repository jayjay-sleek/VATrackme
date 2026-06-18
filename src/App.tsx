import { useEffect, useMemo, useRef, useState } from 'react';
import { getTrackerData, login, postHeartbeat, postUnrelatedDetection, uploadScreenshot, addTask, updateTaskStatus, API_BASE_URL, pingApi, APP_VERSION } from './api';
import {
  buildUnrelatedReportKey,
  collectTrackerWorkerIds,
  detectUnrelatedKeywords,
  extractWorkerIdsExempted,
  formatUnrelatedRemark,
  isWorkerExemptFromUnrelatedDetection,
  parseEmployerKeywords,
} from './detection';
import type { ActiveWindowInfo, ConnectionStatus, Employer, Project, Task, TrackerData, TrackingSelection } from './types';
import { checkForAppUpdate, downloadAppUpdate, type UpdateCheckResult } from './updates';

const savedTokenKey = 'va-tracker-auth-token';
const defaultHeartbeatSeconds = 60;
const defaultScreenshotSeconds = 600;
const defaultDetectionSeconds = 10;
const defaultIdleCheckSeconds = 10;
const idlePreparationLeadSeconds = 30;
const startTrackingReminderSeconds = 30;
const connectionCheckMs = 20000;
const updateCheckStorageKey = 'va-trackme-last-update-check';
const updateCheckIntervalMs = 6 * 60 * 60 * 1000;

function formatIdleDuration(totalSeconds: number): string {
  const secondsTotal = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(secondsTotal / 3600);
  const minutes = Math.floor((secondsTotal % 3600) / 60);
  const seconds = secondsTotal % 60;

  if (hours > 0) {
    const minutePart = minutes > 0 ? `  and ${minutes} minute${minutes === 1 ? '' : 's'}` : '';
    return `${hours} hour${hours === 1 ? '' : 's'}${minutePart}`;
  }
  if (minutes > 0) {
    const secondPart = seconds > 0 ? ` and ${seconds} second${seconds === 1 ? '' : 's'}` : '';
    return `${minutes} minute${minutes === 1 ? '' : 's'}${secondPart}`;
  }
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
}

const idleStatusLabels: Record<number, string> = {
  0: 'Working',
  2: 'Breaktime',
  3: 'Away',
};

function getTrackerAppActiveWindow(): ActiveWindowInfo {
  return {
    processId: 0,
    windowHandle: '',
    windowTitle: 'VA Trackme',
    moduleName: 'VA Trackme',
    moduleFilename: '',
    memoryUsage: 0,
    pagedMemorySize: 0,
  };
}

function getTaskIdFromAddResponse(res: Record<string, unknown>) {
  const nested = (res.Task ?? res.task) as Record<string, unknown> | undefined;
  const taskId = res.task_id ?? res.id ?? nested?.id ?? nested?.task_id;
  return taskId != null ? String(taskId) : '';
}

function parseAddTaskResponse(res: Record<string, unknown>): AddTaskResponse {
  const nested = (res.Task ?? res.task) as Record<string, unknown> | undefined;
  return {
    id: Number(res.id ?? nested?.id ?? 0) || undefined,
    task_id: Number(res.task_id ?? nested?.id ?? res.id ?? 0) || undefined,
    title: String(res.title ?? nested?.title ?? ''),
    status: Number(res.status ?? nested?.status ?? 0),
    task_total_hours: pickString(res.task_total_hours ?? nested?.task_total_hours),
    task_total_hours_today: pickString(res.task_total_hours_today ?? nested?.task_total_hours_today),
    error_va_code: Number(res.error_va_code ?? 0) || undefined,
    error_message: String(res.error_message ?? ''),
  };
}

function pickString(value: unknown): string | undefined {
  if (value == null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function formatAutoTaskTitle(projectTitle: string): string {
  const dateLabel = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `${projectTitle} Task ${dateLabel}`;
}

function getTaskTotalHours(task: Task | undefined): string | null {
  if (!task) return null;
  const hours = task.task_total_hours
    ?? (task as Task & { total_hours?: string }).total_hours
    ?? (task as Task & { hours_consumed?: string }).hours_consumed
    ?? (task as Task & { time_spent?: string }).time_spent
    ?? (task as Task & { hours?: string }).hours;
  if (hours == null || String(hours).trim() === '') return '0:00';
  return String(hours);
}

function mergeTaskRecord(existing: Task | undefined, incoming: Task): Task {
  const merged: Task = {
    ...(existing ?? {}),
    ...incoming,
    id: incoming.id,
    title: incoming.title,
    status: incoming.status,
    project_id: incoming.project_id,
  };
  if (pickString(incoming.task_total_hours)) {
    merged.task_total_hours = incoming.task_total_hours;
  } else if (existing?.task_total_hours) {
    merged.task_total_hours = existing.task_total_hours;
  }
  if (pickString(incoming.task_total_hours_today)) {
    merged.task_total_hours_today = incoming.task_total_hours_today;
  } else if (existing?.task_total_hours_today) {
    merged.task_total_hours_today = existing.task_total_hours_today;
  }
  return merged;
}

function findTrackingSelection(
  trackerData: TrackerData,
  employerId: string,
  projectId: string,
  taskId: string,
): TrackingSelection | null {
  const employer = Object.values(trackerData.employers ?? {}).find((item) => String(item.emp_id) === employerId);
  const project = employer
    ? Object.values(employer.projects ?? {}).find((item) => String(item.id) === projectId)
    : undefined;
  const task = project
    ? Object.values(project.tasks ?? {}).find((item) => String(item.id) === taskId)
    : undefined;
  if (!employer || !project || !task) return null;
  return { employer, project, task };
}

type AddTaskResponse = {
  id?: number;
  task_id?: number;
  title?: string;
  status?: number;
  task_total_hours?: string;
  task_total_hours_today?: string;
  error_va_code?: number;
  error_message?: string;
};

function buildTaskFromAddResponse(
  taskId: string,
  title: string,
  projectId: number | string,
  res: AddTaskResponse,
): Task {
  const task: Task = {
    id: Number(taskId),
    title: pickString(res.title) ?? title,
    status: res.status ?? 0,
    project_id: Number(projectId),
  };
  if (pickString(res.task_total_hours)) task.task_total_hours = res.task_total_hours;
  if (pickString(res.task_total_hours_today)) task.task_total_hours_today = res.task_total_hours_today;
  return task;
}

function upsertTaskInTrackerData(
  trackerData: TrackerData,
  employerId: string,
  projectId: string,
  task: Task,
): TrackerData {
  const employers = { ...(trackerData.employers ?? {}) };
  const employerEntry = Object.entries(employers).find(([, item]) => String(item.emp_id) === employerId);
  if (!employerEntry) return trackerData;

  const [employerKey, employer] = employerEntry;
  const projects = { ...(employer.projects ?? {}) };
  const projectEntry = Object.entries(projects).find(([, item]) => String(item.id) === projectId);
  if (!projectEntry) return trackerData;

  const [projectKey, project] = projectEntry;
  const tasks = { ...(project.tasks ?? {}) };
  const taskKey = String(task.id);
  tasks[taskKey] = mergeTaskRecord(tasks[taskKey], task);

  projects[projectKey] = { ...project, tasks };
  employers[employerKey] = { ...employer, projects };

  return { ...trackerData, employers };
}

function updateTaskHoursInTrackerData(
  trackerData: TrackerData | null,
  taskId: string,
  hours: { task_total_hours?: string; task_total_hours_today?: string },
): TrackerData | null {
  if (!trackerData || (!hours.task_total_hours && !hours.task_total_hours_today)) {
    return trackerData;
  }

  const employers = { ...(trackerData.employers ?? {}) };
  let changed = false;

  for (const [employerKey, employer] of Object.entries(employers)) {
    const projects = { ...(employer.projects ?? {}) };
    let projectChanged = false;

    for (const [projectKey, project] of Object.entries(projects)) {
      const tasks = { ...(project.tasks ?? {}) };
      const taskKey = Object.keys(tasks).find((key) => String(tasks[key].id) === taskId) ?? taskId;
      if (!tasks[taskKey]) continue;

      tasks[taskKey] = {
        ...tasks[taskKey],
        task_total_hours: hours.task_total_hours ?? tasks[taskKey].task_total_hours,
        task_total_hours_today: hours.task_total_hours_today ?? tasks[taskKey].task_total_hours_today,
      };
      projects[projectKey] = { ...project, tasks };
      projectChanged = true;
      changed = true;
    }

    if (projectChanged) {
      employers[employerKey] = { ...employer, projects };
    }
  }

  return changed ? { ...trackerData, employers } : trackerData;
}

type StatusKind = 'info' | 'error' | 'success';

function App() {
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState(() => localStorage.getItem(savedTokenKey) ?? '');
  const [data, setData] = useState<TrackerData | null>(null);
  const [selectedEmployerId, setSelectedEmployerId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedTaskId, setSelectedTaskId] = useState('');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [autoLogin, setAutoLogin] = useState(() => localStorage.getItem('va-auto-login') === '1');
  const [taskCompleted, setTaskCompleted] = useState(false);
  const [trackerId, setTrackerId] = useState<number | undefined>();
  const [isTracking, setIsTracking] = useState(false);
  const [showStartReminder, setShowStartReminder] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [statusKind, setStatusKind] = useState<StatusKind>('info');
  const reportStatus = (message: string, kind: StatusKind = 'info') => {
    setStatus(message);
    setStatusKind(kind);
  };
  const [unrelatedAlert, setUnrelatedAlert] = useState<{
    matches: string[];
    title: string;
    visible: boolean;
  } | null>(null);
  const [showUnrelatedBanner, setShowUnrelatedBanner] = useState(false);
  const [debugActiveWindow, setDebugActiveWindow] = useState<{ title: string; module: string } | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [lastDetectedMatches, setLastDetectedMatches] = useState<string[]>([]);
  const [lastActiveTitle, setLastActiveTitle] = useState<string>('');
  const [testKeyword, setTestKeyword] = useState('');
  const [activity, setActivity] = useState({ keystroke: 0, mouseclick: 0, mousemove: 0 });
  const [lastCaptureAt, setLastCaptureAt] = useState<number | null>(null);
  const [idlePopup, setIdlePopup] = useState<{
    idleMinutes: number;
    idleSeconds: number;
    openedAt: number;
  } | null>(null);
  const [idleSelectedStatus, setIdleSelectedStatus] = useState('0');
  const [idleRemark, setIdleRemark] = useState('');
  const [idleSubmitting, setIdleSubmitting] = useState(false);
  const [idleLiveSeconds, setIdleLiveSeconds] = useState(0);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateDismissedVersion, setUpdateDismissedVersion] = useState('');
  const heartbeatTimer = useRef<number | null>(null);
  const screenshotTimer = useRef<number | null>(null);
  const detectionTimer = useRef<number | null>(null);
  const idleTimer = useRef<number | null>(null);
  const startReminderTimer = useRef<number | null>(null);
  const trackingSelectionRef = useRef<TrackingSelection | null>(null);
  const lastSentUnrelatedRef = useRef('');
  const trackerIdRef = useRef<number | undefined>();
  const wasIdleRef = useRef(false);
  const idleSendInFlightRef = useRef(false);
  const idlePrepInFlightRef = useRef(false);
  const idleSessionPreparedRef = useRef(false);
  const idlePopupVisibleRef = useRef(false);
  const activityRef = useRef(activity);
  const [isAppFocused, setIsAppFocused] = useState(true);
  const fallbackTimer = useRef<number | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const needsDataRefreshRef = useRef(false);
  const refreshInFlightRef = useRef(false);
  const syncInFlightRef = useRef(false);
  const taskSyncTimer = useRef<number | null>(null);

  const employers = useMemo(() => Object.values(data?.employers ?? {}), [data]);
  const selectedEmployer = employers.find((employer) => String(employer.emp_id) === selectedEmployerId);
  const projects = useMemo(() => {
    const arr = Object.values(selectedEmployer?.projects ?? {});
    return arr.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { sensitivity: 'base' }));
  }, [selectedEmployer]);
  const selectedProject = projects.find((project) => String(project.id) === selectedProjectId);
  const tasks = useMemo(() => {
    const arr = Object.values(selectedProject?.tasks ?? {});
    return arr.sort((a, b) => String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { sensitivity: 'base' }));
  }, [selectedProject]);
  const selectedTask = tasks.find((task) => String(task.id) === selectedTaskId);
  const selectedTaskHours = getTaskTotalHours(selectedTask);
  const recentCompletedTasks = useMemo(() => {
    // Prefer tasks_completed from the selected project if provided by API
    const completedSource = selectedProject && (selectedProject as any).tasks_completed ? Object.values((selectedProject as any).tasks_completed) : tasks.filter((t) => (t as any).status === 1);
    return completedSource
      .slice()
      .sort((a: any, b: any) => {
        const ta = a.completed_at ? new Date(a.completed_at).getTime() : Number(a.id ?? 0);
        const tb = b.completed_at ? new Date(b.completed_at).getTime() : Number(b.id ?? 0);
        return tb - ta;
      })
      .slice(0, 5);
  }, [selectedProject, tasks]);
  const selection = selectedEmployer && selectedProject && selectedTask
    ? { employer: selectedEmployer, project: selectedProject, task: selectedTask }
    : null;

  const employerKeywords = useMemo(
    () => parseEmployerKeywords(selectedEmployer),
    [selectedEmployer],
  );
  const workerIdsExempted = useMemo(
    () => extractWorkerIdsExempted(data, selectedEmployer),
    [data, selectedEmployer],
  );
  const trackerWorkerIds = useMemo(
    () => collectTrackerWorkerIds(data, selection),
    [data, selection],
  );
  const isUnrelatedDetectionExempt = useMemo(
    () => isWorkerExemptFromUnrelatedDetection(trackerWorkerIds, workerIdsExempted),
    [trackerWorkerIds, workerIdsExempted],
  );
  const isUnrelatedDetectionExemptRef = useRef(false);

  useEffect(() => {
    isUnrelatedDetectionExemptRef.current = isUnrelatedDetectionExempt;
    if (!isUnrelatedDetectionExempt) return;
    setUnrelatedAlert(null);
    setShowUnrelatedBanner(false);
    lastSentUnrelatedRef.current = '';
  }, [isUnrelatedDetectionExempt]);

  useEffect(() => {
    if (token) {
      void refreshData(token);
    }
  }, [token]);

  useEffect(() => {
    void runUpdateCheck({ silent: true });
  }, []);

  // Monitor internet/API connection and auto-reload data when back online
  useEffect(() => {
    let cancelled = false;

    async function checkConnection() {
      if (cancelled) return;
      const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
      if (!browserOnline) {
        setConnectionStatus('offline');
        if (token) needsDataRefreshRef.current = true;
        return;
      }

      setConnectionStatus((current) => (current === 'offline' ? 'checking' : current));
      const ok = await pingApi();
      if (cancelled) return;

      if (ok) {
        setConnectionStatus('connected');
        if (token && needsDataRefreshRef.current && !refreshInFlightRef.current) {
          void refreshData(token, { silent: true });
        }
      } else {
        setConnectionStatus('offline');
        if (token) needsDataRefreshRef.current = true;
      }
    }

    void checkConnection();
    const intervalId = window.setInterval(checkConnection, connectionCheckMs);

    const onOnline = () => {
      setConnectionStatus('checking');
      void checkConnection();
    };
    const onOffline = () => {
      setConnectionStatus('offline');
      if (token) needsDataRefreshRef.current = true;
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [token]);

  useEffect(() => {
    // update taskCompleted checkbox when selectedTask changes
    setTaskCompleted(Boolean(selectedTask && (selectedTask as any).status === 1));
  }, [selectedTask]);

  useEffect(() => {
    trackerIdRef.current = trackerId;
  }, [trackerId]);

  useEffect(() => {
    activityRef.current = activity;
  }, [activity]);

  useEffect(() => {
    const onKey = () => setActivity((current) => ({ ...current, keystroke: current.keystroke + 1 }));
    const onClick = () => setActivity((current) => ({ ...current, mouseclick: current.mouseclick + 1 }));
    const onMove = () => setActivity((current) => ({ ...current, mousemove: current.mousemove + 1 }));

    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    window.addEventListener('mousemove', onMove);

    const onFocus = () => setIsAppFocused(true);
    const onBlur = () => setIsAppFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // global input listener from main via iohook (if available)
  useEffect(() => {
    try {
      window.desktopApi.onGlobalInput((payload: { type: string }) => {
        if (payload.type === 'keydown') {
          setActivity((current) => ({ ...current, keystroke: current.keystroke + 1 }));
        } else if (payload.type === 'mouseclick') {
          setActivity((current) => ({ ...current, mouseclick: current.mouseclick + 1 }));
        } else if (payload.type === 'mousemove') {
          setActivity((current) => ({ ...current, mousemove: current.mousemove + 1 }));
        }
      });
    } catch (e) {
      // ignore if not available
    }
  }, []);

  // Fallback polling for activity when the app is not focused (estimates activity using system idle time)
  useEffect(() => {
    async function startFallback() {
      if (fallbackTimer.current) return;
      fallbackTimer.current = window.setInterval(async () => {
        try {
          const idleSec = await window.desktopApi.getIdleSeconds();
          // consider active if idle less than threshold (use minute_idle_time if set)
          const idleThreshold = Number(data?.minute_idle_time ?? 60);
          if (idleSec < Math.max(5, idleThreshold)) {
            // heuristic increments
            const kInc = Math.max(1, Math.round((Math.max(60, idleThreshold) - idleSec) / 15));
            const mInc = 1;
            setActivity((current) => {
              const next = { keystroke: current.keystroke + kInc, mouseclick: current.mouseclick + mInc, mousemove: current.mousemove + 1 };
              activityRef.current = next;
              return next;
            });
          }
        } catch (e) {
          try { window.desktopApi.log({ level: 'error', message: 'fallback poll error ' + String(e) }); } catch (_) {}
        }
      }, 5000);
    }

    function stopFallback() {
      if (fallbackTimer.current) {
        window.clearInterval(fallbackTimer.current);
        fallbackTimer.current = null;
      }
    }

    if (!isAppFocused && isTracking) {
      startFallback();
    } else {
      stopFallback();
    }

    return () => stopFallback();
  }, [isAppFocused, isTracking, data]);

  useEffect(() => {
    return () => {
      stopTimers();
    };
  }, []);

  async function syncTrackerDataSilently(authToken = token) {
    if (!authToken || syncInFlightRef.current || refreshInFlightRef.current) return false;

    syncInFlightRef.current = true;
    try {
      const nextData = await getTrackerData(authToken);
      if ((nextData as any).network_error || nextData.error_va_code === -1) {
        return false;
      }
      if (nextData.error_va_code) {
        return false;
      }

      setConnectionStatus('connected');
      needsDataRefreshRef.current = false;
      setData(nextData);

      const activeSelection = trackingSelectionRef.current;
      if (activeSelection) {
        const fresh = findTrackingSelection(
          nextData,
          String(activeSelection.employer.emp_id),
          String(activeSelection.project.id),
          String(activeSelection.task.id),
        );
        if (fresh) trackingSelectionRef.current = fresh;
      }

      return true;
    } catch (e) {
      try { window.desktopApi.log({ level: 'error', message: 'syncTrackerDataSilently failed: ' + String(e) }); } catch (_) {}
      return false;
    } finally {
      syncInFlightRef.current = false;
    }
  }

  async function refreshData(authToken = token, options?: { silent?: boolean }) {
    if (!authToken || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    if (!options?.silent) reportStatus('Loading projects and tasks...');

    try {
      const nextData = await getTrackerData(authToken);

      if ((nextData as any).network_error || nextData.error_va_code === -1) {
        setConnectionStatus('offline');
        needsDataRefreshRef.current = true;
        if (!options?.silent) reportStatus('No internet connection. Retrying automatically...', 'error');
        return;
      }

      if (nextData.error_va_code) {
        const msg = (nextData.error_message || '').toLowerCase();
        if (nextData.error_va_code === 401 || msg.includes('another device') || msg.includes('already logged') || msg.includes('invalid token') || msg.includes('session')) {
          signOut();
          reportStatus(nextData.error_message ?? 'Signed out due to session change.', 'error');
          return;
        }
        setConnectionStatus('connected');
        reportStatus(nextData.error_message ?? 'Unable to load tracker data.', 'error');
        return;
      }

      setConnectionStatus('connected');
      needsDataRefreshRef.current = false;
      setData(nextData);
      if (!options?.silent) reportStatus('Projects and tasks loaded.', 'success');

      const employerList = Object.values(nextData.employers ?? {});
      const firstEmployer = employerList[0];
      const employerForSelection = selectedEmployerId
        ? employerList.find((employer) => String(employer.emp_id) === selectedEmployerId) ?? firstEmployer
        : firstEmployer;
      const employerProjects = employerForSelection
        ? Object.values(employerForSelection.projects ?? {})
        : [];
      const soleProject = employerProjects.length === 1 ? employerProjects[0] : undefined;
      const firstTask = soleProject ? Object.values((soleProject as any).tasks ?? {})[0] : undefined;

      if (!selectedEmployerId && firstEmployer) {
        setSelectedEmployerId(String(firstEmployer.emp_id));
      }
      if (!selectedProjectId && soleProject) {
        setSelectedProjectId(String((soleProject as any).id));
      }
      if (!selectedTaskId && firstTask) {
        setSelectedTaskId(String((firstTask as any).id));
      }
    } catch (e) {
      setConnectionStatus('offline');
      needsDataRefreshRef.current = true;
      if (!options?.silent) reportStatus('No internet connection. Retrying automatically...', 'error');
      try { window.desktopApi.log({ level: 'error', message: 'refreshData failed: ' + String(e) }); } catch (_) {}
    } finally {
      refreshInFlightRef.current = false;
    }
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    reportStatus('Signing in...');

    const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
    if (!browserOnline || !(await pingApi())) {
      setConnectionStatus('offline');
      reportStatus('No internet connection. Retrying automatically...', 'error');
      return;
    }

    const response = await login(userName, password);
    if ('error_message' in response) {
      if ((response as any).network_error) {
        setConnectionStatus('offline');
        reportStatus('No internet connection. Retrying automatically...', 'error');
        return;
      }
      reportStatus(response.error_message, 'error');
      return;
    }

    setConnectionStatus('connected');

    if (autoLogin) {
      localStorage.setItem(savedTokenKey, response.user_auth_key);
      localStorage.setItem('va-auto-login', '1');
    } else {
      localStorage.removeItem(savedTokenKey);
      localStorage.setItem('va-auto-login', '0');
    }
    setToken(response.user_auth_key);
    reportStatus(response.success_message, 'success');
  }

  async function createTaskAndSelect(
    projectId: number | string,
    title: string,
    employerId: string,
  ): Promise<{ taskId: string; selection: TrackingSelection | null; error?: string }> {
    if (!token) {
      return { taskId: '', selection: null, error: 'Sign in first.' };
    }

    const rawRes = await addTask(token, projectId, title);
    const res = parseAddTaskResponse(rawRes as Record<string, unknown>);
    const taskId = getTaskIdFromAddResponse(rawRes as Record<string, unknown>);
    if (!taskId || res?.error_va_code) {
      return { taskId: '', selection: null, error: res?.error_message ?? 'Failed to create task.' };
    }

    updateTrackerId(undefined);

    const nextData = await getTrackerData(token);
    if ((nextData as any).network_error || nextData.error_va_code === -1) {
      return { taskId: '', selection: null, error: 'No internet connection.' };
    }
    if (nextData.error_va_code) {
      return { taskId: '', selection: null, error: nextData.error_message ?? 'Unable to load tracker data.' };
    }

    const fromData = findTrackingSelection(nextData, employerId, String(projectId), taskId);
    const createdTask = buildTaskFromAddResponse(taskId, title, projectId, res);
    if (fromData?.task.task_total_hours && !pickString(createdTask.task_total_hours)) {
      createdTask.task_total_hours = fromData.task.task_total_hours;
    }
    if (fromData?.task.task_total_hours_today && !pickString(createdTask.task_total_hours_today)) {
      createdTask.task_total_hours_today = fromData.task.task_total_hours_today;
    }

    const mergedData = upsertTaskInTrackerData(nextData, employerId, String(projectId), createdTask);

    setConnectionStatus('connected');
    setData(mergedData);
    setSelectedTaskId(taskId);
    setTaskCompleted(createdTask.status === 1);

    const selection = findTrackingSelection(mergedData, employerId, String(projectId), taskId);

    return {
      taskId,
      selection,
      error: selection ? undefined : 'Created task could not be selected.',
    };
  }

  async function switchActiveTrackingTask(nextSelection: TrackingSelection) {
    trackingSelectionRef.current = nextSelection;
    setTaskCompleted(nextSelection.task.status === 1);
    const result = await sendHeartbeat(nextSelection, 1, { resetTrackerId: true });
    if (result?.error_va_code) {
      reportStatus(result.error_message ?? 'Unable to switch task.', 'error');
      return false;
    }

    setData((current) => {
      if (!current) return current;
      const refreshed = updateTaskHoursInTrackerData(current, String(nextSelection.task.id), {
        task_total_hours: result.task_total_hours,
        task_total_hours_today: result.task_total_hours_today,
      });
      const selection = refreshed
        ? findTrackingSelection(refreshed, selectedEmployerId, selectedProjectId, String(nextSelection.task.id))
        : null;
      if (selection) trackingSelectionRef.current = selection;
      return refreshed;
    });

    reportStatus(`Tracking: ${nextSelection.task.title}`);
    return true;
  }

  async function handleTaskSelectionChange(taskId: string) {
    setSelectedTaskId(taskId);
    if (!isTracking || !token || !data) return;

    const nextSelection = findTrackingSelection(data, selectedEmployerId, selectedProjectId, taskId);
    if (!nextSelection) return;

    await switchActiveTrackingTask(nextSelection);
  }

  async function handleAddTask() {
    if (!token) {
      reportStatus('Sign in first.', 'error');
      return;
    }
    if (!selectedProject || !selectedEmployerId) {
      reportStatus('Select a project to add a task.', 'error');
      return;
    }
    const title = newTaskTitle.trim();
    if (!title) {
      reportStatus('Enter a task title.', 'error');
      return;
    }
    reportStatus('Creating task...');
    const created = await createTaskAndSelect(selectedProject.id, title, selectedEmployerId);
    if (created.error || !created.taskId) {
      reportStatus(created.error ?? 'Failed to create task.', 'error');
      return;
    }

    if (created.selection && isTracking) {
      await switchActiveTrackingTask(created.selection);
    } else {
      void syncTrackerDataSilently();
    }

    setNewTaskTitle('');
    if (isTracking && created.selection) {
      reportStatus(`Tracking: ${created.selection.task.title}`);
    } else {
      reportStatus('Task created.', 'success');
    }
  }

  // removed: manual capture button; window capture is now automatic when creating a default task

  async function startTracking() {
    if (!token) {
      reportStatus('Sign in first.', 'error');
      return;
    }

    let currentSelection = selection;

    // If there's no selected task but a project is chosen, create a default task.
    if (!currentSelection) {
      if (!selectedProject || !selectedEmployerId) {
        reportStatus('Select a project before starting the tracker.', 'error');
        return;
      }

      reportStatus('Creating default task...');
      const defaultTitle = formatAutoTaskTitle(selectedProject.title);
      const created = await createTaskAndSelect(selectedProject.id, defaultTitle, selectedEmployerId);
      if (created.error || !created.selection) {
        reportStatus(created.error ?? 'Failed to create default task.', 'error');
        return;
      }
      currentSelection = created.selection;
    }

    trackingSelectionRef.current = currentSelection;
    setIsTracking(true);
    reportStatus(`Tracking: ${currentSelection.task.title}`);
    const result = await sendHeartbeat(currentSelection, 1, { resetTrackerId: true });

    if (result?.id) {
      updateTrackerId(result.id);
    }

    const heartbeatSeconds = normalizeInterval(data?.interval_send_data, defaultHeartbeatSeconds);
    const screenshotSeconds = normalizeInterval(result?.interval_send_screen_capture ?? data?.interval_send_screen_capture, defaultScreenshotSeconds);

    heartbeatTimer.current = window.setInterval(() => {
      const activeSelection = trackingSelectionRef.current;
      if (activeSelection) void sendHeartbeat(activeSelection, 1);
    }, heartbeatSeconds * 1000);

    screenshotTimer.current = window.setInterval(() => {
      void sendScreenshot();
    }, screenshotSeconds * 1000);
  }

  useEffect(() => {
    if (!isTracking || !token || !trackingSelectionRef.current) return;

    const tick = () => {
      const activeSelection = trackingSelectionRef.current;
      if (activeSelection) void checkAndReportUnrelated(activeSelection);
    };

    tick();
    const timer = window.setInterval(tick, defaultDetectionSeconds * 1000);
    detectionTimer.current = timer;

    return () => {
      window.clearInterval(timer);
      detectionTimer.current = null;
    };
  }, [isTracking, token, employerKeywords, isUnrelatedDetectionExempt]);

  useEffect(() => {
    if (!isTracking || !token || !trackingSelectionRef.current) return;

    const tick = () => {
      const activeSelection = trackingSelectionRef.current;
      if (activeSelection) void checkIdleAndShowPopup(activeSelection);
    };

    tick();
    const timer = window.setInterval(tick, defaultIdleCheckSeconds * 1000);
    idleTimer.current = timer;

    return () => {
      window.clearInterval(timer);
      idleTimer.current = null;
    };
  }, [isTracking, token, data?.minute_idle_time]);

  useEffect(() => {
    if (!idlePopup) return;

    const updateIdleDuration = () => {
      const elapsed = Math.floor((Date.now() - idlePopup.openedAt) / 1000);
      setIdleLiveSeconds(idlePopup.idleSeconds + elapsed);
    };

    updateIdleDuration();
    const timer = window.setInterval(updateIdleDuration, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [idlePopup]);

  useEffect(() => {
    if (!idlePopup) {
      void window.desktopApi.setIdlePopupActive?.({ active: false });
      return;
    }

    void window.desktopApi.setIdlePopupActive?.({ active: true, focus: true });
    return () => {
      void window.desktopApi.setIdlePopupActive?.({ active: false });
    };
  }, [idlePopup]);

  function remindStartTracking() {
    setShowStartReminder(true);
    reportStatus('Tracking is stopped. Start working to begin time tracking.');

    if (typeof window !== 'undefined' && 'Notification' in window) {
      try {
        new window.Notification('Start tracking', {
          body: 'Time tracking is stopped. Click Start Tracking to begin working.',
        });
      } catch (e) {}
    }
  }

  useEffect(() => {
    if (!token || isTracking) {
      setShowStartReminder(false);
      if (startReminderTimer.current) {
        window.clearInterval(startReminderTimer.current);
        startReminderTimer.current = null;
      }
      return;
    }

    const timer = window.setInterval(() => {
      remindStartTracking();
    }, startTrackingReminderSeconds * 1000);
    startReminderTimer.current = timer;

    return () => {
      window.clearInterval(timer);
      startReminderTimer.current = null;
    };
  }, [token, isTracking]);

  async function stopTracking() {
    if (selection) {
      await sendHeartbeat(selection, 0);
    }

    stopTimers();
    trackingSelectionRef.current = null;
    setIsTracking(false);
    updateTrackerId(undefined);
    reportStatus('Tracking stopped.');
  }

  async function reportUnrelatedWithScreenshot(
    currentSelection: TrackingSelection,
    unrelatedMatches: string[],
    activeWindow: ActiveWindowInfo,
  ) {
    if (!token || !trackerIdRef.current) return;

    const activity = activityRef.current;

    try {
      const capture = await window.desktopApi.captureScreen();
      if (!capture) {
        try { window.desktopApi.log({ level: 'error', message: 'Failed to capture screenshot for unrelated activity' }); } catch (_) {}
        reportStatus('Unrelated activity detected, but screenshot capture failed.', 'error');
        return;
      }

      const result = await postUnrelatedDetection({
        authtoken: token,
        trackerId: trackerIdRef.current,
        selection: currentSelection,
        keywords: unrelatedMatches,
        activeWindow,
        keystroke: activity.keystroke,
        mouseclick: activity.mouseclick,
        mousemove: activity.mousemove,
      });

      if (result.error_va_code) {
        lastSentUnrelatedRef.current = '';
        const msg = (result.error_message || '').toLowerCase();
        if (result.error_va_code === 401 || msg.includes('another device') || msg.includes('already logged') || msg.includes('invalid token') || msg.includes('session')) {
          signOut();
          reportStatus(result.error_message ?? 'Signed out due to session change.', 'error');
          return;
        }
        reportStatus(result.error_message ?? 'Unable to report unrelated activity.', 'error');
        return;
      }

      if (result.id) {
        updateTrackerId(result.id);
      }

      await uploadScreenshot({
        authtoken: token,
        trackerId: trackerIdRef.current,
        capture,
        keystroke: activity.keystroke,
        mouseclick: activity.mouseclick,
        mousemove: activity.mousemove,
        is_unrelated: 1,
        remark: formatUnrelatedRemark(unrelatedMatches),
      });
      setLastCaptureAt(Date.now());
      try {
        window.desktopApi.log({
          level: 'info',
          message: 'Unrelated reported with screenshot: ' + formatUnrelatedRemark(unrelatedMatches),
        });
      } catch (e) {}
    } catch (e) {
      lastSentUnrelatedRef.current = '';
      try { window.desktopApi.log({ level: 'error', message: 'Failed to report unrelated with screenshot: ' + String(e) }); } catch (_) {}
    }
  }

  function notifyUnrelatedDetected(matches: string[], windowTitle: string) {
    setUnrelatedAlert({ matches, title: windowTitle, visible: true });
    setShowUnrelatedBanner(true);
    if (showDebug) {
      try { window.alert('Unrelated detected: ' + matches.join(', ')); } catch (e) {}
    }
    if (typeof window !== 'undefined' && 'Notification' in window) {
      try {
        new window.Notification('Unrelated activity detected', {
          body: `${matches.join(', ')} — ${windowTitle}`,
        });
      } catch (e) {}
    }
    try { window.desktopApi.log({ level: 'warn', message: 'Unrelated detected: ' + matches.join(', ') }); } catch (e) {}
  }

  async function getIdleStatus(): Promise<{ idleStatus: number; idleMinutes: number; idleSeconds: number }> {
    const idleSeconds = await window.desktopApi.getIdleSeconds();
    const idleMinutes = idleSeconds / 60;
    const idleLimit = Number(data?.minute_idle_time ?? 0);
    // idle_status codes: 0=Working,1=Idle,2=Breaktime,3=Away,4=Absent
    const idleStatus = idleLimit > 0 && idleMinutes >= idleLimit ? 1 : 0;
    return { idleStatus, idleMinutes, idleSeconds };
  }

  async function prepareIdleSessionBeforePopup(
    currentSelection: TrackingSelection,
    idleMinutes: number,
  ) {
    if (!trackerIdRef.current) return false;

    const activeWindow = getTrackerAppActiveWindow();
    const workingFlush = await sendHeartbeat(currentSelection, 1, {
      idleStatus: 0,
      remark: '',
      activeWindow,
      skipUnrelatedDetection: true,
      silent: true,
    });
    if (workingFlush?.error_va_code) return false;

    updateTrackerId(undefined);
    const idleSession = await sendHeartbeat(currentSelection, 1, {
      resetTrackerId: true,
      idleStatus: 1,
      idleMinutes,
      remark: '',
      activeWindow,
      skipUnrelatedDetection: true,
      silent: true,
    });
    if (idleSession?.error_va_code) return false;
    if (!idleSession?.id) return false;

    return true;
  }

  async function checkIdleAndShowPopup(currentSelection: TrackingSelection) {
    if (!token || !isTracking || idlePopupVisibleRef.current) return;

    const idleLimitMinutes = Number(data?.minute_idle_time ?? 0);
    if (idleLimitMinutes <= 0) return;

    const { idleSeconds } = await getIdleStatus();
    const popupThresholdSeconds = idleLimitMinutes * 60;
    const prepThresholdSeconds = Math.max(0, popupThresholdSeconds - idlePreparationLeadSeconds);

    if (idleSeconds < prepThresholdSeconds) {
      idleSessionPreparedRef.current = false;
      wasIdleRef.current = false;
      return;
    }

    if (
      idleSeconds >= prepThresholdSeconds &&
      !idleSessionPreparedRef.current &&
      !idlePrepInFlightRef.current &&
      !idleSendInFlightRef.current &&
      trackerIdRef.current
    ) {
      idlePrepInFlightRef.current = true;
      try {
        const ready = await prepareIdleSessionBeforePopup(
          currentSelection,
          idleSeconds / 60,
        );
        if (ready) idleSessionPreparedRef.current = true;
      } finally {
        idlePrepInFlightRef.current = false;
      }
    }

    if (idleSeconds < popupThresholdSeconds) return;
    if (wasIdleRef.current || idleSendInFlightRef.current) return;

    idleSendInFlightRef.current = true;
    try {
      if (!idleSessionPreparedRef.current) {
        const ready = await prepareIdleSessionBeforePopup(
          currentSelection,
          idleSeconds / 60,
        );
        if (!ready) return;
        idleSessionPreparedRef.current = true;
      }

      idlePopupVisibleRef.current = true;
      setIdleSelectedStatus('0');
      setIdleRemark('');
      setIdlePopup({
        idleMinutes: idleSeconds / 60,
        idleSeconds,
        openedAt: Date.now(),
      });
      setIdleLiveSeconds(idleSeconds);
      reportStatus('Idle detected — please explain why you were idle.');

      if (typeof window !== 'undefined' && 'Notification' in window) {
        try {
          new window.Notification('Idle detected', {
            body: 'Please explain why you were idle.',
          });
        } catch (e) {}
      }
    } finally {
      idleSendInFlightRef.current = false;
    }
  }

  async function submitIdleWithReset(
    currentSelection: TrackingSelection,
    selectedStatus: number,
    remark: string,
    idleMinutes: number,
    activeWindow: ActiveWindowInfo,
  ) {
    const heartbeatOptions = {
      activeWindow,
      skipUnrelatedDetection: true,
      silent: true,
    };

    const idleResult = await sendHeartbeat(currentSelection, 1, {
      ...heartbeatOptions,
      idleStatus: 1,
      idleMinutes,
      remark,
    });
    if (idleResult?.error_va_code) return false;

    if (selectedStatus === 2 || selectedStatus === 3) {
      const statusResult = await sendHeartbeat(currentSelection, 1, {
        ...heartbeatOptions,
        idleStatus: selectedStatus,
        remark: '',
      });
      if (statusResult?.error_va_code) return false;
    }

    updateTrackerId(undefined);
    const resumeResult = await sendHeartbeat(currentSelection, 1, {
      ...heartbeatOptions,
      resetTrackerId: true,
      idleStatus: 0,
      remark: '',
    });
    if (resumeResult?.error_va_code) {
      wasIdleRef.current = false;
      return false;
    }

    return true;
  }

  async function handleIdleGo() {
    const remark = idleRemark.trim();
    if (!remark) {
      reportStatus('Enter a reason for being idle.', 'error');
      return;
    }

    const currentSelection = trackingSelectionRef.current;
    if (!currentSelection || !token || !idlePopup) return;

    const selectedStatus = Number(idleSelectedStatus);
    if (![0, 2, 3].includes(selectedStatus)) return;

    idleSendInFlightRef.current = true;
    setIdleSubmitting(true);

    try {
      const activeWindow = getTrackerAppActiveWindow();
      const ok = await submitIdleWithReset(
        currentSelection,
        selectedStatus,
        remark,
        idleLiveSeconds / 60,
        activeWindow,
      );
      if (!ok) return;

      wasIdleRef.current = true;
      idleSessionPreparedRef.current = false;
      idlePopupVisibleRef.current = false;
      setIdlePopup(null);
      reportStatus(
        selectedStatus === 0
          ? `Working resumed — tracker session ${trackerIdRef.current ?? 'updated'}.`
          : `${idleStatusLabels[selectedStatus]} recorded — working resumed (tracker session ${trackerIdRef.current ?? 'updated'}).`,
      );
    } finally {
      idleSendInFlightRef.current = false;
      setIdleSubmitting(false);
    }
  }

  async function checkAndReportUnrelated(currentSelection: TrackingSelection) {
    if (!token || isUnrelatedDetectionExemptRef.current) return;

    const activeWindow = await window.desktopApi.getActiveWindow();
    setDebugActiveWindow({ title: activeWindow?.windowTitle || '', module: activeWindow?.moduleName || '' });
    setLastActiveTitle(activeWindow?.windowTitle || '');

    const unrelatedMatches = detectUnrelatedKeywords(activeWindow, employerKeywords);

    if (!unrelatedMatches.length) {
      lastSentUnrelatedRef.current = '';
      return;
    }

    const reportKey = buildUnrelatedReportKey(unrelatedMatches, activeWindow?.windowTitle || '');
    if (reportKey === lastSentUnrelatedRef.current) return;

    lastSentUnrelatedRef.current = reportKey;
    notifyUnrelatedDetected(unrelatedMatches, activeWindow?.windowTitle || '');

    await reportUnrelatedWithScreenshot(currentSelection, unrelatedMatches, activeWindow);
  }

  async function sendHeartbeat(
    currentSelection: TrackingSelection,
    timeInOut: 0 | 1,
    options?: {
      resetTrackerId?: boolean;
      idleMinutes?: number;
      idleStatus?: number;
      remark?: string;
      activeWindow?: ActiveWindowInfo;
      skipUnrelatedDetection?: boolean;
      silent?: boolean;
    },
  ) {
    let idleStatus: number;
    let idleMinutes: number;
    if (options?.idleStatus != null) {
      idleStatus = options.idleStatus;
      idleMinutes = options.idleMinutes ?? 0;
    } else if (options?.idleMinutes != null) {
      idleStatus = 1;
      idleMinutes = options.idleMinutes;
    } else {
      const idle = await getIdleStatus();
      idleStatus = idle.idleStatus;
      idleMinutes = idle.idleMinutes;
    }

    const activeWindow = options?.activeWindow ?? await window.desktopApi.getActiveWindow();
    setDebugActiveWindow({ title: activeWindow?.windowTitle || '', module: activeWindow?.moduleName || '' });
    setLastActiveTitle(activeWindow?.windowTitle || '');
    const unrelatedMatches = options?.skipUnrelatedDetection || isUnrelatedDetectionExemptRef.current
      ? []
      : detectUnrelatedKeywords(activeWindow, employerKeywords);

    const remarkExtra = unrelatedMatches.length ? formatUnrelatedRemark(unrelatedMatches) : '';
    const trackerIdForRequest = options?.resetTrackerId ? undefined : trackerIdRef.current;
    const remark = options?.remark != null
      ? options.remark + (remarkExtra ? ` | ${remarkExtra}` : '')
      : (idleStatus === 1 ? `Idle for ${Math.round(idleMinutes)} minutes` : '') + (remarkExtra ? (idleStatus === 1 ? ' | ' : '') + remarkExtra : '');

    const result = await postHeartbeat({
      authtoken: token,
      trackerId: trackerIdForRequest,
      selection: currentSelection,
      timeInOut,
      idleStatus,
      remark,
      keystroke: activityRef.current.keystroke,
      mouseclick: activityRef.current.mouseclick,
      mousemove: activityRef.current.mousemove,
      activeWindow,
    });

    if (result.error_va_code) {
      const msg = (result.error_message || '').toLowerCase();
      if (result.error_va_code === 401 || msg.includes('another device') || msg.includes('already logged') || msg.includes('invalid token') || msg.includes('session')) {
        // automatic logout when session is invalidated elsewhere
        signOut();
        reportStatus(result.error_message ?? 'Signed out due to session change.', 'error');
        return result;
      }
      reportStatus(result.error_message ?? 'Unable to send tracker data.', 'error');
      return result;
    }

    if (result.id) {
      updateTrackerId(result.id);
    }

    const taskId = String(currentSelection.task.id);
    setData((current) => {
      const withTaskHours = updateTaskHoursInTrackerData(current, taskId, {
        task_total_hours: result.task_total_hours,
        task_total_hours_today: result.task_total_hours_today,
      });
      if (!withTaskHours) return current;
      return { ...withTaskHours, hours_work_today: result.hours_work_today ?? withTaskHours.hours_work_today };
    });
    setActivity({ keystroke: 0, mouseclick: 0, mousemove: 0 });
    activityRef.current = { keystroke: 0, mouseclick: 0, mousemove: 0 };
    if (!options?.silent) {
      reportStatus(`Last synced ${new Date().toLocaleTimeString()}`);
    }

    if (timeInOut === 1) {
      void syncTrackerDataSilently();
    }

    return result;
  }

  useEffect(() => {
    if (!token || !selectedTaskId) {
      if (taskSyncTimer.current) {
        window.clearInterval(taskSyncTimer.current);
        taskSyncTimer.current = null;
      }
      return;
    }

    const seconds = normalizeInterval(data?.interval_send_data, defaultHeartbeatSeconds);
    const tick = () => { void syncTrackerDataSilently(); };
    taskSyncTimer.current = window.setInterval(tick, seconds * 1000);

    return () => {
      if (taskSyncTimer.current) {
        window.clearInterval(taskSyncTimer.current);
        taskSyncTimer.current = null;
      }
    };
  }, [token, selectedTaskId, data?.interval_send_data]);

  // Run detection immediately (debug / manual trigger)
  async function runDetectionNow() {
    if (!token || isUnrelatedDetectionExemptRef.current) return;
    const activeWindow = await window.desktopApi.getActiveWindow();
    setDebugActiveWindow({ title: activeWindow?.windowTitle || '', module: activeWindow?.moduleName || '' });
    const matches = detectUnrelatedKeywords(activeWindow, employerKeywords);
    setLastDetectedMatches(matches);
    if (matches.length) {
      notifyUnrelatedDetected(matches, activeWindow?.windowTitle || '');
      if (selection) {
        void reportUnrelatedWithScreenshot(selection, matches, activeWindow);
      }
      try { window.desktopApi.log({ level: 'warn', message: 'Manual detect: ' + matches.join(', ') }); } catch (e) {}
    }
  }

  async function sendScreenshot() {
    if (!token || !trackerIdRef.current) {
      return;
    }

    const capture = await window.desktopApi.captureScreen();
    if (!capture) {
      reportStatus('Unable to capture screen.', 'error');
      return;
    }

    await uploadScreenshot({
      authtoken: token,
      trackerId: trackerIdRef.current,
      capture,
      keystroke: activityRef.current.keystroke,
      mouseclick: activityRef.current.mouseclick,
      mousemove: activityRef.current.mousemove,
    });
    setLastCaptureAt(Date.now());
  }

  function updateTrackerId(nextTrackerId: number | undefined) {
    trackerIdRef.current = nextTrackerId;
    setTrackerId(nextTrackerId);
  }

  function stopTimers() {
    if (heartbeatTimer.current) {
      window.clearInterval(heartbeatTimer.current);
      heartbeatTimer.current = null;
    }

    if (detectionTimer.current) {
      window.clearInterval(detectionTimer.current);
      detectionTimer.current = null;
    }

    if (screenshotTimer.current) {
      window.clearInterval(screenshotTimer.current);
      screenshotTimer.current = null;
    }

    if (idleTimer.current) {
      window.clearInterval(idleTimer.current);
      idleTimer.current = null;
    }

    if (taskSyncTimer.current) {
      window.clearInterval(taskSyncTimer.current);
      taskSyncTimer.current = null;
    }

    lastSentUnrelatedRef.current = '';
    wasIdleRef.current = false;
    idleSendInFlightRef.current = false;
    idlePrepInFlightRef.current = false;
    idleSessionPreparedRef.current = false;
    idlePopupVisibleRef.current = false;
    void window.desktopApi.setIdlePopupActive?.({ active: false });
    setIdlePopup(null);
  }

  function signOut() {
    void stopTracking();
    localStorage.removeItem(savedTokenKey);
    setToken('');
    setData(null);
    reportStatus('Signed out.');
  }

  function openDashboard() {
    if (!token) return;
    const base = API_BASE_URL.replace(/\/+$/, '');
    const url = `${base}/auth/?authtoken=${encodeURIComponent(token)}`;
    try {
      if (window.desktopApi.openExternal) {
        window.desktopApi.openExternal(url);
      } else {
        window.open(url, '_blank');
      }
    } catch (e) {
      window.open(url, '_blank');
    }
  }

  async function runUpdateCheck(options?: { force?: boolean; silent?: boolean }) {
    if (updateChecking) return;

    if (!options?.force) {
      const lastCheck = Number(localStorage.getItem(updateCheckStorageKey) || 0);
      if (Date.now() - lastCheck < updateCheckIntervalMs) return;
    }

    setUpdateChecking(true);
    try {
      const result = await checkForAppUpdate();
      setUpdateInfo(result);
      localStorage.setItem(updateCheckStorageKey, String(Date.now()));

      if (!result.ok) {
        if (options?.force) {
          reportStatus(result.error ?? 'Unable to check for updates.', 'error');
        }
        return;
      }

      if (options?.force && !result.updateAvailable) {
        reportStatus(`You are on the latest version (v${result.currentVersion}).`, 'success');
        return;
      }

      if (result.updateAvailable && !options?.silent) {
        reportStatus(`Update available: v${result.latestVersion}`, 'info');
      }
    } finally {
      setUpdateChecking(false);
    }
  }

  async function handleDownloadUpdate() {
    if (!updateInfo?.downloadUrl) {
      reportStatus('Update download link is unavailable.', 'error');
      return;
    }

    const result = await downloadAppUpdate(updateInfo.downloadUrl);
    if (!result.ok) {
      reportStatus(result.error ?? 'Unable to open update download.', 'error');
      return;
    }

    reportStatus('Opening update download...', 'success');
  }

  return (
    <main className={`app-shell compact${token ? '' : ' login-view'}`}>
      <section className="hero">
        <div>
          <p className="eyebrow">VA Trackme</p>
          <h1>Track task time from your desktop.</h1>
          <p className="muted app-version">Version {APP_VERSION}</p>
          <p className={`muted connection-status ${connectionStatus}`}>
            <span className={`status-dot ${connectionStatus}`} />
            {connectionStatus === 'connected' ? 'Connected' : connectionStatus === 'checking' ? 'Checking connection...' : 'Offline — retrying automatically'}
          </p>
        </div>
        <div className="hero-actions">
          <button
            className="secondary"
            type="button"
            disabled={updateChecking}
            onClick={() => void runUpdateCheck({ force: true })}
          >
            {updateChecking ? 'Checking updates...' : 'Check for updates'}
          </button>
          {token && (
            <button className="secondary" type="button" onClick={signOut}>
              Sign out
            </button>
          )}
        </div>
      </section>

      {updateInfo?.updateAvailable && updateInfo.latestVersion !== updateDismissedVersion && (
        <section className="update-banner card" role="status" aria-live="polite">
          <div className="update-banner-copy">
            <strong>Update available</strong>
            <p className="muted">
              VA Trackme v{updateInfo.latestVersion} is ready. You are on v{updateInfo.currentVersion}.
            </p>
            {updateInfo.releaseNotes ? (
              <p className="update-notes">{updateInfo.releaseNotes}</p>
            ) : null}
          </div>
          <div className="update-banner-actions">
            <button type="button" onClick={() => void handleDownloadUpdate()}>
              Download update
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setUpdateDismissedVersion(updateInfo.latestVersion || '')}
            >
              Later
            </button>
          </div>
        </section>
      )}

      {showUnrelatedBanner && (
        <div style={{ position: 'fixed', top: 12, right: 12, zIndex: 9999 }}>
          <div style={{ background: '#fff7f7', border: '1px solid #ffd2d2', padding: '8px 12px', borderRadius: 8, color: '#b21b1b', boxShadow: '0 8px 30px rgba(16,24,40,0.08)' }}>
            Unrelated activity detected
            <button style={{ marginLeft: 12 }} className="secondary" onClick={() => setShowUnrelatedBanner(false)}>Dismiss</button>
          </div>
        </div>
      )}
      {/* debug UI disabled in production builds */}

      {!token ? (
        <div className="login-center">
          <form className="card login-card" onSubmit={handleLogin}>
          <h2>Worker Login</h2>
          <label>
            Username
            <input value={userName} onChange={(event) => setUserName(event.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
            <div className="login-checkbox">
              <label className="checkbox-label">
                <input type="checkbox" checked={autoLogin} onChange={(e) => setAutoLogin(e.target.checked)} />
                <span>Auto sign in</span>
              </label>
            </div>
          <button type="submit">Login</button>
          <p style={{ margin: 6, fontSize: 13 }}><a href="#" onClick={(e) => { e.preventDefault(); const resetUrl = (typeof API_BASE_URL === 'string' ? API_BASE_URL.replace(/\/api\/?$/i, '/') : API_BASE_URL) + 'request-password-reset/'; try { if (window.desktopApi.openExternal) { window.desktopApi.openExternal(resetUrl); } else { window.open(resetUrl, '_blank'); } } catch (e) { window.open(resetUrl, '_blank'); } }}>Reset password</a></p>
          <p className={`status status-${statusKind}`}>{status}</p>
          </form>
        </div>
      ) : (
        <section className="dashboard">
          <div className="card profile-card">
            <div>
              <p className="eyebrow">Signed In</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <img src={data?.profile_url} alt="profile" style={{ width: 40, height: 40, borderRadius: 8, objectFit: 'cover', border: '1px solid #e6edf6' }} />
                <div>
                  <h2 style={{ margin: 0 }}>{data ? `${data.first_name} ${data.last_name}` : 'Loading...'}</h2>
                  <p className="muted" style={{ margin: 0 }}>{data?.title ?? data?.user_name}</p>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="metric" style={{ minWidth: 72 }}>
                <span>Today</span>
                <strong>{data?.hours_work_today ?? '0:00'}</strong>
              </div>
              <div>
                <button className="secondary" onClick={openDashboard} style={{ padding: '6px 8px' }}>Open Dashboard</button>
              </div>
            </div>
          </div>

          <div className="card tracker-card">
            <h2>Current Task</h2>
            {showStartReminder && !isTracking && (
              <div className="start-reminder-banner" role="status">
                Tracking is stopped. Click <strong>Start Tracking</strong> to begin working.
              </div>
            )}
            <div className="field-grid">
              <Select label="Employer" value={selectedEmployerId} items={employers} getId={(item) => item.emp_id} getLabel={(item) => item.company_name} onChange={(value) => {
                setSelectedEmployerId(value);
                setSelectedProjectId('');
                setSelectedTaskId('');
              }} />
              <Select label="Project" value={selectedProjectId} items={projects} getId={(item) => item.id} getLabel={(item) => item.title} onChange={(value) => {
                setSelectedProjectId(value);
                setSelectedTaskId('');
              }} />
              <Select label="Task" value={selectedTaskId} items={tasks} getId={(item) => item.id} getLabel={(item) => item.title} onChange={(value) => void handleTaskSelectionChange(value)} />
            </div>

            <div className="add-task-row">
              <input placeholder="New task title" value={newTaskTitle} onChange={(e) => setNewTaskTitle(e.target.value)} />
              <button className="secondary" type="button" onClick={handleAddTask}>Add Task</button>
            </div>

            <div className="actions">
              {!isTracking ? (
                <button type="button" onClick={startTracking}>
                  Start Tracking
                </button>
              ) : (
                <button className="danger" type="button" onClick={stopTracking}>
                  Stop Tracking
                </button>
              )}
              <button className="secondary" type="button" onClick={() => void refreshData()}>
                Refresh Tasks
              </button>
            </div>

            <p className={`status status-${statusKind}`}>{status}</p>
          </div>
 
          <div className="card task-complete-card">
            <h3>Selected Task</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>{selectedTask ? selectedTask.title : '-'}</div>
                <div style={{ color: '#6d7b91', fontSize: 13 }}>{selectedProject ? selectedProject.title : ''}</div>
                <div style={{ marginTop: 6, color: '#6d7b91', fontSize: 12 }}>Total hours: <strong style={{ color: '#172033' }}>{selectedTaskHours ?? '-'}</strong></div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={taskCompleted} disabled={!selectedTask} onChange={async (e) => {
                  const checked = e.target.checked;
                  setTaskCompleted(checked);
                  if (!selectedTask || !token) return;
                  reportStatus(checked ? 'Completing task...' : 'Reopening task...');
                  const res = await updateTaskStatus(token, selectedTask.id, checked ? 1 : 0);
                  if (res?.error_va_code) {
                    reportStatus(res.error_message ?? 'Error updating task.', 'error');
                  } else {
                    await refreshData(token);
                    reportStatus(checked ? 'Task completed' : 'Task reopened', 'success');
                  }
                }} />
                <span style={{ fontWeight: 700 }}>Completed</span>
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <h4 style={{ margin: '0 0 6px 0' }}>Recent completed tasks</h4>
              <ul style={{ margin: 0, paddingLeft: 14, fontSize: 12 }}>
                {recentCompletedTasks.length ? (recentCompletedTasks as any[]).map((t: any) => (
                  <li key={String(t.id)} style={{ marginBottom: 4 }}>
                    <div style={{ fontWeight: 700 }}>{t.title}</div>
                    <div style={{ fontSize: 12, color: '#6d7b91' }}>{t.completed_at ? new Date(t.completed_at).toLocaleString() : ''}</div>
                  </li>
                )) : <li style={{ color: '#6d7b91' }}>No recent completed tasks</li>}
              </ul>
            </div>
          </div>

          <div className="card activity-card">
            <h2>Activity</h2>
            <dl>
              
              <div><dt>Keystrokes</dt><dd>{activity.keystroke}</dd></div>
              <div><dt>Mouse clicks</dt><dd>{activity.mouseclick}</dd></div>
              <div><dt>Last screenshot</dt><dd>{lastCaptureAt ? new Date(lastCaptureAt).toLocaleTimeString() : '-'}</dd></div>
            </dl>
          </div>
        </section>
      )}

      {idlePopup && (
        <div className="idle-modal-overlay" role="dialog" aria-modal="true" aria-live="polite">
          <div className="idle-popup card">
            <div className="idle-header">Idle detected</div>
            <div className="idle-body">
              <p className="muted idle-duration-line">
                You have been idle for about{' '}
                <strong className="idle-duration">{formatIdleDuration(idleLiveSeconds)}</strong>.
                Please choose your status and explain why.
              </p>
              <label>
                Status
                <select value={idleSelectedStatus} onChange={(event) => setIdleSelectedStatus(event.target.value)}>
                  <option value="0">Working</option>
                  <option value="2">Breaktime</option>
                  <option value="3">Away</option>
                </select>
              </label>
              <label>
                Reason
                <input
                  value={idleRemark}
                  onChange={(event) => setIdleRemark(event.target.value)}
                  placeholder="Why were you idle?"
                />
              </label>
            </div>
            <div className="idle-actions">
              <button type="button" disabled={idleSubmitting || !idleRemark.trim()} onClick={() => void handleIdleGo()}>
                {idleSubmitting ? 'Sending...' : 'Go'}
              </button>
            </div>
          </div>
        </div>
      )}

      {unrelatedAlert && unrelatedAlert.visible && (
        <div className="unrelated-popup" role="dialog" aria-live="polite">
          <div className="unrelated-header">Unrelated activity detected</div>
          <div className="unrelated-body">
            <div><strong>Window:</strong> {unrelatedAlert.title || '-'}</div>
            <div><strong>Keywords:</strong> {unrelatedAlert.matches.join(', ')}</div>
          </div>
          <div className="unrelated-actions">
            <button className="secondary" onClick={() => setUnrelatedAlert(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </main>
  );
}

type SelectProps<T> = {
  label: string;
  value: string;
  items: T[];
  getId: (item: T) => string | number;
  getLabel: (item: T) => string;
  onChange: (value: string) => void;
};

function Select<T>({ label, value, items, getId, getLabel, onChange }: SelectProps<T>) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Select {label.toLowerCase()}</option>
        {items.map((item) => (
          <option key={String(getId(item))} value={String(getId(item))}>
            {getLabel(item)}
          </option>
        ))}
      </select>
    </label>
  );
}

function normalizeInterval(value: number | undefined, fallback: number) {
  if (!value || Number.isNaN(value)) {
    return fallback;
  }

  return value < 5 ? fallback : value;
}

export default App;
