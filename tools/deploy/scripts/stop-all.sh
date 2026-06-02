#!/bin/bash
# =============================================================================
# stop-all.sh — Stop all services on the Pi
# =============================================================================

set -e

echo "=== Stopping All Services ==="

# PM2 services
pm2 stop    nguyen-backend  2>/dev/null || true
pm2 stop    nguyen-frontend 2>/dev/null || true
pm2 delete  nguyen-backend  2>/dev/null || true
pm2 delete  nguyen-frontend 2>/dev/null || true

# ROS / robot nodes
pkill -f "map_manager"  2>/dev/null || true
pkill -f "brain_node"   2>/dev/null || true
pkill -f "web_bridge"   2>/dev/null || true
pkill -f "lidar_only"   2>/dev/null || true
pkill -f "static_transform_publisher" 2>/dev/null || true

echo "=== All Services Stopped ==="
pm2 status
