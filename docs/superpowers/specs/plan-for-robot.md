# Future Plan: Chuyển Robot từ Slot sang Zone

**Status:** Planning only — không triển khai trong Phase 1.
**Created:** 2026-08-03
**Related:** `docs/superpowers/specs/2026-08-03-zone-inventory-design.md`

## Mục tiêu

Cho phép backend giao nhiệm vụ vận chuyển theo 4 khu tập kết (`S1`–`S4`) thay vì ô cụ thể (`S1A1`–`S4D4`), trong khi robot vẫn có thể chọn một vị trí vật lý cụ thể để tiếp cận. Việc này cần thiết kế và kiểm thử riêng vì ảnh hưởng trực tiếp tới điều hướng robot.

## Ranh giới an toàn

- Không triển khai cùng Phase 1.
- Không thay đổi firmware/ESP32 protocol cho đến khi có thiết kế giao thức được phê duyệt.
- Không thay đổi camera stream.
- Không xóa `ShelfSlot`, tọa độ SLAM, hoặc AprilTag vật lý trước khi có chiến lược chuyển đổi và rollback.
- Mọi thay đổi robot phải có test mô phỏng, dry-run trên robot, và kế hoạch khôi phục.

## Các thành phần cần khảo sát và thay đổi

### 1. Backend Job model/API

Các file dự kiến:

- `apps/api/src/modules/job/job.schema.ts`
- `apps/api/src/modules/job/dto/dispatch-move.dto.ts`
- `apps/api/src/modules/job/job.service.ts`
- `apps/api/src/modules/job/job.controller.ts`
- `apps/api/src/modules/shelf/shelf-service.ts`

Thiết kế dự kiến:

- Thêm `fromZoneCode` và `toZoneCode` với enum `S1`–`S4`.
- Quyết định giữ hay deprecate `fromSlotCode`/`toSlotCode` sau khi có migration; không xóa ngay.
- `dispatchMove()` validate zone, tạo job, và phát sự kiện zone-based.
- API phải từ chối zone không tồn tại và job nguồn không có hàng active.
- Cần định nghĩa rõ việc chọn package khi một zone có nhiều hàng: packageId phải là bắt buộc, không được chọn mơ hồ theo zone.

### 2. Calibrate theo zone

Các file dự kiến:

- `apps/web/src/app/calibrate/page.tsx`
- `apps/web/src/store/calibrateSlice.ts`
- API coordinate DTO/schema tương ứng
- Có thể thêm zone coordinate schema/module thay vì tái sử dụng `ShelfSlot` nếu robot cần cả tọa độ slot cũ.

Thiết kế dự kiến:

- Mỗi zone có centroid/điểm tiếp cận: `zoneX`, `zoneY`, `facingTheta`.
- Calibrate page hiển thị 4 zone cards, không xóa UI slot cho đến khi robot service đã hỗ trợ zone.
- Giữ dữ liệu slot coordinates để rollback và dùng làm các điểm tiếp cận thay thế.
- Chọn cách robot resolve zone: centroid cố định hoặc danh sách slot ứng viên theo zone; không tự động quyết định trước khi khảo sát layout thực tế.

### 3. Robot service

Các khu vực cần khảo sát trước khi sửa:

- `services/robot/src/` — gateway/job receiver và node điều phối.
- Các message/schema liên quan đến `fromSlotCode`, `toSlotCode`.
- Các node dùng tọa độ slot, AprilTag lookup, hoặc `JobStatus`.

Thiết kế dự kiến:

1. Nhận job mới có `packageId`, `fromZoneCode`, `toZoneCode`.
2. Resolve zone thành điểm/slot cụ thể bằng cấu hình đã calibrate.
3. Thực hiện navigation bằng stack hiện tại.
4. Báo status theo cùng lifecycle: `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `FAILED`.
5. Giữ fallback slot-based trong một giai đoạn chuyển đổi để job cũ không bị hỏng.

Không được thay đổi ESP32 command/telemetry protocol chỉ để đổi zone. ESP32 vẫn nhận lệnh motor hiện tại; zone resolution phải xảy ra ở tầng robot/Pi.

### 4. Data migration và tương thích

- `Package.zoneCode` đã là nguồn dữ liệu mới ở Phase 1.
- Hàng legacy có slot phải được map zone bằng prefix `S1`–`S4`.
- Job đang `DISPATCHED`/`IN_PROGRESS` phải tiếp tục dùng slot fields cho đến khi hoàn tất.
- Không chạy migration phá hủy khi còn job active.
- Cần script rollback zone job về slot job nếu dry-run thất bại.

### 5. Kiểm thử và rollout

Trước khi triển khai:

- Unit tests cho zone validation và zone-to-slot resolution.
- Integration tests cho tạo job, status transitions, retry/failure, và nhiều package cùng zone.
- Simulation/dry-run không kích hoạt motor.
- Test AprilTag lookup và tọa độ zone trong kho không tải.
- Chạy một job thật với tốc độ giới hạn và emergency-stop sẵn sàng.
- Theo dõi log, job status, vị trí robot, và rollback về slot-based nếu có sai lệch.

## Điều kiện bắt đầu Phase 2

- Layout vật lý của 4 khu đã chốt.
- Quy tắc chọn vị trí cụ thể trong khu đã chốt.
- Giao thức giữa API và robot service đã được review.
- Có kế hoạch xử lý job đang chạy.
- Có test/simulation và rollback procedure.
- Người phụ trách robot xác nhận không cần thay đổi firmware/ESP32 protocol hoặc đã phê duyệt thay đổi riêng.
