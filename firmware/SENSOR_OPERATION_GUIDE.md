# ESP32-S3 Sensor and Actuator Operation Guide

Tai lieu nay tong hop vai tro, chan ket noi, dieu kien lam viec, nguong an toan, chu ky doc, telemetry va phan ung loi cua cac cam bien/co cau trong firmware ESP32-S3.

> **Pham vi:** Noi dung duoc doi chieu voi `include/config.h`, `src/main.cpp` va cac module trong `src/modules/` tai ngay 2026-08-22.
>
> **Luu y:** Day la tai lieu van hanh va kiem tra phan cung. Khong thay the datasheet cua tung module. Truoc khi cap nguon motor, phai xu ly cac diem canh bao trong muc [Kiem tra bat buoc](#kiem-tra-bat-buoc-truoc-khi-chay-motor).

## 1. Kien truc tong quat

ESP32-S3 dam nhan cac cong viec thoi gian thuc:

- Doc encoder va chay PID cho 4 motor.
- Tao PWM cho 4 BTS7960.
- Doc IR proximity de bao ve cuc bo.
- Doc Front ToF de chan chuyen dong ve phia truoc.
- Doc IMU, rear ToF va cargo switch cho docking/unload.
- Doc INA226 de theo doi dien ap, dong dien, cong suat va SOC.
- Nhan lenh tu Pi, ap dung watchdog va phat telemetry.

Raspberry Pi dam nhan SLAM, LiDAR, AprilTag, Nav2 va quyet dinh dieu huong cap cao. ESP32 khong tu lam SLAM va khong doc AprilTag.

## 2. Dieu kien nguon va dau day chung

| Dieu kien | Yeu cau van hanh |
|---|---|
| Common ground | ESP32, Pi, encoder, cam bien, BTS7960, L298N, buck converter va nguon phai chung GND. |
| Logic ESP32 | Tin hieu vao ESP32 khong duoc vuot qua muc dien ap cho phep cua GPIO ESP32-S3. |
| I2C pull-up | Dung mot cap pull-up ngoai khoang 2.2 kOhm-4.7 kOhm tu SDA/SCL len 3.3 V cho toan bus. |
| I2C speed | 100 kHz; khong doi len 400 kHz khi dang dung BNO055 clone clock-stretch. |
| I2C day | SDA/SCL ngan, xoan/tach khoi day PWM, day motor va day nguon dong co. |
| Nguon logic | BNO055, INA226 va cac carrier ToF phai duoc cap dung dien ap theo datasheet/carrier. |
| Nguon E18 | E18-D80NK thuong dung 5 V, nhung phai xac nhan OUT cua dung phien ban; neu OUT la 5 V truc tiep thi can mach ha muc. |
| Nguon motor | BTS7960 dung rail motor rieng; day dong co khong di chung voi day I2C/encoder. |
| XSHUT ToF | Ca hai ToF phai bi giu LOW truoc khi Wire/I2C duoc khoi tao. Sau do chi nha tung sensor theo thu tu rear -> front. |

## 3. Bang tong hop nhanh

| Thiet bi | Chan | Chu ky doc/xu ly | Telemetry | Vai tro an toan |
|---|---|---:|---|---|
| BNO055 IMU | SDA 10, SCL 11, dia chi 0x28 | 50 ms / 20 Hz | Type 134 | Heading cho docking; tilt/shock dang quan sat, chua cuong che |
| VL53L1X Front ToF | SDA 10, SCL 11, XSHUT 9, dia chi runtime 0x31 | 50 ms / 20 Hz | Type 136 | Chan tien khi qua gan, stale hoac mat sensor |
| VL53L0X Rear ToF | SDA 10, SCL 11, XSHUT 8, dia chi runtime 0x30 | 50 ms, telemetry khoang 100 ms | Type 138 | Can khoang cach docking/unload; khong thay front safety |
| E18-D80NK IR x4 | GPIO 1, 37, 45, 46 | 20 ms / 50 Hz | Type 135 | Chan huong nguy hiem, uu tien hon lenh Pi |
| Cargo microswitch | GPIO 36 | 20 ms, debounce 100 ms | Type 145 on-demand | Xac nhan co hang tren bed |
| Cylinder limit switch | GPIO 44 | Moi tick, debounce 100 ms | Type 139 | Dung retract khi cham cong tac |
| INA226 | SDA 10, SCL 11, dia chi 0x40 | Doc dinh ky theo main, telemetry 5 s | Type 133 | Theo doi pin; low/critical auto safety dang bi comment |
| Encoder x4 | FL 40/41, FR 42/6, RL 4/5, RR 20/21 | 20 ms / 50 Hz | Type 130 | Feedback PID, RPM, phat hien stall |
| BTS7960 x4 | Theo bang motor pin | 20 ms PID | Type 131/status lien quan | E-stop keo EN LOW |

## 4. BNO055 IMU

### 4.1. Nhiem vu

- Do heading/yaw, roll va pitch.
- Cung cap quaternion, linear acceleration, gravity vector va gyro.
- Cung cap nhiet do va trang thai calibration.
- Lam heading gate cho docking va heading-hold khi leave-dock.

### 4.2. Ket noi va dieu kien phan cung

| Muc | Gia tri |
|---|---|
| SDA/SCL | GPIO 10 / GPIO 11 |
| Dia chi mac dinh cua project | 0x28 |
| ADR/COM3 | Noi GND de chon 0x28; khong de troi/noi 3.3 V neu khong doi config |
| Giao dien | I2C only |
| Toc do | 100 kHz |
| PS0/PS1 | De LOW hoac floating theo module; khong keo HIGH neu muon I2C |
| GNDIO | Phai noi GND |
| Lap dat | Truc X cua BNO055 nen huong ve phia truoc robot |

### 4.3. Dieu kien khoi dong

1. SDA va SCL phai idle HIGH truoc `Wire.begin()`.
2. Cho toi thieu 650 ms sau khi cap nguon BNO055.
3. Probe phai ACK tai 0x28.
4. Chip ID doc duoc phai la `0xA0`.
5. Chuyen sensor qua CONFIG mode.
6. Ghi axis remap va axis sign.
7. Chuyen sang NDOF.
8. Doc xac nhan operating mode la NDOF.

Neu mot buoc that bai, sensor bi danh dau loi va HealthMonitor co the thu khoi phuc bang cach goi lai `begin()`.

### 4.4. Dieu kien du lieu dang tin cay

- `cal_sys >= 2` moi nen dung heading cho docking/heading-hold.
- Khi moi bat nguon, heading co the chua on dinh.
- Can di chuyen robot theo hinh so 8 de hieu chuan magnetometer.
- Khi `cal_sys < 2` sau 30 giay, firmware in canh bao dinh ky.

### 4.5. Nguong va safety

- `HEADING_GATE_DEG = 2.0` do: docking chi duoc qua heading gate khi sai so nam trong gioi han nay.
- Tilt warning va shock observer co nguong trong `config.h`.
- `IMU_SAFETY_ENFORCEMENT_ENABLED = false`: tilt/shock hien chi o che do quan sat, khong tu dong e-stop.

### 4.6. Telemetry va loi

Type 134 phat heading, pitch, roll, temperature, quaternion/calibration theo luong hien tai.

Neu I2C khong doc duoc:

- Tang bo dem read failure.
- HealthMonitor danh dau warning/failed/recovery.
- Khong duoc coi heading la hop le cho docking.

## 5. VL53L1X Front ToF / TOF400C

### 5.1. Nhiem vu

Day la cam bien khoang cach phia truoc va la lop bao ve chuyen dong cuc bo doc lap voi LiDAR/Pi.

### 5.2. Ket noi va khoi tao

| Muc | Gia tri |
|---|---|
| SDA/SCL | GPIO 10 / GPIO 11 |
| XSHUT | GPIO 9 |
| Dia chi luc boot | 0x29 |
| Dia chi runtime | 0x31 |
| Distance mode | Long |
| Timing budget | 50 ms |
| Chu ky continuous | 50 ms |
| Khoang hop le | 40-4000 mm |
| Timeout thu vien | 200 ms |

Trinh tu bat buoc:

1. Giu XSHUT front LOW truoc I2C.
2. Khoi tao rear VL53L0X va doi rear sang 0x30.
3. Nha XSHUT front.
4. Probe front o 0x29, init va doi sang 0x31.
5. Kiem tra lai dia chi 0x31.

### 5.3. Dieu kien so do hop le

Mot mau chi hop le khi:

- Khong timeout.
- `RangeStatus` thuoc trang thai hop le.
- Khoang cach nam trong 40-4000 mm.
- Bus I2C dang idle.
- Mau khong qua cu.

Mau loi duoc dat thanh 9999 mm va `valid=false`. Neu khong co sensor, khong co mau hop le hoac mau cu hon 250 ms, `isStale()` la true.

### 5.4. Nguong lam viec va phan ung

| Dieu kien | Phan ung |
|---|---|
| Lon hon 600 mm | Chuyen dong phia truoc binh thuong |
| Nho hon 600 mm | Danh dau vung slowing; han che tien |
| Nho hon 150 mm | Danh dau too-close; chan tien |
| Stale > 250 ms | Fail-safe: chan tien |
| Sensor absent/invalid | Fail-safe: chan tien |

Firmware cat thanh phan `vx > 0`. Van co the cho phep lui/di ngang neu cac cam bien khac khong chan huong do. Neu front, left va right cung bi chan thi dung tat ca thanh phan chuyen dong.

### 5.5. Telemetry

Type 136 gom `distance_mm`, `distance_cm`, `valid`, `stale`, `present`, `too_close` va `slowing`.

## 6. VL53L0X Rear ToF

### 6.1. Nhiem vu

- Do khoang cach phia sau toi dock.
- Can chinh vi tri khi docking.
- Xac dinh robot da dat gan khoang unload muc tieu.
- Khong duoc dung no thay cho Front ToF safety.

### 6.2. Ket noi va dieu kien

| Muc | Gia tri |
|---|---|
| SDA/SCL | GPIO 10 / GPIO 11 |
| XSHUT | GPIO 8 |
| Dia chi luc boot | 0x29 |
| Dia chi runtime | 0x30 |
| Khoang do danh nghia | Khoang 30-2000 mm |
| Timing budget | 33 ms |
| Chu ky doc | 50 ms |
| Bo loc | Median 5 mau |

### 6.3. Khoi tao

1. Giu GPIO 8 LOW truoc I2C.
2. Front VL53L1X van dang shutdown.
3. Probe rear tai 0x29.
4. Init rear va doi dia chi sang 0x30.
5. Xac nhan sensor tai 0x30.
6. Sau do moi bat dau xu ly front sensor.

### 6.4. Dieu kien so do

- Bo qua doc khi bus khong idle.
- Gia tri 8190/8191 hoac timeout duoc coi la invalid va doi thanh 9999 mm.
- Can it nhat 3 mau de median co y nghia; 5 mau giup giam jitter.

### 6.5. Docking/unload

- Khoang cach unload mac dinh: 40 mm.
- `at_unload=true` khi khoang cach <= 40 mm.
- Dung sai docking duoc cau hinh rieng trong `config.h`.
- Khoang cach dung mot minh khong du de unload; con can AprilTag tu Pi, heading BNO055 va cac safety gate.

Type 138 phat khoang cach, `at_unload` va `present`.

## 7. E18-D80NK IR Proximity x4

### 7.1. Nhiem vu

Phat hien vat can rat gan o cac canh robot va tao local obstacle interlock, uu tien hon lenh move/individual tu Pi.

| Vi tri | GPIO | Muc kich hoat |
|---|---:|---|
| Rear-left | 1 | LOW = detected |
| Rear-right | 37 | LOW = detected |
| Left | 45 | LOW = detected |
| Right | 46 | LOW = detected |

### 7.2. Dieu kien phan cung

- GPIO duoc cau hinh `INPUT_PULLUP`.
- OUT phai la muc logic an toan cho ESP32-S3.
- Kiem tra dung phien ban E18-D80NK truoc khi cap 5 V; khong dua 5 V truc tiep vao GPIO neu module khong ha muc.
- Chinh bien tro de dat tam phat hien thuc te. Firmware dat muc tham chieu khoang 15 cm.
- GPIO 45/46 la strapping pins: chi dung input sau khi boot hoan tat.

### 7.3. Dieu kien loc va kich hoat

- Doc moi 20 ms (50 Hz).
- Debounce 50 ms.
- LOW on dinh sau debounce = vat can.
- HIGH on dinh sau debounce = da clear.
- Cam bien bi LOW tren 15 giay se in warning; khong tu dong tat interlock.

### 7.4. Phan ung theo huong

| Tin hieu | Huong bi chan |
|---|---|
| Rear-left/rear-right | Khong cho lui (`vx < 0`) |
| Left | Khong cho strafe trai |
| Right | Khong cho strafe phai |
| IR dang active | Cho phep vector thoat an toan neu khong di vao vat can |
| Front + left + right cung active | Dung tien, ngang va quay |

Type 135 phat trang thai 4 sensor.

### 7.5. Xung dot GPIO can xu ly

Da tach rieng hai tin hieu:

- `IR_REAR_RIGHT_PIN = 37`
- `CYLINDER_RETRACT_SWITCH_PIN = 44`

GPIO 37 chi danh cho IR rear-right. Cong tac retract phai dau vao GPIO 44 va khong duoc noi chung voi GPIO 37.

## 8. Cargo microswitch

### 8.1. Nhiem vu

Xac nhan co hang tren cargo bed. Day la cong tac hien dien, khong phai load cell va khong do duoc trong luong.

### 8.2. Ket noi va dieu kien

| Muc | Gia tri |
|---|---|
| GPIO | 36 |
| Che do | INPUT_PULLUP |
| Loai | Normally Open |
| Dau day | Mot dau GPIO 36, dau kia GND |
| HIGH | Switch mo, khong co hang |
| LOW | Switch dong, co hang |
| Debounce | 100 ms |
| Chu ky doc | 20 ms |

Chi chap nhan thay doi sau khi trang thai on dinh 100 ms de tranh rung do rung dong robot.

### 8.3. Su dung

Co the dung de:

- Xac nhan hang da dat len bed.
- Khong cho bat dau job neu khong co hang.
- Xac nhan hang da roi bed sau unload.
- Bao trang thai len Pi.

Type 145 duoc gui khi co lenh query cargo; trang thai cung co the nam trong status tong.

## 9. Cylinder L298N va cong tac retract

> Day la co cau chap hanh, khong phai cam bien khoang cach. No duoc tong hop vi cong tac gioi han la dau vao an toan cua xy lanh.

### 9.1. Ket noi

| Tin hieu | GPIO | Dieu kien |
|---|---:|---|
| L298N IN1 | 2 | HIGH de extend |
| L298N IN2 | 35 | HIGH de retract |
| ENA | Jumper HIGH | Full speed, khong PWM |
| Retract limit | 44 | INPUT_PULLUP, LOW khi da rut het; debounce 100 ms |

### 9.2. Dieu kien van hanh

- Extend: IN1 HIGH, IN2 LOW.
- Retract: IN1 LOW, IN2 HIGH.
- Stop: ca hai LOW.
- Moi lan chay bi gioi han toi da 8000 ms.
- Khi retract va limit switch LOW, dung ngay.
- Khi extend, state machine co the giu tai dinh trong khoang hold time cau hinh.

### 9.3. Phan ung loi

- Het 8000 ms ma chua toi limit: auto-stop.
- Limit duoc loc debounce 100 ms; neu van bi nhieu, can kiem tra co khi va dau day.
- E-stop tu Pi/local path goi stop cylinder.

Telemetry type 139 bao state, extended, moving va retracted.

## 10. INA226 Power Monitor

### 10.1. Nhiem vu

- Do dien ap pack.
- Do dong dien qua shunt.
- Tinh cong suat.
- Uoc luong SOC theo bang dien ap pack.

### 10.2. Ket noi va dieu kien

| Muc | Gia tri |
|---|---|
| SDA/SCL | GPIO 10 / GPIO 11 |
| Dia chi | 0x40 |
| Shunt | 10 mOhm |
| VIN+ | Phia pin duong theo so do do dong |
| VIN- | Phia tai sau shunt theo so do do dong |
| Pull-up | Chung bus I2C 3.3 V |

### 10.3. Dieu kien khoi dong va doc

1. Probe ACK tai 0x40.
2. LibDriver init thanh cong voi shunt 10 mOhm.
3. Lan doc dau tien thanh cong.
4. Bus phai idle truoc moi lan doc.

Neu bus voltage < 0.05 V, firmware coi la no-load/khong thay pack:

- current = 0;
- power = 0;
- battery status = unknown;
- khong coi day la pin 0%.

Khi bus voltage > 1.0 V, SOC duoc tinh lai. Bang SOC hien tai su dung khoang 14.0 V = 0% den 20.5 V = 100%.

### 10.4. Muc canh bao

| Trang thai | Dieu kien |
|---|---|
| OK | SOC > 20% |
| LOW | SOC <= 20% |
| CRITICAL | SOC <= 10% |
| UNKNOWN | Khong phat hien pack voltage |

Type 133 phat dien ap, dong, cong suat, SOC, battery status va no-load.

### 10.5. Gioi han hien tai trong code

Trong `main.cpp`, khoi battery safety tu dong dang duoc comment de bench test khi chua dau day INA226:

- Chua tu dong gioi han toc do khi LOW.
- Chua tu dong e-stop khi CRITICAL.

Vi vay telemetry co the chay, nhung khong duoc hieu la robot da co battery protection tu dong cho den khi khoi nay duoc bat lai va test an toan.

## 11. Encoder x4

### 11.1. Pin map

| Motor | CHA | CHB | PCNT |
|---|---:|---:|---|
| FL | 40 | 41 | Unit 0 |
| FR | 42 | 6 | Unit 1 |
| RL | 4 | 5 | Unit 2 |
| RR | 20 | 21 | Unit 3 |

### 11.2. Dieu kien phan cung

- Cap encoder dung dien ap theo encoder motor.
- ESP32, encoder va driver chung GND.
- CHA/CHB co muc logic sach va khong bi day motor gay nhieu.
- Hai kenh phai co pha vuong goc.
- Khi motor dung, count khong doi la binh thuong.

### 11.3. Dieu kien tinh RPM va PID

- PCNT dung x2 decoding.
- RPM cap nhat moi 20 ms.
- PID dung RPM do duoc lam feedback.
- Dau ra co the doi dau theo `MOTOR_PINS[].dir` de phu hop chieu quay vat ly.

### 11.4. Dieu kien phat hien stall

Khi lenh motor lon hon khoang 50 va RPM nho hon 2 trong 10 tick lien tiep (xap xi 200 ms), encoder/motor duoc danh dau co kha nang stall.

Hien tai stall detector:

- In warning/HealthMonitor error.
- Ghi ro motor, CHA/CHB va PCNT unit.
- Khong tu dong dung motor trong moi truong hop.

Can kiem tra nguon encoder, GND, connector, day motor, BTS7960 va co khi neu co stall.

Type 130 dung cho snapshot encoder; encoder cung phuc vu PID va odometry.

## 12. BTS7960 va motor feedback

### 12.1. Pin map

| Motor | RPWM | LPWM | EN | Direction |
|---|---:|---:|---:|---:|
| FL | 12 | 13 | 3 | -1 |
| FR | 14 | 15 | 7 | +1 |
| RL | 16 | 17 | 48 | -1 |
| RR | 38 | 39 | 47 | +1 |

### 12.2. Dieu kien lam viec

- BTS7960 VCC theo rail logic 5 V.
- B+ theo rail motor da buck dung dien ap.
- GND BTS7960 chung GND ESP32.
- RPWM/LPWM la PWM 20 kHz.
- EN HIGH de enable; EN LOW de disable.
- PID tick 50 Hz.
- Motor max duty hien gioi han trong `MOTOR_MAX_DUTY` de bao ve motor theo cau hinh nguon.

### 12.3. An toan

- E-stop keo EN cua ca 4 driver LOW va xoa PWM.
- Local IR/front-ToF uu tien hon lenh Pi.
- Watchdog Pi het han thi mode manager chuyen mode fail-safe theo cau hinh.
- Driver khong co chan diagnostic phan cung; khong duoc ket luan driver hong chi tu RPM thap.

## 13. I2C bus manager va dieu kien recovery

Tat ca giao dich tren GPIO 10/11 phai di qua `I2CBus`.

### 13.1. Kiem tra truoc giao dich

- `linesIdle()` chi doc muc SDA/SCL, khong goi `pinMode()` lam tach I2C peripheral.
- Giao dich bi bo qua neu bus dang bi giu LOW.
- Read/write co gioi han thoi gian.

### 13.2. Probe va recovery

- Probe tra ve 0 khi ACK; gia tri khac 0 la loi.
- NACK: coi la thiet bi vang mat, khong reset ca bus.
- Timeout/loi khac: cho phep mot lan recovery co kiem soat va thu lai.
- Khong goi `Wire.end()` tuy tien giua giao dich dang chay.

### 13.3. Dieu kien khong duoc vi pham

- Khong goi `pinMode()` lai tren SDA/SCL sau khi Wire da nam quyen.
- Khong noi hai XSHUT ToF chung nhau.
- Khong de hai ToF cung phan hoi o 0x29 sau giai doan khoi dong.

## 14. Watchdog, telemetry va HealthMonitor

| Su kien | Chu ky/nguong | Phan ung |
|---|---:|---|
| Firmware alive | 500 ms | Type 144 |
| Pi heartbeat | Timeout 2000 ms | Mode manager chuyen mode theo cau hinh |
| Full status | Khoang 500 ms | Type 131 |
| IMU | 50 ms | Type 134 |
| IR/front ToF | Khoang 50 ms | Type 135/136 |
| Rear ToF | Khoang 100 ms telemetry | Type 138 |
| Encoder | Khoang 100 ms telemetry/request | Type 130 |
| Power | 5000 ms telemetry | Type 133 |
| Cylinder | Theo su kien/trang thai | Type 139 |
| Cargo | Khi query | Type 145 |
| Health | 1 s va khi state doi | Type 142 |

HealthMonitor theo doi tinh trang online, warning, failed, offline va recovery cua cac module. Sensor I2C bi mat khong dong nghia toan bus I2C bi hong; can tach loi theo tung peripheral.

## 15. Luong safety tong hop

```text
Power on
  |
  +--> Kiem tra SDA/SCL idle HIGH
  |       |
  |       +--> I2C init OK? -- khong --> Bo qua sensor I2C, bao loi
  |       |
  |       +--> XSHUT rear LOW, init rear -> 0x30
  |       +--> XSHUT front LOW, init front -> 0x31
  |       +--> Init BNO055 -> chip ID -> NDOF
  |       +--> Init INA226 -> first read
  |
  +--> Init IR, cargo, cylinder, motors, encoders
  |
  +--> Moi tick 20 ms
          |
          +--> IR detected? --------> Chan huong nguy hiem
          +--> Front ToF stale/gan? -> Chan tien
          +--> Cargo update ---------> Cap nhat hien dien hang
          +--> Cylinder update ------> Timeout/limit stop
          +--> Encoder/PID ----------> Dieu khien toc do + kiem tra stall
          +--> Heartbeat het han ----> Chuyen mode fail-safe
          +--> E-stop ---------------> EN LOW ca 4 BTS7960
```

## 16. Kiem tra bat buoc truoc khi chay motor

1. **Xu ly GPIO 37/44:** IR rear-right giu o GPIO 37; retract limit phai dau rieng vao GPIO 44. Khong dau hai tin hieu chung mot GPIO.
2. Do xac nhan GND thong mach giua ESP32, driver, sensor, Pi va nguon.
3. Xac nhan OUT E18 khong vuot muc GPIO ESP32; dung level shifter neu can.
4. Do SDA/SCL co pull-up ve 3.3 V va ca hai line idle HIGH.
5. Kiem tra ADR/COM3 BNO055 o GND de khong trung dia chi.
6. Kiem tra PS0/PS1 BNO055 dang o I2C mode.
7. Kiem tra hai XSHUT ToF tach rieng va khong dau nham 8/9.
8. Kiem tra VL53 runtime address la rear 0x30, front 0x31.
9. Chay boot khong tai va xem probe/health cua tung sensor.
10. Test tung IR bang vat can, tung ToF bang muc tieu co dinh.
11. Test cargo switch bang cach nhan/tha switch va quan sat debounce.
12. Test cylinder khong gan tai nguy hiem, gioi han bang timeout va limit switch.
13. Quay tung banh bang tay, xac nhan CHA/CHB co thay doi.
14. Chi sau khi encoder va interlock dung moi cap nguon/dieu khien motor.
15. Nho rang battery critical auto-e-stop va IMU tilt/shock enforcement dang **chua bat** trong code hien tai.

## 17. Cac diem can dong bo tai lieu/code

| Van de | Hien trang | Hanh dong de xuat |
|---|---|---|
| GPIO 37/44 | Da tach IR rear-right va cylinder retract switch | Dau retract limit vao GPIO 44; GPIO 44 khong con dung cho UART RX fallback |
| Battery safety | Khoi low/critical handling dang comment | Chi bat sau khi dau dung VIN+/VIN- va test co kiem soat |
| IMU safety | Enforcement = false | Chi bat sau bench tuning tilt/shock |
| UART | Mot so tai lieu cu ghi GPIO43/44, code hien tai dung native USB CDC `Serial` | Chot mot transport production va cap nhat tat ca tai lieu/Pi bridge cho thong nhat |
| Sharp sensor | Tai lieu cu con ten Sharp | Front sensor thuc te la VL53L1X; cap nhat ten telemetry/tai lieu cu |
| BNO055 SPI | File SPI con ton tai nhung khong dung | Khong dau day SPI; I2C GPIO10/11 la giao dien duoc ho tro |
| Cylinder limit debounce | Dang doc truc tiep, chua co debounce rieng | Them loc phan cung/pham mem neu switch bi rung |
| Encoder stall | Chu yeu warning/health | Neu can safety cao hon, thiet ke quy tac auto-stop rieng va test truoc khi bat |

## 18. Lenh kiem tra nhanh

ASCII query hien co trong firmware:

```text
I       Doc IMU / type 134
W       Doc power / type 133
N       Doc IR / type 135
J       Doc front ToF / type 136
Y       Doc rear ToF / type 138
U       Doc cargo / type 145
V       Doc status tong / type 131
D       E-stop
K       Clear E-stop
Z       Heartbeat
```

> Khi kiem tra thuc te, ghi lai: sensor co ACK khong, gia tri raw, gia tri da loc, trang thai `valid/stale/present`, va phan ung cua motor khi huong nguy hiem bi kich hoat.
