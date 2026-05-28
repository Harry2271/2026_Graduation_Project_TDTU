import type { Metadata } from 'next';
import { Syne, DM_Sans, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import StoreProvider from './StoreProvider';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import MainLayout from '@/components/MainLayout';
import {ConfigProvider, theme, App} from 'antd'

const syne = Syne({
  subsets: ['latin'],
  variable: '--font-syne',
  weight: ['400', '600', '700', '800'],
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  variable: '--font-dm-sans',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NEXUS Control — Robot Warehouse | Đồ án Tốt nghiệp TDTU',
  description: 'Hệ thống điều khiển robot và giám sát kho hàng tự động — NEXUS Control',
  icons: {
    icon: '/LOGO.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${syne.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased">
        <AntdRegistry>
          <StoreProvider>
            <ConfigProvider
              theme={{
                components: {
                  Notification: {
                    colorTextHeading: 'var(--text-primary)',
                    colorText: 'var(--text-secondary)',
                    colorBgElevated: 'var(--bg-surface)',
                    fontFamily: "'JetBrains Mono', monospace",
                  },
                },
              }}
            >
              <App> 
                <MainLayout>{children}</MainLayout>
              </App>
            </ConfigProvider>
          </StoreProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
