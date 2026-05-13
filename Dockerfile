FROM ros:humble-ros-base

# 1. Cài các package tiêu chuẩn (Bỏ sllidar đi, thêm git để clone code)
RUN apt-get update && apt-get install -y --fix-missing --no-install-recommends \
    python3-colcon-common-extensions \
    ros-humble-slam-toolbox \
    python3-serial \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 2. Copy folder src của ông (chứa my_robot_controller) vào
COPY src/ /app/src/

# 3. Ép nó kéo source code chính chủ của SLLidar về folder src luôn
RUN git clone https://github.com/Slamtec/sllidar_ros2.git /app/src/sllidar_ros2

# 4. Build toàn bộ workspace
# Bỏ --symlink-install để tránh lỗi libexec trong Docker và đảm bảo ổn định trên Pi 5
RUN /bin/bash -c "source /opt/ros/humble/setup.bash && colcon build"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]