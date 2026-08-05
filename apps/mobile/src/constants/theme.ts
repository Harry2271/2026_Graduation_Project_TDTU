import '@/global.css';

import { Platform } from 'react-native';

export type ThemeColors = {
  text: string;
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderHover: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  purple: string;
};

export const Colors = {
  dark: {
    text: '#E8ECF4',
    background: '#080B10',
    surface: '#12161E',
    surfaceAlt: '#1A1F2A',
    border: '#2A3040',
    borderHover: '#3A4050',
    textSecondary: '#8890A0',
    textMuted: '#5A6270',
    primary: '#00D4FF',
    success: '#00FF88',
    warning: '#FFB800',
    danger: '#FF4D5A',
    purple: '#A855F7',
  } satisfies ThemeColors,
  light: {
    text: '#1A1F2A',
    background: '#F5F6F8',
    surface: '#FFFFFF',
    surfaceAlt: '#F0F1F3',
    border: '#D4D8E0',
    borderHover: '#B8BCC4',
    textSecondary: '#6A7080',
    textMuted: '#9CA0AA',
    primary: '#0090CC',
    success: '#00B060',
    warning: '#D09000',
    danger: '#E03040',
    purple: '#8030D0',
  } satisfies ThemeColors,
} as const;

export type ThemeColor = keyof ThemeColors;

export const ZoneColors = {
  S1: '#00D4FF',
  S2: '#00FF88',
  S3: '#FFB800',
  S4: '#A855F7',
} as const;

export const Fonts = Platform.select({
  ios: {
    sans: 'system-ui',
    serif: 'ui-serif',
    rounded: 'ui-rounded',
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: 'var(--font-display)',
    serif: 'var(--font-serif)',
    rounded: 'var(--font-rounded)',
    mono: 'var(--font-mono)',
  },
});

export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

export const BottomTabInset = Platform.select({ ios: 50, android: 80 }) ?? 0;
export const MaxContentWidth = 800;
