import { Alert, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuthStore } from '@/store/useAuthStore';
import { useTheme } from '@/hooks/use-theme';

export default function AccountScreen() {
  const theme = useTheme();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const handleLogout = () => {
    Alert.alert('Đăng xuất?', 'Bạn sẽ cần đăng nhập lại để sử dụng ứng dụng.', [
      { text: 'Hủy', style: 'cancel' },
      { text: 'Đăng xuất', style: 'destructive', onPress: () => void logout() },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <View style={styles.container}>
        <Text style={[styles.title, { color: theme.text }]}>TÀI KHOẢN</Text>

        {/* User info card */}
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={[styles.avatar, { backgroundColor: `${theme.primary}15`, borderColor: `${theme.primary}40` }]}>
            <SymbolView
              name={{ ios: 'person.fill', android: 'person', web: 'person' }}
              size={32}
              tintColor={theme.primary}
            />
          </View>
          <View style={styles.userInfo}>
            <Text style={[styles.userEmail, { color: theme.text }]}>{user?.email ?? 'Không xác định'}</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: theme.success }]} />
              <Text style={[styles.statusText, { color: theme.success }]}>Đã xác thực</Text>
            </View>
          </View>
        </View>

        {/* App info */}
        <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <InfoRow label="Ứng dụng" value="AGV SMART" theme={theme} />
          <InfoRow label="Phiên bản" value="1.0.0" theme={theme} />
          <InfoRow label="Nền tảng" value="Expo 55" theme={theme} />
        </View>

        {/* Logout button */}
        <TouchableOpacity
          style={[styles.logoutBtn, { borderColor: `${theme.danger}40`, backgroundColor: `${theme.danger}10` }]}
          onPress={handleLogout}
          activeOpacity={0.7}>
          <SymbolView
            name={{ ios: 'rectangle.portrait.and.arrow.right', android: 'logout', web: 'logout' }}
            size={18}
            tintColor={theme.danger}
          />
          <Text style={[styles.logoutText, { color: theme.danger }]}>ĐĂNG XUẤT</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function InfoRow({ label, value, theme }: { label: string; value: string; theme: ReturnType<typeof useTheme> }) {
  return (
    <View style={[styles.infoRow, { borderBottomColor: theme.border }]}>
      <Text style={[styles.infoLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.infoValue, { color: theme.text }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, maxWidth: MaxContentWidth, alignSelf: 'center', width: '100%' },
  container: { padding: Spacing.four, gap: Spacing.three },
  title: { fontSize: 24, fontWeight: '900', fontFamily: 'monospace', letterSpacing: 1.5 },
  card: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 12 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  userInfo: { gap: 6 },
  userEmail: { fontSize: 15, fontWeight: '700', fontFamily: 'monospace' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 12, fontWeight: '600', fontFamily: 'monospace' },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  infoLabel: { fontSize: 13, fontFamily: 'monospace' },
  infoValue: { fontSize: 13, fontWeight: '600', fontFamily: 'monospace' },
  logoutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  logoutText: { fontSize: 13, fontWeight: '800', fontFamily: 'monospace', letterSpacing: 1 },
});
