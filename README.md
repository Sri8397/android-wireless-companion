# Android App in VS Code — SUVIDHA

Stream and interact with your Android apps directly inside a VS Code panel over **Wireless Debugging (ADB)**. The app runs on an independent virtual display, so your phone screen stays free for other tasks or locked. No floating windows, no cables, and no third-party companion apps needed on your phone.

---

## ⚡ Prerequisites

Before using the extension on macOS:

1. **Install ADB & scrcpy** via Homebrew (if not already installed):
   ```bash
   brew install scrcpy android-platform-tools
   ```
2. **Wi-Fi**: Ensure your Mac and Android phone are connected to the **same Wi-Fi network**.

---

## 📱 Connecting a New Device over Wi-Fi

Follow these simple steps to pair and connect your phone:

### Step 1: Turn on Wireless Debugging on Phone
1. Open **Settings > About Phone** and tap **Build Number** 7 times to unlock **Developer Options**.
2. Go to **Settings > System > Developer Options** (or search for *Developer Options*).
3. Toggle on **Wireless Debugging** (allow on your Wi-Fi network if prompted).

### Step 2: Connect directly from the VS Code UI (Recommended)
Open the **SUVIDHA** tab in your VS Code sidebar (`Controller`):

1. Click **Pair Device (Wireless Debugging)** (`🔗`):
   - On your phone, tap **"Pair device with pairing code"**.
   - In VS Code, enter the **IP address & Port** shown on your phone (e.g. `192.168.1.15:38153`).
   - Enter the **6-digit pairing code** (e.g. `841030`).
2. Click **Connect Device (IP:Port)** (`📶`):
   - Enter the **IP address & Port** shown on the main **Wireless Debugging** screen (e.g. `192.168.1.15:33617`).
3. Click **Open SUVIDHA Screen** (`📱`):
   - Your live phone app screen opens instantly in VS Code!

*(Note: In Android, the pairing port and connection port are different. Both are visible on your phone's Wireless Debugging screen).*

---

### Step 3: (Alternative) Connect via Terminal
If you prefer running commands manually in your terminal:

```bash
# 1. Refresh / start the ADB server
adb kill-server
adb start-server
adb version

# 2. Pair your device (IP & port from "Pair device with pairing code")
adb pair 192.168.1.15:38153
# Enter pairing code: 841030

# 3. Connect to your device (IP & port from main Wireless Debugging screen)
adb connect 192.168.1.15:33617

# 4. Verify connected devices
adb devices
# List of devices attached:
# 192.168.1.15:33617      device
```

---

## ✨ Features & Usage

| Feature | Action | Description |
|---|---|---|
| **Device Selection & Actions** | Click on any device in **Connected Devices** | Choose to set as active device, open screen, deploy debug build, or disconnect. |
| **Live Screen & Touch** | Click **Open SUVIDHA Screen** | Interacts in real time with taps, scrolls, and drag gestures inside the VS Code editor panel for the active device. |
| **Virtual Display** | Enabled by default | Runs the app on its own virtual display. The phone screen remains free and the panel stays alive even if the phone screen locks. |
| **Capture Screenshot for AI** | Click **Capture screenshot for AI** | Saves a high-res PNG to `suvidha-screenshots/` and copies an `@path` tag ready to paste into chat. |
| **Targeted / All Deploy** | Click **Deploy App...** or **Deploy to all devices** | Select whether to deploy to your active device, a specific device, or all connected devices at once. |
| **Restart ADB Server** | Click **Restart ADB Server** (`🔄`) | Cleans up and restarts the local ADB daemon whenever connection gets interrupted. |
| **Disconnect Device** | Click **Disconnect Wireless Device** | Disconnects the selected wireless phone cleanly. |

---

## ⚙️ Settings & Customization

You can customize the extension in **VS Code Settings** (`Cmd + ,` > search for `suvidha`):

| Setting | Default | Description |
|---|---|---|
| `suvidha.appName` | `SUVIDHA` | Display name shown in the panel title, sidebar, status bar, and notifications. |
| `suvidha.appPackage` | `com.just_sri.suvidha.expenses` | Android package name of the app to launch (e.g. `com.example.myapp`). Changing this reconnects and launches the new app. |
| `suvidha.virtualDisplay` | `true` | When `true`, runs on an independent virtual display. Set to `false` for direct screen mirroring. |
| `suvidha.keepActive` | `true` | Prevents the phone screen from sleeping while the panel is open. |
| `suvidha.inDisplayScrollbar` | `true` | Toggles the in-display scrollbar on the right edge of the phone view. |
| `suvidha.androidProjectDir` | *(empty)* | Absolute path to the folder containing your Android project (`gradlew`). If empty, the current open workspace is used. |

---

## 🛠️ Troubleshooting

* **"No Android device found"**:
  - Check that **Wireless Debugging** is still toggled ON on your phone.
  - In the sidebar, click **Restart ADB Server** (`🔄`) or **Connect Device (IP:Port)**.
  - If your phone reconnected to Wi-Fi, Android may assign a new connect port. Check the port in your phone's Wireless Debugging screen and connect again.
* **Touch input not responding**:
  - In Developer Options, verify that **USB debugging (Security settings)** or **Input via ADB** is allowed if your phone manufacturer requires it (e.g. Xiaomi / HyperOS / MIUI).

---

## 🔒 Privacy & Access

The extension communicates strictly with your local device over loopback ADB (`127.0.0.1`). No data, screenshots, or telemetry are ever collected or sent over the internet. See `docs/ACCESS.md` for complete technical details.
