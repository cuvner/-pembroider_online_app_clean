// web/server.js
import express from "express";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";
import multer from "multer";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const app = express();

// --------------------
// Env / Config
// --------------------
const PORT = Number(process.env.PORT || 3000);

// Jobs root (inside container: /app/jobs)
const JOBS_ROOT = process.env.JOBS_ROOT || "/app/jobs";

// Renderer sketch folder (inside container: /app/renderer)
const RENDERER_SKETCH = process.env.RENDERER_SKETCH || "/app/renderer";

// Processing binary wrapper created in Docker: /usr/local/bin/processing
const PROCESSING_BIN = process.env.PROCESSING_BIN || "/usr/local/bin/processing";

// Headless wrapper (Render)
const PROCESSING_WRAPPER = process.env.PROCESSING_WRAPPER || "xvfb-run";
const PROCESSING_WRAPPER_ARGS = (process.env.PROCESSING_WRAPPER_ARGS || "-a")
  .split(" ")
  .filter(Boolean);

// Auth
const CLASS_KEY = (process.env.CLASS_KEY || "").trim();
const REQUIRE_CLASS_KEY = CLASS_KEY.length > 0;

// Limits
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 1);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 120000);
const MAX_FILES = Number(process.env.MAX_FILES || 10);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// Cleanup old jobs
const KEEP_JOBS_HOURS = Number(process.env.KEEP_JOBS_HOURS || 24);

// --------------------
// Paths
// --------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");

// --------------------
// Middleware
// --------------------
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

function authMiddleware(req, res, next) {
  if (!REQUIRE_CLASS_KEY) return next();

  const key = (req.headers["x-class-key"] || "").toString().trim();
  if (!key || key !== CLASS_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function safeBaseName(filename) {
  return path
    .basename(filename)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

async function fileExists(p) {
  try {
    await fsp.access(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function uuid() {
  return crypto.randomUUID();
}

// --------------------
// Concurrency gate
// --------------------
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

// --------------------
// Multer upload (memory)
// --------------------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_BYTES,
    files: MAX_FILES,
  },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "image/png" ||
      file.originalname.toLowerCase().endsWith(".png");
    cb(ok ? null : new Error("Only PNG files allowed"), ok);
  },
});

// --------------------
// Processing command builder (Processing 4 CLI)
// --------------------
function buildCmd(jobDir) {
  // IMPORTANT: Processing 4 uses subcommand "cli"
  // processing cli --sketch=/app/renderer --run -- /app/jobs/<jobId>
  const args = ["cli", `--sketch=${RENDERER_SKETCH}`, "--run", "--", jobDir];

  if (PROCESSING_WRAPPER && PROCESSING_WRAPPER.trim().length > 0) {
    return {
      cmd: PROCESSING_WRAPPER,
      args: [...PROCESSING_WRAPPER_ARGS, PROCESSING_BIN, ...args],
    };
  }

  return { cmd: PROCESSING_BIN, args };
}

// --------------------
// Cleanup
// --------------------
async function cleanupOldJobs() {
  try {
    const entries = await fsp.readdir(JOBS_ROOT, { withFileTypes: true });
    const cutoff = Date.now() - KEEP_JOBS_HOURS * 3600 * 1000;

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(JOBS_ROOT, e.name);
      try {
        const st = await fsp.stat(p);
        if (st.mtimeMs < cutoff) {
          await fsp.rm(p, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

// --------------------
// Routes
// --------------------
app.get("/health", async (req, res) => {
  res.json({
    ok: true,
    PORT,
    JOBS_ROOT,
    RENDERER_SKETCH,
    PROCESSING_BIN,
    PROCESSING_WRAPPER,
    PROCESSING_WRAPPER_ARGS,
    REQUIRE_CLASS_KEY,
    MAX_CONCURRENT,
    active,
  });
});

// Generate embroidery
app.post(
  "/api/generate",
  authMiddleware,
  upload.array("files", MAX_FILES),
  async (req, res) => {
    await withConcurrency(async () => {
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

        // Save PNGs
        const savedNames = [];
        for (const f of files) {
          const name = safeBaseName(f.originalname || `layer-${savedNames.length}.png`);
          await fsp.writeFile(path.join(layersDir, name), f.buffer);
          savedNames.push(name);
        }

        // Spec JSON (optional)
        let spec = null;
        if (req.body && req.body.spec) {
          try {
            spec = JSON.parse(req.body.spec);
          } catch {
            return res.status(400).json({ error: "Invalid spec JSON" });
          }
        }

        // If no spec provided, build a usable default
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
          // If spec has layers, ensure files exist
          if (spec.layers && Array.isArray(spec.layers)) {
            for (const L of spec.layers) {
              if (!L.file) continue;
              if (!savedNames.includes(L.file)) {
                return res.status(400).json({
                  error: `spec.layers references missing file: ${L.file}`,
                  uploaded: savedNames,
                });
              }
            }
          }
        }

        // Write spec.json
        const specPath = path.join(jobDir, "spec.json");
        await fsp.writeFile(specPath, JSON.stringify(spec, null, 2), "utf-8");

        // Validate spec.json looks like JSON before calling Processing
        const specText = await fsp.readFile(specPath, "utf-8");
        const first = (specText || "").trim()[0];
        if (first !== "{" && first !== "[") {
          return res.status(500).json({
            error: "spec.json is not valid JSON (unexpected contents)",
            specPath,
            firstChar: first || "<empty>",
            head: specText.slice(0, 200),
          });
        }

        // Spawn Processing renderer
        const { cmd, args } = buildCmd(jobDir);
        const cmdString = [cmd, ...args].join(" ");

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
            cmd: cmdString,
            stdout,
            stderr,
          });
        }

        if (exitCode !== 0) {
          return res.status(500).json({
            error: `Renderer failed (exit ${exitCode})`,
            cmd: cmdString,
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
            cmd: cmdString,
            stdout,
            stderr,
            expected: { previewPath, pesPath },
            exists: { hasPreview, hasPes },
          });
        }

        // Success
        res.json({
          ok: true,
          jobId,
          previewUrl: `/api/job/${jobId}/preview`,
          pesUrl: `/api/job/${jobId}/pes`,
        });

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

// Serve preview
app.get("/api/job/:id/preview", authMiddleware, async (req, res) => {
  const previewPath = path.join(JOBS_ROOT, req.params.id, "out", "preview.png");
  if (!(await fileExists(previewPath))) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "image/png");
  fs.createReadStream(previewPath).pipe(res);
});

// Serve PES
app.get("/api/job/:id/pes", authMiddleware, async (req, res) => {
  const pesPath = path.join(JOBS_ROOT, req.params.id, "out", "design.pes");
  if (!(await fileExists(pesPath))) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="design-${req.params.id}.pes"`
  );
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
  console.log(
    `[server] WRAPPER=${PROCESSING_WRAPPER} ${PROCESSING_WRAPPER_ARGS.join(" ")}`
  );
  console.log(`[server] REQUIRE_CLASS_KEY=${REQUIRE_CLASS_KEY}`);
});

