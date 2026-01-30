FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
  openjdk-17-jre \
  xvfb \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt
COPY vendor/processing.zip /opt/processing.zip

RUN set -eux; \
  rm -rf /opt/processing_unpack /opt/processing; \
  mkdir -p /opt/processing_unpack; \
  unzip -q /opt/processing.zip -d /opt/processing_unpack; \
  rm /opt/processing.zip; \
  echo "=== top-level after unzip ==="; \
  ls -la /opt/processing_unpack; \
  echo "=== searching for CLI binaries ==="; \
  CAND="$(find /opt/processing_unpack -type f \( -name processing -o -name Processing -o -name processing-java \) | head -n 1 || true)"; \
  echo "Found candidate: ${CAND:-<none>}"; \
  if [ -z "$CAND" ]; then \
    echo "ERROR: No CLI binary found. Showing a sample of files:"; \
    find /opt/processing_unpack -maxdepth 4 -type f | head -n 200; \
    exit 1; \
  fi; \
  chmod +x "$CAND" || true; \
  ln -s "$(dirname "$CAND")" /opt/processing; \
  echo "=== /opt/processing contents ==="; \
  ls -la /opt/processing

ENV PROCESSING_WRAPPER=xvfb-run
ENV PROCESSING_WRAPPER_ARGS=-a

# Default — we may change this after we see which binary was found
ENV PROCESSING_BIN=/opt/processing/processing

WORKDIR /app
COPY . .

WORKDIR /app/web
RUN npm install && npm install sharp

RUN mkdir -p /app/jobs
ENV JOBS_ROOT=/app/jobs

EXPOSE 3000
CMD ["node", "server.js"]

