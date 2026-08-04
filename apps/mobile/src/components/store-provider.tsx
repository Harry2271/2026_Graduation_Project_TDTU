import { useEffect } from 'react';

import { usePackageStore } from '@/store/usePackageStore';

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const load = usePackageStore((s) => s.load);
  const subscribe = usePackageStore((s) => s.subscribe);

  useEffect(() => {
    void load();
    const unsub = subscribe();
    return unsub;
  }, [load, subscribe]);

  return <>{children}</>;
}
