'use client';

import Sidebar from '@/components/Sidebar';

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="flex flex-1 ml-[240px] min-h-screen">
        {children}
      </main>
    </div>
  );
}
