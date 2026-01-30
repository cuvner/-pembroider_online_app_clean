FROM node:20-bookworm-slim

# ---- System deps for Processing + headless rendering ----
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates wget unzip \
  xvfb xauth \
  libxi6 libxrender1 libxtst6 libxext6 libxrandr2 libxfixes3 libxinerama1 \
  libglib2.0-0 libgtk-3-0 \
  libnss3 libasound2 \
  libgbm1 libdrm2 \
  fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# ---- Processing portable (Linux x64) ----
ARG PROCESSING_ZIP_URL="https://github.com/processing/processing4/releases/download/processing-1313-4.5.2/processing-4.5.2-linux-x64-portable.zip"

RUN set -eux; \
  rm -rf /opt/processing_unpack; \
  mkdir -p /opt/processing_unpack; \
  wget -O /tmp/processing.zip "$PROCESSING_ZIP_URL"; \
  unzip -q /tmp/processing.zip -d /opt/processing_unpack; \
  rm /tmp/processing.zip; \
  echo "=== locating Processing launcher ==="; \
  # Find a file literally named 'processing' (not directories)
  P="$(find /opt/processing_unpack -type f -name processing | head -n 1)"; \
  echo "Found: ${P:-<none>}"; \
  test -n "$P"; \
  chmod +x "$P" || true; \
  ln -sf "$P" /usr/local/bin/processing; \
  echo "Symlinked /usr/local/bin/processing -> $P"; \
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
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -Djava2d.opengl=false"

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
