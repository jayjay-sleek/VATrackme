import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// production renderer error reporting
if (typeof window !== 'undefined' && (window as any).desktopApi && (process.env.NODE_ENV === 'production' || true)) {
  window.addEventListener('error', (ev) => {
    try {
      window.desktopApi.log({ level: 'error', message: ev.message || String(ev.error || ev) });
    } catch (e) {}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      window.desktopApi.log({ level: 'error', message: (ev.reason && ev.reason.message) || String(ev.reason || ev) });
    } catch (e) {}
  });
}
