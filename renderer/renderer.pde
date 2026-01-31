/*
  PEmbroider Web App — Renderer (Aspect-safe + global scale + headless window hidden)

  Input: job folder passed as args[0]
    job/
      spec.json
      layers/*.png
      out/

  Output:
    out/design.pes
    out/preview.png
*/

import processing.embroider.*;
import java.io.File;

PEmbroiderGraphics E;

JSONObject spec;
String jobDir;
String layersDir;
String outDir;

int W = 800;
int H = 800;

void settings() {
  // We must create a surface for Processing, but we will hide it in setup().
  size(W, H);
  pixelDensity(1);
}

void setup() {
  noLoop();

  // 1) Job folder
  jobDir = (args != null && args.length > 0) ? args[0] : "";
  if (jobDir == null || jobDir.trim().length() == 0) {
    println("ERROR: No job folder provided. Run with: -- <jobFolder>");
    exit();
    return;
  }

  layersDir = jobDir + File.separator + "layers";
  outDir    = jobDir + File.separator + "out";
  new File(outDir).mkdirs();

  // 2) Load spec.json
  String specPath = jobDir + File.separator + "spec.json";
  spec = loadJSONObject(specPath);
  if (spec == null) {
    println("ERROR: Could not load spec.json at: " + specPath);
    exit();
    return;
  }

  // 3) Canvas size from spec
  if (spec.hasKey("width"))  W = spec.getInt("width");
  if (spec.hasKey("height")) H = spec.getInt("height");

  if (W != width || H != height) {
    surface.setSize(W, H);
  }

  // ---- HEADLESS: hide the Processing window ----
  // This prevents windows popping up when the server renders jobs.
  // (The sketch still renders to the canvas and can save images.)
  try {
    surface.setVisible(false);
  } catch (Exception e) {
    // If a platform doesn't support hiding, ignore.
    println("WARN: Could not hide surface: " + e);
  }

  // 4) Global scale (0.1..1.0)
  float designScale = 1.0;
  if (spec.hasKey("designScale")) {
    designScale = constrain(spec.getFloat("designScale"), 0.1, 1.0);
  }
  // Optional auto-downscale to avoid OOM in optimization
  boolean autoDownscale = true;
  if (spec.hasKey("autoDownscale")) {
    autoDownscale = spec.getBoolean("autoDownscale");
  }
  if (autoDownscale) {
    float maxPixels = 1000000.0;
    int maxDim = 1200;
    if (spec.hasKey("maxPixels")) {
      maxPixels = max(100000.0, spec.getFloat("maxPixels"));
    }
    if (spec.hasKey("maxDimension")) {
      maxDim = max(400, spec.getInt("maxDimension"));
    }
    float scaleByPixels = sqrt(maxPixels / (W * (float)H));
    float scaleByDim = min(maxDim / (float)W, maxDim / (float)H);
    float capScale = min(scaleByPixels, scaleByDim);
    if (capScale < 1.0) {
      float oldScale = designScale;
      designScale = max(0.1, min(designScale, capScale));
      if (designScale < oldScale) {
        println("Auto-downscale: " + oldScale + " -> " + designScale);
      }
    }
  }

  // 5) Output config
  String filenameBase = "design";
  String format = "pes";

  if (spec.hasKey("output")) {
    JSONObject out = spec.getJSONObject("output");
    if (out != null) {
      if (out.hasKey("filename")) filenameBase = out.getString("filename");
      if (out.hasKey("format"))   format = out.getString("format").toLowerCase();
    }
  }

  // 6) Setup PEmbroider
  E = new PEmbroiderGraphics(this, W, H);
  String outputFilePath = outDir + File.separator + filenameBase + "." + format;
  E.setPath(outputFilePath);

  // 7) Render
  E.beginDraw();
  E.clear();
  E.noStroke();

  JSONArray layers = spec.getJSONArray("layers");
  if (layers == null || layers.size() == 0) {
    println("ERROR: spec.json must include a non-empty layers[] array.");
    E.endDraw();
    exit();
    return;
  }

  for (int i = 0; i < layers.size(); i++) {
    JSONObject L = layers.getJSONObject(i);
    renderLayer(E, L, designScale);
  }

  // Optimize (can be slow and memory-hungry on large designs)
  boolean doOptimize = true;
  if (spec.hasKey("optimize")) {
    doOptimize = spec.getBoolean("optimize");
  }
  if (doOptimize) {
    int polyCount = E.polylines != null ? E.polylines.size() : 0;
    int stitchCount = 0;
    if (E.polylines != null) {
      for (int i = 0; i < E.polylines.size(); i++) {
        stitchCount += E.polylines.get(i).size();
      }
    }
    int maxPolys = 2000;
    int maxStitches = 150000;
    if (spec.hasKey("optimizeMaxPolylines")) {
      maxPolys = max(200, spec.getInt("optimizeMaxPolylines"));
    }
    if (spec.hasKey("optimizeMaxStitches")) {
      maxStitches = max(10000, spec.getInt("optimizeMaxStitches"));
    }
    String fallback = spec.hasKey("optimizeFallback") ? spec.getString("optimizeFallback") : "fast";
    boolean overLimit = polyCount > maxPolys || stitchCount > maxStitches;
    if (overLimit) {
      println("Optimize limit hit. polylines=" + polyCount + " stitches=" + stitchCount);
      if (fallback != null && fallback.toLowerCase().trim().equals("skip")) {
        doOptimize = false;
      }
    }
  }
  if (doOptimize) {
    int trials = 2;
    int maxIter = 400;
    if (spec.hasKey("optimizeLevel")) {
      String level = spec.getString("optimizeLevel");
      if (level != null) {
        level = level.toLowerCase().trim();
        if (level.equals("fast")) {
          trials = 1;
          maxIter = 200;
        } else if (level.equals("thorough")) {
          trials = 5;
          maxIter = 999;
        }
      }
    }
    if (spec.hasKey("optimizeFallback")) {
      String fallback = spec.getString("optimizeFallback");
      if (fallback != null && fallback.toLowerCase().trim().equals("fast")) {
        trials = min(trials, 1);
        maxIter = min(maxIter, 200);
      }
    }
    if (spec.hasKey("optimizeTrials")) {
      trials = max(1, spec.getInt("optimizeTrials"));
    }
    if (spec.hasKey("optimizeMaxIter")) {
      maxIter = max(50, spec.getInt("optimizeMaxIter"));
    }
    E.optimize(trials, maxIter);
  }

  // Preview image (draws to the Processing canvas even if hidden)
  E.visualize(true, true, true);

  // Save the preview deterministically (no frame numbering)
  save(outDir + File.separator + "preview.png");

  E.endDraw();

  println("DONE.");
  println("Embroidery: " + outputFilePath);
  println("Preview:    " + outDir + File.separator + "preview.png");

  exit();
}

/* -----------------------------
   Layer rendering
--------------------------------*/

void renderLayer(PEmbroiderGraphics E, JSONObject L, float designScale) {
  if (L == null || !L.hasKey("file")) {
    println("WARN: layer missing 'file'.");
    return;
  }

  String file = L.getString("file");
  String p = layersDir + File.separator + file;

  PImage img = loadImage(p);
  if (img == null) {
    println("WARN: Could not load layer image: " + p);
    return;
  }

  // Threshold/mask (recommended for student uploads)
  boolean thresholdEnabled = L.hasKey("thresholdEnabled") ? L.getBoolean("thresholdEnabled") : true;
  int threshold = L.hasKey("threshold") ? L.getInt("threshold") : 128;

  if (thresholdEnabled) {
    img = toMask(img, threshold);
  }

  // Fit into canvas WITHOUT stretching; apply global designScale; center on black
  img = fitContainOnBlack(img, W, H, designScale);

  // Pattern / hatch mode
  int hatchMode = parseHatchMode(L.hasKey("pattern") ? L.getString("pattern") : "PARALLEL");
  E.hatchMode(hatchMode);

  // Spacing
  float spacing = L.hasKey("spacing") ? L.getFloat("spacing") : 4.0;
  E.HATCH_SPACING = spacing;
  E.hatchSpacing(spacing);

  // Angles (degrees in spec)
  if (L.hasKey("angles")) {
    JSONArray a = L.getJSONArray("angles");
    if (a != null && a.size() >= 1) E.HATCH_ANGLE  = radians(a.getFloat(0));
    if (a != null && a.size() >= 2) E.HATCH_ANGLE2 = radians(a.getFloat(1));
  } else {
    E.HATCH_ANGLE  = radians(0);
    E.HATCH_ANGLE2 = radians(90);
  }

  // Stitch params
  if (L.hasKey("stitch")) {
    JSONArray s = L.getJSONArray("stitch");
    if (s != null && s.size() >= 2) {
      float len = s.getFloat(0);
      float gap = s.getFloat(1);
      float jit = (s.size() >= 3) ? s.getFloat(2) : 0.0;
      E.setStitch(len, gap, jit);
    }
  }

  // Thread colour
  int r = 0, g = 0, b = 0;
  if (L.hasKey("color")) {
    JSONArray c = L.getJSONArray("color");
    if (c != null && c.size() >= 3) {
      r = int(c.getFloat(0));
      g = int(c.getFloat(1));
      b = int(c.getFloat(2));
    }
  }
  E.fill(r, g, b);

  // Draw onto embroidery
  E.image(img, 0, 0);
}

/* -----------------------------
   Utilities
--------------------------------*/

PImage toMask(PImage src, int threshold) {
  // Convert image (including transparency) into a hard black/white mask.
  // Transparent pixels become black.
  PImage m = src.copy();
  m.loadPixels();
  for (int i = 0; i < m.pixels.length; i++) {
    int c = m.pixels[i];
    float a = alpha(c) / 255.0;
    float v = brightness(c) * a; // fade brightness by alpha
    m.pixels[i] = (v > threshold) ? color(255) : color(0);
  }
  m.updatePixels();
  return m;
}

PImage fitContainOnBlack(PImage src, int targetW, int targetH, float designScale) {
  // Scale to fit inside target while preserving aspect ratio,
  // then apply an extra global designScale (0.1–1.0),
  // center it, with black padding.

  float sx = targetW / (float)src.width;
  float sy = targetH / (float)src.height;
  float sContain = min(sx, sy);

  float s = sContain * designScale;

  int newW = max(1, round(src.width * s));
  int newH = max(1, round(src.height * s));

  int x = (targetW - newW) / 2;
  int y = (targetH - newH) / 2;

  PGraphics pg = createGraphics(targetW, targetH);
  pg.beginDraw();
  pg.background(0);
  pg.imageMode(CORNER);
  pg.noSmooth(); // helps keep masks crisp
  pg.image(src, x, y, newW, newH);
  pg.endDraw();

  return pg.get();
}

int parseHatchMode(String name) {
  if (name == null) return PEmbroiderGraphics.PARALLEL;
  name = name.trim().toUpperCase();

  if (name.equals("CROSS"))      return PEmbroiderGraphics.CROSS;
  if (name.equals("CONCENTRIC")) return PEmbroiderGraphics.CONCENTRIC;
  if (name.equals("PARALLEL"))   return PEmbroiderGraphics.PARALLEL;
  if (name.equals("SATIN"))      return PEmbroiderGraphics.SATIN;
  if (name.equals("SPIRAL"))     return PEmbroiderGraphics.SPIRAL;
  if (name.equals("PERLIN"))     return PEmbroiderGraphics.PERLIN;

  println("WARN: Unknown pattern '" + name + "'. Using PARALLEL.");
  return PEmbroiderGraphics.PARALLEL;
}
