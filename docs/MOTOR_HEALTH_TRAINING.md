# Motor Health — Training the Anomaly Detector

`motor_health_node` giám sát động cơ để phát hiện sự cố sớm (kẹt/stall, sai lệch
RPM mục tiêu vs thực tế, quá dòng) từ telemetry ESP32 (`/esp32/encoder`,
`/esp32/power`).

Hai chế độ phát hiện:

1. **Rule-based (mặc định, không cần train)** — đã bật sẵn, không cần thư viện gì.
   Cảnh báo stall (ra lệnh quay nhưng bánh không quay) và quá dòng pack.
2. **LSTM autoencoder (TFLite, tùy chọn)** — học "hình dạng bình thường" của
   telemetry rồi báo động khi lỗi tái tạo (reconstruction error) tăng vọt. Phát
   hiện được các bất thường tinh vi mà luật cứng bỏ sót (ổ bi mòn, lệch tải...).

> Rule-based đã đủ dùng cho đồ án. Autoencoder là phần nâng cao — làm khi bạn
> muốn "predictive maintenance" thực thụ.

## Feature vector

Mỗi timestep (mặc định 5 Hz), node dựng vector 14 chiều:

```
[tgt0,rpm0,err0, tgt1,rpm1,err1, tgt2,rpm2,err2, tgt3,rpm3,err3, current_a, power_w]
```
(`err = tgt - rpm`). 4 động cơ mecanum + dòng/điện năng toàn pack.

## Bước 1 — Thu thập dữ liệu "khỏe mạnh"

Chạy robot ở trạng thái bình thường (các kiểu di chuyển: tiến/lùi/xoay/strafe,
nhiều tốc độ) trong lúc bật collection mode:

```bash
ros2 run my_robot_controller motor_health_node --ros-args -p collection_mode:=true
# CSV ghi vào ~/robot_ws/motor_health/motor_YYYYmmdd_HHMMSS.csv
```

## Bước 2 — Train LSTM autoencoder (PC/Colab)

Script mẫu (chạy trên máy có TensorFlow, KHÔNG chạy trên Pi):

```python
import glob, numpy as np, pandas as pd, tensorflow as tf

WINDOW = 20  # phải khớp param 'window' của node
FEATURES = ['tgt0','rpm0','err0','tgt1','rpm1','err1',
            'tgt2','rpm2','err2','tgt3','rpm3','err3','current_a','power_w']

# 1) Nạp toàn bộ CSV baseline
df = pd.concat([pd.read_csv(f) for f in glob.glob('motor_health/*.csv')])
X = df[FEATURES].values.astype('float32')

# 2) Chuẩn hóa (lưu lại mean/std để dùng khi suy luận nếu cần)
mean, std = X.mean(0), X.std(0) + 1e-6
Xn = (X - mean) / std

# 3) Cắt cửa sổ trượt -> (N, WINDOW, 14)
seqs = np.stack([Xn[i:i+WINDOW] for i in range(len(Xn)-WINDOW)])

# 4) LSTM autoencoder
n_feat = len(FEATURES)
model = tf.keras.Sequential([
    tf.keras.layers.Input((WINDOW, n_feat)),
    tf.keras.layers.LSTM(32, activation='tanh', return_sequences=False),
    tf.keras.layers.RepeatVector(WINDOW),
    tf.keras.layers.LSTM(32, activation='tanh', return_sequences=True),
    tf.keras.layers.TimeDistributed(tf.keras.layers.Dense(n_feat)),
])
model.compile(optimizer='adam', loss='mse')
model.fit(seqs, seqs, epochs=50, batch_size=64, validation_split=0.1)

# 5) Chọn ngưỡng: ví dụ phân vị 99% của lỗi tái tạo trên tập baseline
recon = model.predict(seqs)
errs = np.mean((recon - seqs)**2, axis=(1,2))
print('Ngưỡng gợi ý (p99):', float(np.percentile(errs, 99)))
```

## Bước 3 — Export sang TFLite

```python
conv = tf.lite.TFLiteConverter.from_keras_model(model)
conv.optimizations = [tf.lite.Optimize.DEFAULT]
open('motor_ae.tflite', 'wb').write(conv.convert())
```

> Lưu ý: node hiện dựng input dạng `(1, WINDOW, 14)` **chưa chuẩn hóa**. Nếu bạn
> train có chuẩn hóa, hãy huấn luyện thêm 1 lớp `Normalization` vào đầu model
> (đưa mean/std vào graph) để suy luận trên Pi không cần scale thủ công.

## Bước 4 — Deploy về Pi

```bash
# Cài runtime (1 lần)
cd services/robot && ./install-motor-health.sh

# Copy model
scp motor_ae.tflite pi@robot:~/robot_ws/models/

# Chạy với model + ngưỡng đã chọn
ros2 run my_robot_controller motor_health_node --ros-args \
  -p model_path:=~/robot_ws/models/motor_ae.tflite \
  -p recon_threshold:=0.08 \
  -p window:=20
# hoặc qua PM2:
ENABLE_MOTOR_HEALTH=1 MOTOR_HEALTH_MODEL=~/robot_ws/models/motor_ae.tflite ./deploy.sh
```

## Tham số node

| Param | Mặc định | Ý nghĩa |
|---|---|---|
| `collection_mode` | `false` | Ghi CSV thay vì cảnh báo |
| `data_dir` | `~/robot_ws/motor_health` | Nơi ghi CSV |
| `model_path` | `""` | `.tflite` autoencoder (rỗng = chỉ rule-based) |
| `window` | `20` | Độ dài cửa sổ (phải khớp lúc train) |
| `recon_threshold` | `0.08` | Ngưỡng lỗi tái tạo để báo động |
| `sample_hz` | `5.0` | Tần số lấy mẫu đặc trưng |
| `stall_rpm_frac` | `0.25` | `|rpm| < frac*|tgt|` ⇒ nghi stall |
| `stall_min_tgt` | `40.0` | Bỏ qua stall khi `|tgt|` quá nhỏ |
| `overcurrent_a` | `8.0` | Ngưỡng cảnh báo dòng pack (A) |
| `min_alert_interval` | `5.0` | Giãn cách giữa các cảnh báo (s) |

## Theo dõi

```bash
ros2 topic echo /motor_health_alerts
```
Payload: `{"stamp":..., "alerts":[{"motor":0,"type":"stall",...}], "recon_error":0.12}`.

