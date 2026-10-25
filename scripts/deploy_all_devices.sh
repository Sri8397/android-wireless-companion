#!/usr/bin/env bash
set -eo pipefail

# ==============================================================================
# Script: deploy_all_devices.sh
# Purpose: Build an Android APK and install/restart it on all connected ADB devices
# Host: macOS
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ------------------------------------------------------------------------------
# Locate Android project root
# ------------------------------------------------------------------------------

find_gradlew_root() {
    local candidate="$1"

    while [[ -n "$candidate" && "$candidate" != "/" ]]; do
        if [[ -f "$candidate/gradlew" ]]; then
            echo "$candidate"
            return 0
        fi

        candidate="$(dirname "$candidate")"
    done

    return 1
}

# Prefer the directory configured in VS Code Settings.
PROJECT_ROOT="${ANDROID_PROJECT_DIR:-}"

if [[ -z "$PROJECT_ROOT" ]]; then
    PROJECT_ROOT="$PWD"
fi

if [[ ! -f "$PROJECT_ROOT/gradlew" ]]; then
    echo "Error: gradlew not found in '$PROJECT_ROOT'." >&2
    echo "Configure suvidha.androidProjectDir in VS Code Settings." >&2
    exit 1
fi

PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
cd "$PROJECT_ROOT"

echo "Android project root: $PROJECT_ROOT"
# ------------------------------------------------------------------------------
# Locate ADB
# ------------------------------------------------------------------------------

ADB=""

if [[ -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
    ADB="$HOME/Library/Android/sdk/platform-tools/adb"
elif [[ -n "${ANDROID_HOME:-}" && -x "$ANDROID_HOME/platform-tools/adb" ]]; then
    ADB="$ANDROID_HOME/platform-tools/adb"
elif [[ -n "${ANDROID_SDK_ROOT:-}" && -x "$ANDROID_SDK_ROOT/platform-tools/adb" ]]; then
    ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
elif command -v adb >/dev/null 2>&1; then
    ADB="$(command -v adb)"
else
    echo "Error: adb not found. Install Android SDK platform-tools." >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# Options and configuration
# ------------------------------------------------------------------------------

SKIP_BUILD=false
PACKAGE="${SUVIDHA_APP_PACKAGE:-${ANDROID_APP_PACKAGE:-}}"
ACTIVITY=""
APK_PATH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-build|-s)
            SKIP_BUILD=true
            shift
            ;;

        --apk|-a)
            if [[ $# -lt 2 || -z "$2" ]]; then
                echo "Error: --apk requires a path." >&2
                exit 1
            fi
            APK_PATH="$2"
            shift 2
            ;;

        --package|-p)
            if [[ $# -lt 2 || -z "$2" ]]; then
                echo "Error: --package requires a package name." >&2
                exit 1
            fi
            PACKAGE="$2"
            shift 2
            ;;

        --activity)
            if [[ $# -lt 2 || -z "$2" ]]; then
                echo "Error: --activity requires a component name." >&2
                exit 1
            fi
            ACTIVITY="$2"
            shift 2
            ;;

        --help|-h)
            cat <<EOF
Usage: $0 [options]

Options:
  -s, --skip-build    Skip the Gradle build
  -a, --apk <path>    Specify the APK path
  -p, --package <pkg> Specify the Android package name
      --activity <c>  Specify the launcher activity component
  -h, --help          Show this help

Configuration:
  ANDROID_PROJECT_DIR Android project directory
  SUVIDHA_APP_PACKAGE Preferred package environment variable
  ANDROID_APP_PACKAGE Alternative package environment variable

If --package and both package environment variables are omitted,
the package name is read from the APK manifest.

If --activity is omitted, the launcher activity is discovered
on each connected device.

If --apk is omitted, exactly one APK must be found in the
project's debug APK output directories.
EOF
            exit 0
            ;;

        *)
            echo "Error: Unknown option: $1" >&2
            exit 1
            ;;
    esac
done

echo "Using ADB: $ADB"
echo "Project root: $PROJECT_ROOT"

# ------------------------------------------------------------------------------
# Find connected devices
# ------------------------------------------------------------------------------

echo "Checking connected ADB devices..."

DEVICE_OUTPUT="$("$ADB" devices)"
DEVICES=()

while IFS=$'\t' read -r serial status _; do
    if [[ "$status" == "device" && -n "$serial" ]]; then
        DEVICES+=("$serial")
    fi
done < <(printf '%s\n' "$DEVICE_OUTPUT" | tail -n +2)

if [[ ${#DEVICES[@]} -eq 0 ]]; then
    echo "Error: No authorized/active ADB devices found." >&2
    "$ADB" devices -l
    echo "Enable USB/Wireless debugging and authorize the computer."
    exit 1
fi

echo "Found ${#DEVICES[@]} connected device(s):"

for dev in "${DEVICES[@]}"; do
    MODEL="$("$ADB" -s "$dev" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')"
    echo "  - $dev (${MODEL:-Unknown model})"
done

echo ""

# ------------------------------------------------------------------------------
# Build APK
# ------------------------------------------------------------------------------

if [[ "$SKIP_BUILD" == false ]]; then
    echo "Building debug APK..."
    ./gradlew assembleDebug
else
    echo "Skipping build."
fi

# ------------------------------------------------------------------------------
# Locate APK when --apk wasn't provided
# ------------------------------------------------------------------------------

if [[ -z "$APK_PATH" ]]; then
    APK_CANDIDATES=()

    while IFS= read -r -d '' candidate; do
        APK_CANDIDATES+=("$candidate")
    done < <(
        find "$PROJECT_ROOT" \
            -type f \
            -path '*/build/outputs/apk/debug/*.apk' \
            -print0
    )

    if [[ ${#APK_CANDIDATES[@]} -eq 0 ]]; then
        echo "Error: No debug APK found. Build the project or use --apk." >&2
        exit 1
    elif [[ ${#APK_CANDIDATES[@]} -gt 1 ]]; then
        echo "Error: Multiple debug APKs found. Specify one using --apk:" >&2

        for candidate in "${APK_CANDIDATES[@]}"; do
            echo "  $candidate" >&2
        done

        exit 1
    fi

    APK_PATH="${APK_CANDIDATES[0]}"
fi

# Resolve a relative APK path against the project root.
if [[ "$APK_PATH" != /* ]]; then
    APK_PATH="$PROJECT_ROOT/$APK_PATH"
fi

if [[ ! -f "$APK_PATH" ]]; then
    echo "Error: APK not found: $APK_PATH" >&2
    exit 1
fi

# ------------------------------------------------------------------------------
# Locate aapt to read the APK manifest
# ------------------------------------------------------------------------------

SDK_ROOT="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
AAPT=""

for candidate in "$SDK_ROOT"/build-tools/*/aapt; do
    if [[ -x "$candidate" ]]; then
        AAPT="$candidate"
    fi
done

if [[ -z "$AAPT" ]]; then
    echo "Error: aapt not found in Android SDK build-tools." >&2
    exit 1
fi

APK_PACKAGE="$(
    "$AAPT" dump badging "$APK_PATH" |
        sed -n "s/^package: name='\([^']*\)'.*/\1/p" |
        head -n 1
)"

if [[ -z "$APK_PACKAGE" ]]; then
    echo "Error: Could not read package name from APK manifest." >&2
    exit 1
fi

# Explicit package > environment configuration > APK manifest.
PACKAGE="${PACKAGE:-$APK_PACKAGE}"

echo "APK: $APK_PATH"
echo "Package: $PACKAGE"
echo "Size: $(du -h "$APK_PATH" | cut -f1)"
echo ""

# ------------------------------------------------------------------------------
# Install and launch on each device
# ------------------------------------------------------------------------------

SUCCESS_COUNT=0
FAILED_COUNT=0

for dev in "${DEVICES[@]}"; do
    MODEL="$("$ADB" -s "$dev" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')"

    echo "=================================================="
    echo "Deploying to: $dev (${MODEL:-Unknown model})"
    echo "=================================================="

    echo "Installing APK..."

    if ! "$ADB" -s "$dev" install -r "$APK_PATH"; then
        echo "Error: Installation failed on $dev." >&2
        FAILED_COUNT=$((FAILED_COUNT + 1))
        continue
    fi

    echo "Stopping existing app process..."

    "$ADB" -s "$dev" shell am force-stop "$PACKAGE" || true

    # Resolve the launcher activity on the target device unless overridden.
    DEVICE_ACTIVITY="$ACTIVITY"

    if [[ -z "$DEVICE_ACTIVITY" ]]; then
        DEVICE_ACTIVITY="$(
            "$ADB" -s "$dev" shell cmd package resolve-activity \
                --brief \
                -a android.intent.action.MAIN \
                -c android.intent.category.LAUNCHER \
                "$PACKAGE" 2>/dev/null |
                tr -d '\r' |
                grep -E "^${PACKAGE//./\\.}/" |
                tail -n 1 || true
        )"
    fi

    echo "Launching app..."

    if [[ -n "$DEVICE_ACTIVITY" ]]; then
        if "$ADB" -s "$dev" shell am start -n "$DEVICE_ACTIVITY"; then
            echo "Success: $dev"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        else
            echo "Error: Failed to launch $DEVICE_ACTIVITY on $dev." >&2
            FAILED_COUNT=$((FAILED_COUNT + 1))
        fi
    else
        echo "No launcher activity resolved; trying launcher intent..."

        if "$ADB" -s "$dev" shell monkey \
            -p "$PACKAGE" \
            -c android.intent.category.LAUNCHER 1; then
            echo "Success: $dev"
            SUCCESS_COUNT=$((SUCCESS_COUNT + 1))
        else
            echo "Error: Could not launch $PACKAGE on $dev." >&2
            FAILED_COUNT=$((FAILED_COUNT + 1))
        fi
    fi

    echo ""
done

# ------------------------------------------------------------------------------
# Deployment summary
# ------------------------------------------------------------------------------

echo "=================================================="
echo "Deployment Summary"
echo "Total devices: ${#DEVICES[@]}"
echo "Successful:    $SUCCESS_COUNT"
echo "Failed:        $FAILED_COUNT"
echo "=================================================="

if [[ "$FAILED_COUNT" -gt 0 ]]; then
    exit 1
fi
