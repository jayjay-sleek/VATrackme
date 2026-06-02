import { useEffect, useMemo, useRef, useState } from 'react';
import { getTrackerData, login, postHeartbeat, uploadScreenshot, addTask, updateTaskStatus, API_BASE_URL } from './api';
import type { Employer, Project, Task, TrackerData, TrackingSelection } from './types';

const savedTokenKey = 'va-tracker-auth-token';
const defaultHeartbeatSeconds = 60;
const defaultScreenshotSeconds = 600;

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
  const [status, setStatus] = useState('Ready');
  const [unrelatedAlert, setUnrelatedAlert] = useState<{
    matches: string[];
    title: string;
    visible: boolean;
  } | null>(null);
  const [showUnrelatedBanner, setShowUnrelatedBanner] = useState(false);
  const [ignoredKeywords, setIgnoredKeywords] = useState<Record<string, string[]>>(() => {
    try { return JSON.parse(localStorage.getItem('va-ignored-keywords') || '{}'); } catch { return {}; }
  });
  const [snoozes, setSnoozes] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('va-snoozes') || '{}'); } catch { return {}; }
  });
  const [debugActiveWindow, setDebugActiveWindow] = useState<{ title: string; module: string } | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [lastDetectedMatches, setLastDetectedMatches] = useState<string[]>([]);
  const [lastActiveTitle, setLastActiveTitle] = useState<string>('');
  const [testKeyword, setTestKeyword] = useState('');
  const [activity, setActivity] = useState({ keystroke: 0, mouseclick: 0, mousemove: 0 });
  const [lastCaptureAt, setLastCaptureAt] = useState<number | null>(null);
  const heartbeatTimer = useRef<number | null>(null);
  const screenshotTimer = useRef<number | null>(null);
  const trackerIdRef = useRef<number | undefined>();
  const activityRef = useRef(activity);
  const [isAppFocused, setIsAppFocused] = useState(true);
  const fallbackTimer = useRef<number | null>(null);

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
  const selectedTaskHours = (selectedTask && ((selectedTask as any).task_total_hours ?? (selectedTask as any).total_hours ?? (selectedTask as any).hours_consumed ?? (selectedTask as any).time_spent ?? (selectedTask as any).hours)) || null;
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

  const defaultUnrelated = [
    'facebook', 'twitter', 'instagram', 'tiktok', 'youtube', 'pinterest',
    'reddit', 'snapchat', 'steam', 'epic games', 'league of legends', 'fortnite', 'roblox',
    'discord', 'netflix', 'hulu', 'twitch'
  ];
  const employerKeywords = (() => {
    const val = selectedEmployer && (selectedEmployer as any).unrelated_keywords;
    if (!val) return defaultUnrelated;
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      return val.split(',').map((s) => s.trim()).filter(Boolean);
    }
    return defaultUnrelated;
  })();

  useEffect(() => {
    if (token) {
      void refreshData(token);
    }
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

  async function refreshData(authToken = token) {
    setStatus('Loading projects and tasks...');
    const nextData = await getTrackerData(authToken);

    if (nextData.error_va_code) {
      // if auth invalid or session taken over, sign out automatically
      const msg = (nextData.error_message || '').toLowerCase();
      if (nextData.error_va_code === 401 || msg.includes('another device') || msg.includes('already logged') || msg.includes('invalid token') || msg.includes('session')) {
        // automatic logout
        signOut();
        setStatus(nextData.error_message ?? 'Signed out due to session change.');
        return;
      }
      setStatus(nextData.error_message ?? 'Unable to load tracker data.');
      return;
    }

    setData(nextData);
    setStatus('Projects and tasks loaded.');

    const firstEmployer = Object.values(nextData.employers ?? {})[0];
    const firstProject = firstEmployer ? Object.values(firstEmployer.projects ?? {})[0] : undefined;
    const firstTask = firstProject ? Object.values((firstProject as any).tasks ?? {})[0] : undefined;

    // preserve existing selections; only set defaults when empty
    if (!selectedEmployerId && firstEmployer) {
      setSelectedEmployerId(String(firstEmployer.emp_id));
    }
    if (!selectedProjectId && firstProject) {
      setSelectedProjectId(String((firstProject as any).id));
    }
    if (!selectedTaskId && firstTask) {
      setSelectedTaskId(String((firstTask as any).id));
    }
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setStatus('Signing in...');

    const response = await login(userName, password);
    if ('error_message' in response) {
      setStatus(response.error_message);
      return;
    }

    if (autoLogin) {
      localStorage.setItem(savedTokenKey, response.user_auth_key);
      localStorage.setItem('va-auto-login', '1');
    } else {
      localStorage.removeItem(savedTokenKey);
      localStorage.setItem('va-auto-login', '0');
    }
    setToken(response.user_auth_key);
    setStatus(response.success_message);
  }

  async function handleAddTask() {
    if (!token) {
      setStatus('Sign in first.');
      return;
    }
    if (!selectedProject) {
      setStatus('Select a project to add a task.');
      return;
    }
    const title = newTaskTitle.trim();
    if (!title) {
      setStatus('Enter a task title.');
      return;
    }
    setStatus('Creating task...');
    const res = await addTask(token, selectedProject.id, title);
    if (res?.id) {
      await refreshData(token);
      setSelectedTaskId(String(res.id));
      setNewTaskTitle('');
      setStatus('Task created.');
    } else {
      setStatus(res?.error_message ?? 'Failed to create task.');
    }
  }

  // removed: manual capture button; window capture is now automatic when creating a default task

  async function startTracking() {
    if (!token) {
      setStatus('Sign in first.');
      return;
    }

    // If there's no selected task but a project is chosen, create a default task.
    if (!selection) {
      if (!selectedProject) {
        setStatus('Select a project before starting the tracker.');
        return;
      }

      setStatus('Creating default task...');
      // Try to use the active window title for the default task; fallback to project-based name.
      const aw = await window.desktopApi.getActiveWindow();
      const windowTitle = aw?.windowTitle ? String(aw.windowTitle).trim() : '';
      const defaultTitle = windowTitle && windowTitle.length > 0 ? windowTitle : `${selectedProject.title} task`;
      const created = await addTask(token, selectedProject.id, defaultTitle);
      if (created?.id) {
        await refreshData(token);
        setSelectedTaskId(String(created.id));
      } else {
        setStatus(created?.error_message ?? 'Failed to create default task.');
        return;
      }
    }

    const currentSelection: TrackingSelection = selection ?? {
      employer: selectedEmployer!,
      project: selectedProject!,
      task: tasks.find((t) => String(t.id) === selectedTaskId)!,
    };

    setIsTracking(true);
    setStatus(`Tracking: ${currentSelection.task.title}`);
    const result = await sendHeartbeat(currentSelection, 1);

    if (result?.id) {
      updateTrackerId(result.id);
    }

    const heartbeatSeconds = normalizeInterval(data?.interval_send_data, defaultHeartbeatSeconds);
    const screenshotSeconds = normalizeInterval(result?.interval_send_screen_capture ?? data?.interval_send_screen_capture, defaultScreenshotSeconds);

    heartbeatTimer.current = window.setInterval(() => {
      void sendHeartbeat(currentSelection, 1);
    }, heartbeatSeconds * 1000);

    screenshotTimer.current = window.setInterval(() => {
      void sendScreenshot();
    }, screenshotSeconds * 1000);
  }

  async function stopTracking() {
    if (selection) {
      await sendHeartbeat(selection, 0);
    }

    stopTimers();
    setIsTracking(false);
    updateTrackerId(undefined);
    setStatus('Tracking stopped.');
  }

  async function sendHeartbeat(currentSelection: TrackingSelection, timeInOut: 0 | 1) {
    const idleSeconds = await window.desktopApi.getIdleSeconds();
    const activeWindow = await window.desktopApi.getActiveWindow();
    setDebugActiveWindow({ title: activeWindow?.windowTitle || '', module: activeWindow?.moduleName || '' });
    setLastActiveTitle(activeWindow?.windowTitle || '');
    const idleMinutes = idleSeconds / 60;
    const idleLimit = Number(data?.minute_idle_time ?? 0);
    // idle_status codes: 0=Working,1=Idle,2=Breaktime,3=Away,4=Absent
    let idleStatus = 0;
    if (idleLimit > 0 && idleMinutes >= idleLimit) {
      idleStatus = 1; // Idle reached
    } else {
      idleStatus = 0; // Working
    }
    // detect unrelated by checking active window title and module name for keywords
    let unrelatedMatches: string[] = [];
    const titleToCheck = (activeWindow?.windowTitle || '') + ' ' + (activeWindow?.moduleName || '') + ' ' + (activeWindow?.moduleFilename || '');

    // ignore detection when the active window belongs to this app
    const appNameChecks = ['va worker time tracker', 'va-worker-time-tracker', 'va_worker_time_tracker', 'va4hire', 'va worker'];
    const lcTitle = (activeWindow?.windowTitle || '').toLowerCase();
    const lcModule = (activeWindow?.moduleName || '').toLowerCase();
    let isSelf = false;
    for (const a of appNameChecks) {
      if (lcTitle.indexOf(a) !== -1 || lcModule.indexOf(a) !== -1) {
        isSelf = true;
        break;
      }
    }
    if (isSelf) {
      // do not flag our own app window as unrelated; continue to send heartbeat without detection
      unrelatedMatches = [];
    } else {
      for (const kw of employerKeywords) {
        const k = String(kw).toLowerCase().trim();
        if (!k) continue;
        if (titleToCheck.toLowerCase().indexOf(k) !== -1) {
          unrelatedMatches.push(k);
        }
      }
    }
    const lc = titleToCheck.toLowerCase();
    for (const kw of employerKeywords) {
      const k = String(kw).toLowerCase().trim();
      if (!k) continue;
      if (lc.indexOf(k) !== -1) {
        unrelatedMatches.push(k);
      }
    }

    // filter by ignored keywords for this task
    const taskIdKey = String(currentSelection?.task?.id || selectedTaskId || '');
    const taskIgnored = ignoredKeywords[taskIdKey] || [];
    unrelatedMatches = unrelatedMatches.filter(k => !taskIgnored.includes(k));
    // filter by snooze
    const nowTs = Date.now();
    unrelatedMatches = unrelatedMatches.filter(k => {
      const until = snoozes[k];
      return !(until && until > nowTs);
    });

    let remarkExtra = '';
    if (unrelatedMatches.length) {
      remarkExtra = 'UNRELATED:' + unrelatedMatches.join(',');
      // show an in-app popup and native notification when unrelated detected
      try {
        setUnrelatedAlert({ matches: unrelatedMatches, title: activeWindow?.windowTitle || '', visible: true });
        setShowUnrelatedBanner(true);
        // debug modal to force visibility when debugging
        if (showDebug) {
          try { window.alert('Unrelated detected: ' + unrelatedMatches.join(', ')); } catch (e) {}
        }
        if (typeof window !== 'undefined' && 'Notification' in window) {
          try {
            new window.Notification('Unrelated activity detected', {
              body: `${unrelatedMatches.join(', ')} — ${activeWindow?.windowTitle || ''}`,
            });
          } catch (e) {}
        }
        try { window.desktopApi.log({ level: 'warn', message: 'Unrelated detected: ' + unrelatedMatches.join(', ') }); } catch (e) {}
      } catch (e) {}
    }

    const result = await postHeartbeat({
      authtoken: token,
      trackerId: trackerIdRef.current,
      selection: currentSelection,
      timeInOut,
      idleStatus,
      remark: (idleStatus ? `Idle for ${Math.round(idleMinutes)} minutes` : '') + (remarkExtra ? ' | ' + remarkExtra : ''),
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
        setStatus(result.error_message ?? 'Signed out due to session change.');
        return result;
      }
      setStatus(result.error_message ?? 'Unable to send tracker data.');
      return result;
    }

    if (result.id) {
      updateTrackerId(result.id);
    }

    setData((current) => current ? { ...current, hours_work_today: result.hours_work_today ?? current.hours_work_today } : current);
    setActivity({ keystroke: 0, mouseclick: 0, mousemove: 0 });
    activityRef.current = { keystroke: 0, mouseclick: 0, mousemove: 0 };
    setStatus(`Last synced ${new Date().toLocaleTimeString()}`);
    return result;
  }

  // Run detection immediately (debug / manual trigger)
  async function runDetectionNow() {
    if (!token) return;
    const activeWindow = await window.desktopApi.getActiveWindow();
    setDebugActiveWindow({ title: activeWindow?.windowTitle || '', module: activeWindow?.moduleName || '' });
    const titleToCheck = (activeWindow?.windowTitle || '') + ' ' + (activeWindow?.moduleName || '') + ' ' + (activeWindow?.moduleFilename || '');
    const lc = titleToCheck.toLowerCase();
    let matches: string[] = [];
    for (const kw of employerKeywords) {
      const k = String(kw).toLowerCase().trim();
      if (!k) continue;
      if (lc.indexOf(k) !== -1) matches.push(k);
    }
    setLastDetectedMatches(matches);
    if (matches.length) {
      // trigger the same popup flow
      setUnrelatedAlert({ matches, title: activeWindow?.windowTitle || '', visible: true });
      setShowUnrelatedBanner(true);
      try { window.desktopApi.log({ level: 'warn', message: 'Manual detect: ' + matches.join(', ') }); } catch (e) {}
    }
  }

  async function sendScreenshot() {
    if (!token || !trackerIdRef.current) {
      return;
    }

    const capture = await window.desktopApi.captureScreen();
    if (!capture) {
      setStatus('Unable to capture screen.');
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

    if (screenshotTimer.current) {
      window.clearInterval(screenshotTimer.current);
      screenshotTimer.current = null;
    }
  }

  function signOut() {
    void stopTracking();
    localStorage.removeItem(savedTokenKey);
    setToken('');
    setData(null);
    setStatus('Signed out.');
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

  // popup actions
  async function markAsRelated() {
    if (!token || !trackerIdRef.current) return;
    // send a simple postHeartbeat that clears remark unrelated
    const sel = selection ?? {
      employer: selectedEmployer!,
      project: selectedProject!,
      task: tasks.find((t) => String(t.id) === selectedTaskId)!,
    };
    // remove UNRELATED from remark by sending empty remark
    await sendHeartbeat(sel, 1);
    // also inform server explicitly by posting to postdata with empty remark for the tracker id
    try {
      await window.desktopApi.apiRequest({
        method: 'POST',
        path: 'postdata/',
        query: { authtoken: token },
        bodyType: 'form',
        body: { 'Timetracker[id]': String(trackerIdRef.current), 'Timetracker[remark]': '' },
      });
    } catch (e) {}
    setUnrelatedAlert(null);
  }

  function snoozeKeyword(keyword: string, minutes = 30) {
    const until = Date.now() + minutes * 60 * 1000;
    const next = { ...snoozes, [keyword]: until };
    setSnoozes(next);
    localStorage.setItem('va-snoozes', JSON.stringify(next));
    setUnrelatedAlert(null);
  }

  function ignoreKeywordForTask(keyword: string) {
    const taskIdKey = String(selectedTaskId || '');
    const arr = (ignoredKeywords[taskIdKey] || []).slice();
    if (!arr.includes(keyword)) arr.push(keyword);
    const next = { ...ignoredKeywords, [taskIdKey]: arr };
    setIgnoredKeywords(next);
    localStorage.setItem('va-ignored-keywords', JSON.stringify(next));
    setUnrelatedAlert(null);
  }

  return (
    <main className="app-shell compact">
      <section className="hero">
        <div>
          <p className="eyebrow">VA Trackme</p>
          <h1>Track task time from your desktop.</h1>
          <p className="muted connected">
            <span className="status-dot" /> Connected
          </p>
        </div>
        {token && (
          <button className="secondary" type="button" onClick={signOut}>
            Sign out
          </button>
        )}
      </section>

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
          <p className="status">{status}</p>
          </form>
        </div>
      ) : (
        <section className="dashboard">
          <div className="card profile-card">
            <div>
              <p className="eyebrow">Signed In</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <img src={data?.profile_url} alt="profile" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover', border: '1px solid #e6edf6' }} />
                <div>
                  <h2 style={{ margin: 0 }}>{data ? `${data.first_name} ${data.last_name}` : 'Loading...'}</h2>
                  <p className="muted" style={{ margin: 0 }}>{data?.title ?? data?.user_name}</p>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div className="metric" style={{ minWidth: 90 }}>
                <span>Today</span>
                <strong>{data?.hours_work_today ?? '0:00'}</strong>
              </div>
              <div>
                <button className="secondary" onClick={openDashboard} style={{ padding: '8px 10px' }}>Open Dashboard</button>
              </div>
            </div>
          </div>

          <div className="card tracker-card">
            <h2>Current Task</h2>
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
              <Select label="Task" value={selectedTaskId} items={tasks} getId={(item) => item.id} getLabel={(item) => item.title} onChange={setSelectedTaskId} />
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

            <p className="status">{status}</p>
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
                  setStatus(checked ? 'Completing task...' : 'Reopening task...');
                  const res = await updateTaskStatus(token, selectedTask.id, checked ? 1 : 0);
                  if (res?.error_va_code) {
                    setStatus(res.error_message ?? 'Error updating task.');
                  } else {
                    await refreshData(token);
                    setStatus(checked ? 'Task completed' : 'Task reopened');
                  }
                }} />
                <span style={{ fontWeight: 700 }}>Completed</span>
              </label>
            </div>
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: '0 0 8px 0' }}>Recent completed tasks</h4>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {recentCompletedTasks.length ? (recentCompletedTasks as any[]).map((t: any) => (
                  <li key={String(t.id)} style={{ marginBottom: 6 }}>
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
              <div><dt>Mouse moves</dt><dd>{activity.mousemove}</dd></div>
              <div><dt>Last screenshot</dt><dd>{lastCaptureAt ? new Date(lastCaptureAt).toLocaleTimeString() : '-'}</dd></div>
            </dl>
          </div>
        </section>
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
            <button className="secondary" onClick={() => markAsRelated()}>Mark as related</button>
            <button className="secondary" onClick={() => { if (unrelatedAlert.matches[0]) snoozeKeyword(unrelatedAlert.matches[0], 30); }}>Snooze 30m</button>
            <button className="secondary" onClick={() => { if (unrelatedAlert.matches[0]) ignoreKeywordForTask(unrelatedAlert.matches[0]); }}>Ignore for task</button>
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
