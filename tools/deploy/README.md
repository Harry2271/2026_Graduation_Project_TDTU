# Deploy — Native Build on Raspberry Pi 5 (Ubuntu 24.04 LTS)

Each project is its **own GitHub repo**, cloned independently on the Pi.

## Repos & Clone Paths

| Project | GitHub Repo | Clone Path |
|---|---|---|
| Backend (NestJS) | `nguyen-tdtu` | `/home/pi/nguyen-tdtu` |
| Frontend (Next.js) | `nguyen-web-app` | `/home/pi/nguyen-web-app` |
| Mobile App (Expo) | `nguyen-mobile-app` | `/home/pi/nguyen-mobile-app` |
| Robot Controller (ROS 2) | `robot-controller` | `/home/pi/robot-controller` |

Each repo contains:
- `deploy.sh` — deployment script (auto + manual mode)
- `ecosystem.json` — PM2 config (backend + frontend only)
- `.github/workflows/deploy.yml` — CI/CD (GitHub Actions → Pi)

## CI/CD Flow

```
Push to master
     │
     ├── nguyen-tdtu:    GitHub builds → artifact to Pi → PM2 restart
     ├── nguyen-web-app: GitHub builds → artifact to Pi → PM2 restart
     ├── nguyen-mobile-app: GitHub lints → EAS builds APK (GitHub)
     └── robot-controller: GitHub lints → Pi pulls + colcon build
```

## One-Time Pi Setup

```bash
# 1. Install all dependencies (run once as root)
sudo ./deploy/scripts/install-pi.sh
# Log out and reconnect to refresh shell

# 2. Clone each repo
git clone <backend-repo>  /home/pi/nguyen-tdtu
git clone <frontend-repo> /home/pi/nguyen-web-app
git clone <mobile-repo>    /home/pi/nguyen-mobile-app
git clone <robot-repo>     /home/pi/robot-controller

# 3. Manual deploy each project
cd /home/pi/nguyen-tdtu       && ./deploy.sh manual
cd /home/pi/nguyen-web-app    && ./deploy.sh manual
cd /home/pi/nguyen-mobile-app && ./deploy.sh manual
cd /home/pi/robot-controller  && ./deploy.sh

# 4. Auto-start on boot
pm2 startup   # run the printed command with sudo
pm2 save
```

## Deploy Scripts

### Auto mode (CI/CD — artifact already downloaded)
```bash
./deploy.sh          # backend / frontend: install deps + PM2 restart
```

### Manual mode (on Pi — pull + build)
```bash
./deploy.sh manual    # backend: git pull + yarn build + install + PM2
./deploy.sh manual    # frontend: git pull + yarn build + install + PM2
./deploy.sh manual    # mobile: git pull + expo export + serve
./deploy.sh          # robot: git pull + colcon build + restart nodes
```

## Configuration

### Backend (`nguyen-tdtu/.env`)
```
PORT=5000
MONGO_URI=mongodb://localhost:27017/nguyen_tdtu
```

### Frontend (`nguyen-web-app/.env.local`)
```
NEXT_PUBLIC_API_BASE_URL=http://localhost:5000
NEXT_PUBLIC_WS_URL=ws://localhost:9091
```

### Mobile App Web (`nguyen-mobile-app/.env`)
```
EXPO_PUBLIC_API_BASE_URL=http://localhost:5000
EXPO_PUBLIC_CAMERA_STREAM_URL=http://localhost:8000/stream
```

### Robot (environment)
```bash
export LIDAR_MODEL=a1   # a1m8, a2m8, s2, s3...
```

## PM2 Commands

```bash
pm2 status
pm2 logs nguyen-backend
pm2 logs nguyen-frontend
pm2 restart nguyen-backend
pm2 restart nguyen-frontend
pm2 save
pm2 startup
```

## Ports

| Service | Port |
|---|---|
| Backend API | `5000` |
| Frontend Web | `3000` |
| Robot WebSocket | `9091` |
| Mobile App Web | `3001` |

## Logs

| Service | Location |
|---|---|
| Backend | `pm2 logs nguyen-backend` |
| Frontend | `pm2 logs nguyen-frontend` |
| Robot | `/var/log/robot/*.log` |
