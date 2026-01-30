// web/server.js
// PEmbroider Online App server (Render/Docker friendly)
// - Express server + upload -> Processing CLI renderer
// - Headless via xvfb-run
// - Simple class-key gate (shared secret)

import express from "express";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";
import multer from "multer";
import { spawn } from "child_process";

const app = express();

// --------------------
// Config (env)
// --------------------
const PORT = Number(process.env.PORT || 3000);

// Where to store per-job folders
const JOBS_ROOT = process.env.JOBS_ROOT || path.resolve(process.cwd(), "../jobs");

// Processing runner
// We create /usr/local/bin/processing in Docker, so default this:
const PROCESSING_BIN = process.env.PROCESSING_BIN || "/usr/local/bin/processing";
const RENDERER_SKETCH =
  process.env.RENDERER_SKETCH || "/app/renderer"; // renderer sketch folder inside container

// Wrapper for headless (Render needs this)
const PROCESSING_WRAPPER = process.env.PROCESSING_WRAPPER || "xvfb-run";
const PROCESSING_WRAPPER_ARGS = (process.env.PROCESSING_WRAPPER_ARGS || "-a")
  .split(" ")
  .filter(Boolean);

// Security: shared class key
const CLASS_KEY = process.env.CLASS_KEY || ""; // if empty => no auth
const REQUIRE_CLASS_KEY = CLASS_KEY.trim().length > 0;

// Limits
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 120000);
const MAX_FILES = Number(process.env.MAX_FILES || 10);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// Cleanup
const KEEP_JOBS_HOURS = Number(process.env.KEEP_JOBS_HOURS || 24);

// --------------------
// Helpers
// --------------------
function uuid() {
  return crypto.randomUUID();
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

function safeBaseName(filename) {
  // keep only safe chars, prevent path traversal
  return path
    .basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

function nowISO() {
  return new Date().toISOString();
}

function authMiddleware(req, res, next) {
  if (!REQUIRE_CLASS_KEY) return next();

  const headerKey = (req.headers["x-class-key"] || "").toString().trim();
  if (!headerKey || headerKey !== CLASS_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// Simple concurrency gate (queue)
let active = 0;
const queue = [];
async function withConcurrency(fn) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve) => queue.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}

function buildCmd(jobDir) {
  // Processing 4 CLI invocation (IMPORTANT):
  // processing cli --sketch=<sketch> --run -- <jobDir>
  const args = ["cli", `--sketch=${RENDERER_SKETCH}`, "--run", "--", jobDir];

  // Headless wrapper (xvfb-run -a ...)
  if (PROCESSING_WRAPPER && PROCESSING_WRAPPER.trim().length > 0) {
    return {
      cmd: PROCESSING_WRAPPER,
      args: [...PROCESSING_WRAPPER_ARGS, PROCESSING_BIN, ...args],
    };
  }

  return { cmd: PROCESSING_BIN, args };
}

async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function cleanupOldJobs() {
  try {
    const entries = await fsp.readdir(JOBS_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - KEEP_JOBS_HOURS * 3600 * 1000;

    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const jobPath = path.join(JOBS_ROOT, e.name);
          try {
            const stat = await fsp.stat(jobPath);
            if (stat.mtimeMs < cutoff) {
              await fsp.rm(jobPath, { recursive: true, force: true });
            }
          } catch {
            // ignore
          }
        })
    );
  } catch {
    // ignore
  }
}

// --------------------
// Static frontend
// --------------------
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const publicDir = path.join(__dirname, "public");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(publicDir));

// --------------------
// Multer upload
// --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
  },
  fileFilter: (req, file, cb) => {
    // Accept PNG only
    const ok =
      file.mimetype === "image/png" ||
      file.originalname.toLowerCase().endsWith(".png");
    cb(ok ? null : new Error("Only PNG files allowed"), ok);
  },
});

// --------------------
// Routes
// --------------------
app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    time: nowISO(),
    jobsRoot: JOBS_ROOT,
    rendererSketch: RENDERER_SKETCH,
    processingBin: PROCESSING_BIN,
    wrapper: PROCESSING_WRAPPER,
    active,
    maxConcurrent: MAX_CONCURRENT,
    requireClassKey: REQUIRE_CLASS_KEY,
  });
});

app.post(
  "/api/generate",
  authMiddleware,
  upload.array("files", MAX_FILES),
  async (req, res) => {
    // Wrap the whole job in concurrency limiter
    await withConcurrency(async () => {
      const started = Date.now();
      const jobId = uuid();
      const jobDir = path.join(JOBS_ROOT, jobId);
      const layersDir = path.join(jobDir, "layers");
      const outDir = path.join(jobDir, "out");

      try {
        await ensureDir(layersDir);
        await ensureDir(outDir);

        const files = req.files || [];
        if (!Array.isArray(files) || files.length === 0) {
          return res.status(400).json({ error: "No PNG files uploaded" });
        }

        // Optional JSON spec from client (string)
        // If your frontend sends a "spec" field, parse it; else make a minimal spec.
        let spec = null;
        if (req.body && req.body.spec) {
          try {
            spec = JSON.parse(req.body.spec);
          } catch (e) {
            return res.status(400).json({ error: "Invalid spec JSON" });
          }
        }

        // Save uploaded PNGs into layers/
        const savedNames = [];
        for (const f of files) {
          const name = safeBaseName(f.originalname || `layer-${savedNames.length}.png`);
          const dst = path.join(layersDir, name);
          await fsp.writeFile(dst, f.buffer);
          savedNames.push(name);
        }

        // If no spec provided, build a minimal one mapping layers in order
        if (!spec) {
          spec = {
            width: 800,
            height: 800,
            designScale: 1.0,
            output: { filename: "design", format: "pes" },
            layers: savedNames.map((fn) => ({
              file: fn,
              pattern: "PARALLEL",
              spacing: 4.0,
              angles: [0, 90],
              stitch: [10, 20, 0],
              color: [0, 0, 0],
              thresholdEnabled: true,
              threshold: 128,
            })),
          };
        } else {
          // Ensure spec references files that exist
          if (!spec.layers || !Array.isArray(spec.layers) || spec.layers.length === 0) {
            return res.status(400).json({ error: "spec.layers[] must be a non-empty array" });
          }
        }

        // Write spec.json
        await fsp.writeFile(
          path.join(jobDir, "spec.json"),
          JSON.stringify(spec, null, 2),
          "utf-8"
        );

        // Run renderer
        const { cmd, args } = buildCmd(jobDir);

        const child = spawn(cmd, args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: process.env,
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));

        const killedByTimeout = await new Promise((resolve) => {
          const t = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {}
            resolve(true);
          }, RENDER_TIMEOUT_MS);

          child.on("close", () => {
            clearTimeout(t);
            resolve(false);
          });
        });

        const exitCode = child.exitCode;

        if (killedByTimeout) {
          return res.status(500).json({
            error: `Renderer timed out after ${RENDER_TIMEOUT_MS}ms`,
            cmd: [cmd, ...args].join(" "),
            stdout,
            stderr,
          });
        }

        if (exitCode !== 0) {
          return res.status(500).json({
            error: `Renderer failed (exit ${exitCode})`,
            cmd: [cmd, ...args].join(" "),
            stdout,
            stderr,
          });
        }

        // Expected outputs
        const previewPath = path.join(outDir, "preview.png");
        const pesPath = path.join(outDir, "design.pes");

        const hasPreview = await fileExists(previewPath);
        const hasPes = await fileExists(pesPath);

        if (!hasPreview || !hasPes) {
          return res.status(500).json({
            error: "Renderer finished but outputs missing",
            cmd: [cmd, ...args].join(" "),
            stdout,
            stderr,
            expected: { previewPath, pesPath },
            exists: { hasPreview, hasPes },
          });
        }

        const durationMs = Date.now() - started;
        res.json({
          ok: true,
          jobId,
          durationMs,
          previewUrl: `/api/job/${jobId}/preview`,
          pesUrl: `/api/job/${jobId}/pes`,
        });

        // opportunistic cleanup
        cleanupOldJobs();
      } catch (err) {
        res.status(500).json({
          error: "Server error",
          details: err?.message || String(err),
        });
      }
    });
  }
);

app.get("/api/job/:id/preview", authMiddleware, async (req, res) => {
  const jobId = req.params.id;
  const previewPath = path.join(JOBS_ROOT, jobId, "out", "preview.png");
  if (!(await fileExists(previewPath))) {
    return res.status(404).send("Not found");
  }
  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(previewPath).pipe(res);
});

app.get("/api/job/:id/pes", authMiddleware, async (req, res) => {
  const jobId = req.params.id;
  const pesPath = path.join(JOBS_ROOT, jobId, "out", "design.pes");
  if (!(await fileExists(pesPath))) {
    return res.status(404).send("Not found");
  }
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="design-${jobId}.pes"`);
  fs.createReadStream(pesPath).pipe(res);
});

// --------------------
// Start
// --------------------
await ensureDir(JOBS_ROOT);

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  console.log(`[server] JOBS_ROOT=${JOBS_ROOT}`);
  console.log(`[server] RENDERER_SKETCH=${RENDERER_SKETCH}`);
  console.log(`[server] PROCESSING_BIN=${PROCESSING_BIN}`);
  console.log(`[server] PROCESSING_WRAPPER=${PROCESSING_WRAPPER} ${PROCESSING_WRAPPER_ARGS.join(" ")}`);
  console.log(`[server] REQUIRE_CLASS_KEY=${REQUIRE_CLASS_KEY}`);
  console.log(`[server] MAX_CONCURRENT=${MAX_CONCURRENT}`);
});

