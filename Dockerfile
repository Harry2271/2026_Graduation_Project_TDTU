FROM node:22-alpine

WORKDIR /app

# Set environment variables for production
ENV NODE_ENV production
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# Vì Job 1 đã chuẩn bị sẵn cấu trúc thư mục chuẩn trong artifact,
# chúng ta chỉ cần copy toàn bộ vào container.
COPY . .

# Start server using the generated server.js
CMD ["node", "server.js"]
