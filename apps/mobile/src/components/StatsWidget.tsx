import { View, Text, StyleSheet } from 'react-native';

import type { PackageStats, ZoneCode } from '@/types/inventory';

const ZONE_COLORS: Record<ZoneCode, string> = {
  S1: '#00d4ff',
  S2: '#00ff88',
  S3: '#ffb800',
  S4: '#a855f7',
};

type Tile = {
  label: string;
  value: number;
  color: string;
  bg: string;
};

type Props = {
  stats: PackageStats | null;
};

export function StatsWidget({ stats }: Props) {
  if (!stats) {
    return (
      <View style={styles.grid}>
        <Text style={styles.placeholder}>Đang tải thống kê...</Text>
      </View>
    );
  }

  const tiles: Tile[] = [
    { label: 'TỔNG', value: stats.total, color: '#00d4ff', bg: 'rgba(0,212,255,0.08)' },
    ...(['S1', 'S2', 'S3', 'S4'] as ZoneCode[]).map((z) => ({
      label: z,
      value: stats.zones[z],
      color: ZONE_COLORS[z],
      bg: `${ZONE_COLORS[z]}15`,
    })),
    { label: 'CHƯA XẾP', value: stats.unplaced, color: '#ffb800', bg: 'rgba(255,184,0,0.08)' },
  ];

  return (
    <View style={styles.grid}>
      {tiles.map((tile) => (
        <View
          key={tile.label}
          style={[styles.card, { backgroundColor: tile.bg, borderColor: `${tile.color}40` }]}>
          <Text style={[styles.value, { color: tile.color }]}>{tile.value}</Text>
          <Text style={styles.label}>{tile.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  card: {
    flexBasis: '31%',
    flexGrow: 1,
    minWidth: 90,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  value: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.5,
    fontFamily: 'monospace',
  },
  label: {
    fontSize: 9,
    fontWeight: '700',
    color: '#888',
    marginTop: 4,
    letterSpacing: 1,
    fontFamily: 'monospace',
  },
  placeholder: {
    color: '#888',
    fontFamily: 'monospace',
    paddingVertical: 16,
  },
});
