FROM ros:jazzy-ros-base

ENV DEBIAN_FRONTEND=noninteractive

# Install only what's needed: lidar driver + numpy + websockets
RUN apt-get update && apt-get upgrade -y && \
    apt-get install -y --fix-missing --no-install-recommends \
    python3-colcon-common-extensions \
    python3-pip \
    ros-jazzy-tf2-ros \
    ros-jazzy-sensor-msgs \
    python3-numpy \
    git \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages websockets

WORKDIR /app

# Tạo thư mục src trước
RUN mkdir -p /app/src

# Clone Lidar driver vào thư mục riêng trong src
RUN git clone https://github.com/Slamtec/sllidar_ros2.git /app/src/sllidar_ros2

# Copy code của ông vào
COPY src/ /app/src/my_robot_controller/  # Nên để code của mình vào một package riêng

# Build (Không cần rm -rf /app/build ở đây vì mỗi lần build layer này là nó mới rồi)
RUN /bin/bash -c "source /opt/ros/jazzy/setup.bash && \
    colcon build --merge-install --executor sequential""

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

RUN echo 'source /opt/ros/jazzy/setup.bash' >> /root/.bashrc && \
    echo 'source /app/install/setup.bash' >> /root/.bashrc

RUN echo '#!/bin/bash' > /usr/local/bin/ros2 && \
    echo 'source /opt/ros/jazzy/setup.bash' >> /usr/local/bin/ros2 && \
    echo 'source /app/install/setup.bash' >> /usr/local/bin/ros2 && \
    echo 'exec /opt/ros/jazzy/bin/ros2 "$@"' >> /usr/local/bin/ros2 && \
    chmod +x /usr/local/bin/ros2

ENTRYPOINT ["/entrypoint.sh"]
