import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SymbolView } from 'expo-symbols';

import { useAuthStore } from '@/store/useAuthStore';
import { useTheme } from '@/hooks/use-theme';

export default function LoginScreen() {
  const router = useRouter();
  const theme = useTheme();
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) return;
    try {
      await login(email.trim(), password);
    } catch {
      // error handled by store
    }
  };

  const navigateToRegister = () => {
    clearError();
    router.push('/(auth)/register');
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: theme.background }]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View style={[styles.logoBox, { backgroundColor: `${theme.primary}15`, borderColor: `${theme.primary}40` }]}>
              <SymbolView
                name={{ ios: 'shippingbox.fill', android: 'inventory_2', web: 'inventory_2' }}
                size={40}
                tintColor={theme.primary}
              />
            </View>
            <Text style={[styles.brand, { color: theme.text }]}>AGV SMART</Text>
            <Text style={[styles.subtitle, { color: theme.textMuted }]}>
              Hệ thống quản lý kho hàng
            </Text>
          </View>

          <View style={styles.form}>
            {error ? (
              <View style={[styles.errorBox, { backgroundColor: `${theme.danger}15`, borderColor: `${theme.danger}40` }]}>
                <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>
              </View>
            ) : null}

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: theme.textSecondary }]}>EMAIL</Text>
              <TextInput
                value={email}
                onChangeText={(t) => { setEmail(t); clearError(); }}
                placeholder="email@example.com"
                placeholderTextColor={theme.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, {
                  backgroundColor: theme.surfaceAlt,
                  borderColor: theme.border,
                  color: theme.text,
                }]}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={[styles.label, { color: theme.textSecondary }]}>MẬT KHẨU</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  value={password}
                  onChangeText={(t) => { setPassword(t); clearError(); }}
                  placeholder="••••••••"
                  placeholderTextColor={theme.textMuted}
                  secureTextEntry={!showPassword}
                  style={[styles.input, styles.passwordInput, {
                    backgroundColor: theme.surfaceAlt,
                    borderColor: theme.border,
                    color: theme.text,
                  }]}
                />
                <TouchableOpacity
                  onPress={() => setShowPassword((v) => !v)}
                  style={[styles.eyeBtn, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
                  <SymbolView
                    name={showPassword
                      ? { ios: 'eye.slash', android: 'visibility_off', web: 'visibility_off' }
                      : { ios: 'eye', android: 'visibility', web: 'visibility' }}
                    size={18}
                    tintColor={theme.textMuted}
                  />
                </TouchableOpacity>
              </View>
            </View>

            <TouchableOpacity
              style={[styles.loginBtn, { backgroundColor: theme.primary }, isLoading && { opacity: 0.6 }]}
              onPress={() => void handleLogin()}
              disabled={isLoading || !email.trim() || !password.trim()}
              activeOpacity={0.8}>
              {isLoading ? (
                <ActivityIndicator color="#080B10" size="small" />
              ) : (
                <Text style={styles.loginBtnText}>ĐĂNG NHẬP</Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.registerLink}
              onPress={navigateToRegister}
              activeOpacity={0.7}>
              <Text style={[styles.registerLinkText, { color: theme.textSecondary }]}>
                Chưa có tài khoản?{' '}
                <Text style={{ color: theme.primary, fontWeight: '700' }}>Đăng ký</Text>
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 24 },
  header: { alignItems: 'center', marginBottom: 40 },
  logoBox: {
    width: 80,
    height: 80,
    borderRadius: 20,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  brand: {
    fontSize: 24,
    fontWeight: '900',
    fontFamily: 'monospace',
    letterSpacing: 2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'monospace',
    marginTop: 4,
  },
  form: { gap: 16 },
  inputGroup: { gap: 6 },
  label: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 14,
    fontFamily: 'monospace',
    minHeight: 46,
  },
  passwordRow: { flexDirection: 'row', gap: 8 },
  passwordInput: { flex: 1 },
  eyeBtn: {
    width: 46,
    height: 46,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loginBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 8,
    minHeight: 48,
    justifyContent: 'center',
  },
  loginBtnText: {
    color: '#080B10',
    fontSize: 14,
    fontWeight: '800',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  errorBox: {
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  errorText: {
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  registerLink: { alignItems: 'center', paddingVertical: 8 },
  registerLinkText: {
    fontSize: 13,
    fontFamily: 'monospace',
  },
});
