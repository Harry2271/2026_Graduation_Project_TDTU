import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

import type { ZoneCode } from '@/types/inventory';

const ZONE_CODES: ZoneCode[] = ['S1', 'S2', 'S3', 'S4'];

const ZONE_COLORS: Record<ZoneCode, string> = {
  S1: '#00d4ff',
  S2: '#00ff88',
  S3: '#ffb800',
  S4: '#a855f7',
};

type Props = {
  currentZone: ZoneCode | null;
  onSelect: (zoneCode: ZoneCode | null) => void | Promise<void>;
};

export function ZonePicker({ currentZone, onSelect }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.header}>Chọn khu tập kết</Text>
      <View style={styles.grid}>
        {ZONE_CODES.map((z) => {
          const active = currentZone === z;
          const color = ZONE_COLORS[z];
          return (
            <TouchableOpacity
              key={z}
              onPress={() => void onSelect(z)}
              disabled={active}
              activeOpacity={0.7}
              style={[
                styles.zoneButton,
                {
                  borderColor: active ? color : '#444',
                  backgroundColor: active ? `${color}25` : 'rgba(255,255,255,0.05)',
                  shadowColor: active ? color : 'transparent',
                  shadowOpacity: active ? 0.3 : 0,
                  shadowRadius: active ? 8 : 0,
                },
              ]}>
              <Text style={[styles.zoneLabel, { color: active ? color : '#aaa' }]}>{z}</Text>
              {active && <Text style={[styles.zoneActive, { color }]}>Hiện tại</Text>}
            </TouchableOpacity>
          );
        })}
      </View>

      {currentZone && (
        <TouchableOpacity
          style={styles.unplaceBtn}
          onPress={() => void onSelect(null)}
          activeOpacity={0.7}>
          <Text style={styles.unplaceText}>Bỏ xếp</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.08)',
  },
  header: {
    fontSize: 10,
    fontWeight: '700',
    color: '#888',
    fontFamily: 'monospace',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  grid: {
    flexDirection: 'row',
    gap: 8,
  },
  zoneButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoneLabel: {
    fontSize: 16,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  zoneActive: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
    marginTop: 2,
    opacity: 0.8,
  },
  unplaceBtn: {
    marginTop: 8,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#444',
    alignItems: 'center',
  },
  unplaceText: {
    color: '#888',
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
});
