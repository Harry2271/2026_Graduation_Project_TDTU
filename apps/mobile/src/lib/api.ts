import type {
  Package,
  PackagePaginatedResponseDto,
  PackageStats,
  ZoneCode,
} from '@/types/inventory';

const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  getPackages: (page = 1, limit = 20) =>
    request<PackagePaginatedResponseDto>(`/packages?page=${page}&limit=${limit}`),

  getStats: () => request<PackageStats>('/packages/stats'),

  createPackage: (packageName: string) =>
    request<Package>('/packages', {
      method: 'POST',
      body: JSON.stringify({ packageName }),
    }),

  assignToZone: (id: string, zoneCode: ZoneCode | null) =>
    request<Package>(`/packages/${id}/zone`, {
      method: 'PATCH',
      body: JSON.stringify({ zoneCode }),
    }),

  patchStatus: (id: string, status: string) =>
    request<Package>(`/packages/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  deletePackage: (id: string) =>
    request<void>(`/packages/${id}`, { method: 'DELETE' }),
};
