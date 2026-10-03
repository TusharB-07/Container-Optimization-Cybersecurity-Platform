#!/bin/bash
cd "$(dirname "$0")"

echo "=== Starting Container Optimization Demo ==="
echo ""

# Kill any existing processes
echo "Stopping any existing processes..."
pkill -f "node orchestrator/api.js" 2>/dev/null || true
pkill -f "python3 -m http.server" 2>/dev/null || true
sleep 2

# Start API
echo "Starting Orchestrator API on port 8080..."
PORT=8080 node orchestrator/api.js &
API_PID=$!
sleep 3

# Check if API started
if curl -s http://localhost:8080/sessions > /dev/null 2>&1; then
    echo "✅ API started successfully"
else
    echo "❌ API failed to start"
    exit 1
fi

# Start web server (try 3000, fallback to 3001)
WEB_PORT=3000
if lsof -i :3000 > /dev/null 2>&1; then
    echo "Port 3000 in use, trying 3001..."
    WEB_PORT=3001
fi

echo "Starting web server on port $WEB_PORT..."
python3 -m http.server $WEB_PORT &
WEB_PID=$!
sleep 2

# Check if web server started
if curl -s http://localhost:$WEB_PORT > /dev/null 2>&1; then
    echo "✅ Web server started successfully"
else
    echo "❌ Web server failed to start"
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
echo "Opening browser..."
open http://localhost:$WEB_PORT/demo.html

echo ""
echo "Demo is running! Press Ctrl+C to stop all services"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "Stopping services..."
    kill $API_PID 2>/dev/null || true
    kill $WEB_PID 2>/dev/null || true
    echo "Services stopped"
    exit 0
}

# Set trap for cleanup
trap cleanup INT TERM

# Wait for both processes
wait $API_PID $WEB_PID