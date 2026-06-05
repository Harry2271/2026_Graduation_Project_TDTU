'use client';

import { useSyncExternalStore } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

const TABLET_MIN = 768;
const DESKTOP_MIN = 1024;

function getBreakpoint(width: number): Breakpoint {
  if (width >= DESKTOP_MIN) return 'desktop';
  if (width >= TABLET_MIN) return 'tablet';
  return 'mobile';
}

const subscribe = (callback: () => void) => {
  window.addEventListener('resize', callback, { passive: true });
  return () => window.removeEventListener('resize', callback);
};

const getSnapshot = () => window.innerWidth;
const getServerSnapshot = () => DESKTOP_MIN;

export function useBreakpoint(): {
  breakpoint: Breakpoint;
  isMobile: boolean;
  isTablet: boolean;
  isDesktop: boolean;
} {
  const width = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const breakpoint = getBreakpoint(width);
  return {
    breakpoint,
    isMobile: breakpoint === 'mobile',
    isTablet: breakpoint === 'tablet',
    isDesktop: breakpoint === 'desktop',
  };
}