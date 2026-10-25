# Android App in VS Code — SUVIDHA (VS Code Extension)

Embed the SUVIDHA Android app in a VS Code panel over **Wireless Debugging (ADB)** — no scrcpy window, no third-party app on the phone.

### Features

1. **Embedded live screen**:
   - Streams the device display straight into a webview panel.
   - Touch input is forwarded to the phone.
2. **Separate Virtual Display (default)**:
   - The app runs on its own virtual display, not mirrored from the phone screen.
   - The phone stays free for other apps, and the panel keeps rendering while the phone is locked / screen-off.
   - Turn it off with the `suvidha.virtualDisplay` setting to fall back to plain screen mirroring.
3. **Sleep friendly**:
   - Reconnects automatically when the phone sleeps or the link drops.
4. **Screenshot for AI**:
   - Saves a PNG to `suvidha-screenshots/` and offers an `@path` reference for chat.
5. **Configurable app**:
   - Set `suvidha.appPackage` (default `com.just_sri.suvidha.expenses`) to launch any Android app; the launcher activity is discovered automatically.
   - Set `suvidha.appName` (default `SUVIDHA`) to change the name shown in the panel, sidebar, status bar, and prompts.
6. **Deploy to all devices**:
   - Builds the debug APK and installs/launches it on every connected ADB device.
   - Point it at your Android project with `suvidha.androidProjectDir`, or leave it empty to use the open workspace.
   - Output streams to the **SUVIDHA Deploy** output channel.

### Requirements

- Android SDK platform-tools (`adb`) on `PATH`, or at `~/Library/Android/sdk/platform-tools/adb`.
- Android SDK build-tools (`aapt`) for **Deploy to All Connected Devices**.
- `scrcpy` 5.0.x installed locally so the extension can push its `scrcpy-server` jar (Homebrew paths are auto-detected).
- A USB-authorized device, or Wireless Debugging enabled.
- Currently supported host: macOS.

### Usage

- Run **Launch SUVIDHA Window** from the Command Palette, or click the app-name status bar item.
- Run **Capture Screenshot for AI** to grab the current frame.
- Run **Deploy to All Connected Devices** to build, install, and launch the app on every connected device. Set `suvidha.androidProjectDir` to your Android project (the folder containing `gradlew`); if empty, the open workspace is used.
- Change `suvidha.appName` or `suvidha.appPackage` in Settings. The name updates immediately; changing the package reconnects the panel and launches the new app.

### Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

### Privacy & access

See `docs/ACCESS.md` (bundled in the extension) for exactly what the extension runs on your Mac and your phone, and what data leaves the machine.
