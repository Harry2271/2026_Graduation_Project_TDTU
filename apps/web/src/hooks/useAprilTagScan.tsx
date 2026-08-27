"use client";

import { useEffect, useRef, useState } from 'react';
import { App } from 'antd';
import { getSocket } from '@/lib/socket';
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
 */
export function useAprilTagScan() {
  const { notification } = App.useApp();
  const lastNotifiedTagRef = useRef<{ tagId: number; timestamp: number } | null>(null);
  const [pendingTagId, setPendingTagId] = useState<number | null>(null);

  // Use lazy query trigger
  const [trigger, result] = inventoryApi.endpoints.getPackageByTagId.useLazyQuery();

  useEffect(() => {
    const socket = getSocket();

    const handleDetectedTags = (payload: DetectedTagsPayload) => {
      if (!payload?.tags || payload.tags.length === 0) return;

      // Take the first detected tag (highest confidence)
      const tag = payload.tags[0];
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
      setPendingTagId(tag.tag_id);

      // Fetch package by tagId
      trigger(tag.tag_id);
    };

    socket.on('detected_tags', handleDetectedTags);

    return () => {
      socket.off('detected_tags', handleDetectedTags);
    };
  }, [trigger]);

  // Handle query result
  useEffect(() => {
    if (!result.data || !result.isSuccess || pendingTagId === null) return;

    const pkg = result.data;
    const tagId = pendingTagId;
    setPendingTagId(null);

    // Show success notification with package info
    notification.success({
      message: `Quét thành công AprilTag #${tagId}`,
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
  }, [result.data, result.isSuccess, notification, pendingTagId]);

  // Handle query error (tag not found)
  useEffect(() => {
    if (!result.error || !result.isError || pendingTagId === null) return;

    const tagId = pendingTagId;
    setPendingTagId(null);

    notification.warning({
      message: `AprilTag #${tagId} không tìm thấy`,
      description: 'Không có kiện hàng nào được gán với mã tag này.',
      placement: 'topRight',
      duration: 4,
    });
  }, [result.error, result.isError, notification, pendingTagId]);
}
