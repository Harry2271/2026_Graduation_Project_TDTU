import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, View, Text, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { StatsWidget } from '@/components/StatsWidget';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { usePackageStore } from '@/store/usePackageStore';
import { useTheme } from '@/hooks/use-theme';

export default function DashboardScreen() {
  const router = useRouter();
  const theme = useTheme();
  const packages = usePackageStore((s) => s.packages);
  const stats = usePackageStore((s) => s.stats);
  const isLoading = usePackageStore((s) => s.isLoading);
  const error = usePackageStore((s) => s.error);
  const load = usePackageStore((s) => s.load);

  const recent = useMemo(() => {
    return packages
      .filter((pkg) => pkg.status !== 'FINISHED')
      .slice(0, 5);
  }, [packages]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={() => void load()}
            tintColor={theme.primary}
          />
        }>
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, { color: theme.text }]}>AGV SMART</Text>
            <Text style={[styles.subtitle, { color: theme.textMuted }]}>
              Dashboard realtime
            </Text>
          </View>
          <View style={[styles.statusDot, { backgroundColor: theme.success }]} />
        </View>

        <Section label="Thống kê" theme={theme}>
          {error ? (
            <View style={[styles.errorBox, { backgroundColor: `${theme.danger}15`, borderColor: `${theme.danger}40` }]}>
              <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>
              <TouchableOpacity style={[styles.retryBtn, { borderColor: theme.primary }]} onPress={() => void load()}>
                <Text style={[styles.retryText, { color: theme.primary }]}>Thử lại</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <StatsWidget stats={stats} />
          )}
        </Section>

        <Section label="Gần đây" theme={theme}>
          {isLoading && packages.length === 0 ? (
            <Text style={[styles.empty, { color: theme.textMuted }]}>Đang tải...</Text>
          ) : recent.length === 0 ? (
            <Text style={[styles.empty, { color: theme.textMuted }]}>Chưa có kiện hàng nào.</Text>
          ) : (
            recent.map((pkg) => (
              <TouchableOpacity
                key={pkg._id}
                style={[styles.recentRow, { backgroundColor: theme.surface, borderColor: theme.border }]}
                onPress={() => router.push(`/packages/${pkg._id}` as never)}
                activeOpacity={0.7}>
                <View style={styles.recentInfo}>
                  <Text style={[styles.recentName, { color: theme.text }]} numberOfLines={1}>{pkg.packageName}</Text>
                  <Text style={[styles.recentId, { color: theme.textMuted }]}>#{pkg._id.slice(-8).toUpperCase()}</Text>
                </View>
                <View style={[styles.recentZone, {
                  borderColor: pkg.zoneCode ? theme.primary : theme.border,
                  backgroundColor: pkg.zoneCode ? `${theme.primary}15` : theme.surfaceAlt,
                }]}>
                  <Text style={[styles.recentZoneText, {
                    color: pkg.zoneCode ? theme.primary : theme.textMuted,
                  }]}>
                    {pkg.zoneCode ?? 'Chưa xếp'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </Section>

        <TouchableOpacity
          style={[styles.viewAllBtn, { borderColor: `${theme.primary}40`, backgroundColor: `${theme.primary}10` }]}
          onPress={() => router.push('/packages' as never)}
          activeOpacity={0.7}>
          <Text style={[styles.viewAllText, { color: theme.primary }]}>Xem tất cả kiện hàng</Text>
          <SymbolView
            name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
            size={14}
            tintColor={theme.primary}
          />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children, theme }: { label: string; children: React.ReactNode; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    width: '100%',
  },
  scrollContent: {
    padding: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.four,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    fontFamily: 'monospace',
    letterSpacing: 1.5,
  },
  subtitle: {
    fontSize: 12,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 6,
  },
  recentInfo: {
    flex: 1,
    marginRight: 8,
  },
  recentName: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  recentId: {
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  recentZone: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
  },
  recentZoneText: {
    fontSize: 10,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  empty: {
    fontFamily: 'monospace',
    fontSize: 12,
    paddingVertical: 12,
  },
  viewAllBtn: {
    marginTop: 4,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  viewAllText: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  errorBox: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  errorText: {
    fontSize: 12,
    fontFamily: 'monospace',
  },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  retryText: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
