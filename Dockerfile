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
  echo "=== searching for Processing launchers ==="; \
  CAND="$(find /opt/processing_unpack -type f \( -name processing -o -name Processing -o -name processing-java \) | head -n 1 || true)"; \
  echo "Found candidate: ${CAND:-<none>}"; \
  if [ -z "$CAND" ]; then \
    echo "ERROR: No Processing launcher found"; \
    find /opt/processing_unpack -maxdepth 4 -type f | head -n 200; \
    exit 1; \
  fi; \
  chmod +x "$CAND" || true; \
  ln -s "$(dirname "$CAND")" /opt/processing; \
  echo "=== /opt/processing contents ==="; \
  ls -la /opt/processing; \
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$CAND" > /usr/local/bin/processing; \
  chmod +x /usr/local/bin/processing; \
  /usr/local/bin/processing --help || true

ENV PROCESSING_BIN=/usr/local/bin/processing
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

