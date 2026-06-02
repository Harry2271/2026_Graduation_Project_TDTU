#!/bin/bash
# =============================================================================
# deploy-all.sh — Deploy all three services (backend, frontend, robot)
#                  in parallel on the Pi
# =============================================================================

set -e

DEPLOY_ROOT="${DEPLOY_ROOT:-/home/pi/robot-for-nguyen}"

echo "=== Deploying All Services ==="

"$DEPLOY_ROOT/deploy/scripts/deploy-backend.sh"
"$DEPLOY_ROOT/deploy/scripts/deploy-frontend.sh"
"$DEPLOY_ROOT/deploy/scripts/deploy-robot.sh"

echo ""
echo "=== All Services Deployed ==="
echo ""
echo "PM2 status:"
pm2 status
echo ""
echo "Service URLs:"
echo "  Backend API:  http://localhost:5000"
echo "  Frontend:     http://localhost:3000"
echo "  Robot WS:     ws://localhost:9091"
