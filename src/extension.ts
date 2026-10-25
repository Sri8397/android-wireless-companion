import * as vscode from 'vscode';
import * as cp from 'child_process';
import { spawn } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

// ─── Scrcpy Protocol Constants ──────────────────────────────────────────────
const SCRCPY_VERSION = '5.0.1';
const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
const DEFAULT_APP_NAME = 'SUVIDHA';
const DEFAULT_APP_PACKAGE = 'com.just_sri.suvidha.expenses';

function getConfiguredString(key: string, fallback: string): string {
    const configured = vscode.workspace
        .getConfiguration('suvidha')
        .get<string>(key, fallback);
    return configured?.trim() || fallback;
}

function getAppName(): string {
    return getConfiguredString('appName', DEFAULT_APP_NAME);
}

function getAppPackage(): string {
    return getConfiguredString('appPackage', DEFAULT_APP_PACKAGE);
}

// ─── Reverse-Engineered Scrcpy Client ───────────────────────────────────────
class ScrcpyClient {
    private tcpServer?: net.Server;
    private videoSocket?: net.Socket;
    private controlSocket?: net.Socket;
    private serverProcess?: cp.ChildProcess;
    private stopping = false;
    private videoConnected = false;
    private port: number = 0;
    private scid: string = '';
    private socketName: string = '';
    private deviceName: string = '';
    private videoBuf: Buffer = Buffer.alloc(0);
    private parseState: 'NAME' | 'CODEC' | 'STREAM' = 'NAME';
    private configBuffer: Buffer = Buffer.alloc(0);
    private frameIndex: number = 0;

    private onFrame?: (nalUnit: Buffer, isKeyframe: boolean, timestampUs: number) => void;
    private onDeviceName?: (name: string) => void;
    private onSessionSize?: (width: number, height: number) => void;
    private onStatus?: (status: string) => void;
    private onError?: (message: string) => void;
    private onServerLog?: (line: string) => void;
    private onClose?: () => void;

    private adbPath: string;
    private serial: string;
    private serverJarPath: string;
    private useVirtualDisplay: boolean;
    private keepActive: boolean;
    private targetPackage: string;
    private virtualDisplaySpec = '';
    private serverTail = '';
    public sessionWidth: number = 720;
    public sessionHeight: number = 1570;
    private activeSwipePromise: Promise<void> = Promise.resolve();

    constructor(
        adbPath: string,
        serial: string,
        useVirtualDisplay: boolean = true,
        keepActive: boolean = true,
        targetPackage: string = DEFAULT_APP_PACKAGE
    ) {
        this.adbPath = adbPath;
        this.useVirtualDisplay = useVirtualDisplay;
        this.keepActive = keepActive;
        this.serial = serial;
        this.targetPackage = targetPackage;
        const bundled = path.join(__dirname, '..', 'resources', 'scrcpy-server.jar');
        const candidates = [
            bundled,
            '/opt/homebrew/Cellar/scrcpy/5.0.1/share/scrcpy/scrcpy-server',
            '/opt/homebrew/share/scrcpy/scrcpy-server',
            '/usr/local/share/scrcpy/scrcpy-server',
        ];
        this.serverJarPath = candidates.find(p => fs.existsSync(p)) || bundled;
    }

    public setFrameCallback(cb: (nalUnit: Buffer, isKeyframe: boolean, timestampUs: number) => void) {
        this.onFrame = cb;
    }

    public setDeviceNameCallback(cb: (name: string) => void) {
        this.onDeviceName = cb;
    }

    public setSessionSizeCallback(cb: (width: number, height: number) => void) {
        this.onSessionSize = cb;
    }

    public setStatusCallback(cb: (status: string) => void) {
        this.onStatus = cb;
    }

    public setErrorCallback(cb: (message: string) => void) {
        this.onError = cb;
    }

    public setServerLogCallback(cb: (line: string) => void) {
        this.onServerLog = cb;
    }

    public setCloseCallback(cb: () => void) {
        this.onClose = cb;
    }

    public async start(): Promise<void> {
        this.onStatus?.('Generating connection tunnel...');
        this.scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
        this.socketName = `scrcpy_${this.scid}`;

        // 1. Push server jar
        if (!fs.existsSync(this.serverJarPath)) {
            throw new Error(`scrcpy-server.jar is missing from the extension bundle (${this.serverJarPath}).`);
        }
        this.onStatus?.('Pushing scrcpy-server to device...');
        await this.adbExec(['push', this.serverJarPath, DEVICE_SERVER_PATH]);

        // 2. Start TCP server on host
        this.port = await this.startTcpServer();

        // 3. Set up adb reverse tunnel
        this.onStatus?.('Establishing reverse tunnel...');
        await this.adbExec(['reverse', `localabstract:${this.socketName}`, `tcp:${this.port}`]);

        // 3b. Sweep sessions left behind by a previous crash/force-quit.
        await this.cleanupStaleServers();

        // 4. Prepare the separate virtual display (independent from the phone screen)
        if (this.useVirtualDisplay) {
            this.onStatus?.('Preparing a separate virtual display...');
            try {
                const metrics = await this.deviceMetrics();
                this.virtualDisplaySpec = `${metrics.width}x${metrics.height}/${metrics.density}`;
                // Start from a clean slate so the app is guaranteed to open on the
                // virtual display rather than re-using an instance on the phone screen.
                await this.adbExec(['shell', 'am', 'force-stop', this.targetPackage]);
            } catch (e: any) {
                this.onError?.(`Could not read the device display size: ${e.message}`);
            }
        }

        // 5. Launch server on device
        this.onStatus?.('Launching scrcpy-server on device...');
        this.launchServer();

        // 6. Watchdog: a dead or misconfigured server must not spin forever.
        setTimeout(() => {
            if (!this.videoConnected && !this.stopping) {
                this.onError?.(
                    'No video stream from the device after 15s. Make sure the phone is unlocked and `adb devices` still shows it as "device".'
                );
            }
        }, 15000);
    }

    private adbExec(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const fullArgs = ['-s', this.serial, ...args];
            cp.execFile(this.adbPath, fullArgs, { timeout: 15000 }, (err, stdout, stderr) => {
                if (err) {
                    reject(new Error(`adb ${args.join(' ')} failed: ${stderr || err.message}`));
                } else {
                    resolve(stdout.trim());
                }
            });
        });
    }

    private startTcpServer(): Promise<number> {
        return new Promise((resolve) => {
            let socketCount = 0;
            this.tcpServer = net.createServer((socket) => {
                socketCount++;
                if (socketCount === 1) {
                    this.videoSocket = socket;
                    this.handleVideoSocket(socket);
                } else if (socketCount === 2) {
                    this.controlSocket = socket;
                    console.log('[scrcpy] Control socket connected');
                }
            });

            this.tcpServer.listen(0, '127.0.0.1', () => {
                const addr = this.tcpServer!.address() as net.AddressInfo;
                resolve(addr.port);
            });
        });
    }

    private launchServer() {
        const serverArgs = [
            '-s', this.serial, 'shell',
            `CLASSPATH=${DEVICE_SERVER_PATH}`,
            'app_process', '/',
            'com.genymobile.scrcpy.Server',
            SCRCPY_VERSION,
            `scid=${this.scid}`,
            'log_level=info',
            'audio=false',
            'video=true',
            'control=true',
            'max_fps=30',
            'video_bit_rate=4000000',
        ];

        if (this.keepActive) {
            // Resets the screen timeout with synthetic activity, so the phone (and
            // therefore its virtual display) does not power down while mirroring.
            serverArgs.push('keep_active=true');
        }

        if (this.useVirtualDisplay && this.virtualDisplaySpec) {
            // Dedicated display: the app never touches the phone's own screen and
            // keeps rendering while the physical screen is off/locked.
            serverArgs.push(`new_display=${this.virtualDisplaySpec}`, 'vd_system_decorations=false');
        } else {
            serverArgs.push('max_size=720');
        }

        this.serverProcess = cp.spawn(this.adbPath, serverArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        this.serverProcess.stderr?.on('data', (d) => this.handleServerOutput(d.toString()));
        this.serverProcess.stdout?.on('data', (d) => this.handleServerOutput(d.toString()));

        this.serverProcess.on('error', (err) => {
            this.onError?.(`Could not run adb (${this.adbPath}): ${err.message}`);
        });

        this.serverProcess.on('exit', (code) => {
            console.log(`[scrcpy-server] exited with code ${code}`);
            if (!this.stopping && code !== 0 && code !== null) {
                this.onError?.(`scrcpy-server exited with code ${code}.`);
            }
            if (!this.stopping) {
                this.onClose?.();
            }
        });
    }

    private handleServerOutput(text: string) {
        const msg = text.trim();
        if (msg) {
            console.log('[scrcpy-server]', msg);
            this.onServerLog?.(msg);
        }

        this.serverTail = (this.serverTail + text).slice(-2000);
        const match = this.serverTail.match(/New display:.*\(id=(\d+)\)/);
        if (match && this.useVirtualDisplay) {
            const displayId = match[1];
            this.serverTail = '';
            void this.startAppOnDisplay(displayId);
        }
    }

    private async deviceMetrics(): Promise<{ width: number; height: number; density: number }> {
        const sizeOut = await this.adbExec(['shell', 'wm', 'size']);
        const sizes = [...sizeOut.matchAll(/(\d+)x(\d+)/g)];
        const size = sizes.length ? sizes[sizes.length - 1] : undefined;

        const densityOut = await this.adbExec(['shell', 'wm', 'density']);
        const densities = [...densityOut.matchAll(/(\d+)/g)];
        const density = densities.length ? densities[densities.length - 1] : undefined;

        return {
            width: size ? parseInt(size[1], 10) : 1080,
            height: size ? parseInt(size[2], 10) : 1920,
            density: density ? parseInt(density[1], 10) : 420,
        };
    }

    private async resolveActivity(): Promise<string | undefined> {
        try {
            const out = await this.adbExec(['shell', 'cmd', 'package', 'resolve-activity', '--brief', this.targetPackage]);
            const lines = out.split('\n').map(l => l.trim()).filter(l => l.includes('/'));
            if (lines.length) {
                return lines[lines.length - 1];
            }
        } catch (e) {
            // No launcher activity could be resolved; report it below.
        }
        return undefined;
    }

    private async startAppOnDisplay(displayId: string) {
        try {
            this.onStatus?.(`Starting ${this.targetPackage} on virtual display ${displayId}...`);
            const component = await this.resolveActivity();
            if (!component) {
                throw new Error(`no launcher activity found for ${this.targetPackage}; check suvidha.appPackage`);
            }
            await this.adbExec(['shell', 'am', 'start', '--display', displayId, '-n', component]);
        } catch (e: any) {
            this.onError?.(`Could not start ${this.targetPackage} on the virtual display: ${e.message}`);
        }
    }

    private handleVideoSocket(socket: net.Socket) {
        this.videoBuf = Buffer.alloc(0);
        this.parseState = 'NAME';
        this.configBuffer = Buffer.alloc(0);
        this.frameIndex = 0;
        this.videoConnected = true;
        this.onStatus?.('Device connected! Initializing stream...');

        socket.on('data', (chunk: Buffer) => {
            this.videoBuf = Buffer.concat([this.videoBuf, chunk]);
            this.processStream();
        });

        socket.on('error', (err) => {
            console.error('[scrcpy] Video socket error:', err.message);
        });

        socket.on('close', () => {
            console.log('[scrcpy] Video socket closed');
            if (!this.stopping) {
                this.onClose?.();
            }
        });
    }

    private processStream() {
        // Step 1: 64-byte device name
        if (this.parseState === 'NAME') {
            if (this.videoBuf.length >= 64) {
                const nameBytes = this.videoBuf.subarray(0, 64);
                this.deviceName = nameBytes.toString('utf8').replace(/\0/g, '').trim();
                console.log(`[scrcpy] Device name: "${this.deviceName}"`);
                this.onDeviceName?.(this.deviceName);
                this.videoBuf = this.videoBuf.subarray(64);
                this.parseState = 'CODEC';
            } else {
                return;
            }
        }

        // Step 2: 4-byte codec ID (e.g. 'h264')
        if (this.parseState === 'CODEC') {
            if (this.videoBuf.length >= 4) {
                const codec = this.videoBuf.subarray(0, 4).toString('ascii');
                console.log(`[scrcpy] Codec: "${codec}"`);
                this.videoBuf = this.videoBuf.subarray(4);
                this.parseState = 'STREAM';
            } else {
                return;
            }
        }

        // Step 3: Stream of 12-byte headers (session or packet)
        if (this.parseState === 'STREAM') {
            while (this.videoBuf.length >= 12) {
                const isSession = (this.videoBuf[0] & 0x80) !== 0;

                if (isSession) {
                    const width = this.videoBuf.readUInt32BE(4);
                    const height = this.videoBuf.readUInt32BE(8);
                    console.log(`[scrcpy] Session size: ${width}x${height}`);
                    this.sessionWidth = width;
                    this.sessionHeight = height;
                    this.onSessionSize?.(width, height);
                    this.videoBuf = this.videoBuf.subarray(12);
                    continue;
                }

                const ptsHigh = this.videoBuf.readUInt32BE(0);
                const ptsLow = this.videoBuf.readUInt32BE(4);
                const len = this.videoBuf.readUInt32BE(8);

                if (this.videoBuf.length < 12 + len) {
                    break; // Wait for full packet
                }

                const payload = Buffer.from(this.videoBuf.subarray(12, 12 + len));
                this.videoBuf = this.videoBuf.subarray(12 + len);

                const isConfig = (ptsHigh & 0x40000000) !== 0;
                const isKey = (ptsHigh & 0x20000000) !== 0;
                const ptsRaw = (BigInt(ptsHigh & 0x1FFFFFFF) << 32n) | BigInt(ptsLow);

                if (isConfig) {
                    this.configBuffer = payload;
                } else {
                    let frameData = payload;
                    if (isKey && this.configBuffer.length > 0) {
                        frameData = Buffer.concat([this.configBuffer, payload]);
                    }
                    this.frameIndex++;
                    const timestampUs = ptsRaw > 0n ? Number(ptsRaw) : this.frameIndex * 33333;
                    this.onFrame?.(frameData, isKey, timestampUs);
                }
            }
        }
    }

    private isSwiping = false;
    private nextSwipeArgs: { startX: number, startY: number, endX: number, endY: number, durationMs: number, steps: number } | null = null;

    public sendTouchEvent(action: number, x: number, y: number, screenW: number, screenH: number, pointerId: bigint = 0n) {
        if (!this.controlSocket) return;

        const buf = Buffer.alloc(32);
        let offset = 0;
        buf.writeUInt8(2, offset); offset += 1; // type: INJECT_TOUCH_EVENT
        buf.writeUInt8(action, offset); offset += 1; // 0=DOWN, 1=UP, 2=MOVE
        buf.writeBigInt64BE(pointerId, offset); offset += 8; // pointerId: 0n indicates finger on touchscreen
        buf.writeInt32BE(x, offset); offset += 4;
        buf.writeInt32BE(y, offset); offset += 4;
        buf.writeUInt16BE(screenW, offset); offset += 2;
        buf.writeUInt16BE(screenH, offset); offset += 2;
        buf.writeUInt16BE(action === 1 ? 0 : 0xFFFF, offset); offset += 2; // pressure
        buf.writeUInt32BE(0, offset); offset += 4; // action button: 0 for touchscreen
        buf.writeUInt32BE(0, offset); // buttons: 0 for touchscreen

        try { this.controlSocket.write(buf); } catch (e) {}
    }

    public sendScrollEvent(x: number, y: number, screenW: number, screenH: number, hScroll: number, vScroll: number) {
        if (!this.controlSocket) return;

        const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
        const toI16fp = (f: number) => {
            const clamped = clamp(f, -1.0, 1.0);
            let val = Math.round(clamped * 32768);
            if (val >= 32767) val = 32767;
            if (val < -32768) val = -32768;
            return val;
        };

        const hNorm = clamp(hScroll / 16, -1, 1);
        const vNorm = clamp(vScroll / 16, -1, 1);
        const hFp = toI16fp(hNorm);
        const vFp = toI16fp(vNorm);

        const buf = Buffer.alloc(21);
        let offset = 0;
        buf.writeUInt8(3, offset); offset += 1; // SC_CONTROL_MSG_TYPE_INJECT_SCROLL_EVENT = 3
        buf.writeInt32BE(Math.round(x), offset); offset += 4;
        buf.writeInt32BE(Math.round(y), offset); offset += 4;
        buf.writeUInt16BE(screenW, offset); offset += 2;
        buf.writeUInt16BE(screenH, offset); offset += 2;
        buf.writeInt16BE(hFp, offset); offset += 2;
        buf.writeInt16BE(vFp, offset); offset += 2;
        buf.writeUInt32BE(0, offset); // buttons = 0

        try { this.controlSocket.write(buf); } catch (e) {}
    }

    public sendKeycode(keycode: number) {
        if (!this.controlSocket) return;

        // SC_CONTROL_MSG_TYPE_INJECT_KEYCODE = 0
        const bufDown = Buffer.alloc(14);
        bufDown.writeUInt8(0, 0); // type
        bufDown.writeUInt8(0, 1); // action: DOWN = 0
        bufDown.writeInt32BE(keycode, 2);
        bufDown.writeInt32BE(0, 6); // repeat
        bufDown.writeInt32BE(0, 10); // metastate

        const bufUp = Buffer.alloc(14);
        bufUp.writeUInt8(0, 0); // type
        bufUp.writeUInt8(1, 1); // action: UP = 1
        bufUp.writeInt32BE(keycode, 2);
        bufUp.writeInt32BE(0, 6); // repeat
        bufUp.writeInt32BE(0, 10); // metastate

        try {
            this.controlSocket.write(bufDown);
            setTimeout(() => {
                try { this.controlSocket?.write(bufUp); } catch (e) {}
            }, 35);
        } catch (e) {}
    }

    public async sendSwipe(startX: number, startY: number, endX: number, endY: number, durationMs: number = 85, steps: number = 5): Promise<void> {
        if (!this.controlSocket) return;

        if (this.isSwiping) {
            this.nextSwipeArgs = { startX, startY, endX, endY, durationMs, steps };
            return;
        }

        this.isSwiping = true;
        try {
            const screenW = this.sessionWidth || 720;
            const screenH = this.sessionHeight || 1570;
            const dt = Math.max(8, Math.round(durationMs / steps));

            this.sendTouchEvent(0, Math.round(startX), Math.round(startY), screenW, screenH);
            for (let i = 1; i <= steps; i++) {
                await new Promise(r => setTimeout(r, dt));
                const progress = i / steps;
                // Accelerating flick curve: velocity increases toward release (progress=1.0)
                // so Android's native VelocityTracker measures release speed (>10,000 px/sec)
                // and starts a hardware-accelerated 120 FPS inertial fling!
                const curve = Math.pow(progress, 1.8);
                const curX = Math.round(startX + (endX - startX) * curve);
                const curY = Math.round(startY + (endY - startY) * curve);
                this.sendTouchEvent(2, curX, curY, screenW, screenH);
            }
            // Lift finger immediately at end position with high velocity
            this.sendTouchEvent(1, Math.round(endX), Math.round(endY), screenW, screenH);
        } finally {
            this.isSwiping = false;
            if (this.nextSwipeArgs) {
                const args = this.nextSwipeArgs;
                this.nextSwipeArgs = null;
                void this.sendSwipe(args.startX, args.startY, args.endX, args.endY, args.durationMs, args.steps);
            }
        }
    }

    public stop() {
        if (this.stopping) return;
        this.stopping = true;

        try { this.videoSocket?.destroy(); } catch (e) {}
        try { this.controlSocket?.destroy(); } catch (e) {}
        try { this.tcpServer?.close(); } catch (e) {}

        const proc = this.serverProcess;
        this.serverProcess = undefined;
        if (proc && proc.exitCode === null) {
            try { proc.kill('SIGKILL'); } catch (e) {}
        }

        // Killing the adb client does not always kill the app_process on the
        // phone, and a lingering server keeps the virtual display (and the app
        // running on it) alive. Kill it by scid so other scrcpy sessions survive.
        this.killRemoteServer();

        try {
            cp.execFileSync(
                this.adbPath,
                ['-s', this.serial, 'reverse', '--remove', `localabstract:${this.socketName}`],
                { timeout: 5000 }
            );
        } catch (e) {}

        this.videoConnected = false;
        this.onStatus?.('Screen closed');
    }

    private async cleanupStaleServers(): Promise<void> {
        if (!this.useVirtualDisplay) return;

        let out = '';
        try {
            out = await this.adbExec(['shell', 'ps', '-A', '-o', 'PID,ARGS']);
        } catch (e) {
            return;
        }

        for (const line of out.split('\n')) {
            // Only our own signature: a scrcpy server driving a decoration-free
            // virtual display. A normal scrcpy session never looks like this.
            if (!line.includes('com.genymobile.scrcpy.Server')) continue;
            if (!line.includes('new_display=') || !line.includes('vd_system_decorations=false')) continue;

            const pid = line.trim().split(/\s+/)[0];
            if (!/^\d+$/.test(pid)) continue;

            try {
                await this.adbExec(['shell', 'kill', '-9', pid]);
                this.onServerLog?.(`cleaned up stale scrcpy session (pid ${pid})`);
            } catch (e) {}
        }
    }

    private killRemoteServer(): void {
        // Never run with an empty scid - "scid=" would match, and kill, every
        // scrcpy session on the device.
        if (!this.scid) return;
        const match = `scid=${this.scid}`;
        const list = (args: string[]): string => {
            try {
                return cp.execFileSync(this.adbPath, ['-s', this.serial, 'shell', ...args], {
                    timeout: 5000,
                    encoding: 'utf8'
                });
            } catch (e) {
                return '';
            }
        };

        const out = list(['ps', '-A', '-o', 'PID,ARGS']) || list(['ps', '-A']);
        for (const line of out.split('\n')) {
            if (!line.includes('com.genymobile.scrcpy.Server') || !line.includes(match)) continue;
            const pid = line.trim().split(/\s+/)[0];
            if (!/^\d+$/.test(pid)) continue;
            try {
                cp.execFileSync(this.adbPath, ['-s', this.serial, 'shell', 'kill', '-9', pid], { timeout: 5000 });
            } catch (e) {}
        }
    }
}

// ─── VS Code Extension: Embedded Mirror Panel ──────────────────────────────
class EmbeddedMirrorPanel {
    private panel?: vscode.WebviewPanel;
    private scrcpy?: ScrcpyClient;
    private context: vscode.ExtensionContext;
    private adbPath: string;
    private screenW: number = 720;
    private screenH: number = 1570;
    private output: vscode.OutputChannel;
    private reconnectTimer?: NodeJS.Timeout;
    private monitorTimer?: NodeJS.Timeout;
    private retryDelayMs = 2000;
    private disposed = false;
    private asleep = false;
    private serial = '';
    private deviceName = '';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.output = this.createOutputChannel();
        const home = process.env.HOME || '';
        const adbCandidates = [
            process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb') : '',
            process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb') : '',
            path.join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
            path.join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
            '/opt/homebrew/bin/adb',
            '/usr/local/bin/adb',
            'adb',
        ];
        this.adbPath = adbCandidates.find(p => p && (p === 'adb' || fs.existsSync(p))) || 'adb';
        this.log(`adb: ${this.adbPath}`);

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('suvidha.inDisplayScrollbar')) {
                    const show = vscode.workspace.getConfiguration('suvidha').get<boolean>('inDisplayScrollbar', true);
                    this.panel?.webview.postMessage({ type: 'toggleScrollbar', show });
                }
                if (e.affectsConfiguration('suvidha.appName')) {
                    this.applyAppName();
                }
                if (e.affectsConfiguration('suvidha.appPackage')) {
                    this.log(`target app package changed to ${getAppPackage()}`);
                    if (this.panel && this.scrcpy) {
                        this.disposeClient();
                        this.scheduleReconnect('Target app package changed');
                    }
                }
            })
        );
    }

    private createOutputChannel(): vscode.OutputChannel {
        const channel = vscode.window.createOutputChannel(`${getAppName()} Window`);
        this.context?.subscriptions.push(channel);
        return channel;
    }

    private applyAppName(): void {
        const previous = this.output;
        this.output = this.createOutputChannel();
        this.log(`app name set to "${getAppName()}"`);
        previous.dispose();
        this.updatePanelTitle();
    }

    private updatePanelTitle(): void {
        if (!this.panel) return;
        const appName = getAppName();
        this.panel.title = this.deviceName
            ? `📱 ${appName} · ${this.deviceName}`
            : `📱 ${appName} Screen`;
    }

    private log(message: string) {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    private async findDevice(): Promise<string> {
        return new Promise((resolve) => {
            cp.execFile(this.adbPath, ['devices'], { timeout: 6000 }, (err, stdout, stderr) => {
                if (err) {
                    this.log(`adb devices failed: ${err.message}`);
                    this.log((stderr || '').trim());
                    resolve(''); return;
                }
                this.log(`adb devices:\n${(stdout || '').trim()}`);
                const lines = (stdout || '').trim().split('\n').slice(1).filter(l => l.trim());
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2 && parts[1] === 'device') {
                        if (parts[0].includes('_tcp') || parts[0].includes(':')) {
                            resolve(parts[0]); return;
                        }
                    }
                }
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2 && parts[1] === 'device') {
                        resolve(parts[0]); return;
                    }
                }
                resolve('');
            });
        });
    }

    public async launch(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        const serial = await this.findDevice();
        if (!serial) {
            vscode.window.showErrorMessage('⚠️ No Android device found. Enable Wireless Debugging on your phone.');
            return;
        }
        this.serial = serial;

        // Create WebviewPanel
        this.disposed = false;
        this.retryDelayMs = 2000;
        this.deviceName = '';
        this.panel = vscode.window.createWebviewPanel(
            'suvidhaScreen',
            `📱 ${getAppName()} Screen`,
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        this.panel.onDidDispose(() => {
            this.disposed = true;
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = undefined;
            }
            this.stop();
            this.panel = undefined;
        });

        this.panel.webview.html = this.getWebviewHtml();

        this.panel.webview.onDidReceiveMessage((msg) => {
            this.handleMessage(msg);
        });

        const useVirtual = vscode.workspace.getConfiguration('suvidha').get<boolean>('virtualDisplay', true);
        this.log(`mode: ${useVirtual ? 'virtual display (separate from the phone screen)' : 'mirror phone screen'}`);
        this.startMonitor(serial);
        await this.connect(serial, useVirtual);
    }

    private async connect(serial: string, useVirtual: boolean): Promise<void> {
        this.disposeClient();
        const keepActive = vscode.workspace.getConfiguration('suvidha').get<boolean>('keepActive', true);
        const appPackage = getAppPackage();
        this.log(`keep the phone awake: ${keepActive ? 'yes' : 'no'}`);
        this.log(`target app package: ${appPackage}`);
        this.scrcpy = new ScrcpyClient(this.adbPath, serial, useVirtual, keepActive, appPackage);

        this.scrcpy.setStatusCallback((status) => {
            this.log(status);
            this.panel?.webview.postMessage({ type: 'status', text: status });
        });

        this.scrcpy.setErrorCallback((message) => {
            this.log(`ERROR: ${message}`);
            this.panel?.webview.postMessage({ type: 'error', text: message });
        });

        this.scrcpy.setServerLogCallback((line) => {
            this.log(`server: ${line}`);
        });

        this.scrcpy.setDeviceNameCallback((name) => {
            this.log(`device name: ${name}`);
            this.deviceName = name;
            this.updatePanelTitle();
        });

        this.scrcpy.setSessionSizeCallback((w, h) => {
            this.log(`stream size: ${w}x${h}`);
            this.screenW = w;
            this.screenH = h;
            this.panel?.webview.postMessage({ type: 'sessionSize', width: w, height: h });
        });

        this.scrcpy.setFrameCallback((frameData, isKeyframe, timestampUs) => {
            if (!this.panel) return;
            this.retryDelayMs = 2000;
            const b64 = frameData.toString('base64');
            this.panel.webview.postMessage({
                type: 'videoFrame',
                data: b64,
                isKeyframe,
                timestampUs
            });
        });

        this.scrcpy.setCloseCallback(() => {
            this.log('stream closed unexpectedly');
            this.scheduleReconnect('The phone screen went off or the link dropped');
        });

        this.log(`connecting to ${serial} (this is the adb serial; no explicit adb connect is needed)`);
        try {
            await this.scrcpy.start();
            this.log('scrcpy-server launched; waiting for the device video socket');
            if (!useVirtual) {
                cp.execFile(this.adbPath, ['-s', serial, 'shell', 'monkey', '-p', appPackage, '-c', 'android.intent.category.LAUNCHER', '1'], () => {});
            }
        } catch (err: any) {
            this.log(`start failed: ${err.message}`);
            this.panel?.webview.postMessage({ type: 'status', text: `Start failed: ${err.message}` });
            this.scheduleReconnect(err.message);
        }
    }

    private disposeClient(): void {
        const client = this.scrcpy;
        this.scrcpy = undefined;
        if (client) {
            try { client.stop(); } catch (e) {}
        }
    }

    private startMonitor(serial: string): void {
        this.stopMonitor();
        this.monitorTimer = setInterval(async () => {
            if (this.disposed || !this.panel || !this.scrcpy) return;

            const awake = await this.isDeviceAwake(serial);
            if (!awake && !this.asleep) {
                this.asleep = true;
                this.log('phone is asleep - preview paused');
                this.panel.webview.postMessage({ type: 'asleep' });
            } else if (awake && this.asleep) {
                this.asleep = false;
                this.log('phone woke up - resuming the preview');
                this.panel.webview.postMessage({ type: 'awake' });
                this.disposeClient();
                this.scheduleReconnect('Resuming after the phone woke up');
            }
        }, 4000);
    }

    private stopMonitor(): void {
        if (this.monitorTimer) {
            clearInterval(this.monitorTimer);
            this.monitorTimer = undefined;
        }
    }

    private async wakePhone(): Promise<void> {
        if (!this.serial) return;
        this.log('waking the phone...');
        this.panel?.webview.postMessage({ type: 'status', text: 'Waking the phone...' });
        return new Promise<void>((resolve) => {
            cp.execFile(this.adbPath, ['-s', this.serial, 'shell', 'input', 'keyevent', '224'], { timeout: 6000 }, () => {
                cp.execFile(this.adbPath, ['-s', this.serial, 'shell', 'wm', 'dismiss-keyguard'], { timeout: 6000 }, () => resolve());
            });
        });
    }

    private async isDeviceAwake(serial: string): Promise<boolean> {
        return new Promise((resolve) => {
            cp.execFile(this.adbPath, ['-s', serial, 'shell', 'dumpsys', 'power'], { timeout: 5000 }, (err, stdout) => {
                if (err || !stdout) { resolve(true); return; }
                resolve(/mWakefulness=Awake/.test(stdout));
            });
        });
    }

    private scheduleReconnect(reason: string): void {
        if (this.disposed || !this.panel || this.reconnectTimer) return;

        const delay = this.retryDelayMs;
        this.retryDelayMs = Math.min(this.retryDelayMs * 1.6, 15000);

        this.log(`reconnect in ${Math.round(delay / 1000)}s (${reason})`);
        this.panel.webview.postMessage({
            type: 'connecting',
            text: 'Waiting for the phone...',
            detail: reason
        });

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = undefined;
            if (this.disposed || !this.panel) return;

            const serial = await this.findDevice();
            if (!serial) {
                this.scheduleReconnect('No adb device yet (is Wireless debugging still on?)');
                return;
            }

            if (!(await this.isDeviceAwake(serial))) {
                this.scheduleReconnect('Phone is asleep - waiting for it to wake up');
                return;
            }

            const useVirtual = vscode.workspace.getConfiguration('suvidha').get<boolean>('virtualDisplay', true);
            this.connect(serial, useVirtual);
        }, delay);
    }

    public captureScreenshot(): void {
        if (!this.panel) {
            vscode.window.showInformationMessage(`Open the ${getAppName()} Screen first.`);
            return;
        }
        this.panel.webview.postMessage({ type: 'capture' });
    }

    private async saveScreenshot(msg: any): Promise<void> {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!folder) {
            vscode.window.showErrorMessage('Open a project folder to save screenshots.');
            return;
        }

        try {
            const dir = vscode.Uri.joinPath(folder, 'suvidha-screenshots');
            await vscode.workspace.fs.createDirectory(dir);

            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, '0');
            const name = `suvidha-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
                + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.png`;
            const file = vscode.Uri.joinPath(dir, name);

            await vscode.workspace.fs.writeFile(file, Buffer.from(msg.data, 'base64'));

            const relative = `suvidha-screenshots/${name}`;
            if (msg.copyPath) {
                await vscode.env.clipboard.writeText(`@${relative}`);
            }

            this.log(`screenshot saved: ${relative}`);

            const choice = await vscode.window.showInformationMessage(
                `Screenshot saved: ${relative}`,
                'Copy @path',
                'Open'
            );
            if (choice === 'Copy @path') {
                await vscode.env.clipboard.writeText(`@${relative}`);
            } else if (choice === 'Open') {
                await vscode.commands.executeCommand('vscode.open', file);
            }
        } catch (err: any) {
            this.log(`screenshot failed: ${err.message}`);
            vscode.window.showErrorMessage(`Could not save the screenshot: ${err.message}`);
        }
    }

    private handleMessage(msg: any) {
        if (msg.type === 'wake') {
            void this.wakePhone();
            return;
        }

        if (msg.type === 'screenshot') {
            void this.saveScreenshot(msg);
            return;
        }

        if (!this.scrcpy) return;

        if (msg.type === 'touchDown') {
            const x = Math.round(msg.x * this.screenW);
            const y = Math.round(msg.y * this.screenH);
            this.scrcpy.sendTouchEvent(0, x, y, this.screenW, this.screenH);
        } else if (msg.type === 'touchMove') {
            const x = Math.round(msg.x * this.screenW);
            const y = Math.round(msg.y * this.screenH);
            this.scrcpy.sendTouchEvent(2, x, y, this.screenW, this.screenH);
        } else if (msg.type === 'touchUp') {
            const x = Math.round(msg.x * this.screenW);
            const y = Math.round(msg.y * this.screenH);
            this.scrcpy.sendTouchEvent(1, x, y, this.screenW, this.screenH);
        } else if (msg.type === 'scroll') {
            const x = Math.round((msg.x ?? 0.5) * this.screenW);
            const y = Math.round((msg.y ?? 0.5) * this.screenH);
            this.scrcpy.sendScrollEvent(x, y, this.screenW, this.screenH, msg.dx ?? 0, msg.dy ?? 0);
        } else if (msg.type === 'swipe') {
            const startX = Math.round(msg.startX * this.screenW);
            const startY = Math.round(msg.startY * this.screenH);
            const endX = Math.round(msg.endX * this.screenW);
            const endY = Math.round(msg.endY * this.screenH);
            const duration = msg.duration || 85;
            const steps = msg.steps || 5;
            void this.scrcpy.sendSwipe(startX, startY, endX, endY, duration, steps);
        } else if (msg.type === 'nav') {
            if (msg.key === 'back') {
                this.scrcpy.sendKeycode(4); // AKEYCODE_BACK
            } else if (msg.key === 'home') {
                this.scrcpy.sendKeycode(3); // AKEYCODE_HOME
            } else if (msg.key === 'recents') {
                this.scrcpy.sendKeycode(187); // AKEYCODE_APP_SWITCH
            }
        }
    }

    private getWebviewHtml(): string {
        const showScrollbar = vscode.workspace.getConfiguration('suvidha').get<boolean>('inDisplayScrollbar', true);
        const outputChannelName = JSON.stringify(`${getAppName()} Window`).replace(/</g, '\\u003c');
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; }
  body {
    background: #0d0f12;
    color: #e2e8f0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    height: 100vh;
    padding: 12px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(26, 31, 44, 0.9);
    backdrop-filter: blur(12px);
    border: 1px solid rgba(255,255,255,0.08);
    padding: 6px 14px;
    border-radius: 20px;
    margin-bottom: 12px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.4);
    z-index: 10;
  }
  .badge {
    background: #10b981;
    color: #000;
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 700;
    letter-spacing: 0.5px;
  }
  .tool-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    cursor: pointer;
    padding: 5px 10px;
    border-radius: 8px;
    font-size: 13px;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .tool-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
  .tool-btn.primary {
    background: rgba(16,185,129,0.15);
    color: #6ee7b7;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
  }
  .tool-btn.primary:hover { background: rgba(16,185,129,0.28); color: #d1fae5; }

  .nav-divider-toolbar {
    width: 1px;
    height: 16px;
    background: rgba(255, 255, 255, 0.12);
    margin: 0 4px;
  }
  .spacer { flex: 1; }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 24px;
    transform: translateX(-50%) translateY(10px);
    background: rgba(15,23,42,0.96);
    color: #e2e8f0;
    border: 1px solid rgba(255,255,255,0.12);
    padding: 8px 14px;
    border-radius: 10px;
    font-size: 12px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s ease, transform 0.2s ease;
    z-index: 50;
    max-width: 80%;
    text-align: center;
  }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .phone-frame {
    position: relative;
    max-height: calc(100vh - 80px);
    width: auto;
    aspect-ratio: 720 / 1570;
    background: #000;
    border: 3px solid #1e293b;
    border-radius: 28px;
    overflow: hidden;
    box-shadow: 0 20px 50px rgba(0,0,0,0.6);
    outline: none;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
    cursor: pointer;
    touch-action: none;
  }

  /* Fast Scroller on the right edge */
  .fast-scroller {
    position: absolute;
    top: 24px;
    bottom: 54px;
    right: 4px;
    width: 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    z-index: 8;
    opacity: 0.55;
    transition: opacity 0.2s ease;
  }
  .fast-scroller.hidden {
    display: none !important;
  }
  .fast-scroller:hover {
    opacity: 1;
  }
  .scroller-arrow {
    background: rgba(15, 23, 42, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: #94a3b8;
    font-size: 9px;
    width: 20px;
    height: 20px;
    border-radius: 10px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    padding: 0;
  }
  .scroller-arrow:hover {
    background: rgba(16, 185, 129, 0.3);
    color: #6ee7b7;
    border-color: #10b981;
    transform: scale(1.1);
  }
  .scroller-arrow:active {
    transform: scale(0.95);
  }
  .scroller-track {
    flex: 1;
    width: 6px;
    margin: 6px 0;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.12);
    position: relative;
    cursor: pointer;
    transition: background 0.15s ease, width 0.15s ease;
  }
  .fast-scroller:hover .scroller-track {
    background: rgba(255, 255, 255, 0.2);
    width: 8px;
  }
  .scroller-thumb {
    position: absolute;
    left: 50%;
    top: 50%;
    margin-top: -21px;
    transform: translateX(-50%) translateY(0px);
    width: 14px;
    height: 42px;
    border-radius: 7px;
    background: linear-gradient(180deg, #10b981 0%, #059669 100%);
    box-shadow: 0 0 12px rgba(16, 185, 129, 0.6);
    cursor: grab;
    display: flex;
    align-items: center;
    justify-content: center;
    touch-action: none;
  }
  .scroller-thumb:active {
    cursor: grabbing;
    background: linear-gradient(180deg, #34d399 0%, #10b981 100%);
    box-shadow: 0 0 16px rgba(16, 185, 129, 0.9);
  }
  .scroller-grip {
    width: 6px;
    height: 2px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.85);
    box-shadow: 0 4px 0 rgba(255, 255, 255, 0.85), 0 -4px 0 rgba(255, 255, 255, 0.85);
  }



  .loader-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: rgba(13, 15, 18, 0.95);
    z-index: 5;
    transition: opacity 0.4s ease;
  }
  .loader-overlay.hidden { opacity: 0; pointer-events: none; }
  .asleep-overlay {
    position: absolute;
    inset: 0;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    background: rgba(8, 10, 14, 0.92);
    z-index: 5;
    text-align: center;
    padding: 20px;
  }
  .asleep-overlay.show { display: flex; }
  .asleep-icon { font-size: 34px; }
  .asleep-title { font-size: 15px; font-weight: 600; color: #e2e8f0; }
  .asleep-sub { font-size: 12px; color: #94a3b8; max-width: 240px; }
  .wake-btn {
    margin-top: 6px;
    background: rgba(16,185,129,0.16);
    color: #6ee7b7;
    border: 1px solid rgba(16,185,129,0.4);
    border-radius: 8px;
    padding: 7px 14px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
  .wake-btn:hover { background: rgba(16,185,129,0.28); color: #d1fae5; }
  .ring {
    width: 44px; height: 44px;
    border: 3px solid rgba(16, 185, 129, 0.2);
    border-top-color: #10b981;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loader-text { font-size: 13px; color: #cbd5e1; font-weight: 500; }
  .loader-sub { font-size: 11px; color: #64748b; }
</style>
</head>
<body>
  <div class="toolbar">
    <span class="badge" id="badge">CONNECTING</span>
    <div class="nav-divider-toolbar"></div>
    <button class="tool-btn" id="btnToolScrollUp" title="Scroll Up (Page Up / ↑)">▲ Up</button>
    <button class="tool-btn" id="btnToolScrollDown" title="Scroll Down (Page Down / ↓)">▼ Down</button>
    <div class="spacer"></div>
    <button class="tool-btn primary" id="btnContext" title="Save this screen and copy it for the AI chat">＋ Add to chat</button>
  </div>

  <div class="phone-frame" id="phoneFrame" tabindex="0">
    <div class="loader-overlay" id="loader">
      <div class="ring"></div>
      <div class="loader-text" id="statusText">Connecting to device...</div>
      <div class="loader-sub" id="statusSub">Pushing scrcpy-server & establishing tunnel</div>
    </div>
    <canvas id="screen"></canvas>

    <!-- On-screen Fast Scroller on the right edge -->
    <div class="fast-scroller ${showScrollbar ? '' : 'hidden'}" id="fastScroller" style="display: ${showScrollbar ? 'flex' : 'none'};" title="On-screen Scroller: Drag or click to scroll">
      <button class="scroller-arrow up" id="scrollerArrowUp" title="Scroll Up">▲</button>
      <div class="scroller-track" id="scrollerTrack">
        <div class="scroller-thumb" id="scrollerThumb">
          <div class="scroller-grip"></div>
        </div>
      </div>
      <button class="scroller-arrow down" id="scrollerArrowDown" title="Scroll Down">▼</button>
    </div>


    <div class="asleep-overlay" id="asleep">
      <div class="asleep-icon">🌙</div>
      <div class="asleep-title">Phone is asleep</div>
      <div class="asleep-sub">The virtual display is paused. Wake the phone to resume the preview.</div>
      <button class="wake-btn" id="btnWake">Wake phone</button>
    </div>
  </div>

  <div class="toast" id="toast"></div>

<script>
  const vscode = acquireVsCodeApi();
  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  const loader = document.getElementById('loader');
  const statusText = document.getElementById('statusText');
  const statusSub = document.getElementById('statusSub');
  const badge = document.getElementById('badge');
  const phoneFrame = document.getElementById('phoneFrame');

  let decoder = null;
  let frameCount = 0;
  let configured = false;

  function initDecoder() {
    if (decoder && decoder.state !== 'closed') {
      try { decoder.close(); } catch(e) {}
    }
    configured = false;

    if (typeof VideoDecoder === 'undefined') {
      statusText.innerText = 'VideoDecoder not supported';
      return;
    }

    decoder = new VideoDecoder({
      output: (frame) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
          phoneFrame.style.aspectRatio = frame.displayWidth + ' / ' + frame.displayHeight;
        }
        ctx.drawImage(frame, 0, 0);
        frame.close();

        frameCount++;
        loader.classList.add('hidden');
        document.getElementById('asleep').classList.remove('show');
        badge.innerText = 'LIVE';
        badge.style.background = '#10b981';
      },
      error: (e) => {
        console.error('VideoDecoder error:', e);
        setTimeout(() => initDecoder(), 500);
      }
    });
  }

  initDecoder();

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'status') {
      statusText.innerText = msg.text;
      statusSub.innerText = 'Wireless debugging \u00b7 scrcpy ${SCRCPY_VERSION}';
    } else if (msg.type === 'connecting') {
      document.getElementById('asleep').classList.remove('show');
      loader.classList.remove('hidden');
      badge.innerText = 'RECONNECTING';
      badge.style.background = '#f59e0b';
      statusText.innerText = msg.text || 'Reconnecting...';
      statusSub.innerText = msg.detail || 'Wireless debugging \u00b7 scrcpy ${SCRCPY_VERSION}';
    } else if (msg.type === 'error') {
      statusText.innerText = msg.text;
      statusSub.innerText = 'Open the "' + ${outputChannelName} + '" output channel for details';
      badge.innerText = 'ERROR';
      badge.style.background = '#ef4444';
    } else if (msg.type === 'toggleScrollbar') {
      const scroller = document.getElementById('fastScroller');
      if (scroller) {
        scroller.classList.toggle('hidden', !msg.show);
        scroller.style.display = msg.show ? 'flex' : 'none';
      }
    } else if (msg.type === 'asleep') {
      loader.classList.add('hidden');
      document.getElementById('asleep').classList.add('show');
      badge.innerText = 'ASLEEP';
      badge.style.background = '#64748b';
    } else if (msg.type === 'awake') {
      document.getElementById('asleep').classList.remove('show');
      badge.innerText = 'RECONNECTING';
      badge.style.background = '#f59e0b';
    } else if (msg.type === 'capture') {
      document.getElementById('btnContext').click();
    } else if (msg.type === 'sessionSize') {
      phoneFrame.style.aspectRatio = msg.width + ' / ' + msg.height;
    } else if (msg.type === 'videoFrame' && decoder && decoder.state !== 'closed') {
      try {
        const raw = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));

        if (!configured) {
          decoder.configure({
            codec: 'avc1.64001f',
            optimizeForLatency: true,
          });
          configured = true;
        }

        const chunk = new EncodedVideoChunk({
          type: msg.isKeyframe ? 'key' : 'delta',
          timestamp: msg.timestampUs || 0,
          data: raw
        });
        decoder.decode(chunk);
      } catch (e) {
        console.warn('Decode error:', e);
      }
    }
  });

  function triggerSwipe(direction, distance = 'normal') {
    const centerX = 0.5;
    let startY, endY;
    if (direction === 'down') {
      startY = distance === 'small' ? 0.65 : (distance === 'large' ? 0.82 : 0.72);
      endY = distance === 'small' ? 0.45 : (distance === 'large' ? 0.18 : 0.28);
    } else {
      startY = distance === 'small' ? 0.45 : (distance === 'large' ? 0.18 : 0.28);
      endY = distance === 'small' ? 0.65 : (distance === 'large' ? 0.82 : 0.72);
    }
    const duration = distance === 'small' ? 70 : (distance === 'large' ? 100 : 85);
    const steps = distance === 'small' ? 4 : (distance === 'large' ? 6 : 5);
    vscode.postMessage({
      type: 'swipe',
      startX: centerX,
      startY: startY,
      endX: centerX,
      endY: endY,
      duration: duration,
      steps: steps
    });
  }

  // 1. Mouse wheel & Mac trackpad two-finger scroll with smooth animated momentum
  let wheelAccum = 0;
  let lastWheelTime = 0;
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = performance.now();
    let dY = e.deltaY;
    if (e.deltaMode === 1) { dY *= 28; } // LINE mode (mouse wheel notch)
    else if (e.deltaMode === 2) { dY *= 100; } // PAGE mode

    const isDiscreteWheel = e.deltaMode === 1 || Math.abs(dY) >= 50;

    if (isDiscreteWheel) {
      // Physical mouse wheel notch: instantaneous smooth animated flick
      const dir = dY > 0 ? 'down' : 'up';
      const rapid = (now - lastWheelTime) < 180;
      lastWheelTime = now;
      triggerSwipe(dir, rapid ? 'large' : 'normal');
      bumpThumb(dY > 0 ? 32 : -32);
      wheelAccum = 0;
    } else {
      // Mac trackpad continuous two-finger swipe: accumulate and fire fluid animated flings
      wheelAccum += dY;
      const threshold = 28;
      if (Math.abs(wheelAccum) >= threshold) {
        const dir = wheelAccum > 0 ? 'down' : 'up';
        const mag = Math.abs(wheelAccum);
        const intensity = mag > 80 ? 'large' : (mag > 45 ? 'normal' : 'small');
        triggerSwipe(dir, intensity);
        bumpThumb(wheelAccum > 0 ? 24 : -24);
        wheelAccum = 0;
        lastWheelTime = now;
      }
    }
  }, { passive: false });

  // 2. Mac gestures & Keyboard Navigation with smooth animations
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'ArrowDown' || e.key === 'PageDown' || (e.key === ' ' && !e.shiftKey)) {
      e.preventDefault();
      if (e.key === 'ArrowDown') {
        triggerSwipe('down', 'small');
        bumpThumb(20);
      } else {
        triggerSwipe('down', 'normal');
        bumpThumb(40);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp' || (e.key === ' ' && e.shiftKey)) {
      e.preventDefault();
      if (e.key === 'ArrowUp') {
        triggerSwipe('up', 'small');
        bumpThumb(-20);
      } else {
        triggerSwipe('up', 'normal');
        bumpThumb(-40);
      }
    } else if (e.key === 'Home') {
      e.preventDefault();
      triggerSwipe('up', 'large');
      animateThumbTo(-thumbMax());
    } else if (e.key === 'End') {
      e.preventDefault();
      triggerSwipe('down', 'large');
      animateThumbTo(thumbMax());
    } else if (e.key === 'Escape' || e.key === 'Backspace') {
      e.preventDefault();
      vscode.postMessage({ type: 'nav', key: 'back' });
    } else if ((e.metaKey || e.altKey) && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      vscode.postMessage({ type: 'nav', key: 'home' });
    }
  });

  // 3. On-screen Scroller (right edge): drag = scroll, position is remembered
  const scrollerTrack = document.getElementById('scrollerTrack');
  const scrollerThumb = document.getElementById('scrollerThumb');
  let thumbOffset = 0;
  let targetOffset = 0;
  let thumbRaf = null;
  let isScrollerDragging = false;
  let dragStartY = 0;
  let dragStartOffset = 0;
  let lastDragY = 0;
  let lastDragTime = 0;
  let dragVelocityY = 0;
  let dragAccum = 0;

  function thumbMax() {
    return Math.max(0, (scrollerTrack.clientHeight - scrollerThumb.clientHeight) / 2);
  }

  function renderThumb() {
    scrollerThumb.style.transform = 'translateX(-50%) translateY(' + thumbOffset.toFixed(1) + 'px)';
  }

  // Glide towards the target instead of jumping; keeps motion alive even when
  // wheel events arrive in bursts.
  function animateThumbTo(value) {
    const max = thumbMax();
    targetOffset = Math.max(-max, Math.min(max, value));
    if (thumbRaf !== null) return;

    const tick = () => {
      const diff = targetOffset - thumbOffset;
      if (Math.abs(diff) < 0.4) {
        thumbOffset = targetOffset;
        renderThumb();
        thumbRaf = null;
        return;
      }
      thumbOffset += diff * 0.2;
      renderThumb();
      thumbRaf = requestAnimationFrame(tick);
    };
    thumbRaf = requestAnimationFrame(tick);
  }

  function bumpThumb(delta) {
    animateThumbTo(targetOffset + delta);
  }

  function recenterThumb() {
    animateThumbTo(0);
  }

  scrollerTrack.addEventListener('dblclick', recenterThumb);

  scrollerThumb.addEventListener('pointerdown', (e) => {
    isScrollerDragging = true;
    dragStartY = e.clientY;
    lastDragY = e.clientY;
    lastDragTime = performance.now();
    dragVelocityY = 0;
    dragAccum = 0;
    dragStartOffset = thumbOffset;
    if (thumbRaf !== null) {
      cancelAnimationFrame(thumbRaf);
      thumbRaf = null;
    }
    targetOffset = thumbOffset;
    scrollerThumb.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  scrollerThumb.addEventListener('pointermove', (e) => {
    if (!isScrollerDragging) return;
    const now = performance.now();
    const dt = now - lastDragTime;
    const dy = e.clientY - dragStartY;
    const max = thumbMax();
    thumbOffset = Math.max(-max, Math.min(max, dragStartOffset + dy));
    targetOffset = thumbOffset;
    renderThumb();

    if (dt > 10) {
      dragVelocityY = (e.clientY - lastDragY) / dt;
      lastDragY = e.clientY;
      lastDragTime = now;
    }

    dragAccum += dy;
    dragStartY = e.clientY;
    dragStartOffset = thumbOffset;

    if (Math.abs(dragAccum) >= 20) {
      const dir = dragAccum > 0 ? 'down' : 'up';
      triggerSwipe(dir, 'small');
      dragAccum = 0;
    }
  });

  scrollerThumb.addEventListener('pointerup', (e) => {
    if (!isScrollerDragging) return;
    isScrollerDragging = false;
    try { scrollerThumb.releasePointerCapture(e.pointerId); } catch (err) {}
    // If released with velocity, launch an animated fling
    if (Math.abs(dragVelocityY) > 0.25) {
      const dir = dragVelocityY > 0 ? 'down' : 'up';
      triggerSwipe(dir, Math.abs(dragVelocityY) > 0.9 ? 'large' : 'normal');
    }
  });

  scrollerThumb.addEventListener('pointercancel', () => {
    isScrollerDragging = false;
  });

  scrollerTrack.addEventListener('click', (e) => {
    if (e.target === scrollerThumb || scrollerThumb.contains(e.target)) return;
    const rect = scrollerTrack.getBoundingClientRect();
    const clickY = e.clientY - rect.top;
    if (clickY < rect.height / 2) {
      triggerSwipe('up', 'normal');
      bumpThumb(-42);
    } else {
      triggerSwipe('down', 'normal');
      bumpThumb(42);
    }
  });

  document.getElementById('scrollerArrowUp').onclick = (e) => {
    e.stopPropagation();
    triggerSwipe('up', 'normal');
    bumpThumb(-42);
  };

  document.getElementById('scrollerArrowDown').onclick = (e) => {
    e.stopPropagation();
    triggerSwipe('down', 'normal');
    bumpThumb(42);
  };


  // Toolbar Quick Buttons
  document.getElementById('btnToolScrollUp').onclick = () => triggerSwipe('up', 'normal');
  document.getElementById('btnToolScrollDown').onclick = () => triggerSwipe('down', 'normal');



  // Touch controls with flick velocity detection
  let isDown = false;
  let pointerStartTime = 0;
  let pointerStartY = 0;

  canvas.addEventListener('pointerdown', (e) => {
    isDown = true;
    pointerStartTime = performance.now();
    pointerStartY = e.clientY;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    vscode.postMessage({ type: 'touchDown', x, y });
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDown) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    vscode.postMessage({ type: 'touchMove', x, y });
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!isDown) return;
    isDown = false;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    vscode.postMessage({ type: 'touchUp', x, y });

    // Detect fast flick gesture for natural inertia
    const dt = performance.now() - pointerStartTime;
    const dy = e.clientY - pointerStartY;
    if (dt > 30 && dt < 280 && Math.abs(dy) > 35) {
      const flickDir = dy < 0 ? 'down' : 'up';
      triggerSwipe(flickDir, 'small');
    }
  });

  canvas.addEventListener('pointercancel', () => { isDown = false; });

  // Screenshot / AI context
  const toastEl = document.getElementById('toast');
  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function capturePNG() {
    const dataUrl = canvas.toDataURL('image/png');
    return { dataUrl: dataUrl, base64: dataUrl.split(',')[1] };
  }

  document.getElementById('btnWake').onclick = () => {
    vscode.postMessage({ type: 'wake' });
  };

  document.getElementById('btnContext').onclick = async () => {
    if (!frameCount) { toast('No frame captured yet'); return; }
    const shot = capturePNG();
    let copied = false;
    try {
      const blob = await (await fetch(shot.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copied = true;
    } catch (e) {
      copied = false;
    }
    vscode.postMessage({ type: 'screenshot', data: shot.base64, copyPath: !copied });
    toast(copied ? 'Screenshot copied - paste it into the chat' : 'Saved - path copied, paste it into the chat');
  };
</script>
</body>
</html>`;
    }

    public stop() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
        this.stopMonitor();
        this.asleep = false;
        if (this.scrcpy) {
            this.log(`closing ${getAppName()} screen (stopping server, releasing display)`);
        }
        this.disposeClient();
    }
}

// ─── Sidebar Controller ─────────────────────────────────────────────────────
class ControllerProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    public refresh(): void {
        this.onDidChangeTreeDataEmitter.fire();
    }

    public dispose(): void {
        this.onDidChangeTreeDataEmitter.dispose();
    }

    public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(): vscode.TreeItem[] {
        const appName = getAppName();
        const open = new vscode.TreeItem(`Open ${appName} Screen`, vscode.TreeItemCollapsibleState.None);
        open.iconPath = new vscode.ThemeIcon('device-mobile');
        open.command = { command: 'androidWireless.launchVirtualDisplay', title: `Open ${appName} Screen` };
        open.tooltip = `Open the live ${appName} screen inside the editor`;

        const shot = new vscode.TreeItem('Capture screenshot for AI', vscode.TreeItemCollapsibleState.None);
        shot.iconPath = new vscode.ThemeIcon('camera');
        shot.command = { command: 'androidWireless.captureScreenshot', title: 'Capture screenshot' };
        shot.tooltip = 'Save the current frame and copy it for the chat';

        const deploy = new vscode.TreeItem('Deploy to all devices', vscode.TreeItemCollapsibleState.None);
        deploy.iconPath = new vscode.ThemeIcon('rocket');
        deploy.command = { command: 'androidWireless.deployAllDevices', title: 'Deploy to all devices' };
        deploy.tooltip = 'Build the debug APK and install/launch it on every connected device';

        return [open, shot, deploy];
    }
}

// ─── Extension Activation ───────────────────────────────────────────────────
let mirrorPanel: EmbeddedMirrorPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
    mirrorPanel = new EmbeddedMirrorPanel(context);

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.command = 'androidWireless.launchVirtualDisplay';
    const updateStatusBar = () => {
        const appName = getAppName();
        statusBar.text = `$(device-mobile) ${appName} Screen`;
        statusBar.tooltip = `Open ${appName} embedded screen inside VS Code`;
    };
    updateStatusBar();
    statusBar.show();
    context.subscriptions.push(statusBar);

    const controllerProvider = new ControllerProvider();
    context.subscriptions.push(controllerProvider);

    const disposable = vscode.commands.registerCommand('androidWireless.launchVirtualDisplay', () => {
        mirrorPanel?.launch();
    });

    context.subscriptions.push(disposable);

    context.subscriptions.push(vscode.commands.registerCommand('androidWireless.captureScreenshot', () => {
        mirrorPanel?.captureScreenshot();
    }));

    const deployOutput = vscode.window.createOutputChannel(`${getAppName()} Deploy`);
    const deployChannelName = deployOutput.name;
    context.subscriptions.push(deployOutput);

    let deployProcess: cp.ChildProcess | undefined;
    context.subscriptions.push({
        dispose: () => {
            deployProcess?.kill();
            deployProcess = undefined;
        }
    });

    context.subscriptions.push(vscode.commands.registerCommand('androidWireless.deployAllDevices', () => {
        if (deployProcess) {
            deployOutput.show(true);
            vscode.window.showWarningMessage(`A deployment is already running. See the "${deployChannelName}" output channel.`);
            return;
        }

        const config = vscode.workspace.getConfiguration('suvidha');
        const androidProjectDir = config.get<string>('androidProjectDir', '').trim();
        const workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const projectDir = androidProjectDir || workspaceDir;

        if (!projectDir) {
            vscode.window.showErrorMessage(
                'Open a workspace folder or set suvidha.androidProjectDir before deploying.'
            );
            return;
        }

        const scriptPath = context.asAbsolutePath(path.join('scripts', 'deploy_all_devices.sh'));
        if (!fs.existsSync(scriptPath)) {
            vscode.window.showErrorMessage(`Deployment script not found: ${scriptPath}`);
            return;
        }

        deployOutput.clear();
        deployOutput.show(true);
        deployOutput.appendLine(`[deploy] script: ${scriptPath}`);
        deployOutput.appendLine(`[deploy] cwd: ${workspaceDir ?? projectDir}`);
        deployOutput.appendLine(`[deploy] ANDROID_PROJECT_DIR: ${androidProjectDir || '(empty - using cwd)'}`);
        deployOutput.appendLine('');

        const child = spawn('bash', [scriptPath], {
            cwd: workspaceDir ?? projectDir,
            env: {
                ...process.env,
                ANDROID_PROJECT_DIR: androidProjectDir
            }
        });

        deployProcess = child;

        let failedToStart = false;

        child.stdout?.on('data', (data: Buffer) => deployOutput.append(data.toString()));
        child.stderr?.on('data', (data: Buffer) => deployOutput.append(data.toString()));

        child.on('error', (err) => {
            failedToStart = true;
            deployProcess = undefined;
            deployOutput.appendLine(`\n[deploy] Failed to start deployment: ${err.message}`);
            vscode.window.showErrorMessage(`Could not start deployment: ${err.message}`);
        });

        child.on('close', (code, signal) => {
            deployProcess = undefined;

            if (failedToStart) {
                return;
            }

            if (code === 0) {
                deployOutput.appendLine('\n[deploy] Deployment finished successfully.');
                vscode.window.showInformationMessage('Deployment finished successfully on all connected devices.');
            } else {
                const reason = signal ? `signal ${signal}` : `exit code ${code}`;
                deployOutput.appendLine(`\n[deploy] Deployment failed (${reason}).`);
                vscode.window.showErrorMessage(`Deployment failed (${reason}). See the "${deployChannelName}" output channel.`);
            }
        });
    }));

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('suvidha.appName')) {
                updateStatusBar();
                controllerProvider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('androidWirelessDevices', controllerProvider)
    );
}

export function deactivate() {
    mirrorPanel?.stop();
    mirrorPanel = undefined;
}
