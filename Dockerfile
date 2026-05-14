FROM node:22-alpine

WORKDIR /app

# Copy các file cấu hình
COPY package.json yarn.lock ./

# Chỉ cài các thư viện phục vụ cho Production (Bỏ qua devDependencies cho nhẹ)
RUN yarn install --production --frozen-lockfile

# Copy thư mục .next đã được GitHub build sẵn ở Job 1 vào
COPY .next ./.next
# Copy thư mục public cho các static assets (hình ảnh, favicon...)
COPY public ./public

# Lệnh khởi động server Next.js (chạy production)
CMD ["yarn", "start"]
