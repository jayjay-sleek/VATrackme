# VA Worker Time Tracker

Electron + React rebuild of the worker time tracker desktop app.

## API

The app is wired to the existing local API:

```text
http://localhost/project/va/web/api/
```

Implemented endpoints:

- `POST /login`
- `GET /data?authtoken=...`
- `POST /postdata?authtoken=...`
- `POST /postdata?authtoken=...&type=capture&tracker_id=...`

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run dist
```

`npm run dist` creates platform installers through `electron-builder`.

## Current Desktop Support

- Worker login with the sample account prefilled.
- Employer, project, and task loading from the existing API.
- Start/stop heartbeat posting to `ApiController::actionPostdata`.
- Screenshot capture upload through Electron `desktopCapturer`.
- Idle detection through Electron `powerMonitor`.
- Basic activity counters while the app window is focused.

Native global keyboard/mouse counters and true foreground app/window detection need an additional signed/native module per platform before production release.
