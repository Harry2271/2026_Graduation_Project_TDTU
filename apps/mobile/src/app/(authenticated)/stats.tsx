import { useMemo } from 'react';
import { ScrollView, View, Text, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { BottomTabInset, MaxContentWidth, ZoneColors, Spacing } from '@/constants/theme';
import { usePackageStore } from '@/store/usePackageStore';
import { useTheme } from '@/hooks/use-theme';
import type { PackageStatus, ZoneCode } from '@/types/inventory';

const ZONE_CODES: ZoneCode[] = ['S1', 'S2', 'S3', 'S4'];

const STATUS_CONFIG: Record<PackageStatus, { label: string; icon: { ios: string; android: string; web: string } }> = {
  CREATED: { label: 'Đã tạo', icon: { ios: 'plus.circle', android: 'add_circle', web: 'add_circle' } },
  IN_PROGRESS: { label: 'Đang xử lý', icon: { ios: 'clock.fill', android: 'schedule', web: 'schedule' } },
  FINISHED: { label: 'Hoàn thành', icon: { ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' } },
};

export default function StatsScreen() {
  const theme = useTheme();
  const packages = usePackageStore((s) => s.packages);
  const stats = usePackageStore((s) => s.stats);
  const isLoading = usePackageStore((s) => s.isLoading);
  const load = usePackageStore((s) => s.load);

  const statusCounts = useMemo(() => {
    const counts: Record<PackageStatus, number> = { CREATED: 0, IN_PROGRESS: 0, FINISHED: 0 };
    packages.forEach((pkg) => { counts[pkg.status]++; });
    return counts;
  }, [packages]);

  const recentPackages = useMemo(() => {
    return [...packages].sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return dateB - dateA;
    }).slice(0, 10);
  }, [packages]);

  const total = stats?.total ?? packages.length;
  const unplaced = stats?.unplaced ?? 0;
  const completionRate = total > 0 ? Math.round((statusCounts.FINISHED / total) * 100) : 0;

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={isLoading} onRefresh={() => void load()} tintColor={theme.primary} />
        }>
        <Text style={[styles.title, { color: theme.text }]}>THỐNG KÊ</Text>

        {/* Summary cards */}
        <View style={styles.summaryGrid}>
          <SummaryCard label="Tổng" value={total} icon={{ ios: 'shippingbox', android: 'inventory_2', web: 'inventory_2' }} color={theme.primary} theme={theme} />
          <SummaryCard label="Đang xử lý" value={statusCounts.IN_PROGRESS} icon={{ ios: 'clock.fill', android: 'schedule', web: 'schedule' }} color={theme.warning} theme={theme} />
          <SummaryCard label="Hoàn thành" value={statusCounts.FINISHED} icon={{ ios: 'checkmark.circle.fill', android: 'check_circle', web: 'check_circle' }} color={theme.success} theme={theme} />
          <SummaryCard label="Chưa xếp" value={unplaced} icon={{ ios: 'exclamationmark.circle', android: 'error', web: 'error' }} color={theme.danger} theme={theme} />
        </View>

        {/* Completion rate */}
        <View style={[styles.rateCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.rateLabel, { color: theme.textMuted }]}>Tỷ lệ hoàn thành</Text>
          <View style={styles.rateRow}>
            <Text style={[styles.rateValue, { color: theme.success }]}>{completionRate}%</Text>
            <View style={[styles.rateBar, { backgroundColor: theme.surfaceAlt }]}>
              <View style={[styles.rateBarFill, { backgroundColor: theme.success, width: `${completionRate}%` }]} />
            </View>
          </View>
        </View>

        {/* Zone breakdown */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>THEO KHU</Text>
          <View style={styles.zoneGrid}>
            {ZONE_CODES.map((z) => {
              const count = stats?.zones[z] ?? 0;
              const zoneTotal = total || 1;
              const pct = Math.round((count / zoneTotal) * 100);
              return (
                <View key={z} style={[styles.zoneCard, { backgroundColor: theme.surface, borderColor: `${ZoneColors[z]}40` }]}>
                  <View style={styles.zoneHeader}>
                    <View style={[styles.zoneDot, { backgroundColor: ZoneColors[z] }]} />
                    <Text style={[styles.zoneName, { color: ZoneColors[z] }]}>{z}</Text>
                  </View>
                  <Text style={[styles.zoneValue, { color: theme.text }]}>{count}</Text>
                  <Text style={[styles.zonePct, { color: theme.textMuted }]}>{pct}%</Text>
                  <View style={[styles.zoneBar, { backgroundColor: theme.surfaceAlt }]}>
                    <View style={[styles.zoneBarFill, { backgroundColor: ZoneColors[z], width: `${pct}%` }]} />
                  </View>
                </View>
              );
            })}
          </View>
        </View>

        {/* Status breakdown */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>THEO TRẠNG THÁI</Text>
          {(Object.entries(statusCounts) as [PackageStatus, number][]).map(([status, count]) => {
            const cfg = STATUS_CONFIG[status];
            const color = status === 'FINISHED' ? theme.success : status === 'IN_PROGRESS' ? theme.warning : theme.primary;
            return (
              <View key={status} style={[styles.statusRow, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                <SymbolView name={cfg.icon as never} size={18} tintColor={color} />
                <Text style={[styles.statusLabel, { color: theme.text }]}>{cfg.label}</Text>
                <Text style={[styles.statusCount, { color }]}>{count}</Text>
              </View>
            );
          })}
        </View>

        {/* Recent activity */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>HOẠT ĐỘNG GẦN ĐÂY</Text>
          {recentPackages.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.textMuted }]}>Chưa có dữ liệu.</Text>
          ) : (
            recentPackages.map((pkg) => {
              const color = pkg.status === 'FINISHED' ? theme.success : pkg.status === 'IN_PROGRESS' ? theme.warning : theme.primary;
              return (
                <View key={pkg._id} style={[styles.activityRow, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                  <View style={styles.activityInfo}>
                    <Text style={[styles.activityName, { color: theme.text }]} numberOfLines={1}>{pkg.packageName}</Text>
                    <Text style={[styles.activityId, { color: theme.textMuted }]}>
                      {pkg.createdAt ? new Date(pkg.createdAt).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </Text>
                  </View>
                  <View style={[styles.activityBadge, { borderColor: color, backgroundColor: `${color}15` }]}>
                    <Text style={[styles.activityBadgeText, { color }]}>
                      {pkg.zoneCode ?? '—'}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function SummaryCard({ label, value, icon, color, theme }: {
  label: string; value: number;
  icon: { ios: string; android: string; web: string };
  color: string; theme: ReturnType<typeof useTheme>;
}) {
  return (
    <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: `${color}30` }]}>
      <SymbolView name={icon as never} size={20} tintColor={color} />
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: theme.textMuted }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, maxWidth: MaxContentWidth, alignSelf: 'center', width: '100%' },
  scrollContent: { padding: Spacing.four, paddingBottom: BottomTabInset + Spacing.four, gap: Spacing.three },
  title: { fontSize: 24, fontWeight: '900', fontFamily: 'monospace', letterSpacing: 1.5 },
  summaryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  summaryCard: {
    flexBasis: '47%',
    flexGrow: 1,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 4,
  },
  summaryValue: { fontSize: 28, fontWeight: '900', fontFamily: 'monospace', letterSpacing: -0.5 },
  summaryLabel: { fontSize: 11, fontWeight: '600', fontFamily: 'monospace', letterSpacing: 0.5 },
  rateCard: { borderRadius: 12, borderWidth: 1, padding: 14, gap: 8 },
  rateLabel: { fontSize: 11, fontWeight: '700', fontFamily: 'monospace', letterSpacing: 1, textTransform: 'uppercase' },
  rateRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rateValue: { fontSize: 20, fontWeight: '900', fontFamily: 'monospace', minWidth: 48 },
  rateBar: { flex: 1, height: 6, borderRadius: 3, overflow: 'hidden' },
  rateBarFill: { height: '100%', borderRadius: 3 },
  section: { gap: 8 },
  sectionLabel: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace', letterSpacing: 1.5, textTransform: 'uppercase' },
  zoneGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  zoneCard: {
    flexBasis: '47%',
    flexGrow: 1,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    gap: 4,
  },
  zoneHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  zoneDot: { width: 6, height: 6, borderRadius: 3 },
  zoneName: { fontSize: 12, fontWeight: '800', fontFamily: 'monospace', letterSpacing: 1 },
  zoneValue: { fontSize: 24, fontWeight: '900', fontFamily: 'monospace' },
  zonePct: { fontSize: 11, fontFamily: 'monospace' },
  zoneBar: { height: 4, borderRadius: 2, overflow: 'hidden', marginTop: 4 },
  zoneBarFill: { height: '100%', borderRadius: 2 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  statusLabel: { flex: 1, fontSize: 13, fontFamily: 'monospace', fontWeight: '600' },
  statusCount: { fontSize: 16, fontWeight: '900', fontFamily: 'monospace' },
  emptyText: { fontSize: 12, fontFamily: 'monospace', paddingVertical: 12 },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 6,
  },
  activityInfo: { flex: 1, marginRight: 8 },
  activityName: { fontSize: 13, fontWeight: '700', fontFamily: 'monospace' },
  activityId: { fontSize: 10, fontFamily: 'monospace', marginTop: 2 },
  activityBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1 },
  activityBadgeText: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
});
