import express from "express";
import multer from "multer";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 3000;
const ACCESS_KEY = process.env.ACCESS_KEY || "";

// ---- simple access key middleware ----
app.use((req, res, next) => {
  if (!ACCESS_KEY) return next();
  if (!req.path.startsWith("/api")) return next();
  if (req.path.startsWith("/api/health")) return next();
  const key = req.headers["x-access-key"];
  if (!key || key !== ACCESS_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
});

const REPO_ROOT = path.resolve("..");
const JOBS_ROOT = process.env.JOBS_ROOT || path.join(REPO_ROOT, "jobs");
const RENDERER_SKETCH = process.env.RENDERER_SKETCH || path.join(REPO_ROOT, "renderer");

const PROCESSING_BIN = process.env.PROCESSING_BIN || "processing-java";
const PROCESSING_WRAPPER = process.env.PROCESSING_WRAPPER || "";
const PROCESSING_WRAPPER_ARGS = (process.env.PROCESSING_WRAPPER_ARGS || "").split(" ").filter(Boolean);

const upload = multer({ storage: multer.memoryStorage() });

app.use(express.static(path.join(process.cwd(), "public")));

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function buildCmd(jobDir) {
  const args = [`--sketch=${RENDERER_SKETCH}`, "--run", "--", jobDir];
  if (PROCESSING_WRAPPER) {
    return { cmd: PROCESSING_WRAPPER, args: [...PROCESSING_WRAPPER_ARGS, PROCESSING_BIN, ...args] };
  }
  return { cmd: PROCESSING_BIN, args };
}

function runRenderer(jobDir) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = buildCmd(jobDir);

    const child = spawn(cmd, args, { env: process.env });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("error", (e) => reject(new Error("spawn error: " + e.message)));

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ out, err });
      } else {
        const msg =
          `Renderer failed (exit ${code})\n` +
          `CMD: ${cmd} ${args.join(" ")}\n\n` +
          `STDOUT:\n${out}\n\nSTDERR:\n${err}`;
        reject(new Error(msg));
      }
    });
  });
}

app.post("/api/jobs", upload.array("files"), async (req, res) => {
  try {
    await ensureDir(JOBS_ROOT);

    const id = uuidv4();
    const jobDir = path.join(JOBS_ROOT, id);
    const layers = path.join(jobDir, "layers");
    const outDir = path.join(jobDir, "out");
    await ensureDir(layers);
    await ensureDir(outDir);

    const specRaw = req.body.spec;
    if (!specRaw) return res.status(400).json({ error: "Missing spec" });

    let spec;
    try {
      spec = JSON.parse(specRaw);
    } catch {
      return res.status(400).json({ error: "Spec is not valid JSON" });
    }

    // validate + save PNGs
    for (const f of req.files || []) {
      await sharp(f.buffer).metadata();
      await fs.writeFile(path.join(layers, f.originalname), f.buffer);
    }

    await fs.writeFile(path.join(jobDir, "spec.json"), JSON.stringify(spec, null, 2));

    // run renderer
    const logs = await runRenderer(jobDir);

    res.json({ id, ok: true, logs });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    processing: {
      PROCESSING_BIN,
      PROCESSING_WRAPPER,
      PROCESSING_WRAPPER_ARGS,
      RENDERER_SKETCH,
    },
    JOBS_ROOT,
    cwd: process.cwd(),
  });
});

app.listen(PORT, async () => {
  await ensureDir(JOBS_ROOT);
  console.log("Running on port", PORT);
  console.log("PROCESSING_BIN", PROCESSING_BIN);
  console.log("PROCESSING_WRAPPER", PROCESSING_WRAPPER || "(none)");
  console.log("RENDERER_SKETCH", RENDERER_SKETCH);
  console.log("JOBS_ROOT", JOBS_ROOT);
});

