FROM ros:humble-ros-base

# Set bash as the default shell
SHELL ["/bin/bash", "-c"]

# Install required dependencies
RUN apt-get update && apt-get install -y \
    python3-colcon-common-extensions \
    ros-humble-sllidar-ros2 \
    ros-humble-slam-toolbox \
    python3-serial \
    && rm -rf /var/lib/apt/lists/*

# Create workspace directory
WORKDIR /app

# Copy the source code
COPY src/ /app/src/

# Build the ROS 2 workspace
RUN source /opt/ros/humble/setup.bash && \
    colcon build --symlink-install

# Copy the entrypoint script and make it executable
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set the entrypoint
ENTRYPOINT ["/app/entrypoint.sh"]
