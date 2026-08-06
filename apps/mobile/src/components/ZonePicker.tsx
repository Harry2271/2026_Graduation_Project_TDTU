import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

import { ZoneColors } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { ZoneCode } from '@/types/inventory';

const ZONE_CODES: ZoneCode[] = ['S1', 'S2', 'S3', 'S4'];

type Props = {
  currentZone: ZoneCode | null;
  onSelect: (zoneCode: ZoneCode | null) => void | Promise<void>;
};

export function ZonePicker({ currentZone, onSelect }: Props) {
  const theme = useTheme();

  return (
    <View style={[styles.container, { borderTopColor: theme.border }]}>
      <Text style={[styles.header, { color: theme.textMuted }]}>Chọn khu tập kết</Text>
      <View style={styles.grid}>
        {ZONE_CODES.map((z) => {
          const active = currentZone === z;
          const color = ZoneColors[z];
          return (
            <TouchableOpacity
              key={z}
              onPress={() => void onSelect(z)}
              disabled={active}
              activeOpacity={0.7}
              style={[
                styles.zoneButton,
                {
                  borderColor: active ? color : theme.border,
                  backgroundColor: active ? `${color}25` : theme.surfaceAlt,
                },
              ]}>
              <Text style={[styles.zoneLabel, { color: active ? color : theme.textSecondary }]}>{z}</Text>
              {active && <Text style={[styles.zoneActive, { color }]}>Hiện tại</Text>}
            </TouchableOpacity>
          );
        })}
      </View>

      {currentZone && (
        <TouchableOpacity
          style={[styles.unplaceBtn, { borderColor: theme.border }]}
          onPress={() => void onSelect(null)}
          activeOpacity={0.7}>
          <Text style={[styles.unplaceText, { color: theme.textSecondary }]}>Bỏ xếp</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 10, paddingTop: 12, borderTopWidth: 1 },
  header: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 },
  grid: { flexDirection: 'row', gap: 8 },
  zoneButton: { flex: 1, minHeight: 56, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  zoneLabel: { fontSize: 16, fontWeight: '800', fontFamily: 'monospace' },
  zoneActive: { fontSize: 9, fontWeight: '700', fontFamily: 'monospace', marginTop: 2, opacity: 0.8 },
  unplaceBtn: { marginTop: 8, minHeight: 44, paddingVertical: 10, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  unplaceText: { fontSize: 11, fontWeight: '600', fontFamily: 'monospace' },
});
