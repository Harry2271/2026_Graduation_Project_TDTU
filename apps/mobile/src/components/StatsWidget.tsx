import { View, Text, StyleSheet } from 'react-native';

import { useTheme } from '@/hooks/use-theme';
import { ZoneColors } from '@/constants/theme';
import type { PackageStats, ZoneCode } from '@/types/inventory';

type Props = {
  stats: PackageStats | null;
};

export function StatsWidget({ stats }: Props) {
  const theme = useTheme();

  if (!stats) {
    return (
      <View style={[styles.empty, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Text style={[styles.placeholder, { color: theme.textMuted }]}>Đang tải thống kê...</Text>
      </View>
    );
  }

  const tiles = [
    { label: 'TỔNG', value: stats.total, color: theme.primary },
    ...(['S1', 'S2', 'S3', 'S4'] as ZoneCode[]).map((z) => ({
      label: z,
      value: stats.zones[z],
      color: ZoneColors[z],
    })),
    { label: 'CHƯA XẾP', value: stats.unplaced, color: theme.warning },
  ];

  return (
    <View style={styles.grid}>
      {tiles.map((tile) => (
        <View
          key={tile.label}
          style={[styles.card, { backgroundColor: `${tile.color}10`, borderColor: `${tile.color}40` }]}>
          <Text style={[styles.value, { color: tile.color }]}>{tile.value}</Text>
          <Text style={[styles.label, { color: theme.textMuted }]}>{tile.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    flexBasis: '31%',
    flexGrow: 1,
    minWidth: 90,
    minHeight: 76,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: { fontSize: 22, fontWeight: '900', fontFamily: 'monospace' },
  label: { fontSize: 9, fontWeight: '700', marginTop: 4, letterSpacing: 1, fontFamily: 'monospace' },
  empty: { minHeight: 76, borderRadius: 12, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  placeholder: { fontFamily: 'monospace', paddingVertical: 16 },
});
