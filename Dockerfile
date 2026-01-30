# Dockerfile (repo root)
# Render deployment: Node + Java + Processing CLI + Xvfb (headless)
# Expects repo layout:
#   /web/server.js
#   /web/package.json
#   /renderer/renderer.pde
#   /jobs (created at runtime)

FROM node:20-bookworm

# ---- System deps: Java + Xvfb + download tools ----
RUN apt-get update && apt-get install -y \
  openjdk-17-jre \
  xvfb \
  wget \
  unzip \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# ---- Install Processing (Linux x64 portable) ----
WORKDIR /opt

# Processing 4.5.2 portable linux-x64 zip from official Processing releases on GitHub
RUN wget -O processing.zip \
    https://github.com/processing/processing4/releases/download/processing-1313-4.5.2/processing-4.5.2-linux-x64-portable.zip \
 && unzip processing.zip -d /opt \
 && rm processing.zip

# Processing installs into /opt/processing-4.5.2/processing-java (portable build)
ENV PROCESSING_BIN=/opt/processing-4.5.2/processing-java

# Headless wrapper (important on Render)
ENV PROCESSING_WRAPPER=xvfb-run
ENV PROCESSING_WRAPPER_ARGS=-a

# ---- App ----
WORKDIR /app
COPY . .

# Install Node deps for the server
WORKDIR /app/web
RUN npm install && npm install sharp

# Jobs directory inside container (Render uses ephemeral disk unless you add a persistent disk)
RUN mkdir -p /app/jobs

# Defaults (override in Render environment settings if desired)
ENV JOBS_ROOT=/app/jobs
ENV MAX_CONCURRENT=1
ENV MAX_FILES=6
ENV MAX_FILE_MB=10
ENV RENDER_TIMEOUT_MS=120000

# Render provides PORT env var, but we expose 3000 for local Docker runs
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]

