import express from "express";
import multer from "multer";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import { spawn } from "child_process";

const app = express();

/* -----------------------------
   Config (safe defaults)
--------------------------------*/

const PORT = process.env.PORT || 3000;

// Class access key (required for POST /api/jobs)
const CLASS_KEY = process.env.CLASS_KEY || "changeme";

// Paths
const JOBS_ROOT = process.env.JOBS_ROOT || path.resolve("./jobs");
const RENDERER_SKETCH =
  process.env.RENDERER_SKETCH || path.resolve("./renderer");

// Processing
const PROCESSING_BIN =
  process.env.PROCESSING_BIN || "/usr/local/bin/processing";

// Headless wrapper (xvfb-run in Docker)
const PROCESSING_WRAPPER = process.env.PROCESSING_WRAPPER || null;
const PROCESSING_WRAPPER_ARGS = (process.env.PROCESSING_WRAPPER_ARGS || "")
  .split(" ")
  .filter(Boolean);

// Limits
const MAX_FILES = Number(process.env.MAX_FILES || 10);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 10);
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_MS || 120_000);

// Ensure jobs root exists
fs.mkdirSync(JOBS_ROOT, { recursive: true });

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

const upload = multer({
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
  // Processing 4 REQUIRES "cli"
  const args = ["cli", `--sketch=${RENDERER_SKETCH}`, "--run", "--", jobDir];

  if (PROCESSING_WRAPPER) {
    return {
      cmd: PROCESSING_WRAPPER,
      args: [...PROCESSING_WRAPPER_ARGS, PROCESSING_BIN, ...args],
    };
  }
  return { cmd: PROCESSING_BIN, args };
}

/* -----------------------------
   Routes
--------------------------------*/

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Job creation
app.post(
  "/api/jobs",
  requireClassKey,
  upload.array("files"),
  async (req, res) => {
    try {
      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files uploaded" });
      }

      const jobId = makeJobId();
      const jobDir = path.join(JOBS_ROOT, jobId);
      const layersDir = path.join(jobDir, "layers");
      const outDir = path.join(jobDir, "out");

      await fsp.mkdir(layersDir, { recursive: true });
      await fsp.mkdir(outDir, { recursive: true });

      // Save uploaded PNGs
      for (const f of req.files) {
        const dest = path.join(layersDir, f.originalname);
        await fsp.writeFile(dest, f.buffer);
      }

      // Save spec.json
      if (!req.body.spec) {
        return res.status(400).json({ error: "Missing spec" });
      }

      const specPath = path.join(jobDir, "spec.json");
      await fsp.writeFile(specPath, req.body.spec, "utf-8");

      // Validate spec.json BEFORE launching Processing
      const specText = await fsp.readFile(specPath, "utf-8");
      const first = specText.trim()[0];
      if (first !== "{" && first !== "[") {
        return res.status(500).json({
          error: "spec.json is not valid JSON",
          preview: specText.slice(0, 200),
        });
      }

      // Build renderer command
      const { cmd, args } = buildCmd(jobDir);

      const child = spawn(cmd, args, {
        cwd: jobDir,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
      }, RENDER_TIMEOUT_MS);

      child.on("close", async (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          return res.status(500).json({
            error: "Renderer failed",
            exitCode: code,
            cmd: [cmd, ...args].join(" "),
            stdout,
            stderr,
          });
        }

        // Success
        res.json({
          ok: true,
          jobId,
          files: {
            pes: `/api/jobs/${jobId}/design.pes`,
            preview: `/api/jobs/${jobId}/preview.png`,
          },
        });
      });
    } catch (err) {
      res.status(500).json({
        error: "Server error",
        message: err?.message || String(err),
      });
    }
  }
);

// Download outputs
app.get("/api/jobs/:id/:file", async (req, res) => {
  const filePath = path.join(
    JOBS_ROOT,
    req.params.id,
    "out",
    req.params.file
  );
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Not found");
  }
  res.sendFile(filePath);
});

// Serve frontend
app.use(express.static("public"));

/* -----------------------------
   Start server
--------------------------------*/

app.listen(PORT, () => {
  console.log(`PEmbroider server running on port ${PORT}`);
  console.log(`Processing binary: ${PROCESSING_BIN}`);
  console.log(`Renderer sketch: ${RENDERER_SKETCH}`);
});

