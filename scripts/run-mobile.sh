#!/usr/bin/env bash
# =============================================================================
# Taxi-Wisam: Launch Flutter App on Connected Device / Simulator
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/apps/taxi_wisam_flutter"

export PATH="/opt/homebrew/bin:/opt/homebrew/share/flutter/bin:$HOME/development/flutter/bin:$PATH"

echo "========================================================"
echo "🚖 Taxi-Wisam Mobile App Launcher"
echo "========================================================"

cd "$APP_DIR"

if ! command -v flutter &> /dev/null; then
    echo "[!] Flutter SDK not found in PATH."
    echo "    Please install Flutter SDK via: brew install --cask flutter"
    exit 1
fi

echo "--> Checking connected devices..."
flutter devices

# Ensure project structure has platform folders if needed
if [ ! -d "$APP_DIR/ios" ]; then
    echo "--> Initializing platform scaffolding (iOS/Android)..."
    flutter create . --org com.taxiwisam --project-name taxi_wisam_flutter
fi

echo "--> Installing Flutter dependencies..."
flutter pub get

echo "--> Launching app on active booted device..."
flutter run -d booted
