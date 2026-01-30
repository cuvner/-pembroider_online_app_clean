FROM node:20-bookworm

RUN apt-get update && apt-get install -y \
  openjdk-17-jre \
  xvfb \
  curl \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# --- Processing zip comes from an environment variable ---
# Set this in Render: PROCESSING_ZIP_URL=<direct-download-url>
ARG PROCESSING_ZIP_URL
ENV PROCESSING_ZIP_URL=${PROCESSING_ZIP_URL}

WORKDIR /opt
RUN set -eux; \
  test -n "$PROCESSING_ZIP_URL"; \
  curl -L --fail --retry 10 --retry-delay 2 --retry-all-errors \
    -o /opt/processing.zip "$PROCESSING_ZIP_URL"; \
  rm -rf /opt/processing_unpack /opt/processing; \
  mkdir -p /opt/processing_unpack; \
  unzip -q /opt/processing.zip -d /opt/processing_unpack; \
  rm /opt/processing.zip; \
  P="$(find /opt/processing_unpack -type f -name processing | head -n 1)"; \
  echo "Found processing binary: $P"; \
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

