# Changelog

## 1.0.0

- Initial release.
- Embedded SUVIDHA screen over Wireless Debugging (ADB), rendered in a VS Code webview.
- Separate virtual display by default, with an opt-out for plain screen mirroring.
- Automatic reconnect when the phone sleeps or the link drops.
- Screenshot capture with an `@path` reference for AI chat.
- Configurable app name (`suvidha.appName`) and target Android package (`suvidha.appPackage`); the launcher activity is resolved automatically.
