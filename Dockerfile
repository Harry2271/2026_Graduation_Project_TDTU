FROM node:22-alpine

WORKDIR /app

# Set environment variables for production
ENV NODE_ENV production
ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

# Copy the standalone folder built by Next.js (Job 1 in CI)
# This includes the minimal node_modules required for production
COPY .next/standalone ./

# Standalone doesn't copy public or static files, so we copy them manually
COPY public ./public
COPY .next/static ./.next/static

# Start server using the generated server.js
CMD ["node", "server.js"]
