import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import StoreProvider from './StoreProvider';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import MainLayout from '@/components/MainLayout';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Robot Warehouse Control — Đồ án tốt nghiệp | Tôn Đức Thắng University',
  description: 'Hệ thống điều khiển robot và quản lý kho hàng tự động — Đồ án tốt nghiệp Tôn Đức Thắng University',
  icons: {
    icon: '/LOGO.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className={`${inter.className} antialiased`}>
        <AntdRegistry>
          <StoreProvider>
            <MainLayout>{children}</MainLayout>
          </StoreProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
