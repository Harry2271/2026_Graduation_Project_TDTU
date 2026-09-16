#!/usr/bin/env python3
"""
compare_detection.py — So sánh AprilTag detection giữa Pi 5 và Laptop

Usage:
    # Trên Pi 5: Capture snapshot và test detection
    python3 compare_detection.py --mode pi --save-snapshot

    # Trên Laptop: Test detection với cùng snapshot
    python3 compare_detection.py --mode laptop --snapshot pi_snapshot.jpg

    # Hoặc test trực tiếp từ camera trên Laptop
    python3 compare_detection.py --mode laptop --camera 0
"""

import argparse
import sys
import time

def test_pi_mode(save_snapshot=False):
    """Test detection trên Pi 5 từ camera stream"""
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║          APRILTAG DETECTION TEST — RASPBERRY PI 5                 ║")
    print("╚═══════════════════════════════════════════════════════════════════╝")
    print()

    try:
        import urllib.request
        import cv2
        import numpy as np
        from dt_apriltags import Detector
    except ImportError as e:
        print(f"❌ Missing dependency: {e}")
        print("Install: pip install --break-system-packages dt-apriltags opencv-python-headless numpy")
        sys.exit(1)

    # Lấy snapshot từ camera stream
    SNAPSHOT_URL = "http://127.0.0.1:9092/snapshot"
    print(f"📷 Fetching snapshot from {SNAPSHOT_URL}...")

    try:
        with urllib.request.urlopen(SNAPSHOT_URL, timeout=5) as response:
            frame_bytes = response.read()
        print(f"✅ Got {len(frame_bytes)} bytes")
    except Exception as e:
        print(f"❌ Cannot fetch snapshot: {e}")
        print()
        print("Solutions:")
        print("  • Check camera stream: pm2 logs nexus-robot-camera")
        print("  • Test stream: curl http://127.0.0.1:9092/")
        sys.exit(1)

    # Decode JPEG
    nparr = np.frombuffer(frame_bytes, dtype=np.uint8)
    img_color = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img_color is None:
        print("❌ Cannot decode JPEG image")
        sys.exit(1)

    img_gray = cv2.cvtColor(img_color, cv2.COLOR_BGR2GRAY)
    print(f"✅ Image decoded: {img_gray.shape} (H×W)")
    print(f"   Brightness: min={img_gray.min()}, max={img_gray.max()}, mean={img_gray.mean():.1f}")

    # Save snapshot nếu được yêu cầu
    if save_snapshot:
        filename = f"pi_snapshot_{int(time.time())}.jpg"
        cv2.imwrite(filename, img_color)
        print(f"💾 Saved snapshot to: {filename}")
        print(f"   Copy to laptop: scp pi@<pi-ip>:{filename} ./")

    # Create detector
    print()
    print("🔍 Creating AprilTag detector (tag36h11)...")
    detector = Detector(
        families="tag36h11",
        nthreads=2,
        quad_decimate=2.0,
        quad_sigma=0.0,
        refine_edges=True,
        decode_sharpening=0.25
    )
    print("✅ Detector ready")

    # Run detection
    print()
    print("🔎 Running detection...")
    start_time = time.time()
    detections = detector.detect(img_gray, estimate_tag_pose=False)
    elapsed = (time.time() - start_time) * 1000  # ms

    print()
    print("═" * 70)
    print(f"DETECTION RESULT: {len(detections)} tag(s) found in {elapsed:.1f}ms")
    print("═" * 70)

    if len(detections) == 0:
        print()
        print("❌ NO TAGS DETECTED on Raspberry Pi 5")
        print()
        print("Next steps:")
        print("  1. Copy the saved snapshot to your laptop")
        print("  2. Run this script on laptop with the same image:")
        print("     python3 compare_detection.py --mode laptop --snapshot pi_snapshot_*.jpg")
        print("  3. Compare results to identify the issue")
        return False
    else:
        print()
        for i, det in enumerate(detections, 1):
            print(f"✅ Tag #{i}:")
            print(f"   ID: {det.tag_id}")
            print(f"   Decision margin: {det.decision_margin:.2f}")
            print(f"   Hamming: {det.hamming}")
            print(f"   Center: ({det.center[0]:.1f}, {det.center[1]:.1f})")
        return True


def test_laptop_mode(snapshot_path=None, camera_id=None):
    """Test detection trên Laptop"""
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║          APRILTAG DETECTION TEST — LAPTOP                         ║")
    print("╚═══════════════════════════════════════════════════════════════════╝")
    print()

    try:
        import cv2
        import numpy as np
        from dt_apriltags import Detector
    except ImportError as e:
        print(f"❌ Missing dependency: {e}")
        print("Install: pip install dt-apriltags opencv-python numpy")
        sys.exit(1)

    # Load image
    if snapshot_path:
        print(f"📷 Loading snapshot: {snapshot_path}")
        img_color = cv2.imread(snapshot_path)
        if img_color is None:
            print(f"❌ Cannot read image: {snapshot_path}")
            sys.exit(1)
    elif camera_id is not None:
        print(f"📷 Opening camera {camera_id}...")
        cap = cv2.VideoCapture(camera_id)
        if not cap.isOpened():
            print(f"❌ Cannot open camera {camera_id}")
            sys.exit(1)

        ret, img_color = cap.read()
        cap.release()
        if not ret:
            print("❌ Cannot read frame from camera")
            sys.exit(1)
        print("✅ Frame captured from camera")
    else:
        print("❌ Must specify either --snapshot or --camera")
        sys.exit(1)

    img_gray = cv2.cvtColor(img_color, cv2.COLOR_BGR2GRAY)
    print(f"✅ Image loaded: {img_gray.shape} (H×W)")
    print(f"   Brightness: min={img_gray.min()}, max={img_gray.max()}, mean={img_gray.mean():.1f}")

    # Create detector
    print()
    print("🔍 Creating AprilTag detector (tag36h11)...")
    detector = Detector(
        families="tag36h11",
        nthreads=2,
        quad_decimate=2.0,
        quad_sigma=0.0,
        refine_edges=True,
        decode_sharpening=0.25
    )
    print("✅ Detector ready")

    # Run detection
    print()
    print("🔎 Running detection...")
    start_time = time.time()
    detections = detector.detect(img_gray, estimate_tag_pose=False)
    elapsed = (time.time() - start_time) * 1000  # ms

    print()
    print("═" * 70)
    print(f"DETECTION RESULT: {len(detections)} tag(s) found in {elapsed:.1f}ms")
    print("═" * 70)

    if len(detections) == 0:
        print()
        print("❌ NO TAGS DETECTED on Laptop")
        print()
        print("This confirms the image itself has no visible AprilTag.")
        return False
    else:
        print()
        for i, det in enumerate(detections, 1):
            print(f"✅ Tag #{i}:")
            print(f"   ID: {det.tag_id}")
            print(f"   Decision margin: {det.decision_margin:.2f}")
            print(f"   Hamming: {det.hamming}")
            print(f"   Center: ({det.center[0]:.1f}, {det.center[1]:.1f})")
        return True


def main():
    parser = argparse.ArgumentParser(
        description="Compare AprilTag detection between Pi 5 and Laptop"
    )
    parser.add_argument(
        "--mode",
        choices=["pi", "laptop"],
        required=True,
        help="Test mode: pi or laptop"
    )
    parser.add_argument(
        "--save-snapshot",
        action="store_true",
        help="Save snapshot to file (Pi mode only)"
    )
    parser.add_argument(
        "--snapshot",
        help="Path to snapshot image file (Laptop mode)"
    )
    parser.add_argument(
        "--camera",
        type=int,
        help="Camera ID to capture from (Laptop mode, alternative to --snapshot)"
    )

    args = parser.parse_args()

    if args.mode == "pi":
        success = test_pi_mode(save_snapshot=args.save_snapshot)
    else:  # laptop
        if not args.snapshot and args.camera is None:
            print("❌ Laptop mode requires either --snapshot or --camera")
            sys.exit(1)
        success = test_laptop_mode(
            snapshot_path=args.snapshot,
            camera_id=args.camera
        )

    print()
    print("═" * 70)
    if success:
        print("✅ DETECTION SUCCESSFUL")
    else:
        print("❌ DETECTION FAILED")
    print("═" * 70)

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
