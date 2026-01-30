# ---- Base: Node + Debian (stable for Processing/Xvfb) ----
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

# ---- Processing portable ----
# NOTE: This is the correct asset name for linux x64 portable zip
ARG PROCESSING_ZIP_URL="https://github.com/processing/processing4/releases/download/processing-1313-4.5.2/processing-4.5.2-linux-x64-portable.zip"

RUN set -eux; \
  mkdir -p /opt/processing_unpack; \
  wget -O /tmp/processing.zip "$PROCESSING_ZIP_URL"; \
  unzip -q /tmp/processing.zip -d /opt/processing_unpack; \
  rm /tmp/processing.zip; \
  echo "=== locating processing-java ==="; \
  PJ="$(find /opt/processing_unpack -type f -name processing-java | head -n 1)"; \
  echo "Found processing-java at: ${PJ:-<none>}"; \
  test -n "$PJ"; \
  chmod +x "$PJ" || true; \
  ln -sf "$PJ" /usr/local/bin/processing-java; \
  /usr/local/bin/processing-java --help || true

# ---- Environment: headless + safer rendering ----
ENV NODE_ENV=production
ENV PORT=3000

# Where your app lives in the container
ENV APP_ROOT=/app
ENV JOBS_ROOT=/app/jobs
ENV RENDERER_SKETCH=/app/renderer
ENV PROCESSING_SKETCHBOOK=/app/processing-libraries

# Use processing-java (more reliable headless than GUI launcher)
ENV PROCESSING_BIN=/usr/local/bin/processing-java

# Use Xvfb wrapper
ENV PROCESSING_WRAPPER=xvfb-run
ENV PROCESSING_WRAPPER_ARGS=-a

# Reduce GPU/GL issues
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV JAVA_TOOL_OPTIONS="-Djava.awt.headless=true -Djava2d.opengl=false"

# ---- App files ----
WORKDIR /app

# Copy package files first for better Docker layer caching
COPY web/package*.json /app/web/
RUN cd /app/web && npm ci --omit=dev

# Copy the rest of the repo
# Expecting:
#   /renderer  (Processing sketch folder)
#   /processing-libraries/libraries/PEmbroider/...
#   /web/server.js
#   /web/public/index.html
COPY renderer /app/renderer
COPY processing-libraries /app/processing-libraries
COPY web /app/web

# Ensure jobs dir exists
RUN mkdir -p /app/jobs

# ---- Expose + Start ----
EXPOSE 3000

# Render expects your web service to bind PORT
CMD ["node", "/app/web/server.js"]
