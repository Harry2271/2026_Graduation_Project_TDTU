'use client';

import { useMemo, useState } from 'react';
import { Card, Collapse, Progress, Tag } from 'antd';
import { Cpu, Database, Gauge, ShieldCheck, Zap } from 'lucide-react';
import {
  DiagramPanel,
  MetricCard,
  TechnicalPageShell,
  TechnicalSection,
  TechnicalTable,
  type TechnicalTableRow,
} from '@/components/technical/TechnicalPageShell';
import SystemArchitectureDiagram from './SystemArchitectureDiagram';

const columns = (title: string, keys: string[]) => [
  { title, dataIndex: keys[0], key: keys[0] },
  ...keys.slice(1).map((key) => ({ title: key, dataIndex: key, key })),
];

const hardwareRows: TechnicalTableRow[] = [
  { key: 'pi-soc', item: 'Raspberry Pi 5', value: 'BCM2712 · 4× Cortex-A76 @ 2.4 GHz', note: '8 GB LPDDR4X · Ubuntu 22.04' },
  { key: 'pi-stack', item: 'ROS 2 / SLAM / Nav2', value: 'Humble · slam_toolbox · Nav2', note: 'Sensing, localization và planning' },
  { key: 'esp', item: 'ESP32-S3 WeAct N16R8', value: 'Xtensa LX7 dual-core 240 MHz', note: 'Flash 16 MB · PSRAM 8 MB' },
  { key: 'pwm', item: 'PWM / PID', value: 'LEDC 20 kHz · 10-bit · 50 Hz loop', note: 'Kp 2.5 · Ki 0.2 · Kd 0.05' },
  { key: 'motor', item: 'JGB37-520 ×4', value: '12 V · 333 RPM · gear 30:1', note: 'Encoder 11 PPR motor shaft' },
  { key: 'wheel', item: 'Mecanum wheels ×4', value: 'Ø97 mm · X-pattern', note: 'Omnidirectional 4WD' },
  { key: 'driver', item: 'BTS7960 ×4', value: '6–27 V · 43 A peak', note: 'RPWM / LPWM bridge' },
];

const sensorRows: TechnicalTableRow[] = [
  { key: 'lidar', sensor: 'LiDAR', model: 'RPLIDAR A1M8-R6', range: '0.15–12 m · 360°', protocol: 'USB-UART', role: 'SLAM và tránh vật cản' },
  { key: 'imu', sensor: 'IMU 9 trục', model: 'BNO055 MCU-055', range: 'Euler ±180°', protocol: 'I2C 0x28', role: 'Heading và fusion' },
  { key: 'tof', sensor: 'TOF', model: 'VL53L0X V2', range: '30–1000 mm', protocol: 'I2C 0x29', role: 'Căn dock ±10 mm' },
  { key: 'power', sensor: 'Power monitor', model: 'INA226', range: '0–21 VDC', protocol: 'I2C 0x40', role: 'Voltage, current, SOC' },
  { key: 'sharp', sensor: 'Sharp trước', model: 'GP2Y0A21YK0F', range: '10–80 cm', protocol: 'Analog ADC', role: 'Slowdown / hard-stop' },
  { key: 'ir', sensor: 'IR proximity ×4', model: 'E18-D80NK', range: '≤20 cm', protocol: 'Digital active-LOW', role: 'Hard-stop ưu tiên 1' },
  { key: 'camera', sensor: 'Camera', model: 'Logitech BRIO 100', range: 'Full HD 1080p', protocol: 'USB 3.0', role: 'QR / AprilTag' },
];

const gpioRows: TechnicalTableRow[] = [
  { key: 'pwm', pin: 'GPIO12/13/14/15', function: 'BTS7960 FL/FR RPWM + LPWM' },
  { key: 'pwm2', pin: 'GPIO16/17/38/39', function: 'BTS7960 RL/RR RPWM + LPWM' },
  { key: 'enc-a', pin: 'GPIO40/42/4/20', function: 'Encoder CHA FL/FR/RL/RR' },
  { key: 'enc-b', pin: 'GPIO41/6/5/21', function: 'Encoder CHB FL/FR/RL/RR' },
  { key: 'i2c', pin: 'GPIO10/11', function: 'I2C SDA/SCL · BNO055 + TOF + INA226' },
  { key: 'ir', pin: 'GPIO1/8/45/46', function: 'IR proximity ×4' },
  { key: 'uart', pin: 'GPIO43/44', function: 'UART Pi ↔ ESP32 backup' },
  { key: 'cylinder', pin: 'GPIO2/35/37', function: 'L298N IN1/IN2 + limit switch' },
];

const softwareRows: TechnicalTableRow[] = [
  { key: 'firmware', layer: 'Firmware', technology: 'Arduino + PlatformIO', version: 'ArduinoJson 7.x', role: 'PID, kinematics, UART JSON' },
  { key: 'ros', layer: 'ROS 2', technology: 'Humble Hawksbill', version: 'Ubuntu 22.04', role: 'SLAM, Navigation, TF' },
  { key: 'api', layer: 'Backend API', technology: 'NestJS', version: '11 · TypeScript strict', role: 'REST, Socket.io, MongoDB' },
  { key: 'web', layer: 'Frontend', technology: 'Next.js + React', version: '16 · React 19 · Tailwind v4', role: 'Dashboard và real-time map' },
  { key: 'db', layer: 'Database', technology: 'MongoDB', version: 'Mongoose 8', role: 'Package, Shelf, Job collections' },
];

const protocolRows: TechnicalTableRow[] = [
  { key: 'move', direction: 'Pi → ESP32', message: '{"cmd":"move","vx":N,"vy":N,"omega":N}', role: 'Mecanum velocity' },
  { key: 'stop', direction: 'Pi → ESP32', message: '{"cmd":"stop"} / {"cmd":"e_stop"}', role: 'Brake hoặc hard disable' },
  { key: 'heartbeat', direction: 'Pi → ESP32', message: '{"cmd":"heartbeat"}', role: 'Watchdog timeout 2 s' },
  { key: 'encoder', direction: 'ESP32 → Pi', message: '{"type":130,"data":{...}}', role: 'Encoder snapshot ×4' },
  { key: 'status', direction: 'ESP32 → Pi', message: '{"type":131,"data":{...}}', role: 'Mode, IR, Sharp, TOF' },
  { key: 'imu', direction: 'ESP32 → Pi', message: '{"type":134,"data":{...}}', role: 'Heading 20 Hz' },
];

const progress = [
  ['Điều khiển motor + encoder', 'Hoàn thành', 'success'], ['UART Pi ↔ ESP32 + JSON', 'Hoàn thành', 'success'], ['Mecanum kinematics + odometry', 'Hoàn thành', 'success'], ['LiDAR + obstacle avoidance', 'Hoàn thành', 'success'], ['SLAM mapping', 'Hoàn thành', 'success'], ['Nav2 + job dispatch + brain', 'Đang triển khai', 'processing'], ['AprilTag + dock/unload', 'Đang triển khai', 'processing'], ['5DOF robotic arm', 'Dự kiến', 'default'], ['Web dashboard realtime', 'Hoàn thành', 'success'], ['Battery INA226 + pack', 'Hoàn thành', 'success'],
] as const;

const performanceRows: TechnicalTableRow[] = [
  { key: 'speed', metric: 'Tốc độ tiến tối đa', value: '~0.30 m/s', note: 'Nav2 max_vel_x' },
  { key: 'strafe', metric: 'Tốc độ sang ngang', value: '~0.25 m/s', note: 'Phụ thuộc bề mặt' },
  { key: 'turn', metric: 'Tốc độ xoay', value: '~0.50 rad/s', note: 'Nav2 max_vel_theta' },
  { key: 'amcl', metric: 'Độ chính xác AMCL', value: '±5 cm', note: 'Occupancy grid' },
  { key: 'heading', metric: 'Độ chính xác heading', value: '±1.5°', note: 'Sau calibrate figure-8' },
  { key: 'dock', metric: 'Thời gian dock unload', value: '~27 s', note: 'Heading + TOF + cylinder' },
  { key: 'pid', metric: 'Tần số PID', value: '50 Hz', note: '20 ms mỗi tick' },
  { key: 'obstacle', metric: 'Phạm vi LiDAR avoidance', value: '1.5 m', note: 'Front / left / right / rear' },
];

const powerData = [
  { label: 'Motor', value: 55, watts: '~100 W', color: 'var(--accent)' },
  { label: 'Raspberry Pi 5', value: 18, watts: '~12 W', color: '#ffb800' },
  { label: 'Cảm biến', value: 12, watts: '~8 W', color: '#00ff88' },
  { label: 'Logic / buck', value: 15, watts: '~10 W', color: 'var(--warning)' },
];

function PowerAllocation() {
  const [selected, setSelected] = useState(powerData[0].label);
  const active = powerData.find((entry) => entry.label === selected) ?? powerData[0];
  const gradient = useMemo(() => powerData.reduce<{ cursor: number; stops: string[] }>(
    (accumulator, entry) => ({
      cursor: accumulator.cursor + entry.value,
      stops: [...accumulator.stops, `${entry.color} ${accumulator.cursor}% ${accumulator.cursor + entry.value}%`],
    }),
    { cursor: 0, stops: [] },
  ).stops.join(', '), []);
  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr] lg:items-center">
      <button type="button" aria-label="Biểu đồ phân bổ công suất" onClick={() => setSelected(powerData[(powerData.findIndex((entry) => entry.label === selected) + 1) % powerData.length].label)} className="mx-auto h-48 w-48 rounded-full p-8 transition-transform hover:scale-105" style={{ background: `conic-gradient(${gradient})` }}>
        <span className="flex h-full w-full flex-col items-center justify-center rounded-full" style={{ background: 'var(--bg-surface)' }}><strong className="font-mono text-2xl" style={{ color: active.color }}>~180 W</strong><small style={{ color: 'var(--text-muted)' }}>peak total</small></span>
      </button>
      <div className="space-y-2">
        {powerData.map((entry) => <button type="button" key={entry.label} onClick={() => setSelected(entry.label)} className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-white/[0.04]" style={{ color: 'var(--text-secondary)' }}><span className="h-3 w-3 rounded-sm" style={{ background: entry.color }} /><span className="flex-1 text-xs">{entry.label}</span><span className="font-mono text-xs" style={{ color: entry.color }}>{entry.watts} · {entry.value}%</span></button>)}
        <p className="pt-2 text-xs" style={{ color: 'var(--text-muted)' }}>Đang chọn: <span style={{ color: active.color }}>{active.label}</span>. Nhấn vào biểu đồ để chuyển mục.</p>
      </div>
    </div>
  );
}

export default function SpecificationsPage() {
  return (
    <TechnicalPageShell eyebrow="Robot intelligence / report 01" title="THÔNG SỐ KỸ THUẬT" description="Bản đồ kỹ thuật của AIoT Autonomous Warehouse Robot — từ cảm biến, gateway Raspberry Pi, firmware ESP32 đến cơ cấu vật lý và vận hành kho." icon={<Cpu size={14} />}>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Kiến trúc" value="2-brain" detail="Pi 5 xử lý cấp cao · ESP32 thời gian thực" />
        <MetricCard label="Kho mini" value="64 ô" detail="4 kệ × 4 hàng × 4 cột" color="var(--success)" />
        <MetricCard label="Điều khiển" value="50 Hz" detail="PID đồng thời cho 4 motor" color="var(--warning)" />
        <MetricCard label="Định vị" value="±5 cm" detail="AMCL trên occupancy grid" color="var(--accent)" />
      </div>

      <TechnicalSection title="01 · Tổng quan hệ thống" description="Các khối chức năng chính trong thiết kế hai bộ não và kho hàng 64 slot.">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {[['Two-Brain Architecture', 'Raspberry Pi 5 chạy SLAM, Nav2, WebSocket; ESP32-S3 đảm bảo PWM, PID và encoder real-time.', Cpu], ['Mecanum 4WD', 'Di chuyển tiến, ngang và xoay tại chỗ trong không gian kho hẹp.', Gauge], ['Shelf-slot model', 'Package, Shelf và ShelfSlot hỗ trợ barcode, AprilTag và trạng thái vận chuyển.', Database], ['Safety layers', 'IR hard-stop, Sharp slowdown/hard-stop và LiDAR replan theo ba mức ưu tiên.', ShieldCheck]].map(([title, text, Icon]) => <Card key={title as string} styles={{ body: { padding: 18 } }}><Icon size={18} style={{ color: 'var(--accent)' }} /><h3 className="mt-3 text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{title as string}</h3><p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{text as string}</p></Card>)}
        </div>
      </TechnicalSection>

      <TechnicalSection title="02 · Thông số phần cứng"><TechnicalTable ariaLabel="Thông số phần cứng" columns={columns('Thành phần', ['item', 'value', 'note'])} rows={hardwareRows} /></TechnicalSection>
      <TechnicalSection title="03 · Cảm biến và actuator"><TechnicalTable ariaLabel="Cảm biến và actuator" columns={columns('Cảm biến', ['sensor', 'model', 'range', 'protocol', 'role'])} rows={sensorRows} /></TechnicalSection>
      <TechnicalSection title="04 · Bảng chân GPIO"><TechnicalTable ariaLabel="Bảng chân GPIO ESP32-S3" columns={columns('Chân', ['pin', 'function'])} rows={gpioRows} /></TechnicalSection>
      <TechnicalSection title="05 · Phần mềm và giao thức" description="Các message được phân tách bằng newline, tốc độ 115200 baud, và serial link chỉ có một owner là esp32_telemetry_node."><div className="space-y-4"><TechnicalTable ariaLabel="Ngăn xếp phần mềm" columns={columns('Tầng', ['layer', 'technology', 'version', 'role'])} rows={softwareRows} /><TechnicalTable ariaLabel="Giao thức Pi ESP32" columns={columns('Đường truyền', ['direction', 'message', 'role'])} rows={protocolRows} /></div></TechnicalSection>
      <TechnicalSection title="06 · Kiến trúc hệ thống"><DiagramPanel label="Kiến trúc bốn tầng" caption="Luồng dữ liệu từ cảm biến qua Pi 5 và ESP32-S3 xuống motor, actuator và safety sensors."><SystemArchitectureDiagram /></DiagramPanel></TechnicalSection>
      <TechnicalSection title="07 · Hiệu suất và kinematics"><div className="grid gap-4 lg:grid-cols-2"><TechnicalTable ariaLabel="Hiệu suất robot" columns={columns('Chỉ tiêu', ['metric', 'value', 'note'])} rows={performanceRows} /><Card styles={{ body: { padding: 20 } }}><h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Mecanum kinematics</h3><pre className="mt-4 overflow-x-auto rounded-lg p-4 text-xs leading-7" style={{ background: 'var(--bg-base)', color: 'var(--accent)' }}>{`v_fl = Vx − Vy − ω(L + W)\nv_fr = Vx + Vy + ω(L + W)\nv_rl = Vx + Vy − ω(L + W)\nv_rr = Vx − Vy + ω(L + W)`}</pre><p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>Vx là tiến/lùi, Vy là sang ngang, ω là vận tốc góc; L và W là bán kính hình học của chassis.</p></Card></div></TechnicalSection>
      <TechnicalSection title="08 · Phân tích năng lượng"><div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]"><Card styles={{ body: { padding: 20 } }}><PowerAllocation /></Card><div className="grid gap-4 sm:grid-cols-3"><MetricCard label="Pin 84 Wh" value="~28 phút" detail="Thực tế 35–40 phút ở tải thường" color="var(--warning)" /><MetricCard label="Mecanum" value="~70%" detail="Roller friction loss khoảng 30%" color="var(--success)" /><MetricCard label="Full load" value="~180 W" detail="Motor + Pi + sensor + logic" color="var(--accent)" /></div></div></TechnicalSection>
      <TechnicalSection title="09 · Tiến độ triển khai"><div className="grid gap-3 md:grid-cols-2">{progress.map(([label, status, state], index) => <div key={label} className="rounded-xl border p-4" style={{ borderColor: 'var(--border-dim)', background: 'rgba(17,24,39,0.55)' }}><div className="flex items-center justify-between gap-3"><span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}><span className="mr-2 font-mono" style={{ color: 'var(--text-muted)' }}>{String(index + 1).padStart(2, '0')}</span>{label}</span><Tag color={state}>{status}</Tag></div><Progress className="mt-3" percent={state === 'success' ? 100 : state === 'processing' ? 62 : 12} showInfo={false} status={state === 'success' ? 'success' : 'normal'} strokeColor={state === 'success' ? 'var(--success)' : state === 'processing' ? 'var(--accent)' : 'var(--text-muted)'} railColor="var(--bg-base)" /></div>)}</div></TechnicalSection>
      <TechnicalSection title="10 · Trạng thái dock/unload"><Collapse items={[{ key: 'dock', label: 'Chuỗi 8 trạng thái trên ESP32', children: <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{['IDLE', 'ADJUSTING · heading ±2°', 'EXTENDING · L298N', 'HOLDING · 3 s', 'RETRACTING · limit switch', 'DONE', 'LEAVE · heading hold', 'COMPLETE → IDLE'].map((state, index) => <div key={state} className="rounded-lg border p-3" style={{ borderColor: 'var(--border-dim)' }}><span className="font-mono text-[10px]" style={{ color: 'var(--accent)' }}>STATE {index}</span><p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>{state}</p></div>)}</div> }]} /></TechnicalSection>
      <div className="flex items-center gap-2 border-t pt-5 text-xs" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)' }}><Zap size={14} style={{ color: 'var(--warning)' }} /> Số liệu tổng hợp từ report_specs.html và hợp đồng Pi ↔ ESP32 trong CLAUDE.md.</div>
    </TechnicalPageShell>
  );
}
