# Stage 1: Build frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build the backend + C++ engine into a venv (build toolchain never reaches the
# final image - it compiles acm_engine, but nothing in the final stage needs a compiler).
FROM ubuntu:22.04 AS backend-builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ .

# Compiles the acm_engine C++ extension (OpenMP via GCC) and installs satellite_api into the venv
RUN pip install --no-cache-dir . \
    && python3 -c "import acm_engine; assert hasattr(acm_engine, 'process_conjunctions')"

# Stage 3: Runtime image - no compiler, no headers, non-root user.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/app/data \
    FRONTEND_DIST=/app/frontend_dist \
    PATH="/opt/venv/bin:$PATH"

# python3 to run the venv's interpreter, libgomp1 for the OpenMP runtime the compiled
# extension links against, curl for the HEALTHCHECK - no compiler or dev headers here.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    libgomp1 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1000 acm \
    && useradd --system --uid 1000 --gid acm --home-dir /app --shell /usr/sbin/nologin acm

COPY --from=backend-builder /opt/venv /opt/venv

WORKDIR /app
COPY backend/data ./data
COPY --from=frontend-builder /app/frontend/dist /app/frontend_dist

RUN mkdir -p /app/data && chown -R acm:acm /app

USER acm

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD curl -f http://localhost:8000/health || exit 1

# --workers must stay 1: StateManager is an in-process singleton, so >1 uvicorn worker inside
# a single container silently duplicates/corrupts the simulation (see satellite_api/state.py).
# To scale beyond one process, run multiple *containers* of this same image against a shared
# REDIS_URL instead - RedisStateManager's leader election (state_redis.py) ensures only one
# replica runs the autopilot/screening loops at a time while the rest serve reads.
CMD ["python3", "-m", "uvicorn", "satellite_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
