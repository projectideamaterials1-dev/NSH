# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Backend (serves the API and the built dashboard on port 8000)
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    FRONTEND_DIST=/app/frontend_dist

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    python3 \
    python3-pip \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

COPY backend/ .

# Compiles the acm_engine C++ extension (OpenMP via GCC) and installs satellite_api
RUN pip3 install --no-cache-dir . \
    && python3 -c "import acm_engine; assert hasattr(acm_engine, 'process_conjunctions')"

COPY --from=frontend-builder /app/frontend/dist /app/frontend_dist

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD curl -f http://localhost:8000/health || exit 1

CMD ["uvicorn", "satellite_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
