#!/usr/bin/env python3
"""
brain_node.py
Robot Brain — Raspberry Pi 5
Coordinates: Lidar scan data, QR code detection, ESP32-S3 motor control,
             robotic arm, obstacle avoidance, warehouse navigation.
Communication with ESP32-S3 via Serial USB (/dev/ttyUSB1, 115200 baud).
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan, Odometry
from std_msgs.msg import String
from geometry_msgs.msg import TransformStamped
from tf2_ros import TransformBroadcaster
import math
import serial
import threading
import time
import os

# ---------------------------------------------------------------------------
# Robot State Machine
# ---------------------------------------------------------------------------
STATE_IDLE       = 0
STATE_SCANNING   = 1   # navigating to warehouse / scanning area
STATE_OBSTACLE   = 2   # obstacle detected, navigating around
STATE_QR_SCAN    = 3   # stopped at pickup zone, scanning QR code
STATE_PICKUP     = 4   # robotic arm picking up goods
STATE_RETURNING  = 5   # returning to cargo drop zone
STATE_DEPOSITING = 6   # robotic arm placing goods in cargo box
STATE_DONE       = 7   # task complete, back to home
STATE_HOME       = 8   # returning home / standby

STATE_NAMES = [
    'IDLE', 'SCANNING', 'OBSTACLE', 'QR_SCAN', 'PICKUP',
    'RETURNING', 'DEPOSITING', 'DONE', 'HOME'
]

# ---------------------------------------------------------------------------
# Navigation Constants
# ---------------------------------------------------------------------------
MIN_CLEARANCE    = 0.30   # meters — obstacle avoidance threshold
SIDE_CLEARANCE   = 0.25   # meters — side clearance for strafe
FRONT_SECTOR     = 30     # degrees — forward obstacle detection cone
TURN_THRESHOLD   = 0.40   # meters — trigger turn when front < this
STRAFE_THRESHOLD = 0.30   # meters — trigger strafe when side < this
LINEAR_SPEED     = 0.15   # m/s
TURN_SPEED       = 0.8    # rad/s
STRAFE_SPEED     = 0.12   # m/s
PICKUP_X         = 2.0    # warehouse pickup zone X (meters from origin)
PICKUP_Y         = 1.5    # warehouse pickup zone Y
CARGO_X          = -1.0   # cargo / drop zone X
CARGO_Y          = -1.0   # cargo / drop zone Y

# ESP32 serial config
ESP_PORT         = os.environ.get('ESP32_PORT', '/dev/ttyUSB1')
ESP_BAUD         = 115200
SERIAL_TIMEOUT   = 1.0


class BrainNode(Node):
    def __init__(self):
        super().__init__('brain_node')
        self.get_logger().info('Brain Node starting...')

        # Subscriptions
        self.scan_subscriber = self.create_subscription(
            LaserScan, '/scan', self.scan_callback, 10)
        self.qr_subscriber = self.create_subscription(
            String, '/qr_result', self.qr_callback, 10)

        # Publishers
        self.status_publisher = self.create_publisher(
            String, '/robot_status', 10)
        self.odom_publisher = self.create_publisher(
            Odometry, '/odom', 10)
        self.tf_broadcaster = TransformBroadcaster(self)

        # Odometry state (simulated from commanded velocities)
        self.odom_x = 0.0
        self.odom_y = 0.0
        self.odom_theta = 0.0
        self.odom_vx = 0.0
        self.odom_vy = 0.0
        self.odom_omega = 0.0
        self._last_odom_time = self.get_clock().now()

        # Lidar data
        self.last_scan: LaserScan = None
        self.scan_lock = threading.Lock()

        # State machine
        self.robot_state = STATE_IDLE
        self.qr_data: str = None
        self.goods_retrieved: bool = False
        self.goods_deposited: bool = False
        self.pickup_count: int = 0
        self.max_pickups: int = 3

        # ESP32 Serial
        self.esp_serial: serial.Serial = None
        self.serial_lock = threading.Lock()
        self.esp_response: str = ''
        self.esp_connected: bool = False
        self._connect_esp32()

        # Serial read thread
        self.serial_thread = threading.Thread(
            target=self._read_serial_loop, daemon=True)
        self.serial_thread.start()

        # Hot-plug monitor thread for ESP32
        self.esp_monitor_thread = threading.Thread(
            target=self._esp32_hotplug_monitor, daemon=True)
        self.esp_monitor_thread.start()

        # Command dispatch timer (10 Hz)
        self.command_timer = self.create_timer(0.1, self._command_loop)

        # Odometry publisher (10 Hz)
        self.odom_timer = self.create_timer(0.1, self._publish_odom)

        # Publish heartbeat / status
        self.status_timer = self.create_timer(1.0, self._publish_status)

        self.get_logger().info(
            f'ESP32 connected: {self.esp_serial is not None and self.esp_serial.is_open}'
        )
        self.get_logger().info('Brain Node started successfully')

    # -------------------------------------------------------------------------
    # ESP32 Serial Communication
    # -------------------------------------------------------------------------
    def _connect_esp32(self):
        try:
            self.esp_serial = serial.Serial(
                ESP_PORT, ESP_BAUD, timeout=SERIAL_TIMEOUT)
            self.esp_serial.reset_input_buffer()
            self.esp_connected = True
            self.get_logger().info(f'ESP32 connected on {ESP_PORT}')
        except serial.SerialException as e:
            self.esp_serial = None
            self.esp_connected = False
            self.get_logger().warn(f'ESP32 not found at {ESP_PORT}: {e} — will retry')

    def _esp32_hotplug_monitor(self):
        """Continuously monitor ESP32 plug/unplug and reconnect automatically."""
        while rclpy.ok():
            if not self.esp_connected or self.esp_serial is None or not self.esp_serial.is_open:
                if os.path.exists(ESP_PORT):
                    self.get_logger().info(f'ESP32 detected at {ESP_PORT} — connecting...')
                    self._connect_esp32()
                    if self.esp_connected:
                        self.get_logger().info(f'ESP32 reconnected successfully')
                        # Restart serial read thread to pick up the new connection
                        self.serial_thread = threading.Thread(
                            target=self._read_serial_loop, daemon=True)
                        self.serial_thread.start()
            time.sleep(2)

    def _read_serial_loop(self):
        while rclpy.ok():
            if self.esp_serial and self.esp_serial.is_open:
                try:
                    if self.esp_serial.in_waiting > 0:
                        line = self.esp_serial.readline().decode(
                            'utf-8', errors='ignore').strip()
                        if line.startswith('STAT'):
                            with self.serial_lock:
                                self.esp_response = line
                except Exception as e:
                    self.get_logger().error(f'Serial read error: {e}')
                    self.esp_connected = False
                    try:
                        self.esp_serial.close()
                    except Exception:
                        pass
                    self.esp_serial = None
                    break
            time.sleep(0.01)

    def _send_command(self, cmd: str):
        """Send a command string to the ESP32."""
        if self.esp_connected and self.esp_serial and self.esp_serial.is_open:
            try:
                with self.serial_lock:
                    self.esp_serial.write(
                        (cmd + '\n').encode('utf-8'))
                    self.esp_serial.flush()
                self.get_logger().debug(f'Sent to ESP32: {cmd}')
            except Exception as e:
                self.get_logger().error(f'ESP32 send error: {e}')
                self.esp_connected = False
        else:
            self.get_logger().warn(f'ESP32 not connected — skipping: {cmd}')

    # -------------------------------------------------------------------------
    # Motor Commands (sent to ESP32)
    # -------------------------------------------------------------------------
    def stop(self):
        self.odom_vx = 0.0
        self.odom_vy = 0.0
        self.odom_omega = 0.0
        self._send_command('STOP')

    def move(self, vx: float, vy: float, omega: float):
        self.odom_vx = vx
        self.odom_vy = vy
        self.odom_omega = omega
        self._send_command(f'MOVE,{vx:.3f},{vy:.3f},{omega:.3f}')

    def move_forward(self):
        self.move(LINEAR_SPEED, 0.0, 0.0)

    def move_backward(self):
        self.move(-LINEAR_SPEED, 0.0, 0.0)

    def strafe_left(self):
        self.move(0.0, -STRAFE_SPEED, 0.0)

    def strafe_right(self):
        self.move(0.0, STRAFE_SPEED, 0.0)

    def turn_cw(self):
        self.move(0.0, 0.0, -TURN_SPEED)

    def turn_ccw(self):
        self.move(0.0, 0.0, TURN_SPEED)

    def pick_up(self):
        self._send_command('PICKUP')

    def deposit(self):
        self._send_command('DEPOSIT')

    def arm_home(self):
        self._send_command('HOME')

    def arm_set(self, shoulder: int, gripper: int):
        self._send_command(f'ARM,{shoulder},{gripper}')

    def request_status(self):
        self._send_command('STATUS')

    # -------------------------------------------------------------------------
    # Subscriptions
    # -------------------------------------------------------------------------
    def scan_callback(self, msg: LaserScan):
        with self.scan_lock:
            self.last_scan = msg

    def qr_callback(self, msg: String):
        self.qr_data = msg.data
        self.get_logger().info(f'QR code detected: {self.qr_data}')
        if self.robot_state == STATE_QR_SCAN:
            self.goods_retrieved = True
            self.get_logger().info('Goods identified — initiating pickup sequence')

    # -------------------------------------------------------------------------
    # Lidar Helpers
    # -------------------------------------------------------------------------
    def get_laser_ranges(self) -> list:
        """Return cleaned ranges list (infinity → max_range)."""
        if self.last_scan is None:
            return []
        ranges = []
        max_r = self.last_scan.range_max
        for r in self.last_scan.ranges:
            if math.isinf(r) or math.isnan(r):
                ranges.append(max_r)
            else:
                ranges.append(r)
        return ranges

    def angle_to_index(self, angle_deg: float) -> int:
        """Convert angle in degrees to scan index."""
        if self.last_scan is None:
            return 0
        angle_rad = math.radians(angle_deg)
        idx = int((angle_rad - self.last_scan.angle_min) /
                  self.last_scan.angle_increment)
        idx = max(0, min(idx, len(self.last_scan.ranges) - 1))
        return idx

    def get_sector_distance(self, center_deg: int, half_width_deg: int) -> float:
        """Return minimum distance in a sector [center-half, center+half] degrees."""
        if self.last_scan is None:
            return float('inf')
        ranges = self.get_laser_ranges()
        if not ranges:
            return float('inf')
        min_dist = float('inf')
        for deg in range(center_deg - half_width_deg, center_deg + half_width_deg + 1):
            idx = self.angle_to_index(deg)
            d = ranges[idx]
            if d < min_dist:
                min_dist = d
        return min_dist

    def obstacle_in_front(self) -> float:
        return self.get_sector_distance(0, FRONT_SECTOR)

    def obstacle_left(self) -> float:
        return self.get_sector_distance(-90, 20)

    def obstacle_right(self) -> float:
        return self.get_sector_distance(90, 20)

    def obstacle_back(self) -> float:
        return self.get_sector_distance(180, 30)

    def is_path_clear(self, threshold: float = MIN_CLEARANCE) -> bool:
        front = self.obstacle_in_front()
        left  = self.obstacle_left()
        right = self.obstacle_right()
        return (front > threshold and
                left  > SIDE_CLEARANCE and
                right > SIDE_CLEARANCE)

    # -------------------------------------------------------------------------
    # State Machine
    # -------------------------------------------------------------------------
    def _command_loop(self):
        """Main command dispatch — runs at 10 Hz."""
        self._fsm_step()
        self._fsm_step_obstacle()

    def _fsm_step(self):
        state = self.robot_state

        if state == STATE_IDLE:
            self.stop()
            self.robot_state = STATE_SCANNING
            self.get_logger().info('Starting mission — navigating to pickup zone')

        elif state == STATE_SCANNING:
            self._nav_to_pickup()

        elif state == STATE_OBSTACLE:
            self._avoid_obstacle()

        elif state == STATE_QR_SCAN:
            self.stop()
            # QR code handled via callback; transition when goods_retrieved
            if self.qr_data and self.goods_retrieved:
                self.robot_state = STATE_PICKUP
                self.get_logger().info('Starting pickup sequence')
                self.pickup_count += 1

        elif state == STATE_PICKUP:
            self._do_pickup()

        elif state == STATE_RETURNING:
            self._nav_to_cargo()

        elif state == STATE_DEPOSITING:
            self._do_deposit()

        elif state == STATE_DONE:
            self.stop()
            self.get_logger().info(
                f'Mission complete. Pickups: {self.pickup_count}'
            )

        elif state == STATE_HOME:
            self.stop()
            self.arm_home()
            self.robot_state = STATE_IDLE

    def _fsm_step_obstacle(self):
        """Obstacle avoidance — runs every tick independently."""
        if self.robot_state not in (STATE_SCANNING, STATE_RETURNING):
            return

        front = self.obstacle_in_front()
        left  = self.obstacle_left()
        right = self.obstacle_right()

        if front < MIN_CLEARANCE or left < SIDE_CLEARANCE or right < SIDE_CLEARANCE:
            self.robot_state = STATE_OBSTACLE

    # -------------------------------------------------------------------------
    # Navigation
    # -------------------------------------------------------------------------
    def _nav_to_pickup(self):
        """Simple wall-following + forward navigation to pickup zone.
        Replace with move_base / nav2 for production SLAM navigation."""
        front = self.obstacle_in_front()
        left  = self.obstacle_left()
        right = self.obstacle_right()

        if front > MIN_CLEARANCE and left > SIDE_CLEARANCE and right > SIDE_CLEARANCE:
            # Path clear — move forward slowly
            self.move_forward()
        elif front < TURN_THRESHOLD:
            # Obstacle ahead — turn toward clearer side
            if left > right:
                self.turn_ccw()
            else:
                self.turn_cw()
        elif left < STRAFE_THRESHOLD:
            self.strafe_right()
        elif right < STRAFE_THRESHOLD:
            self.strafe_left()
        else:
            self.move_forward()

        # Proximity check (replace with real localization for production)
        # For demo: after 30 seconds assume we reached pickup zone
        # In production, use /amcl_pose or /odom to check (x, y)
        # Here we simply let the timer-based logic below advance state
        if self.pickup_count < self.max_pickups:
            # Signal QR scan state
            self.robot_state = STATE_QR_SCAN
            self.get_logger().info('Reached pickup zone — awaiting QR scan')

    def _nav_to_cargo(self):
        """Navigate back to cargo drop zone."""
        front = self.obstacle_in_front()
        left  = self.obstacle_left()
        right = self.obstacle_right()

        if front > MIN_CLEARANCE and left > SIDE_CLEARANCE and right > SIDE_CLEARANCE:
            self.move_backward()  # reverse toward cargo
        elif front < TURN_THRESHOLD:
            if left > right:
                self.turn_ccw()
            else:
                self.turn_cw()
        else:
            self.move_backward()

        # Simple proximity flag — replace with real pose check
        # After pickup is done, assume ~20 seconds reverse → cargo zone
        self.robot_state = STATE_DEPOSITING
        self.get_logger().info('Reached cargo zone — depositing goods')

    # -------------------------------------------------------------------------
    # Pickup & Deposit Sequences
    # -------------------------------------------------------------------------
    def _do_pickup(self):
        self.stop()
        self.arm_home()

        # Phase 1: lower arm
        self.arm_set(30, 60)   # shoulder down, gripper open
        time.sleep(2.0)

        # Phase 2: close gripper
        self.arm_set(30, 10)   # gripper closed — grasp item
        time.sleep(1.5)

        # Phase 3: lift arm
        self.arm_set(90, 10)   # lift to carry position
        time.sleep(1.5)

        self.get_logger().info('Goods picked up — returning to cargo')
        self.goods_retrieved = True
        self.robot_state = STATE_RETURNING

    def _do_deposit(self):
        self.stop()
        self.arm_set(160, 10)  # arm raised over cargo box
        time.sleep(1.0)

        # Release gripper
        self.arm_set(160, 60)
        time.sleep(1.5)

        self.arm_home()
        self.goods_deposited = True
        self.get_logger().info('Goods deposited in cargo box')

        if self.pickup_count >= self.max_pickups:
            self.robot_state = STATE_DONE
        else:
            self.qr_data = None
            self.goods_retrieved = False
            self.robot_state = STATE_SCANNING

    # -------------------------------------------------------------------------
    # Obstacle Avoidance
    # -------------------------------------------------------------------------
    def _avoid_obstacle(self):
        front = self.obstacle_in_front()
        left  = self.obstacle_left()
        right = self.obstacle_right()

        if front > MIN_CLEARANCE * 1.5 and left > SIDE_CLEARANCE and right > SIDE_CLEARANCE:
            self.robot_state = STATE_SCANNING
            return

        # Choose the most open direction
        if left > right:
            # Turn left and strafe right to go around
            self.turn_ccw()
            time.sleep(0.5)
            if self.obstacle_front_clear():
                self.strafe_right()
        else:
            self.turn_cw()
            time.sleep(0.5)
            if self.obstacle_front_clear():
                self.strafe_left()

    def obstacle_front_clear(self) -> bool:
        return self.obstacle_in_front() > MIN_CLEARANCE * 1.5

    # -------------------------------------------------------------------------
    # Odometry Publishing (for slam_toolbox scan matching).
    # Publishes /odom topic AND broadcasts odom->base_footprint TF so slam_toolbox
    # can build the full map->odom->base_footprint chain for pose estimation.
    # -------------------------------------------------------------------------
    def _publish_odom(self):
        now = self.get_clock().now()
        dt = (now - self._last_odom_time).nanoseconds * 1e-9
        self._last_odom_time = now

        # Integrate velocities to get pose (differential drive approximation)
        # vx, vy are in robot frame; convert to world frame
        cos_t = math.cos(self.odom_theta)
        sin_t = math.sin(self.odom_theta)
        vx_world = cos_t * self.odom_vx - sin_t * self.odom_vy
        vy_world = sin_t * self.odom_vx + cos_t * self.odom_vy

        self.odom_x += vx_world * dt
        self.odom_y += vy_world * dt
        self.odom_theta += self.odom_omega * dt

        # Normalize theta to [-pi, pi]
        self.odom_theta = math.atan2(math.sin(self.odom_theta), math.cos(self.odom_theta))

        # Publish Odometry message
        odom = Odometry()
        odom.header.stamp = now.to_msg()
        odom.header.frame_id = 'odom'
        odom.child_frame_id = 'base_footprint'
        odom.pose.pose.position.x = self.odom_x
        odom.pose.pose.position.y = self.odom_y
        odom.pose.pose.position.z = 0.0
        qx, qy, qz, qw = self._euler_to_quat(0, 0, self.odom_theta)
        odom.pose.pose.orientation.x = qx
        odom.pose.pose.orientation.y = qy
        odom.pose.pose.orientation.z = qz
        odom.pose.pose.orientation.w = qw
        odom.twist.twist.linear.x = self.odom_vx
        odom.twist.twist.linear.y = self.odom_vy
        odom.twist.twist.angular.z = self.odom_omega
        self.odom_publisher.publish(odom)

        # Broadcast odom -> base_footprint TF so slam_toolbox can build the full chain
        t = TransformStamped()
        t.header.stamp = now.to_msg()
        t.header.frame_id = 'odom'
        t.child_frame_id = 'base_footprint'
        t.transform.translation.x = self.odom_x
        t.transform.translation.y = self.odom_y
        t.transform.translation.z = 0.0
        t.transform.rotation.x = qx
        t.transform.rotation.y = qy
        t.transform.rotation.z = qz
        t.transform.rotation.w = qw
        self.tf_broadcaster.sendTransform(t)

    @staticmethod
    def _euler_to_quat(roll, pitch, yaw):
        cy = math.cos(yaw * 0.5)
        sy = math.sin(yaw * 0.5)
        cp = math.cos(pitch * 0.5)
        sp = math.sin(pitch * 0.5)
        cr = math.cos(roll * 0.5)
        sr = math.sin(roll * 0.5)
        qw = cr * cp * cy + sr * sp * sy
        qx = sr * cp * cy - cr * sp * sy
        qy = cr * sp * cy + sr * cp * sy
        qz = cr * cp * sy - sr * sp * cy
        return qx, qy, qz, qw

    # -------------------------------------------------------------------------
    # Status Reporting
    # -------------------------------------------------------------------------
    def _publish_status(self):
        state_name = STATE_NAMES[self.robot_state]
        status = (
            f'STATE={state_name} '
            f'QR={self.qr_data or "none"} '
            f'pickups={self.pickup_count} '
            f'goods_retrieved={self.goods_retrieved} '
            f'goods_deposited={self.goods_deposited}'
        )
        msg = String()
        msg.data = status
        self.status_publisher.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = BrainNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        if hasattr(node, 'esp_serial') and node.esp_serial and node.esp_serial.is_open:
            node.stop()
            node.esp_serial.close()
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
