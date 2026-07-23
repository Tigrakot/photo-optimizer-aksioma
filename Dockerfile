# Railway Dockerfile
FROM node:20-slim

# Install sharp dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Railway exposes PORT env
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
