import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface DeployOptions {
    projectDir?: string;
    appPackage?: string;
    adbPath: string;
    outputChannel: vscode.OutputChannel;
    targetSerial?: string;
}

/**
 * Searches upward from candidate path for a directory containing gradlew or gradlew.bat.
 */
export function findGradlewRoot(candidate: string): string | null {
    let current = path.resolve(candidate);
    while (true) {
        if (fs.existsSync(path.join(current, 'gradlew')) || fs.existsSync(path.join(current, 'gradlew.bat'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            break;
        }
        current = parent;
    }
    return null;
}

/**
 * Finds the aapt binary in Android SDK build-tools or PATH.
 */
export function findAaptPath(): string | null {
    const home = process.env.HOME || '';
    const sdkCandidates = [
        process.env.ANDROID_HOME,
        process.env.ANDROID_SDK_ROOT,
        path.join(home, 'Library', 'Android', 'sdk'),
        path.join(home, 'Android', 'Sdk'),
    ].filter((p): p is string => Boolean(p && fs.existsSync(p)));

    for (const sdk of sdkCandidates) {
        const buildToolsDir = path.join(sdk, 'build-tools');
        if (fs.existsSync(buildToolsDir)) {
            const versions = fs.readdirSync(buildToolsDir).sort().reverse();
            for (const ver of versions) {
                const aapt = path.join(buildToolsDir, ver, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
                if (fs.existsSync(aapt)) {
                    return aapt;
                }
            }
        }
    }

    try {
        const which = process.platform === 'win32' ? 'where aapt' : 'which aapt';
        const result = cp.execSync(which, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        if (result && fs.existsSync(result)) {
            return result;
        }
    } catch {
        // ignore
    }

    return null;
}

/**
 * Executes a child process command and pipes output to the given OutputChannel.
 */
function execWithOutput(
    command: string,
    args: string[],
    cwd: string,
    outputChannel: vscode.OutputChannel,
    extraEnv: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
        const child = cp.spawn(command, args, {
            cwd,
            env: { ...process.env, ...extraEnv }
        });

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (d: Buffer) => {
            const text = d.toString();
            stdout += text;
            outputChannel.append(text);
        });

        child.stderr?.on('data', (d: Buffer) => {
            const text = d.toString();
            stderr += text;
            outputChannel.append(text);
        });

        child.on('error', (err) => {
            outputChannel.appendLine(`[deploy error] ${err.message}`);
            resolve({ code: -1, stdout, stderr: err.message });
        });

        child.on('close', (code) => {
            resolve({ code: code ?? 0, stdout, stderr });
        });
    });
}

/**
 * Recursively locates debug APK files in build output directories.
 */
function findDebugApks(dir: string): string[] {
    const results: string[] = [];

    function walk(current: string) {
        if (!fs.existsSync(current)) return;
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.gradle') {
                    continue;
                }
                walk(fullPath);
            } else if (entry.isFile() && entry.name.endsWith('.apk')) {
                const norm = fullPath.replace(/\\/g, '/');
                if (norm.includes('/build/outputs/apk/debug/')) {
                    results.push(fullPath);
                }
            }
        }
    }

    walk(dir);
    return results;
}

/**
 * Deploys the Android project to all connected ADB devices.
 */
/**
 * Deploys the Android project to connected ADB devices (or a specific selected device).
 */
export async function deployApp(options: DeployOptions): Promise<boolean> {
    const { adbPath, outputChannel } = options;
    outputChannel.clear();
    outputChannel.show(true);

    outputChannel.appendLine('==================================================');
    outputChannel.appendLine('  SUVIDHA Android Deployment');
    outputChannel.appendLine('==================================================');

    // 1. Resolve project root
    let rootCandidate = options.projectDir;
    if (!rootCandidate && vscode.workspace.workspaceFolders?.length) {
        rootCandidate = vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    if (!rootCandidate) {
        outputChannel.appendLine('Error: No workspace open or suvidha.androidProjectDir configured.');
        vscode.window.showErrorMessage('Open an Android workspace or configure suvidha.androidProjectDir.');
        return false;
    }

    const projectRoot = findGradlewRoot(rootCandidate);
    if (!projectRoot) {
        outputChannel.appendLine(`Error: gradlew not found in "${rootCandidate}" or its parent folders.`);
        vscode.window.showErrorMessage(`gradlew not found in "${rootCandidate}". Configure suvidha.androidProjectDir.`);
        return false;
    }

    outputChannel.appendLine(`Android Project Root: ${projectRoot}`);
    outputChannel.appendLine(`ADB: ${adbPath}`);

    // 2. Discover connected devices
    outputChannel.appendLine('\nChecking connected ADB devices...');
    const devicesOutput = await new Promise<string>((resolve) => {
        cp.execFile(adbPath, ['devices', '-l'], { timeout: 6000 }, (err, stdout) => {
            resolve(err || !stdout ? '' : stdout.toString());
        });
    });

    const lines = devicesOutput.trim().split('\n').slice(1);
    const devices: { serial: string; model: string }[] = [];
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === 'device') {
            const serial = parts[0];
            const modelMatch = line.match(/model:(\S+)/);
            const model = modelMatch ? modelMatch[1].replace(/_/g, ' ') : 'Unknown Model';
            devices.push({ serial, model });
        }
    }

    if (devices.length === 0) {
        outputChannel.appendLine('Error: No authorized/connected ADB devices found.');
        outputChannel.appendLine('Please ensure your device is connected via USB or Wireless Debugging.');
        vscode.window.showErrorMessage('No active ADB devices found. Connect or pair your phone first.');
        return false;
    }

    outputChannel.appendLine(`Found ${devices.length} connected device(s):`);
    for (const d of devices) {
        outputChannel.appendLine(`  - ${d.serial} (${d.model})`);
    }

    let targetDevices = devices;
    if (options.targetSerial && options.targetSerial !== 'ALL') {
        targetDevices = devices.filter(d => d.serial === options.targetSerial);
        if (targetDevices.length === 0) {
            outputChannel.appendLine(`\nError: Target device "${options.targetSerial}" is not currently connected.`);
            vscode.window.showErrorMessage(`Selected device ${options.targetSerial} is not connected.`);
            return false;
        }
        outputChannel.appendLine(`\nTargeting selected device: ${targetDevices[0].serial} (${targetDevices[0].model})`);
    } else {
        outputChannel.appendLine(`\nTargeting all connected devices (${targetDevices.length})`);
    }

    // 3. Build APK with Gradle
    outputChannel.appendLine('\nBuilding debug APK with Gradle...');
    const gradlewScript = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';
    const buildResult = await execWithOutput(gradlewScript, ['assembleDebug'], projectRoot, outputChannel);

    if (buildResult.code !== 0) {
        outputChannel.appendLine(`\nError: Gradle build failed with exit code ${buildResult.code}.`);
        vscode.window.showErrorMessage('Gradle build failed. See output channel for details.');
        return false;
    }

    // 4. Locate built APK
    outputChannel.appendLine('\nLocating debug APK...');
    const apks = findDebugApks(projectRoot);
    if (apks.length === 0) {
        outputChannel.appendLine('Error: No debug APK found in build/outputs/apk/debug/.');
        vscode.window.showErrorMessage('No debug APK found after Gradle build.');
        return false;
    }

    const apkPath = apks[0];
    const stats = fs.statSync(apkPath);
    const apkSizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    outputChannel.appendLine(`APK: ${apkPath} (${apkSizeMb} MB)`);

    // 5. Determine package name
    let targetPackage = options.appPackage?.trim();
    if (!targetPackage) {
        const aaptPath = findAaptPath();
        if (aaptPath) {
            try {
                const badging = cp.execFileSync(aaptPath, ['dump', 'badging', apkPath], { encoding: 'utf8' });
                const match = badging.match(/package: name='([^']+)'/);
                if (match) {
                    targetPackage = match[1];
                }
            } catch {
                // ignore
            }
        }
    }

    if (!targetPackage) {
        targetPackage = 'com.just_sri.suvidha.expenses';
    }
    outputChannel.appendLine(`Target Package: ${targetPackage}\n`);

    // 6. Install & launch on each target device
    let successCount = 0;
    let failedCount = 0;

    for (const dev of targetDevices) {
        outputChannel.appendLine('--------------------------------------------------');
        outputChannel.appendLine(`Deploying to: ${dev.serial} (${dev.model})`);
        outputChannel.appendLine('--------------------------------------------------');

        outputChannel.appendLine('Installing APK...');
        const installResult = await execWithOutput(adbPath, ['-s', dev.serial, 'install', '-r', apkPath], projectRoot, outputChannel);
        if (installResult.code !== 0) {
            outputChannel.appendLine(`Error: Installation failed on ${dev.serial}.`);
            failedCount++;
            continue;
        }

        outputChannel.appendLine('Stopping existing process...');
        try {
            cp.execFileSync(adbPath, ['-s', dev.serial, 'shell', 'am', 'force-stop', targetPackage], { timeout: 5000 });
        } catch {
            // ignore
        }

        outputChannel.appendLine('Resolving launcher activity...');
        let launcherActivity = '';
        try {
            const out = cp.execFileSync(
                adbPath,
                ['-s', dev.serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', targetPackage],
                { encoding: 'utf8', timeout: 5000 }
            );
            const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
            const match = lines.find(l => l.startsWith(`${targetPackage}/`));
            if (match) {
                launcherActivity = match;
            }
        } catch {
            // ignore
        }

        outputChannel.appendLine('Launching app...');
        let launchSuccess = false;
        if (launcherActivity) {
            try {
                cp.execFileSync(adbPath, ['-s', dev.serial, 'shell', 'am', 'start', '-n', launcherActivity], { timeout: 6000 });
                launchSuccess = true;
            } catch (err: any) {
                outputChannel.appendLine(`Launch with ${launcherActivity} failed: ${err.message}`);
            }
        }

        if (!launchSuccess) {
            try {
                cp.execFileSync(adbPath, ['-s', dev.serial, 'shell', 'monkey', '-p', targetPackage, '-c', 'android.intent.category.LAUNCHER', '1'], { timeout: 6000 });
                launchSuccess = true;
            } catch (err: any) {
                outputChannel.appendLine(`Monkey launch failed: ${err.message}`);
            }
        }

        if (launchSuccess) {
            outputChannel.appendLine(`Success: ${dev.serial} running ${targetPackage}`);
            successCount++;
        } else {
            outputChannel.appendLine(`Failed to launch on ${dev.serial}`);
            failedCount++;
        }
        outputChannel.appendLine('');
    }

    outputChannel.appendLine('==================================================');
    outputChannel.appendLine('Deployment Summary:');
    outputChannel.appendLine(`  Target(s):  ${targetDevices.length}`);
    outputChannel.appendLine(`  Successful: ${successCount}`);
    outputChannel.appendLine(`  Failed:     ${failedCount}`);
    outputChannel.appendLine('==================================================');

    if (failedCount === 0) {
        const msg = targetDevices.length === 1
            ? `Deployment finished successfully on ${targetDevices[0].model} (${targetDevices[0].serial}).`
            : `Deployment finished successfully on all ${targetDevices.length} device(s).`;
        vscode.window.showInformationMessage(msg);
        return true;
    } else {
        vscode.window.showWarningMessage(`Deployment completed with ${failedCount} failure(s). Check output.`);
        return false;
    }
}

/**
 * Backward compatibility alias for deployApp targeting all devices.
 */
export const deployToAllDevices = deployApp;
