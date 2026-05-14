import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import StoreProvider from './StoreProvider';
import { AntdRegistry } from '@ant-design/nextjs-registry';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Next.js RTK Query App',
  description: 'A Next.js application using RTK Query and Ant Design',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased`}>
        <AntdRegistry>
          <StoreProvider>
            {children}
          </StoreProvider>
        </AntdRegistry>
      </body>
    </html>
  );
}
