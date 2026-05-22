/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MapPin, RotateCcw, ZoomIn, ZoomOut, Maximize2, Move, Ruler, Compass, Target, AlertTriangle, Activity, WifiOff } from 'lucide-react';
import { Button, notification, Tooltip, Modal } from 'antd';

const WS_URL = "wss://map.nguyen-robot.io.vn"; // Tunnel trỏ vào port 9090 (rosbridge)

interface TFNode {
  parent: string;
  x: number;
  y: number;
  yaw: number;
}

export default function MapPage() {
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [lidarStatus, setLidarStatus] = useState<'connected' | 'disconnected' | 'waiting'>('waiting');
  const [isResetting, setIsResetting] = useState(false);
  const [mapMetadata, setMapMetadata] = useState<{ width: number; height: number; resolution: number } | null>(null);
  const [viewportScaleMeters, setViewportScaleMeters] = useState<number>(10);
  
  // Các chế độ hiển thị & theo dõi vị trí Lidar
  const [isHeadingUp, setIsHeadingUp] = useState<boolean>(true); // Xoay bản đồ theo hướng Lidar (Heading-Up)
  const [isRobotLock, setIsRobotLock] = useState<boolean>(true); // Khóa vị trí Lidar ở trung tâm

  // Dùng Ref để lưu trữ thông số tham chiếu tính toán và cây TF real-time
  const mapMetadataRef = useRef<{ width: number; height: number; resolution: number; origin: any } | null>(null);
  const viewportScaleRef = useRef<number>(10);
  const tfTreeRef = useRef<{ [childFrame: string]: TFNode }>({});
  const lastMsgTimeRef = useRef<number>(0);

  // Watchdog timer giám sát luồng dữ liệu từ Lidar
  useEffect(() => {
    const timer = setInterval(() => {
      if (wsStatus === 'connected') {
        const now = Date.now();
        // Nếu quá 3 giây (3000ms) không nhận được bất kỳ dữ liệu TF/Map nào từ ROS 2
        if (lastMsgTimeRef.current > 0 && now - lastMsgTimeRef.current <= 3000) {
          setLidarStatus('connected');
        } else {
          setLidarStatus('disconnected');
        }
      } else {
        setLidarStatus('waiting');
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [wsStatus]);

  // Quản lý trạng thái Zoom (1.0 = 100% của khung nhìn vật lý)
  const zoomRef = useRef<number>(1.0);
  const [zoomScaleUI, setZoomScaleUI] = useState<number>(1.0);
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const isDraggingRef = useRef<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const wsRef = useRef<WebSocket | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Thuật toán tìm vị trí và hướng Lidar real-time từ cây TF
  const getRobotPose = useCallback(() => {
    const tree = tfTreeRef.current;
    if (Object.keys(tree).length === 0) return null;

    // Tìm frame Lidar/Robot (ưu tiên laser, sllidar_base_link, base_link, base_footprint)
    const robotFrame = ['laser', 'sllidar_base_link', 'base_link', 'base_footprint'].find(f => tree[f]) 
      || Object.keys(tree).find(k => k.includes('laser') || k.includes('lidar'))
      || Object.keys(tree).find(k => tree[k].parent === 'map' || tree[k].parent === 'odom');

    if (!robotFrame) return null;

    let current: string | null = robotFrame;
    let netX = 0;
    let netY = 0;
    let netYaw = 0;
    let iterations = 0;

    // Lần ngược cây TF lên tới gốc 'map'
    while (current && iterations < 10) {
      const node: TFNode | undefined = tree[current];
      if (!node) break;

      const cos = Math.cos(netYaw);
      const sin = Math.sin(netYaw);
      netX = node.x + netX * cos - netY * sin;
      netY = node.y + netX * sin + netY * cos;
      netYaw = node.yaw + netYaw;

      if (node.parent === 'map' || node.parent === 'world') break;
      current = node.parent;
      iterations++;
    }

    if (!mapMetadataRef.current || !mapMetadataRef.current.origin) {
      return { x: netX, y: netY, yaw: netYaw, canvasX: 0, canvasY: 0 };
    }

    const { origin, resolution, width, height } = mapMetadataRef.current;
    const dx = netX - origin.position.x;
    const dy = netY - origin.position.y;
    const cellX = dx / resolution;
    const cellY = dy / resolution;

    // Tọa độ tương đối so với tâm offscreen canvas (trục Y canvas hướng xuống)
    const canvasX = cellX - width / 2;
    const canvasY = -(cellY - height / 2);

    return { x: netX, y: netY, yaw: netYaw, canvasX, canvasY };
  }, []);

  // Hàm redraw chính: tính toán ma trận xoay & tịnh tiến Heading-Up
  const redrawDisplayCanvas = useCallback(() => {
    const dispCanvas = canvasRef.current;
    const offCanvas = offscreenCanvasRef.current;
    if (!dispCanvas || !offCanvas) return;

    const dispCtx = dispCanvas.getContext('2d');
    if (!dispCtx) return;

    dispCtx.imageSmoothingEnabled = false;
    (dispCtx as any).webkitImageSmoothingEnabled = false;
    (dispCtx as any).mozImageSmoothingEnabled = false;

    dispCtx.clearRect(0, 0, dispCanvas.width, dispCanvas.height);
    dispCtx.save();
    
    // Đưa gốc tọa độ về trung tâm màn hình và cộng độ lệch pan
    dispCtx.translate(dispCanvas.width / 2 + panRef.current.x, dispCanvas.height / 2 + panRef.current.y);
    
    const res = mapMetadataRef.current ? mapMetadataRef.current.resolution : 0.05;
    const targetMapPixels = viewportScaleRef.current / res;
    const basePhysicalScale = dispCanvas.width / targetMapPixels;
    const effectiveScale = basePhysicalScale * zoomRef.current;

    const robot = getRobotPose();

    // Nếu khóa trung tâm hoặc xoay bản đồ theo Lidar
    if (robot && (isRobotLock || isHeadingUp)) {
      // Góc xoay bản đồ để Lidar hướng thẳng lên trên (Heading-Up)
      const mapRotation = isHeadingUp ? (-robot.yaw - Math.PI / 2) : 0;
      dispCtx.rotate(mapRotation);
      dispCtx.scale(effectiveScale, effectiveScale);

      // Nếu khóa trung tâm, dịch gốc xoay về đúng vị trí Lidar
      if (isRobotLock) {
        dispCtx.translate(-robot.canvasX, -robot.canvasY);
      }
    } else {
      dispCtx.scale(effectiveScale, effectiveScale);
    }
    
    // Vẽ bản đồ OccupancyGrid từ offscreen
    dispCtx.drawImage(offCanvas, -offCanvas.width / 2, -offCanvas.height / 2);

    // --- Vẽ biểu tượng Robot/Lidar real-time ---
    if (robot) {
      dispCtx.save();
      dispCtx.translate(robot.canvasX, robot.canvasY);
      
      // Xoay theo hướng Lidar (trên hệ tọa độ canvas, góc xoay là -yaw)
      dispCtx.rotate(-robot.yaw);

      // 1. Vẽ chấm tròn xanh lá (vị trí Lidar)
      dispCtx.beginPath();
      dispCtx.arc(0, 0, 7 / effectiveScale, 0, Math.PI * 2);
      dispCtx.fillStyle = '#22c55e'; // Green 500
      dispCtx.fill();
      dispCtx.lineWidth = 2.5 / effectiveScale;
      dispCtx.strokeStyle = '#ffffff';
      dispCtx.stroke();

      // 2. Vẽ mũi tên chỉ hướng (nón đỏ nhô ra phía trước +X)
      dispCtx.beginPath();
      dispCtx.moveTo(16 / effectiveScale, 0); // Đỉnh mũi tên phía trước
      dispCtx.lineTo(5 / effectiveScale, -6 / effectiveScale);
      dispCtx.lineTo(5 / effectiveScale, 6 / effectiveScale);
      dispCtx.closePath();
      dispCtx.fillStyle = '#ef4444'; // Red 500
      dispCtx.fill();

      dispCtx.restore();
    }

    dispCtx.restore();
  }, [getRobotPose, isHeadingUp, isRobotLock]);

  // Xử lý dữ liệu Occupancy Grid: Tối ưu độ tương phản dịu mắt (Nền xám tối, Lối đi trắng sáng, Vách tường đen đậm)
  const processMapGrid = useCallback((info: { width: number; height: number; resolution: number; origin: any }, gridData: number[]) => {
    const { width, height, resolution, origin } = info;
    mapMetadataRef.current = { width, height, resolution, origin };
    setMapMetadata({ width, height, resolution });

    if (!offscreenCanvasRef.current) {
      const off = document.createElement('canvas');
      off.width = width;
      off.height = height;
      offscreenCanvasRef.current = off;
    }

    const offCanvas = offscreenCanvasRef.current;
    if (offCanvas.width !== width || offCanvas.height !== height) {
      offCanvas.width = width;
      offCanvas.height = height;
    }

    const ctx = offCanvas.getContext('2d');
    if (!ctx) return;

    const imgData = ctx.createImageData(width, height);
    const dataArr = imgData.data;

    for (let i = 0; i < gridData.length; i++) {
      const val = gridData[i];
      const r = Math.floor(i / width);
      const c = i % width;
      const canvasIdx = ((height - 1 - r) * width + c) * 4;

      if (val === -1) {
        // Vùng chưa biết (Unknown): Màu xám slate tối dịu mắt (#1e293b) - Tạo chiều sâu hoàn hảo trên nền web sáng
        dataArr[canvasIdx] = 30;     // R
        dataArr[canvasIdx + 1] = 41; // G
        dataArr[canvasIdx + 2] = 59; // B
        dataArr[canvasIdx + 3] = 255;
      } else if (val === 0) {
        // Lối đi (Free space): Màu trắng tinh khiết (#ffffff) - Nổi bật rõ ràng khu vực robot đã quét
        dataArr[canvasIdx] = 255;
        dataArr[canvasIdx + 1] = 255;
        dataArr[canvasIdx + 2] = 255;
        dataArr[canvasIdx + 3] = 255;
      } else if (val > 50) {
        // Vách tường / Chướng ngại vật: Màu đen tuyền (#000000) - Phân cách sắc nét ranh giới tường và lối đi
        dataArr[canvasIdx] = 0;
        dataArr[canvasIdx + 1] = 0;
        dataArr[canvasIdx + 2] = 0;
        dataArr[canvasIdx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);

    redrawDisplayCanvas();
  }, [redrawDisplayCanvas]);

  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) return;

    setWsStatus('connecting');
    try {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        setWsStatus('connected');
        lastMsgTimeRef.current = 0;
        
        // Đăng ký topic /map
        try {
          ws.send(JSON.stringify({ op: "subscribe", topic: "/map", type: "nav_msgs/msg/OccupancyGrid" }));
        } catch (e) {
          console.error("Sub map error", e);
        }

        // Đăng ký luồng TF để theo dõi vị trí và hướng Lidar
        try {
          ws.send(JSON.stringify({ op: "subscribe", topic: "/tf", type: "tf2_msgs/msg/TFMessage" }));
          ws.send(JSON.stringify({ op: "subscribe", topic: "/tf_static", type: "tf2_msgs/msg/TFMessage" }));
        } catch (e) {
          console.error("Sub tf error", e);
        }
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const data = JSON.parse(event.data);
            
            // Xử lý bản đồ
            if (data.op === 'publish' && data.topic === '/map' && data.msg) {
              lastMsgTimeRef.current = Date.now();
              const { info, data: gridData } = data.msg;
              processMapGrid(info, gridData);
            }
            // Xử lý dữ liệu TF real-time
            else if (data.op === 'publish' && (data.topic === '/tf' || data.topic === '/tf_static') && data.msg?.transforms) {
              lastMsgTimeRef.current = Date.now();
              for (const tf of data.msg.transforms) {
                const parent = tf.header?.frame_id;
                const child = tf.child_frame_id;
                const trans = tf.transform?.translation;
                const rot = tf.transform?.rotation;
                if (parent && child && trans && rot) {
                  const { z, w } = rot;
                  const yaw = Math.atan2(2 * (w * z), 1 - 2 * (z * z));
                  tfTreeRef.current[child] = { parent, x: trans.x, y: trans.y, yaw };
                }
              }
            }
            // Xử lý service reset
            else if (data.op === 'service_response' && data.service === '/slam_toolbox/reset') {
              setIsResetting(false);
              if (data.result === false) {
                notification.error({ message: 'Lỗi reset bản đồ', description: 'service_response: false', placement: 'topRight' });
              } else {
                notification.success({ message: 'Thành công', description: 'Đã reset bản đồ thành công!', placement: 'topRight' });
              }
            }
          } catch (e) {
            console.error("Error parsing WS JSON", e);
          }
        }
      };

      ws.onclose = () => {
        setWsStatus('disconnected');
        setLidarStatus('waiting');
      };

      ws.onerror = () => {
        // Tránh log lỗi Event thô gây ra màn hình overlay đỏ trên Next.js dev mode
        console.warn(`[ROS 2 WebSocket] Không thể kết nối tới ${WS_URL}. Vui lòng kiểm tra lại server robot hoặc đường truyền.`);
        setWsStatus('disconnected');
        setLidarStatus('waiting');
      };

      wsRef.current = ws;
    } catch (err) {
      console.warn('[ROS 2 WebSocket] Khởi tạo kết nối thất bại:', err);
      setWsStatus('disconnected');
      setLidarStatus('waiting');
    }
  }, [processMapGrid]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    connectWs();
    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (animFrameRef.current) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, [connectWs]);

  // Luồng render 30fps mượt mà để cập nhật mũi tên và xoay bản đồ theo luồng TF
  useEffect(() => {
    const interval = setInterval(() => {
      if (wsStatus === 'connected') {
        redrawDisplayCanvas();
      }
    }, 33); // ~30fps
    return () => clearInterval(interval);
  }, [wsStatus, redrawDisplayCanvas]);

  useEffect(() => {
    redrawDisplayCanvas();
  }, [viewportScaleMeters, isHeadingUp, isRobotLock, redrawDisplayCanvas]);

  // --- Chức năng Zoom & Pan ---
  const handleZoom = (delta: number) => {
    let newScale = zoomRef.current + delta;
    if (newScale < 0.2) newScale = 0.2;
    if (newScale > 10.0) newScale = 10.0;
    zoomRef.current = parseFloat(newScale.toFixed(2));
    setZoomScaleUI(zoomRef.current);
    redrawDisplayCanvas();
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.15 : -0.15;
    handleZoom(delta);
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    isDraggingRef.current = true;
    dragStartRef.current = {
      x: e.clientX - panRef.current.x,
      y: e.clientY - panRef.current.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return;
    panRef.current = {
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    };
    redrawDisplayCanvas();
  };

  const handleMouseUpOrLeave = () => {
    isDraggingRef.current = false;
  };

  const resetView = () => {
    zoomRef.current = 1.0;
    setZoomScaleUI(1.0);
    panRef.current = { x: 0, y: 0 };
    redrawDisplayCanvas();
  };
  // ----------------------------

  const handleResetMap = () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      notification.warning({ message: 'Đang kết nối lại', description: 'Đang kết nối lại với robot...', placement: 'topRight' });
      connectWs();
      return;
    }

    setIsResetting(true);

    try {
      wsRef.current.send(JSON.stringify({
        op: "call_service",
        service: "/slam_toolbox/reset",
        args: {}
      }));

      setTimeout(() => {
        setIsResetting((prev) => {
          if (prev) {
            notification.success({ message: 'Thành công', description: 'Đã gửi lệnh reset bản đồ (rosbridge) thành công!', placement: 'topRight' });
            return false;
          }
          return prev;
        });
      }, 1500);
    } catch (err) {
      console.error('Error sending rosbridge reset call:', err);
      setIsResetting(false);
      notification.error({ message: 'Thất bại', description: 'Không thể gửi lệnh reset tới robot.', placement: 'topRight' });
    }
  };

  const confirmReset = () => {
    Modal.confirm({
      title: 'Xác nhận vẽ lại bản đồ mới',
      content: 'Thao tác này sẽ xóa toàn bộ dữ liệu vách tường, chướng ngại vật đã quét và bắt đầu vẽ lại bản đồ SLAM từ đầu. Bạn có chắc chắn muốn thực hiện?',
      okText: 'Xác nhận Reset',
      cancelText: 'Hủy bỏ',
      okButtonProps: { danger: true },
      onOk: () => handleResetMap(),
    });
  };

  return (
    <div className="p-8 min-h-screen flex flex-col bg-slate-100 text-slate-900 font-sans select-none transition-colors duration-500">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900 flex items-center gap-3 tracking-tight">
            <MapPin className="text-red-500 animate-bounce" size={32} />
            Hệ Thống Bản Đồ SLAM & TF Real-time
          </h1>
          <p className="text-sm text-slate-500 mt-1 font-medium">
            Màn hình Radar SLAM tối màu tương phản dịu mắt trên nền giao diện Web sáng (Bảo vệ mắt tối đa khi quan sát lâu)
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* ROS 2 WebSocket Status Badge */}
          <div className={`flex items-center gap-2 px-3.5 py-2.5 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all shadow-sm bg-white border ${
            wsStatus === 'connected' ? 'text-emerald-600 border-emerald-300' :
            wsStatus === 'connecting' ? 'text-amber-600 border-amber-300' :
            'text-rose-600 border-rose-300'
          }`}>
            <span className={`w-2.5 h-2.5 rounded-full ${
              wsStatus === 'connected' ? 'bg-emerald-500 animate-pulse' :
              wsStatus === 'connecting' ? 'bg-amber-500 animate-ping' :
              'bg-rose-500'
            }`} />
            <span>
              {wsStatus === 'connected' ? 'ROS 2 Online' :
               wsStatus === 'connecting' ? 'Đang kết nối ROS 2...' :
               'ROS 2 Ngắt Kết Nối'}
            </span>
          </div>

          {/* Lidar Hardware Status Badge */}
          <Tooltip title={
            wsStatus !== 'connected' ? 'Chưa kết nối máy chủ ROS 2' :
            lidarStatus === 'connected' ? 'Cảm biến Lidar hoạt động tốt và đang quét real-time' :
            lidarStatus === 'waiting' ? 'Đang chờ nhận gói tin quét đầu tiên từ Lidar...' :
            'ROS 2 hoạt động nhưng không có dữ liệu Lidar. Vui lòng kiểm tra dây nguồn và cáp USB (/dev/ttyUSB0)'
          }>
            <div className={`flex items-center gap-2 px-3.5 py-2.5 rounded-2xl text-xs font-bold uppercase tracking-wider transition-all shadow-sm bg-white border ${
              wsStatus !== 'connected' ? 'text-slate-400 border-slate-200 bg-slate-50' :
              lidarStatus === 'connected' ? 'text-blue-600 border-blue-300' :
              lidarStatus === 'waiting' ? 'text-amber-600 border-amber-300 bg-amber-50/50' :
              'text-rose-600 border-rose-300 bg-rose-50/80 animate-pulse'
            }`}>
              {wsStatus !== 'connected' ? (
                <WifiOff size={16} className="text-slate-400" />
              ) : lidarStatus === 'connected' ? (
                <Activity size={16} className="text-blue-500 animate-spin" />
              ) : (
                <AlertTriangle size={16} className={lidarStatus === 'waiting' ? "text-amber-500" : "text-rose-500"} />
              )}
              <span>
                {wsStatus !== 'connected' ? 'Lidar Offline' :
                 lidarStatus === 'connected' ? 'Lidar Đã Kết Nối' :
                 lidarStatus === 'waiting' ? 'Đang Dò Lidar...' :
                 'Lidar Mất Tín Hiệu'}
              </span>
            </div>
          </Tooltip>

          <Tooltip title="Xóa toàn bộ bản đồ SLAM hiện tại trên RAM và bắt đầu quét lại phòng mới">
            <Button 
              type="primary" 
              danger 
              size="large"
              icon={<RotateCcw size={18} className={isResetting ? "animate-spin" : ""} />}
              loading={isResetting}
              onClick={confirmReset}
              className="flex items-center gap-2 px-6 py-3 rounded-2xl font-bold shadow-md hover:shadow-red-500/20 transition-all text-sm ml-1"
            >
              Reset Bản Đồ
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Alert Banner cảnh báo khi Lidar mất kết nối */}
      {wsStatus === 'connected' && (lidarStatus === 'disconnected' || lidarStatus === 'waiting') && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 bg-amber-50/90 border border-amber-200 text-amber-950 px-6 py-4 rounded-3xl shadow-sm transition-all">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-amber-100/80 flex items-center justify-center text-amber-600 shrink-0 border border-amber-200/50 shadow-inner">
              <AlertTriangle size={24} className="animate-bounce" />
            </div>
            <div>
              <h4 className="font-extrabold text-base text-amber-950 flex items-center gap-2">
                Không phát hiện luồng dữ liệu từ cảm biến Lidar
                <span className="bg-amber-200 text-amber-800 text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider font-mono">
                  Diagnostics
                </span>
              </h4>
              <p className="text-sm text-amber-800 mt-1 max-w-4xl leading-relaxed">
                Cổng WebSocket <strong>ROS 2</strong> hoạt động bình thường, nhưng hệ thống không nhận được tín hiệu quét bản đồ (TF/OccupancyGrid). 
                Khả năng cao Lidar chưa được kết nối vào cổng <code className="bg-amber-200/70 font-bold px-1.5 py-0.5 rounded text-amber-900 font-mono">/dev/ttyUSB0</code> hoặc cáp USB bị lỏng khiến container <code className="bg-amber-200/70 font-bold px-1.5 py-0.5 rounded text-amber-900 font-mono">robot-core</code> đang đứng ở chế độ chờ thiết bị.
              </p>
            </div>
          </div>
          <Button 
            type="default" 
            size="middle" 
            onClick={() => {
              notification.info({ message: 'Đang thử kết nối lại...', placement: 'topRight' });
              connectWs();
            }}
            className="border-amber-300 text-amber-900 font-bold rounded-2xl px-5 py-2.5 shadow-sm hover:border-amber-400 hover:bg-amber-100/50 transition-all text-xs uppercase"
          >
            Thử Kết Nối Lại
          </Button>
        </div>
      )}

      {/* Standalone Native HTML5 Canvas 2D Viewer: Màn hình Radar tối màu (Dark Slate) nằm lọt lòng giữa nền Web sáng */}
      <div 
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUpOrLeave}
        onMouseLeave={handleMouseUpOrLeave}
        className="flex-1 bg-slate-900 rounded-3xl border border-slate-800 shadow-2xl overflow-hidden relative flex flex-col items-center justify-center p-6 min-h-[650px] cursor-grab active:cursor-grabbing"
      >
        {/* Chú thích Bảng màu (Tường Đen, Lối đi trắng, Chưa biết xám tối, Robot xanh) */}
        <div className="absolute top-6 left-6 z-10 flex items-center gap-5 bg-slate-950/85 backdrop-blur-md px-5 py-3 rounded-2xl border border-slate-800 shadow-xl text-xs font-bold tracking-wide text-slate-300 pointer-events-auto">
          <span className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-md bg-black border border-slate-700 inline-block shadow-xs" /> Vách Tường (Đen)
          </span>
          <span className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-md bg-white inline-block shadow-xs" /> Lối Đi (Trắng)
          </span>
          <span className="flex items-center gap-2">
            <span className="w-3.5 h-3.5 rounded-md bg-slate-800 inline-block shadow-xs" /> Chưa Biết (Xám Tối)
          </span>
          <span className="flex items-center gap-2 border-l border-slate-800 pl-4">
            <span className="w-3.5 h-3.5 rounded-full bg-green-500 border border-white inline-block shadow-sm shadow-green-500/50 animate-pulse" /> Vị Trí Lidar
          </span>
          {mapMetadata && (
            <span className="text-slate-400 border-l border-slate-800 pl-4 font-mono text-xs font-normal">
              {mapMetadata.width}x{mapMetadata.height} ({mapMetadata.resolution}m/cell)
            </span>
          )}
        </div>

        {/* Cụm công tắc chế độ xoay bản đồ & Khóa vị trí ở góc trên bên phải */}
        <div className="absolute top-6 right-6 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md p-1.5 rounded-2xl border border-slate-800 shadow-xl pointer-events-auto">
          <Tooltip title={isHeadingUp ? "Đang bật chế độ Heading-Up (Xoay bản đồ theo hướng Lidar)" : "Đang cố định bản đồ (Góc nhìn North-Up)"}>
            <button
              onClick={() => setIsHeadingUp(!isHeadingUp)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                isHeadingUp 
                  ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30' 
                  : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Compass size={16} className={isHeadingUp ? 'animate-spin' : ''} />
              <span>Xoay Theo Lidar</span>
            </button>
          </Tooltip>

          <Tooltip title={isRobotLock ? "Đang khóa trung tâm camera vào vị trí Lidar" : "Đang cho phép tự do dịch chuyển (Pan)"}>
            <button
              onClick={() => setIsRobotLock(!isRobotLock)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                isRobotLock 
                  ? 'bg-emerald-600 text-white shadow-md shadow-emerald-500/30' 
                  : 'bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800'
              }`}
            >
              <Target size={16} />
              <span>Khóa Trung Tâm</span>
            </button>
          </Tooltip>
        </div>

        {/* Bộ chọn hệ quy chiếu vật lý (2m, 5m, 10m, 20m) ở góc dưới bên trái */}
        <div className="absolute bottom-6 left-6 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md p-2 rounded-2xl border border-slate-800 shadow-xl pointer-events-auto">
          <div className="flex items-center gap-1.5 px-2 text-slate-400 text-xs font-bold">
            <Ruler size={16} className="text-blue-400" />
            <span>Khung nhìn thực tế:</span>
          </div>
          <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-xl border border-slate-800">
            {[2, 5, 10, 20].map((meters) => (
              <button
                key={meters}
                onClick={() => {
                  setViewportScaleMeters(meters);
                  viewportScaleRef.current = meters;
                  zoomRef.current = 1.0;
                  setZoomScaleUI(1.0);
                  panRef.current = { x: 0, y: 0 };
                  redrawDisplayCanvas();
                }}
                className={`px-3.5 py-1.5 rounded-lg font-mono text-xs font-bold transition-all cursor-pointer ${
                  viewportScaleMeters === meters 
                    ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30 scale-105' 
                    : 'text-slate-400 hover:text-white hover:bg-slate-800'
                }`}
              >
                {meters}m
              </button>
            ))}
          </div>
        </div>

        {/* Zoom & Reset Controls ở góc dưới bên phải */}
        <div className="absolute bottom-6 right-6 z-10 flex items-center gap-2 bg-slate-950/85 backdrop-blur-md p-2 rounded-2xl border border-slate-800 shadow-xl pointer-events-auto">
          <Tooltip title="Thu nhỏ (-)">
            <button 
              onClick={() => handleZoom(-0.2)}
              className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-300 flex items-center justify-center transition-all shadow-sm hover:text-blue-400 border border-slate-800"
            >
              <ZoomOut size={18} />
            </button>
          </Tooltip>

          <span className="font-mono text-sm px-3 font-bold text-amber-400 min-w-[64px] text-center">
            {Math.round(zoomScaleUI * 100)}%
          </span>

          <Tooltip title="Phóng to (+)">
            <button 
              onClick={() => handleZoom(0.2)}
              className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-300 flex items-center justify-center transition-all shadow-sm hover:text-blue-400 border border-slate-800"
            >
              <ZoomIn size={18} />
            </button>
          </Tooltip>

          <div className="w-[1px] h-6 bg-slate-800 mx-1" />

          <Tooltip title="Đặt lại tâm nhìn mặc định">
            <button 
              onClick={resetView}
              className="w-10 h-10 rounded-xl bg-slate-900 hover:bg-slate-800 active:scale-95 text-slate-400 hover:text-emerald-400 flex items-center justify-center transition-all shadow-sm border border-slate-800"
            >
              <Maximize2 size={18} />
            </button>
          </Tooltip>
        </div>

        <canvas 
          ref={canvasRef} 
          width={1000} 
          height={800}
          className="w-full h-full max-h-[800px] object-contain rounded-2xl pointer-events-none bg-slate-900 shadow-inner [image-rendering:pixelated]"
        />
      </div>
    </div>
  );
}

