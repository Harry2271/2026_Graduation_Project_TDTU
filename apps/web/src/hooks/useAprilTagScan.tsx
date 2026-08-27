"use client";

import { useEffect, useRef } from 'react';
import { App } from 'antd';
import { getRobotSocket } from '@/lib/robotSocket';
import { inventoryApi } from '@/store/services/inventoryApi';

interface DetectedTag {
  tag_id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  confidence: number;
  size_m: number;
}

interface DetectedTagsPayload {
  ts: number;
  tags: DetectedTag[];
}

/**
 * Hook that listens to AprilTag detections from the robot and shows
 * a notification with package information when a tag is scanned.
 * 
 * Usage: Call this in a component that wraps the app (e.g., MainLayout)
 * so it's always active while the user is logged in.
 * 
 * IMPORTANT: This hook connects to the robot WebSocket (port 9091), not the API Socket.io.
 * The 'detected_tags' event is emitted by web_bridge.py on the robot.
 */
export function useAprilTagScan() {
  const { notification } = App.useApp();
  const lastNotifiedTagRef = useRef<{ tagId: number; timestamp: number } | null>(null);
  const [trigger] = inventoryApi.endpoints.getPackageByTagId.useLazyQuery();

  useEffect(() => {
    const robotSocket = getRobotSocket();

    const handleDetectedTags = async (data: unknown) => {
      const payload = data as DetectedTagsPayload;
      if (!payload?.tags || payload.tags.length === 0) return;

      // The detector does not guarantee ordering; use the strongest result.
      const tag = payload.tags.reduce((best, current) =>
        current.confidence > best.confidence ? current : best,
      );
      if (!tag) return;

      const now = Date.now();
      const DEBOUNCE_MS = 3000; // Don't show notification for same tag within 3 seconds

      // Debounce: skip if we just notified about this tag
      if (
        lastNotifiedTagRef.current &&
        lastNotifiedTagRef.current.tagId === tag.tag_id &&
        now - lastNotifiedTagRef.current.timestamp < DEBOUNCE_MS
      ) {
        return;
      }

      // Update last notified
      lastNotifiedTagRef.current = { tagId: tag.tag_id, timestamp: now };
      try {
        const pkg = await trigger(tag.tag_id).unwrap();
        notification.success({
          message: `Quét thành công AprilTag #${tag.tag_id}`,
          description: (
            <div style={{ fontFamily: "'JetBrains Mono', monospace" }}>
              <p style={{ margin: 0, fontWeight: 700, color: 'var(--accent)' }}>
                {pkg.packageName}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                Trạng thái: {pkg.status === 'CREATED' ? 'Đã tạo' : pkg.status === 'IN_PROGRESS' ? 'Đang xử lý' : 'Hoàn thành'}
              </p>
              {pkg.zoneCode && (
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
                  Khu: {pkg.zoneCode}
                </p>
              )}
            </div>
          ),
          placement: 'topRight',
          duration: 5,
        });
      } catch {
        notification.warning({
          message: `AprilTag #${tag.tag_id} không tìm thấy`,
          description: 'Không có kiện hàng nào được gán với mã tag này.',
          placement: 'topRight',
          duration: 4,
        });
      }
    };

    robotSocket.on('detected_tags', handleDetectedTags);

    return () => {
      robotSocket.off('detected_tags', handleDetectedTags);
    };
  }, [notification, trigger]);
}
