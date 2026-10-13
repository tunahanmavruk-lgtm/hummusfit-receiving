const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const { fork } = require("node:child_process");
const { once } = require("node:events");
const { dataDirectory, readJson, writeJson, listeningPort } = require("../runtime-safety");

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hf-runtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function child(t, script, env) {
  const process = fork(script, [], { silent: true, env: { PATH: global.process.env.PATH, ...env } });
  let output = "";
  process.stdout.on("data", chunk => { output += chunk; });
  process.stderr.on("data", chunk => { output += chunk; });
  const exit = once(process, "exit");
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); });
  return { process, exit, output: () => output };
}
function request(port, route = "/healthz") {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, agent: false }, res => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(1500, () => req.destroy(new Error("Request timed out")));
  });
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function ready(instance, port) {
  for (let count = 0; count < 100; count++) {
    if (instance.process.exitCode !== null) throw new Error(instance.output());
    try { return await request(port); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error(`Server did not start: ${instance.output()}`);
}

test("Railway never falls back to ephemeral data or creates a missing mount", t => {
  const directory = temporary(t);
  assert.throws(() => dataDirectory(directory, { RAILWAY_PROJECT_ID: "test" }), /persistent volume/);
  const missing = path.join(directory, "missing");
  assert.throws(() => dataDirectory(directory, { RAILWAY_PROJECT_ID: "test", RAILWAY_VOLUME_MOUNT_PATH: missing }), /ENOENT/);
  assert.equal(fs.existsSync(missing), false);
  assert.throws(() => dataDirectory(directory, { RAILWAY_PROJECT_ID: "test", RAILWAY_VOLUME_MOUNT_PATH: directory, DATA_DIR: missing }), /must match/);
  assert.equal(dataDirectory(directory, { RAILWAY_PROJECT_ID: "test", RAILWAY_VOLUME_MOUNT_PATH: directory }), directory);
});

test("PORT accepts a deployment port and rejects invalid configuration", () => {
  assert.equal(listeningPort("8080"), 8080);
  for (const value of ["", "no", "-1", "0", "65536", "3.5"]) assert.throws(() => listeningPort(value), /PORT/);
});

test("corrupt JSON is never replaced with empty operational data", t => {
  const file = path.join(temporary(t), "data.json");
  assert.deepEqual(readJson(file, []), []);
  fs.writeFileSync(file, '{"unfinished":');
  assert.throws(() => readJson(file, []), SyntaxError);
  assert.equal(fs.readFileSync(file, "utf8"), '{"unfinished":');
});

test("atomic save retains prior data and removes temporary files if replacement fails", t => {
  const directory = temporary(t);
  const file = path.join(directory, "data.json");
  writeJson(file, { saved: 1 });
  const rename = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(new Error("simulated write failure"), { code: "EIO" }); };
    assert.throws(() => writeJson(file, { saved: 2 }), /simulated/);
  } finally { fs.renameSync = rename; }
  assert.deepEqual(readJson(file), { saved: 1 });
  assert.deepEqual(fs.readdirSync(directory), ["data.json"]);
  writeJson(file, { saved: 3 });
  assert.deepEqual(readJson(file), { saved: 3 });
});

test("SIGTERM finishes an active receipt and background task before exiting zero", { timeout: 6000 }, async t => {
  const directory = temporary(t);
  const instance = child(t, path.join(__dirname, "fixtures/runtime-server.cjs"), { DATA_DIR: directory });
  const [{ port }] = await once(instance.process, "message");
  assert.equal((await request(port)).status, 200);
  const working = once(instance.process, "message");
  const response = request(port, "/write");
  await working;
  instance.process.kill("SIGTERM");
  assert.equal((await response).status, 200);
  assert.deepEqual(await instance.exit, [0, null], instance.output());
  assert.deepEqual(readJson(path.join(directory, "receipt.json")), { preserved: true });
  assert.deepEqual(readJson(path.join(directory, "background.json")), { finished: true });
  assert.equal(fs.existsSync(path.join(directory, "unexpected-retry.json")), false);
});

test("unfinished background work causes a bounded nonzero shutdown", { timeout: 6000 }, async t => {
  const directory = temporary(t);
  const instance = child(t, path.join(__dirname, "fixtures/runtime-server.cjs"), { DATA_DIR: directory, HANG: "true" });
  const [{ port }] = await once(instance.process, "message");
  const working = once(instance.process, "message");
  const response = request(port, "/write");
  await working;
  instance.process.kill("SIGTERM");
  await response;
  assert.deepEqual(await instance.exit, [1, null]);
  assert.match(instance.output(), /Shutdown deadline exceeded/);
});

test("actual application starts on PORT, survives restart without rewriting data, and exits cleanly", { timeout: 10000 }, async t => {
  const directory = temporary(t);
  const seeds = { "reports.json": [], "data.json": { marker: "preserve" }, "push-subscriptions.json": [], "completed-orders-archive.json": {}, "essentials-pos-receipts.json": {} };
  for (const [file, data] of Object.entries(seeds)) fs.writeFileSync(path.join(directory, file), JSON.stringify(data));
  const before = Object.fromEntries(Object.keys(seeds).map(file => [file, fs.readFileSync(path.join(directory, file), "utf8")]));
  for (const signal of ["SIGTERM", "SIGINT"]) {
    const port = await freePort();
    const instance = child(t, path.join(__dirname, "../server.js"), { DATA_DIR: directory, PORT: String(port), ROUTE_BOARD_URL: "http://127.0.0.1:1" });
    assert.equal((await ready(instance, port)).status, 200);
    instance.process.kill(signal);
    assert.deepEqual(await instance.exit, [0, null], instance.output());
    for (const file of Object.keys(seeds)) assert.equal(fs.readFileSync(path.join(directory, file), "utf8"), before[file]);
  }
});

test("actual application refuses to start with corrupted persistent data", { timeout: 6000 }, async t => {
  const directory = temporary(t);
  for (const file of ["reports.json", "data.json"]) fs.writeFileSync(path.join(directory, file), "broken-json");
  const instance = child(t, path.join(__dirname, "../server.js"), { DATA_DIR: directory, PORT: String(await freePort()) });
  assert.equal((await instance.exit)[0], 1);
  for (const file of ["reports.json", "data.json"]) assert.equal(fs.readFileSync(path.join(directory, file), "utf8"), "broken-json");
});
