import type { ReactNode } from 'react';

function SvgFrame({ title, viewBox, children }: { title: string; viewBox: string; children: ReactNode }) {
  return (
    <svg viewBox={viewBox} className="block w-full" role="img" aria-label={title}>
      <title>{title}</title>
      <defs>
        <marker id="encoder-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10z" fill="#8b97a8" />
        </marker>
      </defs>
      {children}
    </svg>
  );
}

function Box({ x, y, width, height, title, lines, color = '#00d4ff' }: { x: number; y: number; width: number; height: number; title: string; lines: string[]; color?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx="8" fill={color} fillOpacity="0.07" stroke={color} strokeOpacity="0.67" strokeWidth="1.5" />
      <text x={x + 14} y={y + 24} fill={color} fontSize="12" fontWeight="800" fontFamily="var(--font-jetbrains), monospace">{title}</text>
      {lines.map((line, index) => <text key={line} x={x + 14} y={y + 45 + index * 16} fill="#b5c0cd" fontSize="10" fontFamily="var(--font-jetbrains), monospace">{line}</text>)}
    </g>
  );
}

function Arrow({ from, to, label }: { from: [number, number]; to: [number, number]; label?: string }) {
  return (
    <g>
      <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} stroke="#758196" strokeWidth="1.5" markerEnd="url(#encoder-arrow)" />
      {label && <text x={(from[0] + to[0]) / 2} y={(from[1] + to[1]) / 2 - 7} textAnchor="middle" fill="#758196" fontSize="9" fontFamily="var(--font-jetbrains), monospace">{label}</text>}
    </g>
  );
}

export function EncoderArchitectureDiagram() {
  return (
    <SvgFrame title="Luồng dữ liệu encoder từ Hall sensor đến ROS 2" viewBox="0 0 1060 470">
      <Box x={30} y={28} width={210} height={76} title="HALL SENSOR ×4" lines={['JGB37-520 encoder', 'CHA + CHB · 11 PPR']} color="#ff3b5c" />
      <Box x={300} y={28} width={210} height={76} title="MECANUM WHEELS ×4" lines={['97 mm omnidirectional', 'FL · FR · RL · RR']} color="var(--success)" />
      <Box x={30} y={150} width={480} height={82} title="ESP32-S3 PCNT PERIPHERAL" lines={['PCNT_UNIT_0..3 · signed 16-bit counter', 'Filter = 1000 ticks ≈ 12.5 µs · x2 decode']} color="var(--accent)" />
      <Box x={30} y={282} width={480} height={90} title="ENCODER CLASS · C++" lines={['readCount() → int32 cumulative_count_ · wrap correction', 'calculateRPM(dt) → filtered_rpm_ · EMA α=0.3 · deadband 0.1']} color="var(--accent)" />
      <Box x={30} y={410} width={145} height={48} title="PID" lines={['50 Hz · PWM']} color="var(--success)" />
      <Box x={205} y={410} width={145} height={48} title="TYPE 130" lines={['count + rpm ×4']} color="var(--warning)" />
      <Box x={380} y={410} width={130} height={48} title="ODOMETRY" lines={['count → /odom']} color="var(--accent)" />
      <Box x={610} y={30} width={400} height={122} title="RASPBERRY PI 5" lines={['ROS 2 · slam_toolbox · Nav2', 'brain_node · esp32_telemetry_node', 'USB CDC JSON newline framing']} color="#ff3b5c" />
      <Box x={610} y={198} width={185} height={60} title="BNO055 IMU" lines={['I2C 0x28 · heading 20 Hz']} color="var(--accent)" />
      <Box x={825} y={198} width={185} height={60} title="INA226 POWER" lines={['I2C 0x40 · 5 s interval']} color="var(--warning)" />
      <Arrow from={[135, 104]} to={[135, 146]} label="CHA / CHB" /><Arrow from={[405, 104]} to={[405, 146]} label="quadrature" /><Arrow from={[270, 232]} to={[270, 278]} label="int16 raw" />
      <Arrow from={[110, 372]} to={[110, 406]} label="RPM" /><Arrow from={[270, 372]} to={[270, 406]} label="JSON" /><Arrow from={[430, 372]} to={[430, 406]} label="counts" />
      <path d="M350 434 H555 V96 H606" fill="none" stroke="var(--warning)" strokeWidth="1.5" strokeDasharray="5 4" markerEnd="url(#encoder-arrow)" />
      <text x="470" y="424" fill="var(--warning)" fontSize="10" fontFamily="var(--font-jetbrains), monospace">USB CDC Type 130</text>
    </SvgFrame>
  );
}

export function QuadratureDiagram() {
  const pulseA = 'M170 78 V38 H210 V78 H250 V38 H290 V78 H330 V38 H370 V78 H410 V38 H450 V78 H490 V38 H530 V78 H570 V38 H610 V78 H650 V38 H690 V78 H730 V38 H770 V78 H810 V38 H850 V78 H890 V38 H930 V78 H970 V38 H1010 V78';
  const pulseB = 'M170 148 V108 H190 V148 H230 V108 H250 V148 H290 V108 H310 V148 H350 V108 H370 V148 H410 V108 H430 V148 H470 V108 H490 V148 H530 V108 H550 V148 H590 V108 H610 V148 H650 V108 H670 V148 H710 V108 H730 V148 H770 V108 H790 V148 H830 V108 H850 V148 H890 V108 H910 V148 H950 V108 H970 V148 H1010 V108 H1010 V148';
  return (
    <SvgFrame title="Tín hiệu quadrature Channel A và Channel B với PCNT x2" viewBox="0 0 1060 280">
      <text x="20" y="45" fill="var(--accent)" fontSize="13" fontWeight="800">Channel A · pulse</text><path d={pulseA} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      <text x="20" y="115" fill="var(--warning)" fontSize="13" fontWeight="800">Channel B · direction</text><path d={pulseB} fill="none" stroke="var(--warning)" strokeWidth="2.5" />
      <line x1="170" y1="88" x2="1010" y2="88" stroke="#334155" /><line x1="170" y1="158" x2="1010" y2="158" stroke="#334155" />
      <text x="20" y="205" fill="var(--success)" fontSize="13" fontWeight="800">PCNT count · x2 decode</text>
      <polyline points="170,242 250,242 250,232 330,232 330,222 410,222 410,212 490,212 490,202 570,202 570,192 650,192 650,182 730,182 730,172 810,172 810,162 890,162 890,152 970,152 970,142 1010,142" fill="none" stroke="#00ff88" strokeWidth="2.5" />
      {[170, 250, 330, 410, 490, 570, 650, 730, 810, 890, 970].map((x, index) => <g key={x}><line x1={x} y1="170" x2={x} y2="246" stroke="var(--accent)" strokeDasharray="3 3" /><text x={x + 4} y="260" fill="var(--success)" fontSize="9">{index}</text></g>)}
      <rect x="690" y="22" width="320" height="60" rx="6" fill="#111827" stroke="var(--accent)" /><text x="704" y="43" fill="#d8e2ef" fontSize="11">x2 decode: đếm cạnh lên CHA</text><text x="704" y="61" fill="#8b97a8" fontSize="10">CHB LOW → +1 · CHB HIGH → -1</text><text x="704" y="76" fill="#8b97a8" fontSize="10">11 PPR × 2 = 22 counts/rev motor</text>
    </SvgFrame>
  );
}

export function OverflowDiagram() {
  return (
    <SvgFrame title="PCNT raw counter overflow và cumulative counter" viewBox="0 0 1060 190">
      <text x="25" y="28" fill="var(--accent)" fontSize="13" fontWeight="800">PCNT raw int16_t · sawtooth waveform</text><line x1="100" y1="155" x2="1020" y2="155" stroke="#64748b" /><line x1="100" y1="42" x2="100" y2="155" stroke="#64748b" />
      <text x="92" y="50" textAnchor="end" fill="#8b97a8" fontSize="10">+32K</text><text x="92" y="155" textAnchor="end" fill="#8b97a8" fontSize="10">-32K</text>
      <polyline points="100,130 230,100 360,70 430,42 430,145 560,115 690,85 820,55 960,42 960,145 1020,130" fill="none" stroke="var(--accent)" strokeWidth="2.5" />
      {[430, 960].map((x) => <g key={x}><rect x={x - 15} y="38" width="30" height="111" fill="#ff3b5c22" stroke="#ff3b5c" /><text x={x} y="174" textAnchor="middle" fill="#ff3b5c" fontSize="10">overflow</text></g>)}
      <line x1="100" y1="182" x2="1020" y2="182" stroke="#00ff88" strokeWidth="2" /><text x="560" y="178" textAnchor="middle" fill="var(--success)" fontSize="10">cumulative_count_ int32_t · monotonic aggregate</text>
    </SvgFrame>
  );
}

export function RpmPipelineDiagram() {
  const steps = [['01', 'Đọc raw', 'pcnt_get_counter'], ['02', 'Tính delta', 'raw - last + wrap'], ['03', 'RPM raw', 'delta / dt × 60000 / 660'], ['04', 'Clamp', '|RPM| ≤ 500'], ['05', 'EMA filter', 'α = 0.3 · τ ≈ 56 ms'], ['06', 'Deadband', '|RPM| < 0.1 → 0'], ['07', 'PID', 'PWM output']];
  return (
    <SvgFrame title="Bảy bước xử lý RPM của encoder" viewBox="0 0 1060 150">
      {steps.map(([number, title, detail], index) => { const x = 12 + index * 150; const color = index === 4 ? 'var(--accent)' : index === 6 ? 'var(--success)' : index === 3 ? 'var(--warning)' : 'var(--accent)'; return <g key={number}><rect x={x} y="34" width="130" height="72" rx="8" fill={color} fillOpacity="0.07" stroke={color} /><text x={x + 14} y="58" fill={color} fontSize="11" fontWeight="800">{number} · {title}</text><text x={x + 14} y="82" fill="#b5c0cd" fontSize="9">{detail}</text>{index < steps.length - 1 && <Arrow from={[x + 130, 70]} to={[x + 147, 70]} />}</g>; })}
      <text x="530" y="133" textAnchor="middle" fill="#8b97a8" fontSize="11">Một sampling interval: 20 ms · update PID ở 50 Hz</text>
    </SvgFrame>
  );
}

export function PidLoopDiagram() {
  return (
    <SvgFrame title="Vòng điều khiển PID closed-loop của một motor" viewBox="0 0 1060 300">
      <Box x={20} y={100} width={130} height={60} title="SETPOINT" lines={['Target RPM']} color="var(--warning)" /><circle cx="205" cy="130" r="25" fill="#111827" stroke="#b5c0cd" strokeWidth="1.5" /><text x="205" y="136" textAnchor="middle" fill="#e8ecf0" fontSize="18">Σ</text>
      <Box x={270} y={85} width={170} height={90} title="PID CONTROLLER" lines={['Kp=2.5 · Ki=0.2 · Kd=0.05', '50 Hz · output ±511']} color="var(--accent)" /><Box x={510} y={85} width={150} height={90} title="BTS7960" lines={['20 kHz · 10-bit', 'PWM driver']} color="var(--success)" /><Box x={730} y={85} width={150} height={90} title="JGB37-520" lines={['DC motor + encoder', '333 RPM · gear 30:1']} color="var(--accent)" /><Box x={930} y={100} width={105} height={60} title="WHEEL" lines={['Mecanum 97 mm']} color="var(--success)" />
      <Arrow from={[150, 130]} to={[176, 130]} /><Arrow from={[230, 130]} to={[266, 130]} label="error" /><Arrow from={[440, 130]} to={[506, 130]} label="PWM" /><Arrow from={[660, 130]} to={[726, 130]} label="voltage" /><Arrow from={[880, 130]} to={[926, 130]} />
      <path d="M805 175 V240 H85 V165" fill="none" stroke="var(--accent)" strokeWidth="2" markerEnd="url(#encoder-arrow)" /><text x="440" y="235" textAnchor="middle" fill="var(--accent)" fontSize="10">Encoder → PCNT → EMA filtered RPM feedback</text><rect x="290" y="190" width="130" height="28" rx="5" fill="var(--warning)" fillOpacity="0.09" stroke="var(--warning)" /><text x="355" y="208" textAnchor="middle" fill="var(--warning)" fontSize="9">Integral clamp ±400</text>
    </SvgFrame>
  );
}

export function WheelLayoutDiagram() {
  const wheels = [['FL', 350, 52, 'GPIO 40 / 41'], ['FR', 650, 52, 'GPIO 42 / 6'], ['RL', 350, 190, 'GPIO 4 / 5'], ['RR', 650, 190, 'GPIO 20 / 21']] as const;
  return <SvgFrame title="Bố trí bốn encoder trên chassis mecanum" viewBox="0 0 1060 290"><rect x="330" y="30" width="400" height="225" rx="12" fill="none" stroke="#8b97a8" strokeDasharray="8 4" /><text x="530" y="22" textAnchor="middle" fill="#b5c0cd" fontSize="12">CHASSIS · TOP VIEW · FRONT ↑</text><Box x={445} y={110} width={170} height={60} title="ESP32-S3" lines={['4× PCNT + 4× LEDC']} color="var(--accent)" />{wheels.map(([name, x, y, pins], index) => <g key={name}><rect x={x} y={y} width="82" height="44" rx="6" fill="var(--success)" fillOpacity="0.09" stroke="var(--success)" /><text x={x + 41} y={y + 19} textAnchor="middle" fill="var(--success)" fontSize="13" fontWeight="800">{name}</text><text x={x + 41} y={y + 34} textAnchor="middle" fill="#b5c0cd" fontSize="9">PCNT_{index}</text><text x={x + 41} y={y - 8} textAnchor="middle" fill="#8b97a8" fontSize="9">{pins}</text><line x1={x + 41} y1={y + (y < 100 ? 44 : 0)} x2={x < 500 ? 465 : 595} y2={y < 100 ? 110 : 170} stroke="var(--accent)" /></g>)}</SvgFrame>;
}

export function TimingAndTelemetryDiagram() {
  const tasks = [['Encoder read', '10 µs', '#00d4ff', 5], ['RPM compute', '5 µs', '#00ff88', 5], ['PID compute', '5 µs', '#00d4ff', 5], ['PWM write', '2 µs', '#ffb800', 5], ['Serial parse', '50 µs', '#00d4ff', 20], ['Idle / yield', '~19.9 ms', '#475569', 790]] as const;
  return <SvgFrame title="Timing budget 20 ms PID cycle and Type 130 telemetry" viewBox="0 0 1060 315"><text x="15" y="25" fill="#e8ecf0" fontSize="13" fontWeight="800">Timing budget · one 20 ms PID cycle</text>{tasks.map(([name, value, color, width], index) => { const y = 48 + index * 31; return <g key={name}><text x="15" y={y + 14} fill={color} fontSize="11">{name}</text><rect x="210" y={y} width="810" height="18" rx="3" fill="#ffffff0b" /><rect x={210} y={y} width={width} height="18" rx="3" fill={color} /><text x={225 + width} y={y + 14} fill="#b5c0cd" fontSize="10">{value}</text></g>})}<line x1="210" y1="245" x2="1020" y2="245" stroke="#8b97a8" /><text x="210" y="262" fill="#8b97a8" fontSize="10">0 ms</text><text x="605" y="262" fill="#8b97a8" fontSize="10">10 ms</text><text x="990" y="262" fill="#8b97a8" fontSize="10">20 ms</text><rect x="20" y="278" width="1000" height="28" rx="5" fill="#ffb80012" stroke="#ffb80055" /><text x="34" y="296" fill="var(--warning)" fontSize="10" fontFamily="var(--font-jetbrains), monospace">Type 130 · {`{"encoders":[{"id":0,"name":"FL","count":12345,"rpm":120.5}, ...]}`} · 20 Hz · ~250 bytes · ~5 KB/s</text></SvgFrame>;
}
