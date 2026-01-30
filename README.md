# PEmbroider Web Service

This repository contains a simple web UI and a Processing-based renderer.

## Render deployment (Docker)

Render can build and run the service using the included `Dockerfile`.

Required environment variables:
- `CLASS_KEY`: shared access key required by `POST /api/jobs`.

Recommended environment variables:
- `JOB_TTL_HOURS`: set a TTL (in hours) for job cleanup. Example: `24`.
- `MAX_FILES`: max files per request (default 10).
- `MAX_FILE_MB`: max size per file in MB (default 10).

Health check:
- `GET /api/health`

Notes:
- Render disks are ephemeral. If you need outputs to persist, set a TTL
  and/or export results to external storage.

