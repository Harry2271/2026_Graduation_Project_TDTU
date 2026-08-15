# Bao cao diem dang nghi: Web khong nhan LiDAR

**Pham vi:** Chi ghi nhan chan doan, khong thay doi ma nguon hay cau hinh.

## 1. Ket luan uu tien cao nhat

Kiem tra endpoint public hien tai tra ve:

```text
https://map.nguyen-robot.io.vn
HTTP/1.1 530
Server: cloudflare
```

HTTP 530 cho thay lop public tunnel/proxy khong ket noi duoc toi origin phia Raspberry Pi. Dashboard mac dinh ket noi raw WebSocket den:

```text
wss://map.nguyen-robot.io.vn
```

Vi vay, du LiDAR va ROS tren Pi van tao `/scan`, browser van khong the nhan du lieu neu domain public khong route duoc toi `web_bridge` port `9091`.

Day la diem dang nghi so mot vi da co bang chung truc tiep.

## 2. Chuoi du lieu can hoat dong

```text
RPLIDAR A1M8
  -> rplidar_ros
  -> /scan (sensor_msgs/msg/LaserScan)
  -> web_bridge.py
  -> WebSocket raw :9091
  -> public tunnel / reverse proxy
  -> wss://map.nguyen-robot.io.vn
  -> Browser map page
```

Voi SLAM map, chuoi them TF va map layer:

```text
/scan (frame: laser)
  -> TF laser -> base_link -> base_footprint
  -> slam_toolbox
  -> /map
  -> map_manager
  -> /map_combined
  -> web_bridge.py
  -> Browser
```

Build lai chi co ich khi dung artifact duoc build, dung process dang chay va network/tunnel van hoat dong.

## 3. Cac diem dang nghi theo thu tu uu tien

### 3.1. Public WebSocket domain loi 530

**Bang chung:** `map.nguyen-robot.io.vn` tra HTTP 530.

**Tac dong:** Browser khong the ket noi raw WebSocket, nen khong nhan scan, map, pose hay telemetry.

**Kiem tra tren Pi:**

```bash
sudo ss -ltnp | grep ':9091'
sudo lsof -nP -iTCP:9091 -sTCP:LISTEN

sudo systemctl status cloudflared --no-pager
sudo systemctl cat cloudflared
sudo grep -RniE 'map\.nguyen-robot\.io\.vn|9091|ingress|service:' \
  /etc/cloudflared /home/pi/.cloudflared 2>/dev/null
```

**Ket qua dung:**

- `web_bridge` listen tren `0.0.0.0:9091`.
- Tunnel map domain `map.nguyen-robot.io.vn` den `http://localhost:9091`.
- Tunnel giu WebSocket Upgrade va query string `?token=...`.

**Test bridge noi bo, khong qua domain public:**

```bash
curl -i --http1.1 \
  -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==' \
  http://127.0.0.1:9091/
```

- Tra `401` khi khong co token: bridge dang song, day la ket qua binh thuong.
- Khong ket noi duoc: bridge chua listen hoac dang crash.
- Local tra `401` nhung public van `530`: loi nam o Cloudflare Tunnel/reverse proxy, khong nam o LiDAR.

### 3.2. WebSocket bi tu choi do token

`web_bridge.py` fail-closed: neu khong co `WS_AUTH_TOKEN` hoac `ROBOT_BRAIN_TOKEN`, moi WebSocket handshake deu bi tu choi.

Frontend chi them `?token=...` khi `NEXT_PUBLIC_WS_AUTH_TOKEN` ton tai tai **thoi diem build**. `NEXT_PUBLIC_*` duoc nhung vao JavaScript bundle; restart container khong thay doi URL hay token da nhung.

**Kiem tra tren Pi:**

```bash
pm2 logs nexus-robot-web-bridge --lines 120 --nostream | \
  grep -E 'FATAL|rejected|token mismatch|Unauthorized|Server on'

pm2 show nexus-robot-web-bridge
```

**Dau hieu:**

- `no auth token configured`: bridge khong co token.
- `token mismatch`: token web khac token bridge.
- `invalid or missing auth token`: browser khong gui token.

**Kiem tra browser:** Mo DevTools -> Network -> WS.

- `401`: token sai/thieu.
- `530`: public tunnel loi.
- `101 Switching Protocols`: WebSocket da ket noi; tiep tuc kiem tra ROS `/scan`.

### 3.3. Deploy tu chon sai cong serial cho LiDAR

Startup hien tai tim thiet bi dau tien trong:

```text
/dev/ttyUSB* -> /dev/ttyACM*
```

No khong xac nhan day la LiDAR. Khi thu tu USB thay doi, driver co the mo ESP32 thay vi LiDAR. Build lai khong giai quyet duoc loi runtime nay.

**Kiem tra tren Pi:**

```bash
ls -l /dev/ttyUSB* /dev/ttyACM* /dev/robot-lidar /dev/robot-esp32
readlink -f /dev/robot-lidar
readlink -f /dev/robot-esp32
lsusb
sudo lsof /dev/ttyUSB0 /dev/ttyACM0 2>/dev/null
```

Can xac nhan cong ma process `nexus-robot-lidar` dang dung chinh la adapter cua RPLIDAR, khong phai ESP32.

### 3.4. Driver chay nhung `/scan` khong co message that

PM2 online hoac log co dong `current scan mode:` khong dong nghia browser co `LaserScan` hop le. Driver co the mo sai device, gap serial error, sai ROS domain hoac QoS khong tuong thich.

**Kiem tra tren Pi:**

```bash
source /opt/ros/jazzy/setup.bash
source ~/robot_ws/install/setup.bash
export ROS_DOMAIN_ID=0

pm2 status
pm2 logs nexus-robot-lidar --lines 100 --nostream

ros2 topic list | grep -x /scan
ros2 topic echo /scan --once
ros2 topic hz /scan
ros2 topic info --verbose /scan
```

**Dien giai:**

- Khong co `/scan`: driver, cong serial, permission, driver overlay hoac ROS domain loi.
- Co `/scan` khoang 5-12 Hz: LiDAR va ROS driver dang hoat dong.
- Co `/scan` nhung browser trong: loi nam o bridge, ROS domain, token hoac tunnel.

### 3.5. ROS_DOMAIN_ID tach LiDAR khoi web_bridge

LiDAR launch va SLAM launch ep `ROS_DOMAIN_ID=0`. `web_bridge` la PM2 process rieng. Neu PM2 daemon giu domain khac 0, bridge se khong thay `/scan` du terminal cua operator van thay scan o domain 0.

**Kiem tra process that:**

```bash
for name in nexus-robot-lidar nexus-robot-slam nexus-robot-map-manager nexus-robot-web-bridge; do
  pid=$(pm2 pid "$name")
  echo "== $name ($pid) =="
  sudo tr '\0' '\n' < "/proc/$pid/environ" | grep '^ROS_DOMAIN_ID=' || echo 'ROS_DOMAIN_ID unset'
done

export ROS_DOMAIN_ID=0
ros2 topic info --verbose /scan
ros2 node info /web_bridge
```

Can dam bao LiDAR va `web_bridge` o cung DDS domain.

### 3.6. QoS cua `/scan` khong tuong thich voi web_bridge

`web_bridge` dung default ROS subscription cho `/scan`. Driver upstream nam ngoai repository nay; neu publisher dung sensor-data/best-effort va subscriber reliable, callback cua bridge co the khong bao gio duoc goi.

**Kiem tra:**

```bash
export ROS_DOMAIN_ID=0
ros2 topic info --verbose /scan
ros2 node info /web_bridge
```

Can xem publisher/subscriber co bao `incompatible QoS` hay khong, dac biet `reliability`.

### 3.7. TF hong lam SLAM map trong, nhung khong giai thich mat raw scan

`web_bridge` subscribe truc tiep `/scan` va gui type `scan` cho browser. Raw scan khong can TF de hien thi scan-only.

Vi vay:

- `/scan` co, browser nhan type `scan`, nhung khong co `/map`: can kiem tra TF/SLAM.
- Browser khong nhan bat ky type `scan` nao: uu tien tunnel, token, ROS domain, QoS hoac bridge.

Kiem tra TF va map khi `/scan` da co:

```bash
ros2 run tf2_ros tf2_echo base_footprint laser
ros2 topic echo /map --once
ros2 topic echo /map_combined --once
```

### 3.8. Pi co the dang chay code/branch khac voi code vua build

Workflow deploy chi trigger push vao `master`. Neu sua o branch khac, Pi co the van dang chay source cu trong `~/robot_ws/src/my_robot_controller` hoac checkout cu trong repository.

**Kiem tra tren Pi:**

```bash
cd /path/to/robot-for-nguyen
git branch --show-current
git rev-parse HEAD
git log -1 --oneline

grep -n 'base_footprint_to_base_link' \
  services/robot/src/my_robot_controller/urdf/agv.urdf.xacro \
  ~/robot_ws/src/my_robot_controller/urdf/agv.urdf.xacro
```

Build thanh cong o may khac khong dong nghia Pi dang chay dung commit hoac dung overlay ROS moi.

### 3.9. Browser bundle co URL/token cu

`NEXT_PUBLIC_WS_URL` va `NEXT_PUBLIC_WS_AUTH_TOKEN` duoc gan khi build Web image. Restart `nguyen-web` hoac restart Pi khong cap nhat cac gia tri nay neu khong build lai image voi dung build args.

**Kiem tra tren Pi:**

```bash
docker compose config | sed -n '/web:/,/^[^ ]/p'
docker inspect nguyen-web --format '{{.Image}} {{.Created}}'
docker compose logs --tail=100 web

docker exec nguyen-web sh -lc \
  "grep -Rao 'wss://[^\"'\"' ]*' /app/apps/web/.next/static 2>/dev/null | head -20"
```

Can doi chieu URL trong bundle voi domain dang duoc cau hinh va kiem tra browser Network WS co query token hay khong.

## 4. Thu tu chan doan khuyen nghi

1. Kiem tra browser DevTools Network -> WS de lay status code (`530`, `401`, `101`, hoac close code).
2. Kiem tra `cloudflared` va listener local port `9091`.
3. Kiem tra log `nexus-robot-web-bridge` va environment token cua PM2 process.
4. Kiem tra `/scan` trong `ROS_DOMAIN_ID=0`.
5. Kiem tra subscriber/QoS cua `/scan` va domain cua web bridge.
6. Kiem tra cong serial thuc te cua LiDAR.
7. Khi `/scan` va WebSocket da dung, moi kiem tra TF, `/map` va `/map_combined`.

## 5. Cach ket luan nhanh theo ket qua

| Ket qua | Ket luan |
|---|---|
| Public WS tra `530`, local `9091` tra `401` | Tunnel/proxy loi |
| Public WS tra `401` | Token web/bridge sai hoac thieu |
| Khong co `/scan` | Driver, port serial, permission, driver build hoac ROS domain loi |
| Co `/scan`, web_bridge khong co subscriber/match | ROS domain hoac QoS loi |
| Co `/scan`, bridge match, WS `101`, nhung khong co scan frame | Can xem log bridge va queue/callback |
| Co scan frame, khong co map/pose | TF, slam_toolbox hoac map_manager loi |

## 6. Ket luan

Tai thoi diem lap bao cao, bang chung manh nhat la endpoint public `map.nguyen-robot.io.vn` dang tra Cloudflare `530`. Day la du de giai thich browser khong nhan LiDAR du LiDAR van tot tren PC va ROS co the da build thanh cong.

Khong nen tiep tuc build lai lien tuc truoc khi hoan tat chuoi kiem tra theo Muc 4. Can phan biet ro: LiDAR hardware, ROS `/scan`, web bridge local, token, ROS domain va public tunnel la nam tang doc lap.
