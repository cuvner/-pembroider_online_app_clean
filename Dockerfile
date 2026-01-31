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
# Use Processing 3.5.4 to keep processing-java CLI support.
ARG PROCESSING_ARCHIVE_URL=https://github.com/processing/processing/releases/download/processing-0270-3.5.4/processing-3.5.4-linux64.tgz
ARG PROCESSING_ARCHIVE_SHA256=
RUN set -eux; \
  wget -O /tmp/processing.tgz "$PROCESSING_ARCHIVE_URL"; \
  if [ -n "$PROCESSING_ARCHIVE_SHA256" ]; then \
    echo "$PROCESSING_ARCHIVE_SHA256  /tmp/processing.tgz" | sha256sum -c -; \
  fi

RUN set -eux; \
  rm -rf /opt/processing_unpack; \
  mkdir -p /opt/processing_unpack; \
  tar -xzf /tmp/processing.tgz -C /opt/processing_unpack; \
  rm /tmp/processing.tgz; \
  echo "=== locating Processing CLI ==="; \
  PJAVA="$(find /opt/processing_unpack -type f -name 'processing-java' | head -n 1)"; \
  echo "Found processing-java: ${PJAVA:-<none>}"; \
  test -n "$PJAVA"; \
  chmod +x "$PJAVA" || true; \
  PROCESSING_HOME="$(dirname "$PJAVA")"; \
  echo "Processing home: $PROCESSING_HOME"; \
  PAPP="$PROCESSING_HOME/processing"; \
  echo "Found Processing launcher: ${PAPP:-<none>}"; \
  test -n "$PAPP"; \
  chmod +x "$PAPP" || true; \
  printf '%s\n' \
    '#!/bin/sh' \
    'APPDIR="'"$PROCESSING_HOME"'"' \
    'export APPDIR' \
    'export LD_LIBRARY_PATH="$APPDIR/lib:$LD_LIBRARY_PATH"' \
    'export JAVA_HOME="$APPDIR/lib/runtime"' \
    'exec "$APPDIR/processing" "$@"' \
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
ENV HOME=/app

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

RUN mkdir -p /app/sketchbook /app/.processing \
  && ln -sfn /app/processing-libraries/libraries /app/sketchbook/libraries \
  && printf '%s\n' "sketchbook.path=/app/processing-libraries" > /app/.processing/preferences.txt

RUN mkdir -p /app/jobs

EXPOSE 3000
CMD ["node", "/app/web/server.js"]
