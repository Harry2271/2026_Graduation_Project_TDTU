import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import StoreProvider from './StoreProvider';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import MainLayout from '@/components/MainLayout';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Robot Control — Warehouse System',
  description: 'Hệ thống điều khiển tay robot và quản lý kho hàng',
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
