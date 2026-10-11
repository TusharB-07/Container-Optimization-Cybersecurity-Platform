#!/usr/bin/env bash
# Cross-platform demo session script (macOS, Linux, Windows via Git Bash/WSL)
# ---------------------------------------------------------------------------
# Manages a Container Optimization demo session: creates, status, containers,
# resource usage, network isolation, connectivity testing, and cleanup.

cd "$(dirname "$0")"

# Color output helpers
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
yellow(){ printf '\033[33m%s\033[0m\n' "$1"; }
cyan()  { printf '\033[36m%s\033[0m\n' "$1"; }

echo "=== Container Optimization Platform Demo ==="
echo ""

# Detect OS
case "$(uname -s)" in
  Linux*)   OS="linux";;
  Darwin*)  OS="macos";;
  *)        OS="unknown";;
esac

# Check if API is already running
API_RUNNING=false
if curl -s http://localhost:8080/sessions > /dev/null 2>&1; then
    green "✓ API already running on port 8080"
    API_RUNNING=true
    API_PID=""
else
    cyan "1. Starting Orchestrator API..."
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
fi

echo ""

# Create demo session
cyan "2. Creating demo session..."
SESSION_OUTPUT=$(curl -s -X POST localhost:8080/sessions \
  -H 'content-type: application/json' \
  -d '{"bundle":"web-exploitation","id":"tech-lead-demo"}')
echo "$SESSION_OUTPUT"

echo ""

# Session Status
cyan "3. Session Status:"
SESSION_STATUS=$(curl -s localhost:8080/sessions/tech-lead-demo)
echo "$SESSION_STATUS" | jq '.'

echo ""

# Running Containers
cyan "4. Running Containers:"
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  docker ps 2>/dev/null | grep tech-lead-demo || yellow "docker ps not available or no matching containers"
else
  docker ps | grep tech-lead-demo || yellow "No matching containers found"
fi

echo ""

# Resource Usage
cyan "5. Resource Usage:"
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  docker stats --no-stream 2>/dev/null | grep tech-lead-demo || yellow "docker stats not available"
else
  docker stats --no-stream | grep tech-lead-demo || yellow "No matching container stats"
fi

echo ""

# Network Isolation
cyan "6. Network Isolation:"
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  docker network ls | grep tech-lead-demo || yellow "No matching network found"
else
  docker network ls | grep tech-lead-demo || yellow "No matching network found"
fi

echo ""

# Testing connectivity between containers
cyan "7. Testing connectivity between containers:"
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  if docker exec sess-tech-lead-demo-attacker nc -z sess-tech-lead-demo-target 8080 2>/dev/null; then
    green "✓ Attacker can reach target on port 8080"
  else
    yellow "✗ Attacker cannot reach target on port 8080"
  fi
else
  if docker exec sess-tech-lead-demo-attacker nc -z sess-tech-lead-demo-target 8080 >/dev/null 2>&1; then
    green "✓ Attacker can reach target on port 8080"
  else
    yellow "✗ Attacker cannot reach target on port 8080"
  fi
fi

echo ""

# Cleanup - deleting session
cyan "8. Cleanup - deleting session..."
curl -s -X DELETE localhost:8080/sessions/tech-lead-demo

echo ""

# Final container status
cyan "9. Final container status:"
if [ "$OS" = "windows" ] || [ "$OS" = "msys" ] || [ "$OS" = "cygwin" ]; then
  if docker ps | grep tech-lead-demo >/dev/null 2>&1; then
    red "✗ Containers still running"
  else
    green "✓ All demo containers cleaned up"
  fi
else
  if docker ps | grep tech-lead-demo >/dev/null 2>&1; then
    red "✗ Containers still running"
  else
    green "✓ All demo containers cleaned up"
  fi
fi

echo ""
echo "=== Demo Complete ==="

# Only kill API if we started it
if [ "$API_RUNNING" = "false" ] && [ "$OS" != "windows" ] && [ "$OS" != "msys" ] && [ "$OS" != "cygwin" ]; then
    kill $API_PID 2>/dev/null || true
fi