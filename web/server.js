import express from "express";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const app = express();

// Resolve paths relative to this server.js file (NOT process.cwd)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isMain = process.argv[1] === __filename;

/* -----------------------------
   Config (safe defaults)
--------------------------------*/

const PORT = process.env.PORT || 3000;

// Class access key (required for POST /api/jobs)
const CLASS_KEY = process.env.CLASS_KEY;
if (isMain && !CLASS_KEY) {
  console.error("Missing required env var: CLASS_KEY");
  process.exit(1);
}

// Sketchbook for Processing libraries
const PROCESSING_SKETCHBOOK =
  process.env.PROCESSING_SKETCHBOOK || "/app/processing-libraries";

// Paths (make them robust regardless of working directory)
const JOBS_ROOT = process.env.JOBS_ROOT || path.resolve(__dirname, "../jobs");
const RENDERER_SKETCH =
  process.env.RENDERER_SKETCH || path.resolve(__dirname, "../renderer");

// Processing (Dockerfile provides /usr/local/bin/processing-java)
const PROCESSING_BIN =
  process.env.PROCESSING_BIN || "/usr/local/bin/processing-java";
const PROCESSING_GUI =
  process.env.PROCESSING_GUI || "/usr/local/bin/processing";

// Headless wrapper (xvfb-run in Docker)
const PROCESSING_WRAPPER = process.env.PROCESSING_WRAPPER || null;
const PROCESSING_WRAPPER_ARGS = (process.env.PROCESSING_WRAPPER_ARGS || "")
  .split(" ")
  .filter(Boolean);

// Limits
const MAX_FILES = Number(process.env.MAX_FILES || 10);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 120_000);
const JOB_TTL_HOURS = Number(process.env.JOB_TTL_HOURS || 0);
const LOG_RENDERER_OUTPUT = process.env.LOG_RENDERER_OUTPUT === "1";
const RENDER_CONCURRENCY = Math.max(
  1,
  Number(process.env.RENDER_CONCURRENCY || 1)
);
const AUTO_CLEANUP_JOBS = process.env.AUTO_CLEANUP_JOBS === "1";
const AUTO_CLEANUP_DELAY_MS = Math.max(
  0,
  Number(process.env.AUTO_CLEANUP_DELAY_MS || 300_000)
);

// Ensure jobs root exists
fs.mkdirSync(JOBS_ROOT, { recursive: true });

/* -----------------------------
   Simple render queue
--------------------------------*/

const renderQueue = [];
let runningCount = 0;
const jobs = new Map();
const jobProcesses = new Map();

async function writeJobStatus(jobId, statusObj) {
  const jobDir = path.join(JOBS_ROOT, jobId);
  const statusPath = path.join(jobDir, "status.json");
  try {
    await fsp.writeFile(statusPath, JSON.stringify(statusObj), "utf-8");
  } catch {}
}

function withRenderSlot(id, fn) {
  return new Promise((resolve, reject) => {
    renderQueue.push({ id, fn, resolve, reject });
    drainQueue();
  });
}

function drainQueue() {
  while (runningCount < RENDER_CONCURRENCY && renderQueue.length > 0) {
    const job = renderQueue.shift();
    runningCount += 1;
    job
      .fn()
      .then((res) => job.resolve(res))
      .catch((err) => job.reject(err))
      .finally(() => {
        runningCount -= 1;
        drainQueue();
      });
  }
}

/* -----------------------------
   Auth middleware
--------------------------------*/

function requireClassKey(req, res, next) {
  const key = req.headers["x-class-key"];
  if (!key || key !== CLASS_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* -----------------------------
   Multer upload setup
--------------------------------*/

function sanitizeFilename(name) {
  const base = path.basename(name || "");
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^_+/, "");
  return cleaned || `file_${crypto.randomUUID()}.png`;
}

function uniqueName(dir, baseName) {
  const ext = path.extname(baseName);
  const stem = path.basename(baseName, ext);
  let candidate = baseName;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`;
    i += 1;
  }
  return candidate;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    cb(null, req.layersDir);
  },
  filename: (req, file, cb) => {
    const safe = sanitizeFilename(file.originalname);
    const unique = uniqueName(req.layersDir, safe);
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: {
    files: MAX_FILES,
    fileSize: MAX_FILE_MB * 1024 * 1024,
  },
});

/* -----------------------------
   Helpers
--------------------------------*/

function makeJobId() {
  return crypto.randomUUID();
}

function buildCmd(jobDir) {
  // processing-java does NOT use "cli"
  const args = [
    `--sketch=${RENDERER_SKETCH}`,
    "--run",
    jobDir,
  ];

  if (PROCESSING_WRAPPER) {
    return {
      cmd: PROCESSING_WRAPPER,
      args: [...PROCESSING_WRAPPER_ARGS, PROCESSING_BIN, ...args],
    };
  }
  return { cmd: PROCESSING_BIN, args };
}

async function cleanupJobs() {
  if (!JOB_TTL_HOURS || Number.isNaN(JOB_TTL_HOURS)) return;
  const cutoffMs = Date.now() - JOB_TTL_HOURS * 60 * 60 * 1000;
  const entries = await fsp.readdir(JOBS_ROOT, { withFileTypes: true });
  await Promise.all(
    entries.map(async (ent) => {
      if (!ent.isDirectory()) return;
      const dir = path.join(JOBS_ROOT, ent.name);
      try {
        const stat = await fsp.stat(dir);
        if (stat.mtimeMs < cutoffMs) {
          await fsp.rm(dir, { recursive: true, force: true });
        }
      } catch {}
    }),
  );
}

async function ensureJobDirs(req, res, next) {
  try {
    const jobId = makeJobId();
    const jobDir = path.join(JOBS_ROOT, jobId);
    const layersDir = path.join(jobDir, "layers");
    const outDir = path.join(jobDir, "out");

    await fsp.mkdir(layersDir, { recursive: true });
    await fsp.mkdir(outDir, { recursive: true });

    req.jobId = jobId;
    req.jobDir = jobDir;
    req.layersDir = layersDir;
    req.outDir = outDir;
    next();
  } catch (err) {
    res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}

/* -----------------------------
   Routes
--------------------------------*/

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    processingBin: PROCESSING_BIN,
    processingGui: PROCESSING_GUI,
    rendererSketch: RENDERER_SKETCH,
    jobsRoot: JOBS_ROOT,
    sketchbook: PROCESSING_SKETCHBOOK,
    wrapper: PROCESSING_WRAPPER,
  });
});

// (Optional) quiet favicon 404s
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Job creation
app.post(
  "/api/jobs",
  requireClassKey,
  ensureJobDirs,
  upload.array("files"),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      if (!req.body.spec) {
        return res.status(400).json({ error: "Missing spec" });
      }

      const { jobId, jobDir } = req;
      const statusUrl = `/api/jobs/${jobId}/status`;
      const pesUrl = `/api/jobs/${jobId}/design.pes`;
      const previewUrl = `/api/jobs/${jobId}/preview.png`;

      // Save spec.json
      const specPath = path.join(jobDir, "spec.json");

      // Validate spec.json BEFORE launching Processing
      let spec;
      try {
        spec = JSON.parse(req.body.spec);
      } catch (err) {
        return res.status(400).json({
          error: "spec.json is not valid JSON",
          message: err?.message || String(err),
        });
      }
      await fsp.writeFile(specPath, JSON.stringify(spec), "utf-8");

      jobs.set(jobId, {
        status: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        stdout: "",
        stderr: "",
        error: null,
      });
      await writeJobStatus(jobId, jobs.get(jobId));

      withRenderSlot(
        jobId,
        () =>
          new Promise((resolve) => {
            // Build renderer command
            const { cmd, args } = buildCmd(jobDir);
            console.log(`Renderer start: ${jobId}`);
            console.log(`Renderer cmd: ${[cmd, ...args].join(" ")}`);

            const job = jobs.get(jobId);
            if (job) {
              job.status = "running";
              job.updatedAt = Date.now();
              writeJobStatus(jobId, job).catch(() => {});
            }

            const child = spawn(cmd, args, {
              cwd: jobDir,
              stdio: ["ignore", "pipe", "pipe"],
              env: process.env, // keep env vars (JAVA_TOOL_OPTIONS, LIBGL_ALWAYS_SOFTWARE, etc.)
            });
            jobProcesses.set(jobId, child);

            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (d) => {
              const text = d.toString();
              stdout += text;
              if (LOG_RENDERER_OUTPUT) {
                console.log(`[renderer ${jobId} stdout] ${text}`.trimEnd());
              }
            });
            child.stderr.on("data", (d) => {
              const text = d.toString();
              stderr += text;
              if (LOG_RENDERER_OUTPUT) {
                console.log(`[renderer ${jobId} stderr] ${text}`.trimEnd());
              }
            });

            let timedOut = false;
            const timeout = setTimeout(() => {
              timedOut = true;
              child.kill("SIGKILL");
            }, RENDER_TIMEOUT_MS);

            child.on("error", (err) => {
              clearTimeout(timeout);
              if (job) {
                job.status = "error";
                job.updatedAt = Date.now();
                job.error = err?.message || String(err);
                job.stdout = stdout;
                job.stderr = stderr;
                writeJobStatus(jobId, job).catch(() => {});
              }
              jobProcesses.delete(jobId);
              resolve();
            });

            child.on("close", async (code) => {
              clearTimeout(timeout);

              if (code !== 0) {
                if (job) {
                  job.status = "error";
                  job.updatedAt = Date.now();
                  job.error = timedOut ? "Renderer timed out" : "Renderer failed";
                  job.exitCode = code;
                  job.cmd = [cmd, ...args].join(" ");
                  job.stdout = stdout;
                  job.stderr = stderr;
                  writeJobStatus(jobId, job).catch(() => {});
                }
              } else {
                if (job) {
                  job.status = "done";
                  job.updatedAt = Date.now();
                  job.stdout = stdout;
                  job.stderr = stderr;
                  writeJobStatus(jobId, job).catch(() => {});
                }
              }

              if (AUTO_CLEANUP_JOBS) {
                setTimeout(async () => {
                  try {
                    await fsp.rm(jobDir, { recursive: true, force: true });
                  } catch {}
                }, AUTO_CLEANUP_DELAY_MS).unref();
              }

              jobProcesses.delete(jobId);
              resolve();
            });
          })
      );

      return res.status(202).json({
        ok: true,
        jobId,
        statusUrl,
        pesUrl,
        previewUrl,
      });
    } catch (err) {
      res.status(500).json({
        error: "Server error",
        message: err?.message || String(err),
      });
    }
  },
);

// Job status
app.get("/api/jobs/:id/status", (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  if (!job) {
    const jobDir = path.join(JOBS_ROOT, jobId);
    const statusPath = path.join(jobDir, "status.json");
    const outDir = path.join(jobDir, "out");
    const pesPath = path.join(outDir, "design.pes");
    const previewPath = path.join(outDir, "preview.png");
    if (fs.existsSync(statusPath)) {
      try {
        const raw = fs.readFileSync(statusPath, "utf-8");
        const saved = JSON.parse(raw);
        if (saved.status === "error") {
          return res.json({
            status: "error",
            message: saved.error || "Renderer failed",
            exitCode: saved.exitCode,
            cmd: saved.cmd,
            stderr: saved.stderr,
            stdout: saved.stdout,
            stale: true,
          });
        }
        if (saved.status === "done") {
          return res.json({
            status: "done",
            previewUrl: `/api/jobs/${jobId}/preview.png`,
            pesUrl: `/api/jobs/${jobId}/design.pes`,
            stale: true,
          });
        }
        return res.json({ status: saved.status || "running", stale: true });
      } catch {}
    }
    if (fs.existsSync(pesPath) && fs.existsSync(previewPath)) {
      return res.json({
        status: "done",
        previewUrl: `/api/jobs/${jobId}/preview.png`,
        pesUrl: `/api/jobs/${jobId}/design.pes`,
        stale: true,
      });
    }
    if (fs.existsSync(jobDir)) {
      return res.json({ status: "running", stale: true });
    }
    return res.status(404).json({ error: "Unknown job" });
  }

  const queuedIndex = renderQueue.findIndex((q) => q.id === jobId);
  const queuePosition = queuedIndex >= 0 ? queuedIndex + 1 : null;

  if (job.status === "error") {
    return res.json({
      status: "error",
      message: job.error || "Renderer failed",
      exitCode: job.exitCode,
      cmd: job.cmd,
      stderr: job.stderr,
      stdout: job.stdout,
    });
  }

  if (job.status === "done") {
    return res.json({
      status: "done",
      previewUrl: `/api/jobs/${req.params.id}/preview.png`,
      pesUrl: `/api/jobs/${req.params.id}/design.pes`,
    });
  }

  return res.json({
    status: job.status,
    queuePosition,
  });
});

// Cancel job
app.post("/api/jobs/:id/cancel", requireClassKey, (req, res) => {
  const jobId = req.params.id;
  const job = jobs.get(jobId);
  const child = jobProcesses.get(jobId);

  if (child) {
    try {
      child.kill("SIGKILL");
    } catch {}
    jobProcesses.delete(jobId);
  }

  // Remove from queue if not running yet
  const queuedIndex = renderQueue.findIndex((q) => q.id === jobId);
  if (queuedIndex >= 0) {
    renderQueue.splice(queuedIndex, 1);
  }

  if (job) {
    job.status = "canceled";
    job.updatedAt = Date.now();
    writeJobStatus(jobId, job).catch(() => {});
  }

  return res.json({ ok: true, status: "canceled" });
});

// Download outputs
app.get("/api/jobs/:id/:file", async (req, res) => {
  const filePath = path.join(JOBS_ROOT, req.params.id, "out", req.params.file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
  }
  res.sendFile(filePath);
});

// Serve frontend (robust absolute path)
app.use(express.static(path.resolve(__dirname, "public")));

/* -----------------------------
   Start server
--------------------------------*/

if (isMain) {
  app.listen(PORT, () => {
    console.log(`PEmbroider server running on port ${PORT}`);
    console.log(`Processing binary: ${PROCESSING_BIN}`);
    console.log(`Processing GUI: ${PROCESSING_GUI}`);
    console.log(`Renderer sketch: ${RENDERER_SKETCH}`);
    console.log(`Jobs root: ${JOBS_ROOT}`);
    console.log(`Sketchbook: ${PROCESSING_SKETCHBOOK}`);
  });
}

// Optional periodic cleanup
if (JOB_TTL_HOURS && !Number.isNaN(JOB_TTL_HOURS)) {
  cleanupJobs();
  setInterval(cleanupJobs, 60 * 60 * 1000).unref();
}

export { sanitizeFilename, uniqueName };
