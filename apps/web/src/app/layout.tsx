import type { Metadata } from "next";
import { Syne, DM_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import StoreProvider from "./StoreProvider";
import { AntdRegistry } from "@ant-design/nextjs-registry";
import MainLayout from "@/components/MainLayout";
import { ConfigProvider, theme, App } from "antd";

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-syne",
  weight: ["400", "600", "700", "800"],
  display: "swap",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "NEXUS Control — Robot Warehouse | Đồ án Tốt nghiệp TDTU",
  description:
    "Hệ thống điều khiển robot và giám sát kho hàng tự động — NEXUS Control",
  icons: {
    icon: "/LOGO.png",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="vi"
      className={`${syne.variable} ${dmSans.variable} ${jetbrainsMono.variable}`}
    >
      <body className="antialiased">
        <AntdRegistry>
          <StoreProvider>
            <ConfigProvider
              theme={{
                algorithm: theme.darkAlgorithm,
                token: {
                  colorPrimary: "#00d4ff",
                  colorInfo: "#00d4ff",
                  colorSuccess: "#00ff88",
                  colorWarning: "#ffb800",
                  colorError: "#ff3b5c",
                  colorBgBase: "#080b10",
                  colorBgContainer: "#111827",
                  colorBgElevated: "#1a2035",
                  colorFillAlter: "#0c0f14",
                  colorBorder: "rgba(255,255,255,0.09)",
                  colorBorderSecondary: "rgba(255,255,255,0.05)",
                  colorText: "#8b97a8",
                  colorTextHeading: "#e8ecf0",
                  colorTextSecondary: "#4a5568",
                  borderRadius: 8,
                  fontFamily: "var(--font-jetbrains)",
                },
                components: {
                  Notification: {
                    colorTextHeading: "var(--text-primary)",
                    colorText: "var(--text-secondary)",
                    colorBgElevated: "var(--bg-surface)",
                    fontFamily: "'JetBrains Mono', monospace",
                  },
                  Modal: {
                    // Token riêng cho Modal để chắc cú
                    titleColor: "var(--text-primary)",
                    contentBg: "var(--bg-surface)",
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
