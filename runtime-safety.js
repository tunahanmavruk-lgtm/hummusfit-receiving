const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function dataDirectory(localDirectory, env = process.env) {
  const railway = Boolean(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID);
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
  if (railway && !mount) throw new Error("Railway persistent volume is required; refusing ephemeral storage");
  const directory = path.resolve(env.DATA_DIR || mount || (fs.existsSync("/data") ? "/data" : localDirectory));
  if (railway && directory !== path.resolve(mount)) {
    throw new Error("DATA_DIR must match RAILWAY_VOLUME_MOUNT_PATH");
  }
  // Never create a missing mount or silently switch to the container filesystem.
  if (!fs.statSync(directory).isDirectory()) throw new Error("Data path is not a directory");
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
  return directory;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error; // Corrupt or unreadable operational data must never become an empty ledger.
  }
}

function writeJson(file, value) {
  const json = JSON.stringify(value, null, 2);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, json);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, file); // Same directory/filesystem: readers see the old or complete new file.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function listeningPort(value = process.env.PORT) {
  const port = value === undefined ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535");
  return port;
}

function createRuntime(app, { directory, files, shutdownTimeoutMs = 25000 }) {
  // Fail before accepting requests if existing JSON cannot be read. No data migration/reset.
  for (const file of files) readJson(path.join(directory, file), null);
  let stopping = false;
  let server;
  const jobs = new Set();
  const timers = new Set();

  app.get("/healthz", (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      res.status(stopping ? 503 : 200).json({ status: stopping ? "stopping" : "ok" });
    } catch {
      res.status(503).json({ status: "storage-unavailable" });
    }
  });
  app.use((req, res, next) => {
    if (!stopping) return next();
    res.set("Connection", "close").set("Retry-After", "5").status(503).json({ error: "Service restarting; please retry" });
  });

  function runBackground(task) {
    if (stopping) return Promise.resolve();
    const job = Promise.resolve().then(task);
    jobs.add(job);
    // Attach both handlers so a background rejection cannot become unhandled.
    job.then(() => jobs.delete(job), error => {
      jobs.delete(job);
      console.error("Background task failed:", error.message);
    });
    return job;
  }

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    console.log(`Received ${signal}; draining requests and background work`);
    const deadline = setTimeout(() => {
      console.error("Shutdown deadline exceeded; unfinished work requires investigation");
      process.exit(1);
    }, shutdownTimeoutMs);
    try {
      const closed = new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections?.();
      });
      await Promise.all([closed, ...jobs]);
      clearTimeout(deadline);
      console.log("Shutdown complete");
      process.exit(0);
    } catch (error) {
      console.error("Shutdown failed:", error.message);
      process.exit(1);
    }
  }

  return {
    runBackground,
    schedule(task, milliseconds, { immediate = true } = {}) {
      // No overlapping polls, and no new poll after shutdown has begun.
      let pending = false;
      const tick = () => {
        if (pending || stopping) return;
        pending = true;
        runBackground(task).then(() => { pending = false; }, () => { pending = false; });
      };
      const timer = setInterval(tick, milliseconds);
      timers.add(timer);
      if (immediate) tick();
    },
    later(task, milliseconds) {
      if (stopping) return;
      const timer = setTimeout(() => {
        timers.delete(timer);
        runBackground(task);
      }, milliseconds);
      timers.add(timer);
    },
    listen(port, callback) {
      server = app.listen(port, "0.0.0.0", callback);
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));
      return server;
    },
  };
}

module.exports = { dataDirectory, readJson, writeJson, listeningPort, createRuntime };
