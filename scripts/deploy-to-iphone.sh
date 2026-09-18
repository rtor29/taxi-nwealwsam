#!/usr/bin/env bash
# =============================================================================
# Taxi-Wisam: Deploy Directly to Physical iPhone 15 Pro Max
# Device UDID: 00008130-000C78D83C01001C
# Apple Team ID: 423L2V646H
# =============================================================================

set -e

DEVICE_UDID="00008130-000C78D83C01001C"
TEAM_ID="423L2V646H"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$ROOT_DIR/apps/taxi_wisam_flutter"

export PATH="/opt/homebrew/bin:/opt/homebrew/share/flutter/bin:$HOME/development/flutter/bin:$PATH"

echo "========================================================"
echo "📱 Deploying Taxi-Wisam to Physical iPhone 15 Pro Max"
echo "UDID: $DEVICE_UDID"
echo "Team ID: $TEAM_ID"
echo "========================================================"

cd "$APP_DIR"

if ! command -v flutter &> /dev/null; then
    echo "[!] Flutter SDK not ready yet. Please wait a moment."
    exit 1
fi

# Ensure iOS scaffolding exists
if [ ! -d "$APP_DIR/ios" ]; then
    echo "--> Generating iOS workspace..."
    flutter create . --org com.taxiwisam --project-name taxi_wisam_flutter
fi

# Set Development Team in Xcode project if needed
if [ -f "$APP_DIR/ios/Runner.xcodeproj/project.pbxproj" ]; then
    echo "--> Injecting Apple Development Team ID ($TEAM_ID)..."
    sed -i '' "s/DevelopmentTeam = \"\";/DevelopmentTeam = \"$TEAM_ID\";/g" "$APP_DIR/ios/Runner.xcodeproj/project.pbxproj" 2>/dev/null || true
    sed -i '' "s/DEVELOPMENT_TEAM = \"\";/DEVELOPMENT_TEAM = $TEAM_ID;/g" "$APP_DIR/ios/Runner.xcodeproj/project.pbxproj" 2>/dev/null || true
fi

echo "--> Restoring dependencies..."
flutter pub get

echo "--> Building and Installing onto iPhone 15 Pro Max..."
flutter run -d "$DEVICE_UDID"
