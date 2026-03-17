# STRICT PDF CONSTRAINT: Must use ubuntu:22.04 base image
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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies FIRST to leverage Docker caching
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Copy the entire project into the container
COPY . .

# 🚀 CRITICAL FIX: Use pip to install the C++ extension globally inside the container
# This guarantees 'import acm_engine' works anywhere in the app.
RUN pip3 install .

# STRICT PDF CONSTRAINT: Export Port 8000
EXPOSE 8000

# Healthcheck to ensure the container is routing properly
HEALTHCHECK --interval=5s --timeout=3s \
  CMD curl -f http://localhost:8000/health || exit 1

# Start the FastAPI server bound to 0.0.0.0
CMD ["uvicorn", "satellite_api.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]