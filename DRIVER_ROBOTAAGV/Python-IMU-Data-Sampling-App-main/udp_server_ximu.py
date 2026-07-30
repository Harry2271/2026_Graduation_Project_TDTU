"""x-IMU Offline Motion Tracking - MATLAB Algorithm Implementation

Press 'R' to start recording
Press 'T' to stop and process with x-IMU algorithm
Press 'C' to clear
"""

import socket
import re
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from threading import Thread, Lock
import time
from scipy import signal

# ==========================================
# CONFIGURATION
# ==========================================
UDP_IP = "0.0.0.0"
UDP_PORT = 5000
BUFFER_SIZE = 1024

# PHYSICS
GRAVITY = 9.81
SAMPLE_RATE = 100.0
DT = 1.0 / SAMPLE_RATE

# X-IMU ALGORITHM PARAMETERS (MATLAB)
HP_FILTER_CUTOFF = 0.1
HP_FILTER_ORDER = 1
CALIBRATION_SAMPLES = 200
MAX_RECORD_DURATION = 60
MAX_RECORD_SAMPLES = int(MAX_RECORD_DURATION * SAMPLE_RATE)

# ZUPT PARAMETERS
STATIONARY_ACCEL_THRESHOLD = 0.02  # g
STATIONARY_GYRO_THRESHOLD = 3.0     # deg/s
ZUPT_WINDOW = 10

# ANIMATION
ANIMATION_INTERVAL = 50
ANIMATION_SPEED = 3.4  # Increased from 3.0 for faster playback

# ==========================================
# GLOBAL STATE
# ==========================================
is_recording = False
is_calibrating = True
is_animating = False
animation_frame = 0
recording_buffer = []
calibration_buffer_accel = []
calibration_buffer_gyro = []
gyro_bias = np.zeros(3)
accel_bias = np.zeros(3)
processed_trajectory = None
processed_quaternions = None
data_lock = Lock()


# ==========================================
# PACKET PARSING
# ==========================================
def parse_packet(line):
    pattern = re.compile(r"Accel\[(.*?)\] Gyro\[(.*?)\] Quat\[(.*?)\]")
    match = pattern.search(line)
    if not match:
        return None
    accel = np.array([float(x) for x in match.group(1).split(',')], dtype=float)
    gyro = np.array([float(x) for x in match.group(2).split(',')], dtype=float)
    quat = np.array([float(x) for x in match.group(3).split(',')], dtype=float)
    return accel, gyro, quat


# ==========================================
# QUATERNION MATH
# ==========================================
def quaternion_conjugate(q):
    return np.array([q[0], -q[1], -q[2], -q[3]])

def quaternion_multiply(q1, q2):
    w1, x1, y1, z1 = q1
    w2, x2, y2, z2 = q2
    return np.array([
        w1*w2 - x1*x2 - y1*y2 - z1*z2,
        w1*x2 + x1*w2 + y1*z2 - z1*y2,
        w1*y2 - x1*z2 + y1*w2 + z1*x2,
        w1*z2 + x1*y2 - y1*x2 + z1*w2
    ])

def quaternion_rotate(v, q):
    qv = np.array([0, v[0], v[1], v[2]])
    return quaternion_multiply(quaternion_multiply(q, qv), quaternion_conjugate(q))[1:]

def quaternion_to_rotation_matrix(q):
    """Convert quaternion to 3x3 rotation matrix."""
    w, x, y, z = q
    return np.array([
        [1 - 2*(y**2 + z**2), 2*(x*y - w*z), 2*(x*z + w*y)],
        [2*(x*y + w*z), 1 - 2*(x**2 + z**2), 2*(y*z - w*x)],
        [2*(x*z - w*y), 2*(y*z + w*x), 1 - 2*(x**2 + y**2)]
    ])


# ==========================================
# X-IMU ALGORITHM (EXACT MATLAB)
# ==========================================
def process_recorded_data():
    """x-IMU MATLAB offline processing algorithm."""
    global processed_trajectory, processed_quaternions, is_animating, animation_frame
    
    with data_lock:
        if len(recording_buffer) < 50:
            print("⚠ Not enough data")
            return
        data = recording_buffer.copy()
    
    print(f"\n{'='*60}")
    print(f"x-IMU Processing: {len(data)} samples ({len(data)/SAMPLE_RATE:.1f}s)")
    print(f"{'='*60}")
    
    # Extract and calibrate
    accel_array = np.array([s[0] for s in data])
    gyro_array = np.array([s[1] for s in data])
    quat_array = np.array([s[2] for s in data])  # BNO055 quaternions [w, x, y, z]
    N = len(data)
    
    accel = (accel_array - accel_bias) * GRAVITY
    gyro = np.radians(gyro_array - gyro_bias)
    
    # STEP 1: Use BNO055 quaternions directly (no integration needed!)
    print("1/7 Using BNO055 quaternions...")
    quat = quat_array  # Direct from sensor fusion!
    
    # STEP 2: Rotate to Earth frame
    print("2/7 Earth frame rotation...")
    acc_earth = np.zeros((N, 3))
    for i in range(N):
        acc_earth[i] = quaternion_rotate(accel[i], quat[i])
    acc_earth[:, 0] = -acc_earth[:, 0]  # Correct x-axis direction
    acc_earth[:, 1] = -acc_earth[:, 1]  # Correct y-axis direction
    acc_earth[:, 2] -= GRAVITY
    
    # STEP 3: HP filter acceleration
    print("3/7 HP filter acceleration...")
    if N > 20:
        sos = signal.butter(HP_FILTER_ORDER, HP_FILTER_CUTOFF / (0.5 * SAMPLE_RATE),
                           'highpass', output='sos')
        acc_earth = signal.sosfiltfilt(sos, acc_earth, axis=0)
    
    # STEP 4: ZUPT detection
    print("4/7 Stationary detection...")
    acc_mag = np.linalg.norm(acc_earth, axis=1)
    gyro_mag = np.linalg.norm(gyro, axis=1)
    stat = (acc_mag < STATIONARY_ACCEL_THRESHOLD * GRAVITY) & \
           (gyro_mag < np.radians(STATIONARY_GYRO_THRESHOLD))
    
    # STEP 5: Velocity integration
    print("5/7 Velocity integration...")
    vel = np.zeros((N, 3))
    for i in range(1, N):
        vel[i] = vel[i-1] + acc_earth[i] * DT
        if i >= ZUPT_WINDOW and np.all(stat[i-ZUPT_WINDOW:i+1]):
            vel[i] = 0
    
    # STEP 6: HP filter velocity
    print("6/7 HP filter velocity...")
    if N > 20:
        vel = signal.sosfiltfilt(sos, vel, axis=0)
    
    # STEP 7: Position integration
    print("7/7 Position integration...")
    pos = np.zeros((N, 3))
    for i in range(1, N):
        pos[i] = pos[i-1] + vel[i] * DT
    
    processed_trajectory = pos
    processed_quaternions = quat
    is_animating = True
    animation_frame = 0
    
    print(f"\n{'='*60}")
    print(f"✓ Complete | Stationary: {100*np.sum(stat)/N:.0f}%")
    print(f"Final: [{pos[-1,0]:.3f}, {pos[-1,1]:.3f}, {pos[-1,2]:.3f}] m")
    print(f"Displacement: {np.max(np.linalg.norm(pos, axis=1)):.3f} m")
    print(f"Path: {np.sum(np.linalg.norm(np.diff(pos, axis=0), axis=1)):.3f} m")
    print(f"{'='*60}\n")


# ==========================================
# UDP SERVER
# ==========================================
def udp_server():
    global is_calibrating, is_recording, gyro_bias, accel_bias
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind((UDP_IP, UDP_PORT))
    print(f"UDP Server listening on {UDP_IP}:{UDP_PORT}")
    print("Calibrating... keep device still")
    
    while True:
        try:
            data, _ = sock.recvfrom(BUFFER_SIZE)
            line = data.decode('utf-8', errors='ignore').strip()
            parsed = parse_packet(line)
            if parsed is None:
                continue
            
            accel_g, gyro_dps, quat_raw = parsed
            timestamp = time.time()
            
            if is_calibrating:
                calibration_buffer_accel.append(accel_g)
                calibration_buffer_gyro.append(gyro_dps)
                
                if len(calibration_buffer_accel) >= CALIBRATION_SAMPLES:
                    avg_accel = np.mean(calibration_buffer_accel, axis=0)
                    avg_gyro = np.mean(calibration_buffer_gyro, axis=0)
                    gyro_bias = avg_gyro
                    accel_bias = avg_accel - np.array([0.0, 0.0, 1.0])
                    is_calibrating = False
                    print(f"\n{'='*60}")
                    print("✓ Calibration complete")
                    print(f"Accel: {avg_accel} | Bias: {accel_bias}")
                    print(f"Gyro bias: {avg_gyro} deg/s")
                    print(f"{'='*60}\n")
                    
                    # Auto-start recording after calibration
                    is_recording = True
                    print("🔴 Recording started automatically... Press 'T' to stop\n")
                continue
            
            if is_recording:
                with data_lock:
                    if len(recording_buffer) < MAX_RECORD_SAMPLES:
                        recording_buffer.append((accel_g, gyro_dps, quat_raw, timestamp))
        
        except Exception as e:
            print(f"UDP Error: {e}")


# ==========================================
# VISUALIZATION
# ==========================================
fig = plt.figure(figsize=(14, 10))
fig.suptitle("x-IMU Motion Tracking", fontsize=16, fontweight='bold')

# 3D trajectory
ax_3d = fig.add_subplot(221, projection='3d')
ax_3d.set_xlabel('X (m)')
ax_3d.set_ylabel('Y (m)')
ax_3d.set_zlabel('Z (m)')
ax_3d.set_title('3D Trajectory')
ax_3d.grid(True, alpha=0.3)

# Top view (XY)
ax_top = fig.add_subplot(222)
ax_top.set_xlabel('X (m)')
ax_top.set_ylabel('Y (m)')
ax_top.set_title('Top View (XY)')
ax_top.grid(True, alpha=0.3)
ax_top.set_aspect('equal')

# Side view (XZ)
ax_side = fig.add_subplot(223)
ax_side.set_xlabel('X (m)')
ax_side.set_ylabel('Z (m)')
ax_side.set_title('Side View (XZ)')
ax_side.grid(True, alpha=0.3)
ax_side.set_aspect('equal')

# Front view (YZ)
ax_front = fig.add_subplot(224)
ax_front.set_xlabel('Y (m)')
ax_front.set_ylabel('Z (m)')
ax_front.set_title('Front View (YZ)')
ax_front.grid(True, alpha=0.3)
ax_front.set_aspect('equal')

# Plot objects
line_3d_proc, = ax_3d.plot([], [], [], 'b-', linewidth=2, label='Trajectory')
scat_3d_proc = ax_3d.scatter([], [], [], c='red', s=100, marker='o', label='Current')

# Orientation frame (3 arrows for X, Y, Z axes)
quiver_x = ax_3d.quiver([], [], [], [], [], [], color='red', arrow_length_ratio=0.3, linewidth=2, label='X-axis')
quiver_y = ax_3d.quiver([], [], [], [], [], [], color='green', arrow_length_ratio=0.3, linewidth=2, label='Y-axis')
quiver_z = ax_3d.quiver([], [], [], [], [], [], color='blue', arrow_length_ratio=0.3, linewidth=2, label='Z-axis')

line_top_proc, = ax_top.plot([], [], 'b-', linewidth=2)
scat_top_proc = ax_top.scatter([], [], c='red', s=100, marker='o')
line_side_proc, = ax_side.plot([], [], 'b-', linewidth=2)
scat_side_proc = ax_side.scatter([], [], c='red', s=100, marker='o')
line_front_proc, = ax_front.plot([], [], 'b-', linewidth=2)
scat_front_proc = ax_front.scatter([], [], c='red', s=100, marker='o')

# Origin markers
ax_3d.scatter([0], [0], [0], c='green', s=150, marker='*', label='Origin')
ax_top.scatter([0], [0], c='green', s=150, marker='*')
ax_side.scatter([0], [0], c='green', s=150, marker='*')
ax_front.scatter([0], [0], c='green', s=150, marker='*')

ax_3d.legend(loc='upper right', fontsize=8)
plt.tight_layout()


def update_plot(frame):
    global processed_trajectory, processed_quaternions, is_animating, animation_frame
    
    # Update title
    if is_calibrating:
        status = f"CALIBRATING... ({len(calibration_buffer_accel)}/{CALIBRATION_SAMPLES})"
        fig.suptitle(status, fontsize=14, fontweight='bold', color='orange')
    elif is_recording:
        duration = len(recording_buffer) / SAMPLE_RATE
        status = f"🔴 RECORDING... {duration:.1f}s ({len(recording_buffer)} samples)"
        fig.suptitle(status, fontsize=14, fontweight='bold', color='red')
    elif is_animating and processed_trajectory is not None:
        progress = (animation_frame / len(processed_trajectory)) * 100
        time_elapsed = animation_frame / SAMPLE_RATE
        status = f"▶ PLAYBACK | {progress:.1f}% | {time_elapsed:.2f}s"
        fig.suptitle(status, fontsize=14, fontweight='bold', color='blue')
    elif processed_trajectory is not None:
        final_pos = processed_trajectory[-1]
        quat = processed_quaternions[-1]
        status = f"✓ Complete | Pos: [{final_pos[0]:.3f}, {final_pos[1]:.3f}, {final_pos[2]:.3f}] m | Quat: [{quat[0]:.3f}, {quat[1]:.3f}, {quat[2]:.3f}, {quat[3]:.3f}]"
        fig.suptitle(status, fontsize=14, fontweight='bold', color='green')
    else:
        fig.suptitle("Ready - Press 'R' to record", fontsize=14, fontweight='bold', color='blue')
    
    # Animate trajectory
    current_quat = None
    if is_animating and processed_trajectory is not None:
        samples_per_frame = int((ANIMATION_INTERVAL / 1000.0) * SAMPLE_RATE * ANIMATION_SPEED)
        animation_frame += max(1, samples_per_frame)
        if animation_frame >= len(processed_trajectory):
            animation_frame = len(processed_trajectory) - 1
            is_animating = False
            print("✓ Animation complete\n")
        
        xs = processed_trajectory[:animation_frame+1, 0]
        ys = processed_trajectory[:animation_frame+1, 1]
        zs = processed_trajectory[:animation_frame+1, 2]
        current_quat = processed_quaternions[animation_frame]
    elif processed_trajectory is not None and len(processed_trajectory) > 0:
        xs = processed_trajectory[:, 0]
        ys = processed_trajectory[:, 1]
        zs = processed_trajectory[:, 2]
        current_quat = processed_quaternions[-1]
    else:
        xs, ys, zs = np.array([]), np.array([]), np.array([])
    
    # Update plots
    if len(xs) > 0:
        line_3d_proc.set_data(xs, ys)
        line_3d_proc.set_3d_properties(zs)
        scat_3d_proc._offsets3d = ([xs[-1]], [ys[-1]], [zs[-1]])
        
        # Update orientation frame at current position
        if current_quat is not None:
            R = quaternion_to_rotation_matrix(current_quat)
            axis_length = 0.3  # Length of orientation arrows
            
            # Remove old quivers and create new ones
            global quiver_x, quiver_y, quiver_z
            quiver_x.remove()
            quiver_y.remove()
            quiver_z.remove()
            
            pos = np.array([xs[-1], ys[-1], zs[-1]])
            x_axis = R[:, 0] * axis_length
            y_axis = R[:, 1] * axis_length
            z_axis = R[:, 2] * axis_length
            
            quiver_x = ax_3d.quiver(pos[0], pos[1], pos[2], x_axis[0], x_axis[1], x_axis[2],
                                   color='red', arrow_length_ratio=0.3, linewidth=2.5, alpha=0.9)
            quiver_y = ax_3d.quiver(pos[0], pos[1], pos[2], y_axis[0], y_axis[1], y_axis[2],
                                   color='green', arrow_length_ratio=0.3, linewidth=2.5, alpha=0.9)
            quiver_z = ax_3d.quiver(pos[0], pos[1], pos[2], z_axis[0], z_axis[1], z_axis[2],
                                   color='blue', arrow_length_ratio=0.3, linewidth=2.5, alpha=0.9)
        
        line_top_proc.set_data(xs, ys)
        scat_top_proc.set_offsets([[xs[-1], ys[-1]]])
        
        line_side_proc.set_data(xs, zs)
        scat_side_proc.set_offsets([[xs[-1], zs[-1]]])
        
        line_front_proc.set_data(ys, zs)
        scat_front_proc.set_offsets([[ys[-1], zs[-1]]])
        
        # Auto-scale
        margin = 0.3
        x_min, x_max = min(xs.min() - margin, -0.2), max(xs.max() + margin, 0.2)
        y_min, y_max = min(ys.min() - margin, -0.2), max(ys.max() + margin, 0.2)
        z_min, z_max = min(zs.min() - margin, -0.2), max(zs.max() + margin, 0.2)
        
        ax_3d.set_xlim(x_min, x_max)
        ax_3d.set_ylim(y_min, y_max)
        ax_3d.set_zlim(z_min, z_max)
        ax_top.set_xlim(x_min, x_max)
        ax_top.set_ylim(y_min, y_max)
        ax_side.set_xlim(x_min, x_max)
        ax_side.set_ylim(z_min, z_max)
        ax_front.set_xlim(y_min, y_max)
        ax_front.set_ylim(z_min, z_max)
    
    return [line_3d_proc, scat_3d_proc, line_top_proc, scat_top_proc,
            line_side_proc, scat_side_proc, line_front_proc, scat_front_proc]


def on_key(event):
    global is_recording, recording_buffer, processed_trajectory, processed_quaternions, is_animating, animation_frame
    global is_calibrating, calibration_buffer_accel, calibration_buffer_gyro, gyro_bias, accel_bias
    
    if event.key in ['r', 'R']:
        if is_calibrating:
            print("⚠ Still calibrating...")
            return
        if is_recording:
            print("⚠ Already recording")
            return
        
        # Clear old data and start recalibration
        with data_lock:
            recording_buffer.clear()
        processed_trajectory = None
        processed_quaternions = None
        is_animating = False
        animation_frame = 0
        calibration_buffer_accel.clear()
        calibration_buffer_gyro.clear()
        is_calibrating = True
        print("\n🔄 Recalibrating... keep device still")
        print(f"Will start recording automatically after calibration ({CALIBRATION_SAMPLES} samples)\n")
    
    elif event.key in ['t', 'T']:
        if is_recording:
            # Stop recording and process
            is_recording = False
            print(f"\n⏹ Stopped ({len(recording_buffer)} samples)")
            process_recorded_data()
        elif processed_trajectory is not None and not is_animating:
            # Restart playback
            is_animating = True
            animation_frame = 0
            print("\n▶ Restarting playback...\n")
    
    elif event.key in ['c', 'C']:
        with data_lock:
            recording_buffer.clear()
        processed_trajectory = None
        processed_quaternions = None
        is_recording = False
        is_animating = False
        animation_frame = 0
        print("\n🗑 Cleared\n")


fig.canvas.mpl_connect('key_press_event', on_key)

fig.text(0.5, 0.01,
         "Press 'R' to Record  |  'T' to Stop & Process (or Replay)  |  'C' to Clear",
         ha='center', fontsize=10, style='italic',
         bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5))

# Start
server_thread = Thread(target=udp_server, daemon=True)
server_thread.start()

ani = FuncAnimation(fig, update_plot, interval=ANIMATION_INTERVAL, blit=False, cache_frame_data=False)
plt.show()
