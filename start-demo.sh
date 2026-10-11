#!/usr/bin/env bash
# Cross-platform demo startup script (macOS, Linux, Windows via Git Bash/WSL)
# ---------------------------------------------------------------------------
# Starts the Orchestrator API and web server for the Container Optimization
# Demo. Automatically detects the OS and uses appropriate commands.

set -euo pipefail

cd "$(dirname "$0")"

# Color output helpers
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }

echo "=== Starting Container Optimization Demo ==="
echo ""

# Detect OS
case "$(uname -s)" in
  Linux*)   OS="linux";;
  Darwin*)  OS="macos";;
  *)        OS="unknown";;
esac

# Kill any existing processes
echo "Stopping any existing processes..."
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  taskkill /f /node orchestrator/api.js 2>/dev/null || true
  taskkill /f /im python3.exe 2>/dev/null || true
else
  pkill -f "node orchestrator/api.js" 2>/dev/null || true
  pkill -f "python3 -m http.server" 2>/dev/null || true
fi
sleep 2

# Start API
echo "Starting Orchestrator API on port 8080..."
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  set PORT=8080
  node orchestrator/api.js > /dev/null 2>&1 &
  API_PID=$!
else
  PORT=8080
  node orchestrator/api.js &
  API_PID=$!
fi
sleep 3

# Check if API started
if curl -s http://localhost:8080/sessions > /dev/null 2>&1; then
    green "✅ API started successfully"
else
    red "❌ API failed to start"
    exit 1
fi

# Start web server (try 3000, fallback to 3001)
WEB_PORT=3000
if command -v lsof > /dev/null 2>&1; then
  if lsof -i :3000 > /dev/null 2>&1; then
    yellow "Port 3000 in use, trying 3001..."
    WEB_PORT=3001
  fi
fi

echo "Starting web server on port $WEB_PORT..."
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  python3 -m http.server $WEB_PORT > /dev/null 2>&1 &
  WEB_PID=$!
else
  python3 -m http.server $WEB_PORT &
  WEB_PID=$!
fi
sleep 2

# Check if web server started
if curl -s http://localhost:$WEB_PORT > /dev/null 2>&1; then
    green "✅ Web server started successfully"
else
    red "❌ Web server failed to start"
    exit 1
fi

echo ""
echo "=== Demo Environment Ready ==="
echo "API: http://localhost:8080"
echo "Web: http://localhost:$WEB_PORT/demo.html"
echo ""

echo "Benchmarks on this page:"
echo "  GET  localhost:8080/benchmarks          -> live measurement if one exists,"
echo "                                          else the recorded 2026-10-01 baseline"
echo "  POST localhost:8080/benchmarks/run      -> measure a fresh pair now (202 {job_id})"
echo "  GET  localhost:8080/benchmarks/status   -> {running, last_run_at, error?}"
echo "  The page's 'Re-run benchmark' button calls the same two endpoints and polls."
echo "  Headless equivalent: ./benchmark/run.sh live"
echo ""

# Open browser based on OS
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  start http://localhost:$WEB_PORT/demo.html 2>/dev/null || powershell -Command "Start-Process http://localhost:$WEB_PORT/demo.html" 2>/dev/null || true
elif [ "$OS" = "macos" ]; then
  open http://localhost:$WEB_PORT/demo.html
else
  xdg-open http://localhost:$WEB_PORT/demo.html 2>/dev/null || true
fi

echo ""
echo "Demo is running! Press Ctrl+C to stop all services"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping services..."
    if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
      taskkill /f /pid $API_PID 2>/dev/null || true
      taskkill /f /pid $WEB_PID 2>/dev/null || true
    else
      kill $API_PID 2>/dev/null || true
      kill $WEB_PID 2>/dev/null || true
    fi
    echo "Services stopped"
    exit 0
}

# Set trap for cleanup
trap cleanup INT TERM

# Wait for both processes
wait $API_PID $WEB_PID