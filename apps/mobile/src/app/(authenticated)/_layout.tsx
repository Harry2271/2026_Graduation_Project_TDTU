import { Tabs } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useColorScheme } from 'react-native';

import { StoreProvider } from '@/components/store-provider';
import { Colors } from '@/constants/theme';

export default function AuthenticatedLayout() {
  const scheme = useColorScheme();
  const colors = Colors[scheme === 'dark' ? 'dark' : 'light'];

  return (
    <StoreProvider>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
          },
          tabBarLabelStyle: {
            fontFamily: 'monospace',
            fontSize: 10,
            fontWeight: '600',
          },
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: 'Dashboard',
            tabBarIcon: ({ color, size }) => (
              <SymbolView
                name={{ ios: 'square.grid.2x2', android: 'dashboard', web: 'dashboard' }}
                size={size}
                tintColor={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="packages"
          options={{
            title: 'Kiện hàng',
            tabBarIcon: ({ color, size }) => (
              <SymbolView
                name={{ ios: 'shippingbox', android: 'inventory_2', web: 'inventory_2' }}
                size={size}
                tintColor={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: 'Bản đồ',
            tabBarIcon: ({ color, size }) => (
              <SymbolView
                name={{ ios: 'location.viewfinder', android: 'radar', web: 'radar' }}
                size={size}
                tintColor={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="stats"
          options={{
            title: 'Thống kê',
            tabBarIcon: ({ color, size }) => (
              <SymbolView
                name={{ ios: 'chart.bar', android: 'bar_chart', web: 'bar_chart' }}
                size={size}
                tintColor={color}
              />
            ),
          }}
        />
        <Tabs.Screen
          name="account"
          options={{
            title: 'Tài khoản',
            tabBarIcon: ({ color, size }) => (
              <SymbolView
                name={{ ios: 'person.circle', android: 'person', web: 'person' }}
                size={size}
                tintColor={color}
              />
            ),
          }}
        />
      </Tabs>
    </StoreProvider>
  );
}
