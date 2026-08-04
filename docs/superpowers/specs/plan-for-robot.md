# Kế hoạch Robot — Chuyển từ Slot sang Zone (Phase 2)

**Trạng thái:** Kế hoạch tương lai, không triển khai trong Phase 1.
**Phạm vi:** Robot gateway trên Raspberry Pi, Job API và Calibrate UI.

Phase 1 chỉ chuyển inventory/package UX sang bốn khu tập kết `S1`–`S4`. Robot vẫn vận chuyển đến slot cụ thể trong bộ dữ liệu hiện tại. Tài liệu này mô tả cách chuyển phần robot sau khi đã có tọa độ và quy trình an toàn phù hợp.

## 1. Job dispatch theo zone

- Bổ sung `fromZoneCode` và `toZoneCode` vào Job, dùng enum `S1`–`S4`.
- Trong giai đoạn tương thích, giữ `fromSlotCode`/`toSlotCode` nullable để các job cũ hoàn tất được.
- `JobService.dispatchMove()` nhận zone thay vì yêu cầu người dùng chọn slot.
- Robot gateway nhận job zone-based qua API/socket và trả ACK/FAILED như hiện tại.
- Một zone có thể có nhiều package; dispatch phải chọn package cụ thể theo `_id`, không suy luận bằng capacity.

## 2. Calibrate theo zone

- Thay lưới 4×4 bằng bốn zone cards.
- Mỗi zone lưu centroid `(slotX, slotY)`, `facingTheta` và tùy chọn danh sách slot vật lý.
- Giữ endpoint slot hiện tại trong thời gian chuyển đổi để robot cũ không bị gián đoạn.
- Chỉ cho phép publish zone calibration khi có đủ tọa độ và kiểm tra khoảng cách an toàn giữa các zone.
- Cần xác nhận tọa độ bằng một lượt robot chạy chậm, có người giám sát.

## 3. ZoneManager trong robot service

`ZoneManager` sẽ ánh xạ `zoneCode` tới các slot vật lý có thể phục vụ:

1. Đọc cấu hình/calibration zone.
2. Lọc ShelfSlot thuộc zone, còn tọa độ hợp lệ và không bị khóa.
3. Chọn slot đích theo trạng thái, khoảng cách và quy tắc an toàn.
4. Trả về slot cụ thể cho Nav2/ESP32 bridge.
5. Giữ mapping ổn định trong suốt một job; không đổi slot giữa chừng nếu không có recovery rõ ràng.

Robot service không thay đổi giao thức UART ESP32. ESP32 vẫn nhận vận tốc và lệnh motor như hiện tại; việc chọn slot là trách nhiệm của gateway/ZoneManager.

## 4. Migration và tương thích

- Backfill Job cũ từ slot prefix sang zone khi có thể; giữ nguyên slot để audit và rollback.
- Job đang `IN_PROGRESS` phải hoàn tất theo slot cũ trước khi bật dispatch zone mới.
- Có cờ vận hành ở tầng gateway để chuyển từng bước: read-only zone, shadow resolution, rồi active dispatch.
- Nếu zone calibration thiếu hoặc ZoneManager không chọn được slot, job phải FAILED an toàn và báo lý do — không tự gửi lệnh mù.

## 5. Safety và rollback

- Không dispatch khi robot mất heartbeat, localization không hợp lệ, obstacle hard-stop đang bật, hoặc slot đích không có tọa độ.
- Giới hạn tốc độ và cho phép dừng khẩn cấp trong toàn bộ lượt xác nhận phần cứng.
- Ghi log zone, slot được resolve, pose, timestamp và kết quả từng bước.
- Rollback bằng cách tắt zone dispatch, để job mới dùng slot API cũ; không xóa ShelfSlot hay dữ liệu calibration.
- Kiểm tra khôi phục sau mất điện, mất websocket, timeout Nav2 và lỗi UART trước khi production.

## 6. Hardware validation bắt buộc

Trước khi bật production:

1. Calibrate bốn zone trên sàn thật và đo sai số lặp lại.
2. Chạy từng zone với robot không tải, sau đó với tải đại diện.
3. Xác nhận robot dừng trước vật cản và ESP32 vẫn giữ hard-stop độc lập.
4. Kiểm tra AprilTag/vision ở nhiều hướng và điều kiện ánh sáng.
5. Chạy thử chuyển zone, hủy job, retry và recovery sau restart.
6. Được người vận hành kho nghiệm thu trước khi bật active dispatch.

## Ranh giới Phase 1

Tài liệu này **không thay đổi** `services/robot/`, `firmware/`, camera stream, Job schema/service hiện tại hoặc Calibrate page hiện tại. Các thay đổi đó chỉ được thực hiện trong Phase 2 sau khi có thiết kế, kiểm thử và phê duyệt phần cứng riêng.
