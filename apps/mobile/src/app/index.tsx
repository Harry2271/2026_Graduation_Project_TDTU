import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, View, Text, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatsWidget } from '@/components/StatsWidget';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { usePackageStore } from '@/store/usePackageStore';

export default function DashboardScreen() {
  const router = useRouter();
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
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={isLoading}
            onRefresh={() => void load()}
            tintColor="#00d4ff"
          />
        }>
        <View style={styles.header}>
          <Text style={styles.title}>KHO HÀNG</Text>
          <Text style={styles.subtitle}>Dashboard realtime</Text>
        </View>

        <Section label="Thống kê">
          {error ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <TouchableOpacity style={styles.retryBtn} onPress={() => void load()}>
                <Text style={styles.retryText}>Thử lại</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <StatsWidget stats={stats} />
          )}
        </Section>

        <Section label="Gần đây">
          {isLoading && packages.length === 0 ? (
            <ActivityIndicator color="#00d4ff" />
          ) : recent.length === 0 ? (
            <Text style={styles.empty}>Chưa có kiện hàng nào.</Text>
          ) : (
            recent.map((pkg) => (
              <TouchableOpacity
                key={pkg._id}
                style={styles.recentRow}
                onPress={() => router.push(`/packages/${pkg._id}`)}>
                <View style={styles.recentInfo}>
                  <Text style={styles.recentName} numberOfLines={1}>{pkg.packageName}</Text>
                  <Text style={styles.recentId}>#{pkg._id.slice(-8).toUpperCase()}</Text>
                </View>
                <View
                  style={[
                    styles.recentZone,
                    pkg.zoneCode
                      ? { borderColor: '#00d4ff', backgroundColor: '#00d4ff15' }
                      : { borderColor: '#444', backgroundColor: 'rgba(255,255,255,0.04)' },
                  ]}>
                  <Text style={[styles.recentZoneText, pkg.zoneCode ? { color: '#00d4ff' } : { color: '#888' }]}>
                    {pkg.zoneCode ?? 'Chưa xếp'}
                  </Text>
                </View>
              </TouchableOpacity>
            ))
          )}
        </Section>

        <TouchableOpacity style={styles.viewAllBtn} onPress={() => router.push('/packages')}>
          <Text style={styles.viewAllText}>Xem tất cả kiện hàng →</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
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
    marginBottom: 4,
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    color: '#fff',
    fontFamily: 'monospace',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 12,
    color: '#888',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: '#666',
    fontFamily: 'monospace',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0,212,255,0.04)',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
    marginBottom: 6,
  },
  recentInfo: {
    flex: 1,
    marginRight: 8,
  },
  recentName: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
    fontFamily: 'monospace',
  },
  recentId: {
    fontSize: 10,
    color: '#666',
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
    color: '#666',
    fontFamily: 'monospace',
    fontSize: 12,
    paddingVertical: 12,
  },
  viewAllBtn: {
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#00d4ff40',
    backgroundColor: '#00d4ff10',
    alignItems: 'center',
  },
  viewAllText: {
    color: '#00d4ff',
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  errorBox: {
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#ff888840',
    backgroundColor: '#ff444415',
    gap: 8,
  },
  errorText: {
    color: '#ff8888',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  retryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#00d4ff',
  },
  retryText: {
    color: '#00d4ff',
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
});
