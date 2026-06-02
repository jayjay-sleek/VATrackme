CI build & signing (Windows)

Overview
- This project includes a GitHub Actions workflow that builds the renderer, packages the Electron app, and signs the Windows installer using a PFX code-signing certificate.

What you need to provide
- Two GitHub repository secrets:
  - PFX_BASE64 — the base64 encoding of your codesign .pfx file.
  - PFX_PASSWORD — the password for the PFX file.

How to create the base64 string (PowerShell)
1. On your Windows machine run:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\path\to\your\codesign.pfx')) | Out-File -Encoding ASCII pfx.b64
```

2. Open `pfx.b64` and copy its contents into the GitHub secret `PFX_BASE64`. Set `PFX_PASSWORD` to the PFX password.

How the workflow works
- File: `.github/workflows/windows-sign-and-build.yml`
- Trigger: manual (workflow_dispatch) or tag push (v*).
- Steps:
  1. Checkout and install dependencies.
  2. Build the renderer (`npm run build`).
  3. Write `build/codesign.pfx` from `PFX_BASE64`.
  4. Run `electron-builder` with CSC_LINK pointing to `build/codesign.pfx` and CSC_KEY_PASSWORD from `PFX_PASSWORD`.
  5. Upload the generated installer (artifact `va-trackme-windows-installer`).

Notes and recommendations
- A CA-signed certificate is recommended for production releases (SmartScreen/trusted publisher).
- The workflow uses `windows-latest` runner; secrets never leave GitHub runners and are not printed in logs.
- If you prefer I can:
  - configure the workflow to build for multiple platforms,
  - add code signing timestamp server configuration,
  - or help purchase and install a CA-signed certificate.

