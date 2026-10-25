# Access & Data Handling

What Android App in VS Code — SUVIDHA touches on your machine, runs on the phone, and where data goes.

## On your computer

- **Uses `adb`** from Android SDK platform-tools — found via `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `~/Library/Android/sdk`, `~/Android/Sdk`, `/opt/homebrew/bin`, `/usr/local/bin`, then `PATH`. It is never bundled or modified.
- **Ships its own `scrcpy-server.jar`** (inside the extension) and pushes it to the phone on each session.
- **Reads**: settings (`suvidha.appName`, `suvidha.appPackage`, `suvidha.virtualDisplay`, `suvidha.keepActive`, `suvidha.inDisplayScrollbar`, `suvidha.androidProjectDir`) and the workspace folder path.
- **Writes**: `suvidha-screenshots/*.png` — only when you click **Add to chat**.
- **Deploy command** (only when you run **Deploy to All Connected Devices**): runs the bundled `scripts/deploy_all_devices.sh` with `ANDROID_PROJECT_DIR` set. That script runs `./gradlew assembleDebug` in your Android project, writes Gradle build outputs there, then uses `adb install`, `adb shell am force-stop`, and `adb shell am start` on each connected device. Output goes to the **SUVIDHA Deploy** output channel.
- **Binds** one TCP listener on `127.0.0.1` (random port), used for the video stream, closed on exit.
- **Clipboard**: written only by **Add to chat** (PNG, or `@path` fallback).
- **No** outbound network requests, telemetry, analytics, or accounts.

## On your phone (runs as adb `shell`, uid 2000)

| What | Command | Why |
|---|---|---|
| Find the device | `adb devices` | Pick the wireless device |
| Copy the server | `adb push scrcpy-server.jar /data/local/tmp/` | Run the capture server |
| Open the stream | `adb reverse localabstract:scrcpy_<id> tcp:<port>` | Loopback-only tunnel |
| Start capture | `app_process … scrcpy.Server … audio=false video=true` | Encode the virtual display |
| Launch the app | `am force-stop`, `am start --display <n> -n …` | Configured app on its own display |
| Read state | `wm size`, `wm density`, `dumpsys power`, `ps -A` | Display size, sleep state, own process |
| Wake the phone | `input keyevent 224`, `wm dismiss-keyguard` | **Wake phone** button |
| Clean up | `kill -9 <own scid>`, `adb reverse --remove` | Leave nothing behind |

- **Captured:** H.264 video of the **virtual display it creates** (720×1570, ~30 fps, ~4 Mbps). Audio, camera, and microphone are all disabled.
- **Injected:** touch coordinates from taps/drags on the preview. No keyboard input, no accessibility service.
- **Not read:** storage, photos, messages, contacts, accounts, notifications, other apps' data.

## What leaves the machine

- Video frames: extension host → webview, in-process only.
- Screenshots: written to the workspace; nothing is uploaded.
- Nothing is sent to the internet by the extension. A screenshot reaches an AI chat only if **you** paste it there.

## Lifecycle

- **Closing the panel** (tab, window, or IDE quit): sockets closed, server killed by `scid`, reverse tunnel removed, virtual display released, app process on that display ends.
- **After a crash/force-quit**: the next launch kills leftover servers matching this extension's exact signature.
- **Phone sleeps**: Android powers down virtual displays, so the preview pauses instead of going black; it resumes automatically when the phone wakes.

## Settings

- `suvidha.appName` (default `SUVIDHA`) — app name shown in the panel, sidebar, status bar, and prompts.
- `suvidha.appPackage` (default `com.just_sri.suvidha.expenses`) — Android package to launch. Its launcher activity is resolved with `cmd package resolve-activity`.
- `suvidha.virtualDisplay` (default `true`) — separate virtual display vs. mirroring the phone screen.
- `suvidha.keepActive` (default `true`) — simulate activity so the phone's screen timeout never fires while the panel is open.
- `suvidha.androidProjectDir` (default empty) — absolute path to the Android project containing `gradlew`, used by **Deploy to All Connected Devices**. Empty means the open workspace folder.

## Requirements

- `adb` (Android platform-tools) on the machine.
- Android 11+ with Wireless debugging enabled, and the device authorized for ADB.
