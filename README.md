# PEmbroider Web Service

This repository contains a web UI and a Processing-based renderer for generating embroidery files from layered PNGs.

## Local development (Docker)

Build the image:
```
docker build -t pembroider .
```

Run the service:
```
docker run --rm -p 3000:3000 -e CLASS_KEY=dev pembroider
```

Open the UI at `http://localhost:3000` and use `dev` as the class key.

## API

- `POST /api/jobs` (multipart)
  - Headers: `x-class-key: <CLASS_KEY>`
  - Form fields:
    - `files`: one or more PNGs
    - `spec`: JSON string
  - Response (success):
    - `previewUrl`: PNG preview
    - `pesUrl`: PES download

- `GET /api/jobs/:id/:file`
  - Download `preview.png` or `design.pes`

- `GET /api/health`
  - Health info and Processing binary paths

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

## Processing version

The Dockerfile uses Processing 3.5.4 so the `processing-java` CLI flags work.
If you need to change versions, update the `PROCESSING_ARCHIVE_URL` build arg.

