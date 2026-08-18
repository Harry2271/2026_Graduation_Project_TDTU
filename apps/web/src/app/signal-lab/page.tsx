'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Card, Segmented, Slider, Statistic, Tag } from 'antd';
import { Activity, Radar, SlidersHorizontal } from 'lucide-react';
import { DiagramPanel, TechnicalPageShell, TechnicalSection, TechnicalTable, type TechnicalTableRow } from '@/components/technical/TechnicalPageShell';
import { PidLineChart, PolarScanChart, PwmChart, ZoneBarChart } from './CanvasCharts';
import { defaultGains, generateLidar, getLidarZones, getPidStats, simulatePid, type LidarScene, type PidGains, type PidScene } from './simulation';

const lidarRows: TechnicalTableRow[] = [
  { key: 'model', parameter: 'Model', value: 'RPLIDAR A1M8-R6' }, { key: 'angle', parameter: 'Góc quét', value: '360° · full circle' }, { key: 'range', parameter: 'Phạm vi', value: '0.15–12 m' }, { key: 'rate', parameter: 'Tần số', value: '~8 Hz · sample 5.5 kHz' }, { key: 'topic', parameter: 'ROS 2 topic', value: '/scan · sensor_msgs/LaserScan' }, { key: 'zones', parameter: 'Zones', value: 'Front ±45° · Left 45–135° · Rear 135–225° · Right còn lại' }, { key: 'threshold', parameter: 'Threshold', value: 'LiDAR 1.5 m · Sharp 60/15 cm · IR 20 cm' },
];
const tuningRows: TechnicalTableRow[] = [
  { key: 'kp', property: 'Kp quá cao', overshoot: '>20%', settling: 'Dài · oscillate', steady: 'Có thể còn', response: 'Nhanh nhưng rung' }, { key: 'ki', property: 'Ki quá cao', overshoot: 'Trung bình', settling: 'Rất dài · windup', steady: '=0', response: 'Nhanh nhưng overshoot' }, { key: 'kd', property: 'Kd quá cao', overshoot: 'Nhỏ', settling: 'Dài · chậm', steady: 'Có thể còn', response: 'Overdamped' }, { key: 'balanced', property: 'Cân bằng 2.5/0.2/0.05', overshoot: '~5–10%', settling: '~0.3 s', steady: '~0', response: 'Nhanh, ổn định' },
];

const sceneLabels: Record<PidScene, string> = { step: 'Step response', tracking: 'Speed tracking', compare: 'Tune compare' };
const lidarLabels: Record<LidarScene, string> = { room: 'Phòng mô hình', corridor: 'Hành lang', cluttered: 'Kho chật' };

export default function SignalLabPage() {
  const [pidScene, setPidScene] = useState<PidScene>('step');
  const [gains, setGains] = useState<PidGains>(defaultGains);
  const [lidarScene, setLidarScene] = useState<LidarScene>('room');
  const [sweep, setSweep] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const pidSeries = useMemo(() => simulatePid(gains, pidScene), [gains, pidScene]);
  const pidStats = useMemo(() => getPidStats(pidSeries), [pidSeries]);
  const compareSeries = useMemo(() => pidScene === 'compare' ? [simulatePid({ kp: 2.5, ki: 0.2, kd: 0.05 }, 'step'), simulatePid({ kp: 6, ki: 0.2, kd: 0.05 }, 'step'), simulatePid({ kp: 1, ki: 0.05, kd: 0.01 }, 'step')] : undefined, [pidScene]);
  const lidarPoints = useMemo(() => generateLidar(lidarScene), [lidarScene]);
  const zones = useMemo(() => getLidarZones(lidarPoints), [lidarPoints]);
  const minimumDistance = Math.min(zones.front, zones.left, zones.right, zones.rear);

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (reducedMotion) { setSweep(0); return; }
    let frame = 0;
    let last = 0;
    const tick = (timestamp: number) => {
      if (!document.hidden && timestamp - last > 45) { last = timestamp; setSweep((value) => (value + 4) % 360); }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reducedMotion, lidarScene]);

  const updateGain = (key: keyof PidGains, value: number | number[]) => setGains((current) => ({ ...current, [key]: Array.isArray(value) ? value[0] : value }));
  return <TechnicalPageShell eyebrow="Controls / report 03" title="PID & LiDAR SIGNAL LAB" description="Phòng thí nghiệm mô phỏng tách biệt với telemetry thật: điều chỉnh PID 50 Hz, quan sát closed-loop response và quét LiDAR 360° theo nhiều bối cảnh kho." icon={<Radar size={14} />}>
    <Alert type="info" showIcon title="Chế độ mô phỏng" description="Các đường tín hiệu và điểm LiDAR được sinh deterministic từ mô hình trong tài liệu; chúng không đại diện cho dữ liệu robot live." />
    <TechnicalSection title="01 · PID motor control · 50 Hz loop"><Card styles={{ body: { padding: 20 } }}><div className="flex flex-wrap items-center justify-between gap-4"><div className="flex items-center gap-2"><SlidersHorizontal size={16} style={{ color: 'var(--accent)' }} /><span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>Kịch bản mô phỏng</span></div><Segmented value={pidScene} onChange={(value) => setPidScene(value as PidScene)} options={Object.entries(sceneLabels).map(([value, label]) => ({ value, label }))} /></div><div className="mt-6 grid gap-x-8 gap-y-4 md:grid-cols-3">{([['kp', 'Kp', 0.5, 8, 0.1], ['ki', 'Ki', 0, 2, 0.02], ['kd', 'Kd', 0, 1, 0.01]] as const).map(([key, label, min, max, step]) => <div key={key}><div className="mb-1 flex justify-between text-xs"><span style={{ color: 'var(--text-secondary)' }}>{label}</span><strong className="font-mono" style={{ color: 'var(--accent)' }}>{gains[key].toFixed(key === 'kp' ? 1 : 2)}</strong></div><Slider min={min} max={max} step={step} value={gains[key]} onChange={(value) => updateGain(key, value)} styles={{ track: { background: 'var(--accent)' }, rail: { background: 'var(--bg-base)' }, handle: { borderColor: 'var(--accent)', boxShadow: '0 0 0 2px var(--accent-glow)' } }} /></div>)}</div></Card><div className="mt-4 grid gap-6 md:grid-cols-2"><Card styles={{ body: { padding: 0 } }}><div className="border-b px-4 py-3 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)' }}>Motor RPM · target vs actual</div>{pidScene === 'compare' && compareSeries ? <PidLineChart series={compareSeries[0]} compare={compareSeries} /> : <PidLineChart series={pidSeries} />}</Card><Card styles={{ body: { padding: 0 } }}><div className="border-b px-4 py-3 text-[10px] font-bold uppercase tracking-[0.12em]" style={{ borderColor: 'var(--border-dim)', color: 'var(--text-muted)' }}>PWM duty output · 0–511</div>{pidScene === 'compare' ? <div className="flex h-[210px] items-center justify-center px-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>Tune compare hiển thị ba response; chuyển sang Step hoặc Tracking để xem PWM trace.</div> : <PwmChart series={pidSeries} />}</Card></div><div className="mt-4 grid grid-cols-2 gap-5 lg:grid-cols-5">{[['Overshoot', `${pidStats.overshootPct.toFixed(1)}%`], ['Rise time', `${pidStats.riseMs} ms`], ['Settling', `${pidStats.settlingMs} ms`], ['Steady-state', `${pidStats.steadyStateError.toFixed(1)} RPM`], ['Update rate', '50 Hz']].map(([label, value]) => <Card key={label} styles={{ body: { padding: 14 } }}><Statistic title={label} value={value} valueStyle={{ color: 'var(--text-primary)', fontFamily: 'var(--font-jetbrains)' }} /></Card>)}</div><Card className="mt-4" styles={{ body: { padding: 18 } }}><h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Công thức PID</h3><pre className="mt-3 overflow-x-auto rounded-lg p-4 text-xs leading-6" style={{ background: 'var(--bg-base)', color: 'var(--text-secondary)' }}>{`output = Kp × error + Ki × ∫error·dt + Kd × d(error)/dt\nerror = target_RPM − actual_RPM\nintegral += error × dt · clamp ±400\noutput → clamp ±511 PWM → BTS7960`}</pre></Card><TechnicalTable ariaLabel="So sánh tham số PID" columns={[{ title: 'Thuộc tính', dataIndex: 'property', key: 'property' }, { title: 'Overshoot', dataIndex: 'overshoot', key: 'overshoot' }, { title: 'Settling time', dataIndex: 'settling', key: 'settling' }, { title: 'Steady-state error', dataIndex: 'steady', key: 'steady' }, { title: 'Phản hồi', dataIndex: 'response', key: 'response' }]} rows={tuningRows} /></TechnicalSection>
    <TechnicalSection title="02 · LiDAR scan 360° · RPLIDAR A1M8-R6"><Card styles={{ body: { padding: 20 } }}><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2"><Activity size={16} style={{ color: 'var(--accent)' }} /><span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>Bối cảnh scan</span></div><p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>Sweep animation {reducedMotion ? 'đã giảm theo prefers-reduced-motion' : 'đang hoạt động'}</p></div><Segmented value={lidarScene} onChange={(value) => setLidarScene(value as LidarScene)} options={Object.entries(lidarLabels).map(([value, label]) => ({ value, label }))} /></div></Card><div className="mt-4 grid gap-6 lg:grid-cols-2"><Card styles={{ body: { padding: 10 } }}><PolarScanChart points={lidarPoints} sweep={sweep} /></Card><Card styles={{ body: { padding: 10 } }}><ZoneBarChart zones={zones} /><div className="grid grid-cols-2 gap-5 border-t px-3 pt-3" style={{ borderColor: 'var(--border-dim)' }}><Statistic title="Min distance" value={minimumDistance.toFixed(2)} suffix="m" valueStyle={{ color: minimumDistance < 1.5 ? 'var(--danger)' : 'var(--success)', fontFamily: 'var(--font-jetbrains)' }} /><div><p className="text-xs" style={{ color: 'var(--text-muted)' }}>Obstacle state</p><Tag className="mt-2" color={minimumDistance < 1.5 ? 'error' : 'success'}>{minimumDistance < 1.5 ? 'VẬT CẢN PHÁT HIỆN' : 'KHÔNG PHÁT HIỆN'}</Tag></div><Statistic title="Points" value={lidarPoints.length} /><Statistic title="Range" value="0.15–12" suffix="m" /></div></Card></div><TechnicalTable ariaLabel="Thông số LiDAR" columns={[{ title: 'Thông số', dataIndex: 'parameter', key: 'parameter' }, { title: 'Giá trị', dataIndex: 'value', key: 'value' }]} rows={lidarRows} /><DiagramPanel label="Thuật toán tránh vật cản ba lớp" caption="Safety priority: local hard-stop luôn thắng global replan."><div className="grid gap-3 md:grid-cols-3">{[['Priority 1 · IR', '≤20 cm → HARD STOP ngay lập tức', 'var(--danger)'], ['Priority 2 · Sharp', '<15 cm hard-stop · 15–60 cm slowdown', 'var(--warning)'], ['Priority 3 · LiDAR', '<1.5 m → score 6 hướng → replan', 'var(--accent)']].map(([title, text, color]) => <div key={title} className="rounded-xl border p-4" style={{ borderColor: `${color}55`, background: `${color}0d` }}><h3 className="text-xs font-bold" style={{ color }}>{title}</h3><p className="mt-2 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{text}</p></div>)}</div></DiagramPanel></TechnicalSection>
  </TechnicalPageShell>;
}
