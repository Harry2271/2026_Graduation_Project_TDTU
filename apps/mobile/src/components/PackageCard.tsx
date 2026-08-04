import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';

import { ZonePicker } from '@/components/ZonePicker';
import type { Package, ZoneCode } from '@/types/inventory';

const ZONE_COLORS: Record<ZoneCode, string> = {
  S1: '#00d4ff',
  S2: '#00ff88',
  S3: '#ffb800',
  S4: '#a855f7',
};

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Đã tạo',
  IN_PROGRESS: 'Đang xử lý',
  FINISHED: 'Hoàn thành',
};

type Props = {
  pkg: Package;
  onPress?: () => void;
  onAssignZone: (zoneCode: ZoneCode | null) => Promise<void>;
  onFinish: () => Promise<void>;
  onDelete: () => Promise<void>;
};

export function PackageCard({ pkg, onPress, onAssignZone, onFinish, onDelete }: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const isFinished = pkg.status === 'FINISHED';
  const statusColor = isFinished ? '#00ff88' : pkg.status === 'IN_PROGRESS' ? '#ffb800' : '#00d4ff';

  const handleDelete = () => {
    Alert.alert('Xóa kiện hàng?', 'Thao tác này không thể hoàn tác.', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: () => void onDelete() },
    ]);
  };

  const handleFinish = () => {
    Alert.alert('Hoàn tất kiện hàng?', `${pkg.packageName} sẽ chuyển sang trạng thái hoàn thành.`, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Hoàn tất', onPress: () => void onFinish() },
    ]);
  };

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.name} numberOfLines={1}>{pkg.packageName}</Text>
          <View style={[styles.statusBadge, { borderColor: statusColor, backgroundColor: `${statusColor}15` }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{STATUS_LABELS[pkg.status]}</Text>
          </View>
        </View>
        <Text style={styles.id}>#{pkg._id.slice(-8).toUpperCase()}</Text>
      </View>

      <View style={styles.metaRow}>
        {pkg.zoneCode ? (
          <View
            style={[
              styles.zoneBadge,
              { borderColor: ZONE_COLORS[pkg.zoneCode], backgroundColor: `${ZONE_COLORS[pkg.zoneCode]}15` },
            ]}>
            <Text style={[styles.zoneText, { color: ZONE_COLORS[pkg.zoneCode] }]}>{pkg.zoneCode}</Text>
          </View>
        ) : (
          <View style={styles.pendingBadge}>
            <Text style={styles.pendingText}>Chưa xếp</Text>
          </View>
        )}
        {pkg.createdAt && (
          <Text style={styles.date}>
            {new Date(pkg.createdAt).toLocaleDateString('vi-VN', {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        )}
      </View>

      {!isFinished && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.btnZone]}
            onPress={() => setPickerOpen((open) => !open)}>
            <Text style={styles.btnZoneText}>{pickerOpen ? 'Đóng' : pkg.zoneCode ? 'Chuyển khu' : 'Đưa vào khu'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnFinish]} onPress={handleFinish}>
            <Text style={styles.btnFinishText}>Hoàn tất</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, styles.btnDelete]} onPress={handleDelete}>
            <Text style={styles.btnDeleteText}>Xóa</Text>
          </TouchableOpacity>
        </View>
      )}

      {pickerOpen && (
        <ZonePicker
          currentZone={pkg.zoneCode}
          onSelect={async (zone) => {
            await onAssignZone(zone);
            setPickerOpen(false);
          }}
        />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: 'rgba(0,212,255,0.04)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 14,
    marginBottom: 10,
  },
  header: {
    marginBottom: 8,
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
    fontFamily: 'monospace',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  id: {
    fontSize: 10,
    color: '#666',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  zoneBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  zoneText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  pendingBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#444',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  pendingText: {
    fontSize: 11,
    color: '#888',
    fontStyle: 'italic',
    fontFamily: 'monospace',
  },
  date: {
    fontSize: 11,
    color: '#888',
    fontFamily: 'monospace',
  },
  actions: {
    flexDirection: 'row',
    gap: 6,
    flexWrap: 'wrap',
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  btnZone: {
    borderColor: '#00d4ff40',
    backgroundColor: '#00d4ff15',
  },
  btnZoneText: {
    color: '#00d4ff',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  btnFinish: {
    borderColor: '#00ff8840',
    backgroundColor: '#00ff8815',
  },
  btnFinishText: {
    color: '#00ff88',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  btnDelete: {
    borderColor: '#ff444440',
    backgroundColor: '#ff444415',
  },
  btnDeleteText: {
    color: '#ff8888',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
