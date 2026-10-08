const express = require("express");
const path = require("node:path");
const { createRuntime, writeJson } = require("../../runtime-safety");
const app = express();
const runtime = createRuntime(app, {
  directory: process.env.DATA_DIR,
  files: [],
  shutdownTimeoutMs: process.env.HANG ? 150 : 3000,
});
app.get("/write", (req, res) => {
  runtime.runBackground(async () => {
    if (process.env.HANG) await new Promise(() => {});
    else await new Promise(resolve => setTimeout(resolve, 180));
    writeJson(path.join(process.env.DATA_DIR, "background.json"), { finished: true });
  });
  runtime.later(() => writeJson(path.join(process.env.DATA_DIR, "unexpected-retry.json"), {}), 120);
  process.send("working");
  setTimeout(() => {
    writeJson(path.join(process.env.DATA_DIR, "receipt.json"), { preserved: true });
    res.json({ saved: true });
  }, 80);
});
const server = runtime.listen(0, () => process.send({ port: server.address().port }));
