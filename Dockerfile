FROM node:20-bookworm-slim

# ---- System deps for Processing + headless rendering ----
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates wget unzip \
  xvfb xauth \
  libxi6 libxrender1 libxtst6 libxext6 libxrandr2 libxfixes3 libxinerama1 \
  libx11-xcb1 libxcomposite1 libxdamage1 libxkbcommon0 libxkbcommon-x11-0 \
  libxss1 libxshmfence1 \
  libglib2.0-0 libgtk-3-0 libatk1.0-0 libatk-bridge2.0-0 \
  libpango-1.0-0 libpangocairo-1.0-0 libcups2 \
  libnss3 libasound2 \
  libgbm1 libdrm2 libgl1 libgl1-mesa-dri libglx-mesa0 \
  fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# ---- Processing portable (Linux x64) ----
# Download bundle during build to avoid missing Git LFS assets in remote builders.
# Override the URL to pin a different version if needed.
ARG PROCESSING_ZIP_URL=https://github.com/processing/processing4/releases/download/processing-1313-4.5.2/processing-4.5.2-linux-x64-portable.zip
ARG PROCESSING_ZIP_SHA256=5d5ce0f5a59cffc86f12b49997184434f554ff546932323f148aad92626bc3ff
RUN set -eux; \
  wget -O /tmp/processing.zip "$PROCESSING_ZIP_URL"; \
  if [ -n "$PROCESSING_ZIP_SHA256" ]; then \
    echo "$PROCESSING_ZIP_SHA256  /tmp/processing.zip" | sha256sum -c -; \
  fi

RUN set -eux; \
  rm -rf /opt/processing_unpack; \
  mkdir -p /opt/processing_unpack; \
  unzip -q /tmp/processing.zip -d /opt/processing_unpack; \
  rm /tmp/processing.zip; \
  echo "=== locating Processing launcher ==="; \
  # Processing 4 portable bundles ship a launcher at Processing/bin/Processing
  PAPP="$(find /opt/processing_unpack -type f -path '*/bin/Processing' | head -n 1)"; \
  echo "Found Processing launcher: ${PAPP:-<none>}"; \
  test -n "$PAPP"; \
  chmod +x "$PAPP" || true; \
  PROCESSING_HOME="$(dirname "$(dirname "$PAPP")")"; \
  echo "Processing home: $PROCESSING_HOME"; \
  # Locate CLI runner (processing-java) for headless sketches
  PJAVA="$(find "$PROCESSING_HOME" -maxdepth 2 -type f -name 'processing-java' | head -n 1)"; \
  echo "Found processing-java: ${PJAVA:-<none>}"; \
  test -n "$PJAVA"; \
  chmod +x "$PJAVA" || true; \
  printf '%s\n' \
    '#!/bin/sh' \
    'APPDIR="'"$PROCESSING_HOME"'"' \
    'export APPDIR' \
    'export LD_LIBRARY_PATH="$APPDIR/lib:$LD_LIBRARY_PATH"' \
    'export JAVA_HOME="$APPDIR/lib/runtime"' \
    'exec "$APPDIR/bin/Processing" "$@"' \
    > /usr/local/bin/processing; \
  printf '%s\n' \
    '#!/bin/sh' \
    'APPDIR="'"$PROCESSING_HOME"'"' \
    'export APPDIR' \
    'export LD_LIBRARY_PATH="$APPDIR/lib:$LD_LIBRARY_PATH"' \
    'export JAVA_HOME="$APPDIR/lib/runtime"' \
    'exec "'"$PJAVA"'" "$@"' \
    > /usr/local/bin/processing-java; \
  chmod +x /usr/local/bin/processing; \
  chmod +x /usr/local/bin/processing-java; \
  /usr/local/bin/processing --help || true

# ---- Environment: headless + safer rendering ----
ENV NODE_ENV=production
ENV PORT=3000

ENV APP_ROOT=/app
ENV JOBS_ROOT=/app/jobs
ENV RENDERER_SKETCH=/app/renderer
ENV PROCESSING_SKETCHBOOK=/app/processing-libraries

# Use processing-java CLI for headless runs
ENV PROCESSING_BIN=/usr/local/bin/processing-java

# Use Xvfb wrapper
ENV PROCESSING_WRAPPER=xvfb-run
ENV PROCESSING_WRAPPER_ARGS=-a

# Reduce GPU/GL issues
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=false -Djava2d.opengl=false"

WORKDIR /app

# Install node deps
COPY web/package*.json /app/web/
RUN cd /app/web && npm ci --omit=dev

# Copy app + renderer + libraries
COPY renderer /app/renderer
COPY processing-libraries /app/processing-libraries
COPY web /app/web

RUN mkdir -p /app/jobs

EXPOSE 3000
CMD ["node", "/app/web/server.js"]
