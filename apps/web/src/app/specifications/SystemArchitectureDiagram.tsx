export default function SystemArchitectureDiagram() {
  const layers = [
    { title: 'TẦNG CẢM BIẾN', subtitle: 'Sensing Layer · ROS 2', color: '#00d4ff', rows: ['RPLIDAR A1M8-R6 → /scan · LaserScan ~10 Hz', 'slam_toolbox → map → odom → base_footprint', 'BNO055 heading 20 Hz · INA226 battery 5 s · Camera AprilTag'], y: 18 },
    { title: 'TẦNG GATEWAY', subtitle: 'Brain · Python / Nav2', color: '#ffb800', rows: ['Nav2 SimpleCommander → goToPose(x, y, θ)', 'Job workflow: PICKUP → DROPOFF → DOCK → UNLOAD → HOME', 'Socket.io ↔ API · LiDAR zone scoring · ESP32 telemetry'], y: 145 },
    { title: 'TẦNG ĐIỀU KHIỂN', subtitle: 'ESP32-S3 Firmware · C++ / Arduino', color: '#00ff88', rows: ['Mecanum kinematics → vFL, vFR, vRL, vRR', 'PID loop 50 Hz × 4 motor · PCNT encoder feedback', 'IR hard-stop · VL53L0X dock alignment · cylinder state machine'], y: 272 },
    { title: 'TẦNG VẬT LÝ', subtitle: 'Motors · Sensors · Actuators', color: '#ff8a3d', rows: ['4× BTS7960 → 4× JGB37-520 Mecanum', 'IR E18-D80NK · Sharp GP2Y0A21YK0F · VL53L0X · INA226', 'L298N electric cylinder · 4× PCNT encoder · 5DOF arm'], y: 399 },
  ];

  return (
    <svg viewBox="0 0 900 520" className="block w-full" role="img" aria-labelledby="architecture-title architecture-description">
      <title id="architecture-title">Kiến trúc bốn tầng của robot kho tự hành</title>
      <desc id="architecture-description">Dữ liệu đi từ tầng cảm biến qua gateway Raspberry Pi, xuống ESP32 điều khiển và phần cứng robot.</desc>
      <defs>
        <marker id="spec-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#758196" /></marker>
      </defs>
      {layers.map((layer, index) => (
        <g key={layer.title}>
          <rect x="18" y={layer.y} width="864" height="102" rx="10" fill={`${layer.color}0f`} stroke={`${layer.color}99`} strokeWidth="1.5" />
          <rect x="18" y={layer.y} width="7" height="102" rx="3" fill={layer.color} />
          <text x="42" y={layer.y + 28} fill={layer.color} fontSize="12" fontWeight="800" fontFamily="var(--font-jetbrains), monospace">{layer.title}</text>
          <text x="42" y={layer.y + 45} fill="#8b97a8" fontSize="9" fontFamily="var(--font-jetbrains), monospace">{layer.subtitle}</text>
          {layer.rows.map((row, rowIndex) => <text key={row} x="42" y={layer.y + 65 + rowIndex * 15} fill="#c8d0da" fontSize="10" fontFamily="var(--font-jetbrains), monospace">{row}</text>)}
          {index < layers.length - 1 && <><line x1="450" y1={layer.y + 102} x2="450" y2={layer.y + 124} stroke="#758196" strokeWidth="1.5" markerEnd="url(#spec-arrow)" /><text x="464" y={layer.y + 118} fill="#758196" fontSize="9" fontFamily="var(--font-jetbrains), monospace">{index === 0 ? 'ROS 2 topics' : index === 1 ? 'USB CDC · JSON · 115200' : 'PWM + GPIO'}</text></>}
        </g>
      ))}
    </svg>
  );
}
