FROM ros:humble-ros-base

ENV DEBIAN_FRONTEND=noninteractive

# 1. Cài các package tiêu chuẩn (Bỏ sllidar đi, thêm git để clone code)
RUN apt-get update && apt-get upgrade -y && apt-get install -y --fix-missing --no-install-recommends \
    python3-colcon-common-extensions \
    ros-humble-slam-toolbox \
    ros-humble-tf2-ros \
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
# Bỏ --symlink-install và thêm --executor sequential để tránh quá tải RAM (Exit code 2) trên Pi
RUN /bin/bash -c "source /opt/ros/humble/setup.bash && colcon build --executor sequential"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]