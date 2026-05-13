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

# 4. Cấp quyền thực thi và Build tất cả cục diện bằng colcon
# Dùng --symlink-install để sau này code Python nhạy hơn khi update
RUN /bin/bash -c "source /opt/ros/humble/setup.bash && colcon build --symlink-install"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]