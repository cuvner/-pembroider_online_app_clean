FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
  openjdk-17-jre \
  xvfb \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---- Install Processing from ZIP already in the repo ----
WORKDIR /opt
COPY vendor/processing.zip /opt/processing.zip

RUN set -eux; \
  rm -rf /opt/processing_unpack /opt/processing; \
  mkdir -p /opt/processing_unpack; \
  unzip -q /opt/processing.zip -d /opt/processing_unpack; \
  rm /opt/processing.zip; \
  echo "=== locating Processing binary ==="; \
  P="$(find /opt/processing_unpack -type f -name processing | head -n 1)"; \
  echo "Found: $P"; \
  test -n "$P"; \
  chmod +x "$P" || true; \
  ln -s "$(dirname "$P")" /opt/processing; \
  /opt/processing/processing --help || true

ENV PROCESSING_BIN=/opt/processing/processing
ENV PROCESSING_WRAPPER=xvfb-run
ENV PROCESSING_WRAPPER_ARGS=-a

WORKDIR /app
COPY . .

WORKDIR /app/web
RUN npm install && npm install sharp

RUN mkdir -p /app/jobs
ENV JOBS_ROOT=/app/jobs

EXPOSE 3000
CMD ["node", "server.js"]

