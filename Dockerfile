# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend + serve static frontend
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    curl \
    python3 \
    python3-pip \
    python3-dev \
    libomp-dev \
    nginx \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY . .

RUN pip3 install .

# Copy built frontend from stage 1
COPY --from=frontend-builder /app/frontend/dist /var/www/html

# Configure nginx to serve frontend and proxy API
RUN echo 'server { \
    listen 80; \
    location / { \
        root /var/www/html; \
        try_files $uri /index.html; \
    } \
    location /api/ { \
        proxy_pass http://localhost:8000; \
        proxy_set_header Host $host; \
    } \
}' > /etc/nginx/sites-enabled/default

EXPOSE 80

HEALTHCHECK --interval=5s --timeout=3s \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["sh", "-c", "nginx && uvicorn satellite_api.main:app --host 0.0.0.0 --port 8000 --workers 1"]