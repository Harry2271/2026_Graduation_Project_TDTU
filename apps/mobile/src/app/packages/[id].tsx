import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ZonePicker } from '@/components/ZonePicker';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { usePackageStore } from '@/store/usePackageStore';

const ZONE_COLORS: Record<string, string> = {
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

export default function PackageDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const packages = usePackageStore((s) => s.packages);
  const load = usePackageStore((s) => s.load);
  const assign = usePackageStore((s) => s.assign);
  const finish = usePackageStore((s) => s.finish);
  const remove = usePackageStore((s) => s.remove);

  const pkg = packages.find((p) => p._id === id);
  const [showPicker, setShowPicker] = useState(false);

  useEffect(() => {
    if (!pkg) void load();
  }, [pkg, load]);

  if (!pkg) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Đang tải kiện hàng...</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isFinished = pkg.status === 'FINISHED';
  const statusColor = isFinished ? '#00ff88' : pkg.status === 'IN_PROGRESS' ? '#ffb800' : '#00d4ff';
  const zoneColor = pkg.zoneCode ? ZONE_COLORS[pkg.zoneCode] : null;

  const handleFinish = () => {
    Alert.alert('Hoàn tất kiện hàng?', `${pkg.packageName} sẽ chuyển sang trạng thái hoàn thành.`, [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Hoàn tất', onPress: () => void finish(pkg._id) },
    ]);
  };

  const handleDelete = () => {
    Alert.alert('Xóa kiện hàng?', 'Thao tác này không thể hoàn tác.', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Xóa', style: 'destructive', onPress: async () => {
        await remove(pkg._id);
        router.back();
      } },
    ]);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.heroRow}>
          <View style={styles.iconWrap}>
            <View style={styles.iconBox}>
              <Text style={styles.iconText}>📦</Text>
            </View>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title} numberOfLines={2}>{pkg.packageName}</Text>
            <Text style={styles.id}>#{pkg._id.slice(-12).toUpperCase()}</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          <View style={[styles.statusBadge, { borderColor: statusColor, backgroundColor: `${statusColor}15` }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>TRẠNG THÁI: {STATUS_LABELS[pkg.status]}</Text>
          </View>
        </View>

        <InfoCard label="Khu tập kết">
          {zoneColor ? (
            <View style={[styles.zoneBadge, { borderColor: zoneColor, backgroundColor: `${zoneColor}15` }]}>
              <Text style={[styles.zoneBadgeText, { color: zoneColor }]}>{pkg.zoneCode}</Text>
            </View>
          ) : (
            <Text style={styles.muted}>Chưa xếp</Text>
          )}
        </InfoCard>

        <InfoCard label="Mã AprilTag">
          {pkg.tagId !== null && pkg.tagId !== undefined ? (
            <Text style={styles.tagId}>#{pkg.tagId}</Text>
          ) : (
            <Text style={styles.muted}>—</Text>
          )}
        </InfoCard>

        {pkg.createdAt && (
          <InfoCard label="Ngày tạo">
            <Text style={styles.normalText}>
              {new Date(pkg.createdAt).toLocaleString('vi-VN', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          </InfoCard>
        )}

        {!isFinished && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary]}
              onPress={() => setShowPicker((v) => !v)}>
              <Text style={styles.btnPrimaryText}>{showPicker ? 'Đóng' : pkg.zoneCode ? 'Chuyển khu' : 'Đưa vào khu'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnFinish]} onPress={handleFinish}>
              <Text style={styles.btnFinishText}>Hoàn tất</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.btn, styles.btnDelete]} onPress={handleDelete}>
              <Text style={styles.btnDeleteText}>Xóa</Text>
            </TouchableOpacity>
          </View>
        )}

        {showPicker && !isFinished && (
          <ZonePicker
            currentZone={pkg.zoneCode}
            onSelect={async (zone) => {
              await assign(pkg._id, zone);
              setShowPicker(false);
            }}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function InfoCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.infoCard}>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={styles.infoValue}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, maxWidth: MaxContentWidth, alignSelf: 'center', width: '100%' },
  scrollContent: { padding: Spacing.four, paddingBottom: BottomTabInset + Spacing.four, gap: 12 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { color: '#888', fontFamily: 'monospace' },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 4,
  },
  iconWrap: { width: 56, height: 56, borderRadius: 14, backgroundColor: '#00d4ff15', borderWidth: 1, borderColor: '#00d4ff40', justifyContent: 'center', alignItems: 'center' },
  iconBox: { width: 32, height: 32, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
  iconText: { fontSize: 18 },
  title: { fontSize: 22, fontWeight: '900', color: '#fff', fontFamily: 'monospace', letterSpacing: -0.5 },
  id: { fontSize: 11, color: '#666', fontFamily: 'monospace', marginTop: 4 },
  statusRow: { flexDirection: 'row' },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusText: { fontSize: 12, fontWeight: '700', fontFamily: 'monospace' },
  infoCard: {
    backgroundColor: 'rgba(0,212,255,0.04)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  infoLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#888',
    fontFamily: 'monospace',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  infoValue: { flexDirection: 'row', alignItems: 'center' },
  zoneBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
  },
  zoneBadgeText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  muted: { color: '#666', fontStyle: 'italic', fontFamily: 'monospace', fontSize: 13 },
  normalText: { color: '#fff', fontSize: 13, fontFamily: 'monospace' },
  tagId: { color: '#00d4ff', fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, borderWidth: 1, minWidth: 100, alignItems: 'center' },
  btnPrimary: { borderColor: '#00d4ff', backgroundColor: '#00d4ff15' },
  btnPrimaryText: { color: '#00d4ff', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  btnFinish: { borderColor: '#00ff88', backgroundColor: '#00ff8815' },
  btnFinishText: { color: '#00ff88', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  btnDelete: { borderColor: '#ff4444', backgroundColor: '#ff444415' },
  btnDeleteText: { color: '#ff8888', fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
});
