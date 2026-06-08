# Install VA Trackme on macOS

## Why macOS shows "Apple could not verify..."

The app is not yet signed with an **Apple Developer ID** certificate and **notarized** by Apple. This is normal for internal/test builds. macOS Gatekeeper blocks unknown apps until you allow them once.

## Open the app (recommended)

1. Open the DMG and drag **VA Trackme** to **Applications**.
2. Open **Applications** in Finder.
3. **Right-click** (or Control-click) **VA Trackme** → **Open**.
4. Click **Open** in the dialog (not Cancel).

After the first successful launch, you can open it normally.

## Alternative: System Settings

1. Try to open the app once (it will be blocked).
2. Open **System Settings** → **Privacy & Security**.
3. Scroll down and click **Open Anyway** next to the VA Trackme message.
4. Confirm **Open**.

## Alternative: Terminal (remove quarantine)

If the app was downloaded from the browser, macOS may mark it as quarantined:

```bash
xattr -cr "/Applications/VA Trackme.app"
```

Then open the app from Applications (right-click → Open the first time).

## Permanent fix (for distribution)

To remove this warning for all users, you need:

1. **Apple Developer Program** membership ($99/year)
2. **Developer ID Application** certificate
3. CI secrets for macOS signing and notarization:
   - `MAC_CERT_BASE64` — base64 of `.p12` certificate
   - `MAC_CERT_PASSWORD` — certificate password
   - `APPLE_ID` — Apple ID email
   - `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password from appleid.apple.com
   - `APPLE_TEAM_ID` — Team ID from developer.apple.com

When those secrets are added to GitHub, the **Build macOS Installer** workflow will produce a signed and notarized DMG that opens without the malware warning.
