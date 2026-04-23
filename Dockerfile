FROM node:22-alpine

WORKDIR /app

# Copy các file cấu hình
COPY package.json yarn.lock ./

# Chỉ cài các thư viện phục vụ cho Production (Bỏ qua devDependencies cho nhẹ)
RUN yarn install --production --frozen-lockfile

# Copy thư mục dist đã được GitHub build sẵn ở Job 1 vào
COPY dist ./dist

# Lệnh khởi động server NestJS
CMD ["node", "dist/main.js"]