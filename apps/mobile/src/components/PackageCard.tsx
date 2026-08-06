import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';

import { ZonePicker } from '@/components/ZonePicker';
import { useTheme } from '@/hooks/use-theme';
import type { Package, ZoneCode } from '@/types/inventory';
import { ZoneColors } from '@/constants/theme';

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
  const theme = useTheme();
  const isFinished = pkg.status === 'FINISHED';
  const statusColor = isFinished ? theme.success : pkg.status === 'IN_PROGRESS' ? theme.warning : theme.primary;

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
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>{pkg.packageName}</Text>
          <View style={[styles.statusBadge, { borderColor: statusColor, backgroundColor: `${statusColor}15` }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{STATUS_LABELS[pkg.status]}</Text>
          </View>
        </View>
        <Text style={[styles.id, { color: theme.textMuted }]}>#{pkg._id.slice(-8).toUpperCase()}</Text>
      </View>

      <View style={styles.metaRow}>
        {pkg.zoneCode ? (
          <View style={[styles.zoneBadge, { borderColor: ZoneColors[pkg.zoneCode], backgroundColor: `${ZoneColors[pkg.zoneCode]}15` }]}>
            <Text style={[styles.zoneText, { color: ZoneColors[pkg.zoneCode] }]}>{pkg.zoneCode}</Text>
          </View>
        ) : (
          <View style={[styles.pendingBadge, { borderColor: theme.border, backgroundColor: theme.surfaceAlt }]}>
            <Text style={[styles.pendingText, { color: theme.textMuted }]}>Chưa xếp</Text>
          </View>
        )}
        {pkg.createdAt && (
          <Text style={[styles.date, { color: theme.textMuted }]}>
            {new Date(pkg.createdAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>

      {!isFinished && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, { borderColor: `${theme.primary}40`, backgroundColor: `${theme.primary}15` }]}
            onPress={() => setPickerOpen((open) => !open)}
            activeOpacity={0.7}>
            <Text style={[styles.btnZoneText, { color: theme.primary }]}>{pickerOpen ? 'Đóng' : pkg.zoneCode ? 'Chuyển khu' : 'Đưa vào khu'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { borderColor: `${theme.success}40`, backgroundColor: `${theme.success}15` }]}
            onPress={handleFinish}
            activeOpacity={0.7}>
            <Text style={[styles.btnFinishText, { color: theme.success }]}>Hoàn tất</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, { borderColor: `${theme.danger}40`, backgroundColor: `${theme.danger}15` }]}
            onPress={handleDelete}
            activeOpacity={0.7}>
            <Text style={[styles.btnDeleteText, { color: theme.danger }]}>Xóa</Text>
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
  card: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 10 },
  header: { marginBottom: 8 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 15, fontWeight: '700', fontFamily: 'monospace' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  statusText: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  id: { fontSize: 10, fontFamily: 'monospace', marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  zoneBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  zoneText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  pendingBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1 },
  pendingText: { fontSize: 11, fontStyle: 'italic', fontFamily: 'monospace' },
  date: { fontSize: 11, fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, minHeight: 32, justifyContent: 'center' },
  btnZoneText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  btnFinishText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
  btnDeleteText: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace' },
});
