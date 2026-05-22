FROM ros:jazzy-ros-base

ENV DEBIAN_FRONTEND=noninteractive

# 1. Install all dependencies: colcon, SLAM, TF, serial, git, OpenCV, camera deps
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --fix-missing --no-install-recommends \
    python3-colcon-common-extensions \
    ros-jazzy-slam-toolbox \
    ros-jazzy-tf2-ros \
    ros-jazzy-cv-bridge \
    ros-jazzy-image-transport \
    ros-jazzy-vision-msgs \
    ros-jazzy-sensor-msgs \
    python3-serial \
    python3-opencv \
    python3-numpy \
    python3-websockets \
    libopencv-dev \
    libv4l-dev \
    libgtk-3-dev \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copy local source packages
COPY src/ /app/src/

# 3. Clone SLLidar ROS 2 driver
RUN git clone https://github.com/Slamtec/sllidar_ros2.git /app/src/sllidar_ros2

# 4. Build workspace (sequential to avoid RAM exhaustion on Pi 5)
RUN /bin/bash -c "source /opt/ros/jazzy/setup.bash && \
    colcon build --executor sequential && \
    pip install websockets"

# 5. Re-install the Python package so entry points are registered correctly
RUN /bin/bash -c "source /opt/ros/jazzy/setup.bash && \
    source /app/install/setup.bash && \
    pip install --no-deps -e /app/src/my_robot_controller"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
