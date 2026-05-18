import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
import { PackageItem, MoveCommandPayload, MoveCommandResponse } from '../types/inventory';

// Dữ liệu mock ban đầu trong bộ nhớ
const mockPackagesData: PackageItem[] = [
  {
    id: 'pkg-1',
    code: 'PKG-1001',
    name: 'iPhone 15 Pro Max 256GB',
    sender: 'Apple Distribution VN',
    recipient: 'Công ty TNHH Bán lẻ FPT',
    shelfId: 1,
    cell: 'A1',
    weight: 0.5,
    status: 'stored',
    importedAt: '2026-05-18 08:30',
  },
  {
    id: 'pkg-2',
    code: 'PKG-1002',
    name: 'MacBook Air M3 15-inch',
    sender: 'Apple Distribution VN',
    recipient: 'Công ty TNHH Bán lẻ FPT',
    shelfId: 1,
    cell: 'B2',
    weight: 1.6,
    status: 'stored',
    importedAt: '2026-05-18 09:15',
  },
  {
    id: 'pkg-3',
    code: 'PKG-1003',
    name: 'iPad Pro M4 13-inch',
    sender: 'Apple Distribution VN',
    recipient: 'Nguyễn Văn A',
    shelfId: 1,
    cell: 'C3',
    weight: 0.8,
    status: 'stored',
    importedAt: '2026-05-18 10:00',
  },
  {
    id: 'pkg-4',
    code: 'PKG-1004',
    name: 'AirPods Pro Gen 2 Type-C',
    sender: 'Apple Distribution VN',
    recipient: 'Trần Thị B',
    shelfId: 1,
    cell: 'D1',
    weight: 0.3,
    status: 'stored',
    importedAt: '2026-05-18 10:20',
  },
  {
    id: 'pkg-5',
    code: 'PKG-2001',
    name: 'Màn hình Dell UltraSharp 27" U2723QE',
    sender: 'Synnex FPT',
    recipient: 'Công ty Công nghệ XYZ',
    shelfId: 2,
    cell: 'A2',
    weight: 6.5,
    status: 'stored',
    importedAt: '2026-05-17 14:00',
  },
  {
    id: 'pkg-6',
    code: 'PKG-2002',
    name: 'Bàn phím cơ Keychron Q1 Pro',
    sender: 'Keychron VN',
    recipient: 'Lê Hoàng C',
    shelfId: 2,
    cell: 'B1',
    weight: 1.8,
    status: 'stored',
    importedAt: '2026-05-17 15:30',
  },
  {
    id: 'pkg-7',
    code: 'PKG-2003',
    name: 'Chuột không dây Logitech MX Master 3S',
    sender: 'Logitech VN',
    recipient: 'Phạm Minh D',
    shelfId: 2,
    cell: 'C4',
    weight: 0.4,
    status: 'stored',
    importedAt: '2026-05-17 16:10',
  },
  {
    id: 'pkg-8',
    code: 'PKG-3001',
    name: 'Máy ảnh Sony Alpha A7 IV Body',
    sender: 'Sony Electronics VN',
    recipient: 'Studio Nhiếp ảnh Ánh Sáng',
    shelfId: 3,
    cell: 'B3',
    weight: 0.9,
    status: 'stored',
    importedAt: '2026-05-16 09:00',
  },
  {
    id: 'pkg-9',
    code: 'PKG-3002',
    name: 'Ống kính Sony FE 24-70mm f/2.8 GM II',
    sender: 'Sony Electronics VN',
    recipient: 'Studio Nhiếp ảnh Ánh Sáng',
    shelfId: 3,
    cell: 'C2',
    weight: 0.7,
    status: 'stored',
    importedAt: '2026-05-16 09:30',
  },
  {
    id: 'pkg-10',
    code: 'PKG-3003',
    name: 'Gimbal DJI RS 3 Pro Combo',
    sender: 'DJI VN',
    recipient: 'Hoàng Vũ Media',
    shelfId: 3,
    cell: 'D4',
    weight: 2.1,
    status: 'stored',
    importedAt: '2026-05-16 11:00',
  },
  {
    id: 'pkg-11',
    code: 'PKG-4001',
    name: 'PlayStation 5 Slim 1TB Standard',
    sender: 'Sony Electronics VN',
    recipient: 'GameStore HN',
    shelfId: 4,
    cell: 'A4',
    weight: 4.2,
    status: 'stored',
    importedAt: '2026-05-15 13:20',
  },
  {
    id: 'pkg-12',
    code: 'PKG-4002',
    name: 'Tay cầm không dây DualSense Edge',
    sender: 'Sony Electronics VN',
    recipient: 'GameStore HN',
    shelfId: 4,
    cell: 'B4',
    weight: 0.5,
    status: 'stored',
    importedAt: '2026-05-15 13:45',
  },
  {
    id: 'pkg-13',
    code: 'PKG-4003',
    name: 'Kính thực tế ảo Meta Quest 3 512GB',
    sender: 'VR World VN',
    recipient: 'Vũ Đức E',
    shelfId: 4,
    cell: 'C1',
    weight: 0.8,
    status: 'stored',
    importedAt: '2026-05-15 15:00',
  },
  {
    id: 'pkg-14',
    code: 'PKG-4004',
    name: 'Loa Bluetooth Marshall Stanmore III',
    sender: 'Ashico Audio',
    recipient: 'Quán Cafe Hoa Nắng',
    shelfId: 4,
    cell: 'D2',
    weight: 4.3,
    status: 'stored',
    importedAt: '2026-05-15 16:30',
  },
];

export const apiSlice = createApi({
  reducerPath: 'api',
  baseQuery: fetchBaseQuery({ baseUrl: '/' }),
  tagTypes: ['Packages'],
  endpoints: (builder) => ({
    getPackages: builder.query<PackageItem[], void>({
      queryFn: async () => {
        // Giả lập delay mạng nhẹ 400ms
        await new Promise((resolve) => setTimeout(resolve, 400));
        return { data: [...mockPackagesData] };
      },
      providesTags: ['Packages'],
    }),
    submitMoveCommand: builder.mutation<MoveCommandResponse, MoveCommandPayload>({
      queryFn: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const { from, to } = payload;
        
        // Tìm kiện hàng ở vị trí nguồn
        const pkgIndex = mockPackagesData.findIndex(
          (p) => p.shelfId === from.shelfId && p.cell === from.cell
        );

        if (pkgIndex !== -1) {
          // Nếu ô đích đã có hàng, đổi chỗ hoặc ghi đè (ở đây ta giả sử ô đích trống hoặc ta đổi chỗ)
          const destPkgIndex = mockPackagesData.findIndex(
            (p) => p.shelfId === to.shelfId && p.cell === to.cell
          );
          if (destPkgIndex !== -1) {
            // Đổi chỗ 2 kiện hàng
            mockPackagesData[destPkgIndex].shelfId = from.shelfId;
            mockPackagesData[destPkgIndex].cell = from.cell;
          }

          mockPackagesData[pkgIndex].shelfId = to.shelfId;
          mockPackagesData[pkgIndex].cell = to.cell;
        }

        return { data: { success: true, message: 'Di chuyển thành công!' } };
      },
      invalidatesTags: ['Packages'],
    }),
  }),
});

export const { useGetPackagesQuery, useSubmitMoveCommandMutation } = apiSlice;
