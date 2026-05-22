#!/usr/bin/env python3
"""
qr_detector.py
USB webcam QR code detector for Raspberry Pi 5.
Publishes detected QR code data as std_msgs/String on /qr_result topic.
"""

import os
import time
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
import cv2
import numpy as np


class QRDetector(Node):
    def __init__(self):
        super().__init__('qr_detector')

        self.qr_publisher = self.create_publisher(
            String,
            '/qr_result',
            10
        )

        # Camera parameters
        self.camera_device = int(os.environ.get('CAMERA_DEVICE', 0))
        self.frame_width = int(os.environ.get('CAMERA_WIDTH', 640))
        self.frame_height = int(os.environ.get('CAMERA_HEIGHT', 480))

        self.get_logger().info(
            f'Opening camera device {self.camera_device} '
            f'({self.frame_width}x{self.frame_height})'
        )

        self.cap = cv2.VideoCapture(self.camera_device)
        if not self.cap.isOpened():
            self.get_logger().warn(
                f'Cannot open camera device {self.camera_device} — QR detection disabled'
            )
            self.cap = None

        self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.frame_width)
        self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.frame_height)
        self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        self.qr_detector = cv2.QRCodeDetector()
        self.last_detected = ''
        self.detect_count = 0
        self.confirm_threshold = 3  # Require N consecutive detections to confirm

        self.get_logger().info('QR Detector node started successfully')

    def detect_qr(self):
        if self.cap is None:
            time.sleep(1.0)
            return
        ret, frame = self.cap.read()
        if not ret:
            self.get_logger().warn('Failed to grab frame from camera', throttle_duration_sec=5.0)
            return

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # Detect + decode QR code
        data, vertices, _ = self.qr_detector.detectAndDecode(gray)

        if vertices is not None and len(data) > 0:
            # Draw bounding box around QR
            vertices = vertices[0].astype(np.int32)
            cv2.polylines(frame, [vertices], True, (0, 255, 0), 2)

            if data != self.last_detected:
                self.detect_count = 1
                self.last_detected = data
                self.get_logger().info(f'QR code candidate: {data}')
            else:
                self.detect_count += 1
                if self.detect_count >= self.confirm_threshold:
                    self.get_logger().info(f'QR code CONFIRMED: {data}')
                    msg = String()
                    msg.data = data
                    self.qr_publisher.publish(msg)
                    self.detect_count = 0
        else:
            self.detect_count = 0
            self.last_detected = ''

        # Optional: display frame locally (commented for headless operation)
        # cv2.imshow('QR Camera', frame)
        # if cv2.waitKey(1) & 0xFF == ord('q'):
        #     pass

    def destroy_node(self):
        if hasattr(self, 'cap') and self.cap is not None and self.cap.isOpened():
            self.cap.release()
        cv2.destroyAllWindows()
        super().destroy_node()




def main(args=None):
    rclpy.init(args=args)
    node = QRDetector()
    try:
        while rclpy.ok():
            node.detect_qr()
            rclpy.spin_once(node, timeout_sec=0.03)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.try_shutdown()


if __name__ == '__main__':
    main()
