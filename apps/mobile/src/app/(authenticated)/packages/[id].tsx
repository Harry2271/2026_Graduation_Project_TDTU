import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, View, Text, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { ZonePicker } from '@/components/ZonePicker';
import { BottomTabInset, MaxContentWidth, ZoneColors, Spacing } from '@/constants/theme';
import { usePackageStore } from '@/store/usePackageStore';
import { useTheme } from '@/hooks/use-theme';
import type { ZoneCode } from '@/types/inventory';

const STATUS_LABELS: Record<string, string> = {
  CREATED: 'Đã tạo',
  IN_PROGRESS: 'Đang xử lý',
  FINISHED: 'Hoàn thành',
};

export default function PackageDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const theme = useTheme();
  const packages = usePackageStore((s) => s.packages);
  const load = usePackageStore((s) => s.load);
  const assign = usePackageStore((s) => s.assign);
  const finish = usePackageStore((s) => s.finish);
  const remove = usePackageStore((s) => s.remove);

  const pkg = packages.find((p) => p._id === id);
  const [showPicker, setShowPicker] = useState(false);
  const loadingAttempted = useRef(false);

  useEffect(() => {
    if (!pkg && !loadingAttempted.current) {
      loadingAttempted.current = true;
      void load();
    }
  }, [pkg, load]);

  if (!pkg) {
    if (!loadingAttempted.current) {
      return (
        <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>Đang tải kiện hàng...</Text>
          </View>
        </SafeAreaView>
      );
    }
    return (
      <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: theme.textMuted }]}>Không tìm thấy kiện hàng.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const isFinished = pkg.status === 'FINISHED';
  const statusColor = isFinished ? theme.success : pkg.status === 'IN_PROGRESS' ? theme.warning : theme.primary;
  const zoneColor = pkg.zoneCode ? ZoneColors[pkg.zoneCode] : null;

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
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.heroRow}>
          <View style={[styles.iconWrap, { backgroundColor: `${theme.primary}15`, borderColor: `${theme.primary}40` }]}>
            <SymbolView
              name={{ ios: 'shippingbox.fill', android: 'inventory_2', web: 'inventory_2' }}
              size={24}
              tintColor={theme.primary}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>{pkg.packageName}</Text>
            <Text style={[styles.id, { color: theme.textMuted }]}>#{pkg._id.slice(-12).toUpperCase()}</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          <View style={[styles.statusBadge, { borderColor: statusColor, backgroundColor: `${statusColor}15` }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>TRẠNG THÁI: {STATUS_LABELS[pkg.status]}</Text>
          </View>
        </View>

        <InfoCard label="Khu tập kết" theme={theme}>
          {zoneColor ? (
            <View style={[styles.zoneBadge, { borderColor: zoneColor, backgroundColor: `${zoneColor}15` }]}>
              <Text style={[styles.zoneBadgeText, { color: zoneColor }]}>{pkg.zoneCode}</Text>
            </View>
          ) : (
            <Text style={[styles.muted, { color: theme.textMuted }]}>Chưa xếp</Text>
          )}
        </InfoCard>

        <InfoCard label="Mã AprilTag" theme={theme}>
          {pkg.tagId !== null && pkg.tagId !== undefined ? (
            <Text style={[styles.tagId, { color: theme.primary }]}>#{pkg.tagId}</Text>
          ) : (
            <Text style={[styles.muted, { color: theme.textMuted }]}>—</Text>
          )}
        </InfoCard>

        {pkg.createdAt && (
          <InfoCard label="Ngày tạo" theme={theme}>
            <Text style={[styles.normalText, { color: theme.text }]}>
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
              style={[styles.btn, { borderColor: theme.primary, backgroundColor: `${theme.primary}15` }]}
              onPress={() => setShowPicker((v) => !v)}
              activeOpacity={0.7}>
              <Text style={[styles.btnText, { color: theme.primary }]}>{showPicker ? 'Đóng' : pkg.zoneCode ? 'Chuyển khu' : 'Đưa vào khu'}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { borderColor: theme.success, backgroundColor: `${theme.success}15` }]}
              onPress={handleFinish}
              activeOpacity={0.7}>
              <Text style={[styles.btnText, { color: theme.success }]}>Hoàn tất</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { borderColor: theme.danger, backgroundColor: `${theme.danger}15` }]}
              onPress={handleDelete}
              activeOpacity={0.7}>
              <Text style={[styles.btnText, { color: theme.danger }]}>Xóa</Text>
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

function InfoCard({ label, children, theme }: { label: string; children: React.ReactNode; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={[styles.infoCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Text style={[styles.infoLabel, { color: theme.textMuted }]}>{label}</Text>
      <View style={styles.infoValue}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, maxWidth: MaxContentWidth, alignSelf: 'center', width: '100%' },
  scrollContent: { padding: Spacing.four, paddingBottom: BottomTabInset + Spacing.four, gap: 12 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontFamily: 'monospace' },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 4,
  },
  iconWrap: { width: 56, height: 56, borderRadius: 14, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '900', fontFamily: 'monospace', letterSpacing: -0.5 },
  id: { fontSize: 11, fontFamily: 'monospace', marginTop: 4 },
  statusRow: { flexDirection: 'row' },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  statusText: { fontSize: 12, fontWeight: '700', fontFamily: 'monospace' },
  infoCard: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  infoLabel: {
    fontSize: 10,
    fontWeight: '700',
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
  zoneBadgeText: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  muted: { fontStyle: 'italic', fontFamily: 'monospace', fontSize: 13 },
  normalText: { fontSize: 13, fontFamily: 'monospace' },
  tagId: { fontSize: 14, fontWeight: '700', fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
  btn: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 10, borderWidth: 1, minWidth: 100, alignItems: 'center' },
  btnText: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
});
