# TEST 4 MOTORS — Direct BTS7960 Driver Test

Standalone PlatformIO project — chỉ test 4 motor + 4 BTS7960. Không có sensor, không PID, không encoder.

## Pin Wiring (theo PIN_MAP.md)

| Motor | EN | RPWM | LPWM |
|---|---|---|---|
| FL | GPIO 3 | GPIO 12 | GPIO 13 |
| FR | GPIO 7 | GPIO 14 | GPIO 15 |
| RL | GPIO 48 | GPIO 16 | GPIO 17 |
| RR | GPIO 47 | GPIO 38 | GPIO 39 |

## BTS7960 connection

```
ESP32-S3              BTS7960 (×4)
  │
  ├─ GPIO 3   ───────→  R_EN + L_EN
  ├─ GPIO 12  ───────→  RPWM
  ├─ GPIO 13  ───────→  LPWM
                     └─ 12V supply on B+, motor on OUT+/OUT-

  ├─ GPIO 7   ───────→  R_EN + L_EN
  ├─ GPIO 14  ───────→  RPWM
  ├─ GPIO 15  ───────→  LPWM
                     └─ second BTS7960

  ├─ GPIO 48  ───────→  R_EN + L_EN
  ├─ GPIO 16  ───────→  RPWM
  ├─ GPIO 17  ───────→  LPWM
                     └─ third BTS7960

  ├─ GPIO 47  ───────→  R_EN + L_EN
  ├─ GPIO 38  ───────→  RPWM
  ├─ GPIO 39  ───────→  LPWM
                     └─ fourth BTS7960
```

## Cấp nguồn

- **12V supply** cấp vào B+ (hoặc VM) của **mỗi** BTS7960
- **GND chung** giữa ESP32 và cả 4 BTS7960
- Motor JGB37-520 nối OUT+ / OUT-

## Test sequence (loop vô hạn)

1. **Single motor forward** — từng motor quay tiến
2. **Single motor reverse** — từng motor quay lùi
3. **All forward** — cả 4 motor quay tiến đồng thời
4. **All reverse** — cả 4 motor quay lùi đồng thời
5. **Spin** — bên trái tiến, bên phải lùi (xe xoay tại chỗ)
6. **Ramp up** — tăng tốc từ từ lên max

Mỗi test chạy 2 giây, nghỉ 0.5s, sau khi xong hết loop sẽ đợi 5s rồi chạy lại.

## Build + flash

```bash
cd e:\robot-for-nguyen\test-motors
pio run --target upload
pio device monitor          # xem log Serial (115200 baud)
```

## Safety trước khi flash

- **Kiểm tra dây nối** — đặc biệt EN, RPWM, LPWM từng driver
- **Kiểm tra nguồn 12V** — đủ dòng cho 4 motor (~2-5A)
- **Bỏ chân lên khỏi mặt đất** — xe có thể tự di chuyển
- **Đặt nút tắt nguồn trong tầm tay** — sẵn sàng ngắt 12V