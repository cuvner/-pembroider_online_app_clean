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
# Use vendored bundle to avoid remote fetch during build.
COPY vendor/processing.zip /tmp/processing.zip

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
  ln -sf "$PAPP" /usr/local/bin/processing; \
  echo "Symlinked /usr/local/bin/processing -> $PAPP"; \
  /usr/local/bin/processing --help || true

# ---- Environment: headless + safer rendering ----
ENV NODE_ENV=production
ENV PORT=3000

ENV APP_ROOT=/app
ENV JOBS_ROOT=/app/jobs
ENV RENDERER_SKETCH=/app/renderer
ENV PROCESSING_SKETCHBOOK=/app/processing-libraries

# Use the portable Processing launcher
ENV PROCESSING_BIN=/usr/local/bin/processing

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
