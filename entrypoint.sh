#!/bin/bash

# Configuration
LIDAR_PORT="/dev/ttyUSB0"

echo "Starting Robot Core Entrypoint..."

while true; do
    echo "Waiting for Lidar to be plugged in at $LIDAR_PORT..."
    
    # Wait until the device file exists
    while [ ! -e "$LIDAR_PORT" ]; do
        sleep 1
    done

    echo "Lidar detected at $LIDAR_PORT!"
    
    # Set proper permissions for the serial port
    chmod 666 "$LIDAR_PORT"

    # Source ROS 2 environment
    source /opt/ros/humble/setup.bash
    source /app/install/setup.bash

    echo "Launching mapping node..."
    # Launch the mapping stack in the background
    ros2 launch my_robot_controller mapping_launch.py serial_port:="$LIDAR_PORT" &
    LAUNCH_PID=$!

    # Monitor the connection
    while [ -e "$LIDAR_PORT" ]; do
        # Check if the process has died unexpectedly
        if ! kill -0 $LAUNCH_PID 2>/dev/null; then
            echo "Launch process died unexpectedly. Restarting..."
            break
        fi
        sleep 1
    done

    echo "Lidar disconnected! Stopping mapping node..."
    # Kill the background process
    if kill -0 $LAUNCH_PID 2>/dev/null; then
        kill -SIGINT $LAUNCH_PID
        wait $LAUNCH_PID 2>/dev/null
    fi
    
    # Small delay before trying again
    sleep 2
done
