#!/usr/bin/env python3
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan
from nav_msgs.msg import OccupancyGrid
import math

# Boilerplate for future ESP32 serial communication
import serial
import threading

class BrainNode(Node):
    def __init__(self):
        super().__init__('brain_node')
        
        # Subscribe to Lidar scan data
        self.scan_subscriber = self.create_subscription(
            LaserScan,
            '/scan',
            self.scan_callback,
            10
        )
        
        # Subscribe to SLAM map data
        self.map_subscriber = self.create_subscription(
            OccupancyGrid,
            '/map',
            self.map_callback,
            10
        )

        # ----------------------------------------------------------------------
        # ESP32 Serial Communication Setup (Commented out to prevent crashes)
        # ----------------------------------------------------------------------
        # self.esp_port = '/dev/ttyUSB1'
        # self.esp_baudrate = 115200
        # try:
        #     self.esp_serial = serial.Serial(self.esp_port, self.esp_baudrate, timeout=1)
        #     self.get_logger().info(f"Successfully connected to ESP32 on {self.esp_port}")
        #     
        #     # Start a thread to read from ESP32
        #     self.serial_thread = threading.Thread(target=self.read_serial_data)
        #     self.serial_thread.daemon = True
        #     self.serial_thread.start()
        # except serial.SerialException as e:
        #     self.get_logger().error(f"Failed to connect to ESP32: {e}")
        #     self.esp_serial = None
        # ----------------------------------------------------------------------

        self.get_logger().info("Brain Node has been started successfully.")

    def scan_callback(self, msg: LaserScan):
        """
        Callback to process lidar scan data.
        Finds the distance directly in front of the robot.
        """
        # The scan data is an array of ranges. 
        # Assuming index 0 is the front for a standard sllidar setup.
        # If the array is empty, return safely
        if not msg.ranges:
            return

        # Calculate the index corresponding to 0 degrees (front)
        if msg.angle_min <= 0 <= msg.angle_max:
            front_index = int((-msg.angle_min) / msg.angle_increment)
            front_distance = msg.ranges[front_index]
            
            # Filter out inf or invalid readings
            if math.isinf(front_distance) or math.isnan(front_distance):
                front_distance = -1.0
                
            self.get_logger().info(f"Front Lidar Distance: {front_distance:.2f} m", throttle_duration_sec=2.0)
        else:
             self.get_logger().info("Scan range does not cover 0 degrees (front).", throttle_duration_sec=2.0)


    def map_callback(self, msg: OccupancyGrid):
        """
        Callback to process map data from slam_toolbox.
        """
        width = msg.info.width
        height = msg.info.height
        resolution = msg.info.resolution
        
        self.get_logger().info(
            f"Map received - Dimensions: {width}x{height} cells, Resolution: {resolution:.3f} m/cell",
            throttle_duration_sec=5.0
        )

    # def read_serial_data(self):
    #     """
    #     Thread function to read data continuously from ESP32.
    #     """
    #     while rclpy.ok() and self.esp_serial and self.esp_serial.is_open:
    #         try:
    #             if self.esp_serial.in_waiting > 0:
    #                 line = self.esp_serial.readline().decode('utf-8').strip()
    #                 if line:
    #                     self.get_logger().debug(f"ESP32 says: {line}")
    #         except Exception as e:
    #             self.get_logger().error(f"Error reading serial: {e}")
    #             break

def main(args=None):
    rclpy.init(args=args)
    node = BrainNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        # Cleanup
        # if hasattr(node, 'esp_serial') and node.esp_serial and node.esp_serial.is_open:
        #     node.esp_serial.close()
        node.destroy_node()
        rclpy.try_shutdown()

if __name__ == '__main__':
    main()
