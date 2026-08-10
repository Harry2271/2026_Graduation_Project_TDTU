import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, useWindowDimensions, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { MapCanvas } from '@/components/MapCanvas';
import { useTheme } from '@/hooks/use-theme';
import { useRobotWs } from '@/hooks/useRobotWs';
import { useMapStore } from '@/store/useMapStore';

const WS_LABELS: Record<string, string> = {
  idle: 'CHƯA KẾT NỐI',
  connecting: 'ĐANG KẾT NỐI…',
  connected: 'ĐANG TRỰC TUYẾN',
  disconnected: 'MẤT KẾT NỐI',
};

export default function MapScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const { connect, sendCommand } = useRobotWs();
  const wsStatus = useMapStore((s) => s.wsStatus);
  const scanData = useMapStore((s) => s.scanData);
  const pose = useMapStore((s) => s.pose);
  const info = useMapStore((s) => s.info);
  const scanCount = useMapStore((s) => s.scanCount);
  const lastUpdate = useMapStore((s) => s.lastUpdate);
  const [axis, setAxis] = useState(1);
  const [busy, setBusy] = useState(false);

  const canvasSize = Math.min(width - 32, 520);
  const isOnline = wsStatus === 'connected';
  const hasScan = Boolean(scanData?.points.length);
  const lastUpdateLabel = useMemo(() => {
    if (!lastUpdate) return 'Chưa nhận dữ liệu';
    const seconds = Math.max(0, Math.floor((Date.now() - lastUpdate) / 1000));
    return seconds < 2 ? 'Vừa cập nhật' : `${seconds}s trước`;
  }, [lastUpdate, scanCount]);

  const sendMapping = useCallback((command: string) => {
    if (!sendCommand({ type: 'cmd', command })) {
      connect();
      return;
    }
    setBusy(true);
    setTimeout(() => setBusy(false), 900);
  }, [connect, sendCommand]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={wsStatus === 'connecting'} onRefresh={connect} tintColor={theme.primary} />}>
        <View style={styles.header}>
          <View>
            <Text style={[styles.title, { color: theme.text }]}>LIDAR / SLAM</Text>
            <Text style={[styles.subtitle, { color: theme.textMuted }]}>Giám sát bản đồ robot realtime</Text>
          </View>
          <View style={styles.connection}>
            <View style={[styles.statusDot, { backgroundColor: isOnline ? theme.success : theme.danger }]} />
            <Text style={[styles.statusText, { color: isOnline ? theme.success : theme.textMuted }]}>
              {WS_LABELS[wsStatus]}
            </Text>
          </View>
        </View>

        <View style={[styles.statusCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Status label="LIDAR" active={info.lidar || hasScan} theme={theme} />
          <Status label="MAP" active={info.map} theme={theme} />
          <Status label="POSE" active={info.pose || Boolean(pose)} theme={theme} />
          <View style={styles.modeBox}>
            <Text style={[styles.modeLabel, { color: theme.textMuted }]}>MODE</Text>
            <Text style={[styles.modeValue, { color: theme.primary }]}>{info.mode.toUpperCase()}</Text>
          </View>
        </View>

        <View style={[styles.viewerCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={styles.viewerHeader}>
            <Text style={[styles.viewerTitle, { color: theme.text }]}>RADAR SCAN</Text>
            <Text style={[styles.viewerMeta, { color: hasScan ? theme.primary : theme.textMuted }]}>
              {hasScan ? `${scanData?.points.length ?? 0} điểm` : 'Đang chờ scan…'}
            </Text>
          </View>
          <MapCanvas size={canvasSize} lidarAxis={axis} />
          <View style={styles.viewerFooter}>
            <Text style={[styles.footerText, { color: theme.textMuted }]}>±3m · {lastUpdateLabel}</Text>
            <Text style={[styles.footerText, { color: theme.primary }]}>SCAN #{scanCount}</Text>
          </View>
        </View>

        <View style={styles.axisRow}>
          <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>HƯỚNG LIDAR</Text>
          {[{ value: 0, label: '+X' }, { value: 1, label: '+Y' }, { value: 2, label: '-X' }, { value: 3, label: '-Y' }].map((item) => (
            <TouchableOpacity
              key={item.value}
              onPress={() => setAxis(item.value)}
              style={[styles.axisButton, { borderColor: axis === item.value ? theme.primary : theme.border, backgroundColor: axis === item.value ? `${theme.primary}20` : theme.surface }]}>
              <Text style={[styles.axisText, { color: axis === item.value ? theme.primary : theme.textMuted }]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.controls}>
          <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>ĐIỀU KHIỂN BẢN ĐỒ</Text>
          <View style={styles.controlRow}>
            <ActionButton label="BẮT ĐẦU" icon="play_arrow" color={theme.success} disabled={!isOnline || busy || info.mode?.includes?.('mapping') === true} onPress={() => sendMapping('start')} theme={theme} />
            <ActionButton label="DỪNG" icon="stop" color={theme.warning} disabled={!isOnline || busy} onPress={() => sendMapping('stop')} theme={theme} />
            <ActionButton label="XÓA MAP" icon="refresh" color={theme.danger} disabled={!isOnline || busy} onPress={() => sendMapping('reset')} theme={theme} />
          </View>
        </View>

        {!isOnline && (
          <TouchableOpacity style={[styles.retryButton, { borderColor: theme.primary, backgroundColor: `${theme.primary}12` }]} onPress={connect}>
            <Text style={[styles.retryText, { color: theme.primary }]}>↻  THỬ KẾT NỐI LẠI</Text>
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Status({ label, active, theme }: { label: string; active: boolean; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={styles.statusItem}>
      <View style={[styles.statusDotSmall, { backgroundColor: active ? theme.success : theme.textMuted }]} />
      <Text style={[styles.statusItemText, { color: active ? theme.success : theme.textMuted }]}>{label}</Text>
    </View>
  );
}

function ActionButton({ label, icon, color, disabled, onPress, theme }: { label: string; icon: string; color: string; disabled: boolean; onPress: () => void; theme: ReturnType<typeof useTheme> }) {
  return (
    <TouchableOpacity disabled={disabled} onPress={onPress} style={[styles.actionButton, { borderColor: `${color}70`, backgroundColor: `${color}12`, opacity: disabled ? 0.4 : 1 }]}>
      <SymbolView name={{ ios: icon, android: icon, web: icon }} size={16} tintColor={color} />
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  content: { padding: 16, gap: 14, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '900', fontFamily: 'monospace', letterSpacing: 1 },
  subtitle: { fontSize: 11, fontFamily: 'monospace', marginTop: 3 },
  connection: { alignItems: 'flex-end', gap: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 9, fontWeight: '700', fontFamily: 'monospace' },
  statusCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: 1, padding: 12, gap: 18 },
  statusItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  statusDotSmall: { width: 6, height: 6, borderRadius: 3 },
  statusItemText: { fontSize: 9, fontWeight: '700', fontFamily: 'monospace' },
  modeBox: { marginLeft: 'auto', alignItems: 'flex-end' },
  modeLabel: { fontSize: 8, fontFamily: 'monospace' },
  modeValue: { fontSize: 10, fontWeight: '800', fontFamily: 'monospace', marginTop: 2 },
  viewerCard: { borderRadius: 12, borderWidth: 1, padding: 10, alignItems: 'center' },
  viewerHeader: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  viewerTitle: { fontSize: 10, fontWeight: '800', fontFamily: 'monospace', letterSpacing: 1 },
  viewerMeta: { fontSize: 9, fontFamily: 'monospace' },
  viewerFooter: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  footerText: { fontSize: 9, fontFamily: 'monospace' },
  axisRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionLabel: { fontSize: 9, fontWeight: '700', fontFamily: 'monospace', letterSpacing: 1, marginRight: 'auto' },
  axisButton: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 6, borderWidth: 1 },
  axisText: { fontSize: 10, fontWeight: '700', fontFamily: 'monospace' },
  controls: { gap: 9 },
  controlRow: { flexDirection: 'row', gap: 8 },
  actionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 11, borderRadius: 8, borderWidth: 1 },
  actionText: { fontSize: 10, fontWeight: '800', fontFamily: 'monospace' },
  retryButton: { alignItems: 'center', paddingVertical: 12, borderRadius: 9, borderWidth: 1 },
  retryText: { fontSize: 11, fontWeight: '800', fontFamily: 'monospace' },
});
