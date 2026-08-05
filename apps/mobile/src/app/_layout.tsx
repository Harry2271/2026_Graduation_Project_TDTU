import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import React, { useEffect } from 'react';
import { ActivityIndicator, useColorScheme, View, StyleSheet } from 'react-native';
import { SymbolView } from 'expo-symbols';

import { useAuthStore } from '@/store/useAuthStore';
import { setTokenGetter } from '@/lib/api';

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const segments = useSegments();
  const restoreSession = useAuthStore((s) => s.restoreSession);
  const isRestoring = useAuthStore((s) => s.isRestoring);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const getToken = useAuthStore((s) => s.getToken);

  useEffect(() => {
    setTokenGetter(getToken);
    void restoreSession();
  }, [restoreSession, getToken]);

  useEffect(() => {
    if (isRestoring) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/' as never);
    }
  }, [isAuthenticated, isRestoring, segments, router]);

  if (isRestoring) {
    return <LoadingScreen />;
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }} />
    </ThemeProvider>
  );
}

function LoadingScreen() {
  return (
    <View style={loadingStyles.container}>
      <View style={loadingStyles.iconBox}>
        <SymbolView
          name={{ ios: 'shippingbox.fill', android: 'inventory_2', web: 'inventory_2' }}
          size={48}
          tintColor="#00D4FF"
        />
      </View>
      <ActivityIndicator size="small" color="#00D4FF" style={{ marginTop: 24 }} />
    </View>
  );
}

const loadingStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080B10',
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconBox: {
    width: 96,
    height: 96,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: '#00D4FF40',
    backgroundColor: '#00D4FF15',
    justifyContent: 'center',
    alignItems: 'center',
  },
});
