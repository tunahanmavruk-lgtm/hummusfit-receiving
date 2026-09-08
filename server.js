const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const HF_LOGISTICS_HANDOFF_SECRET = process.env.HF_LOGISTICS_HANDOFF_SECRET || "";
const STORE_TRACKING_SECRET = process.env.STORE_TRACKING_SECRET || "";
const HF_LOGISTICS_COOKIE = "hf_logistics_access";

function decodeBase64Url(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function parseCookies(req) {
  return String(req.get("cookie") || "").split(";").reduce((cookies, part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return cookies;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function verifyLogisticsToken(token, requiredScope) {
  if (!HF_LOGISTICS_HANDOFF_SECRET || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  const expected = crypto.createHmac("sha256", HF_LOGISTICS_HANDOFF_SECRET).update(payloadPart).digest();
  const supplied = decodeBase64Url(signaturePart);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart).toString("utf8"));
    if (!payload.sub || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!Array.isArray(payload.scope) || !payload.scope.includes(requiredScope)) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function reportsManager(req) {
  const authorization = String(req.get("authorization") || "");
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return verifyLogisticsToken(bearer || parseCookies(req)[HF_LOGISTICS_COOKIE], "reports.manage");
}

function requireReportsManager(req, res, next) {
  if (!HF_LOGISTICS_HANDOFF_SECRET) return res.status(503).json({ error: "Secure HF Logistics access is not configured" });
  const identity = reportsManager(req);
  if (!identity || !["owner", "administrator", "manager"].includes(identity.role)) {
    return res.status(401).json({ error: "Open report administration from HF Logistics" });
  }
  req.hfLogisticsIdentity = identity;
  next();
}

function signStoreToken(store) {
  if (!STORE_TRACKING_SECRET) return null;
  const payloadPart = Buffer.from(JSON.stringify({ v: 1, scope: "receiving.store", store }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", STORE_TRACKING_SECRET).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}

function verifyStoreToken(token, expectedStore) {
  if (!STORE_TRACKING_SECRET || typeof token !== "string") return null;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const payloadPart = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1), "base64url");
  const expected = crypto.createHmac("sha256", STORE_TRACKING_SECRET).update(payloadPart).digest();
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (payload.v !== 1 || payload.scope !== "receiving.store" || payload.store !== expectedStore) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireStoreAccess(req, res, next) {
  const store = req.params.store || req.body?.store;
  const access = String(req.query.access || req.body?.access || "");
  if (!ALL_STORES.includes(store)) return res.status(404).json({ error: "Unknown store" });
  if (!verifyStoreToken(access, store)) {
    return res.status(403).json({ error: "This store receiving link is invalid. Ask Hummus Fit for a new QR code." });
  }
  next();
}

function signVehicleTrackingToken(store, imei) {
  if (!STORE_TRACKING_SECRET) return null;
  const payloadPart = Buffer.from(JSON.stringify({
    v: 1, scope: "store.vehicle.track", store, imei,
    exp: Math.floor(Date.now() / 1000) + (12 * 60 * 60),
  }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", STORE_TRACKING_SECRET).update(payloadPart).digest("base64url");
  return `${payloadPart}.${signature}`;
}

function safeReturnPath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/reports";
}

app.get("/auth/hf-logistics", (req, res) => {
  const token = String(req.query.token || "");
  const identity = verifyLogisticsToken(token, "reports.manage");
  if (!HF_LOGISTICS_HANDOFF_SECRET) return res.status(503).send("Secure HF Logistics access is not configured.");
  if (!identity || !["owner", "administrator", "manager"].includes(identity.role)) {
    return res.status(403).send("This HF Logistics management link is invalid or expired.");
  }
  res.cookie(HF_LOGISTICS_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 12 * 60 * 60 * 1000,
    path: "/",
  });
  res.redirect(302, safeReturnPath(req.query.returnTo));
});

app.get("/api/admin-session", (req, res) => {
  const identity = reportsManager(req);
  res.json({ canManageReports: Boolean(identity && ["owner", "administrator", "manager"].includes(identity.role)) });
});

// The one and only connection to the Route Board app — a read-only
// call to find out what was actually picked for a store, so receiving
// has real ground truth to check against. Nothing here writes back to
// Route Board, and nothing in Route Board depends on this app existing.
const ROUTE_BOARD_URL =
  process.env.ROUTE_BOARD_URL || "https://hummusfit-route-board-production.up.railway.app";

// Pulled directly from Route Board's real local store list, so this
// never drifts out of sync with the actual stops. If a store shouldn't
// get a QR code, just remove it here.
const STORES = [
  "Lindenhurst", "Lynbrook", "Island Park", "Bellmore", "Islip",
  "Farmingdale", "Deer Park", "Woodbury", "Huntington", "Ozone Park",
  "Hicksville", "Selden", "Miller Place", "Lake Grove", "Holbrook", "Ronkonkoma",
];

// The B2B / out-of-state customer list — same idea as STORES above,
// just for the accounts on Route Board's Out of State board instead
// of the local daily routes. The receiving-check flow underneath
// (picked-summary, scanning, reports) already works identically for
// these — it was never actually local-store-specific — this list is
// the only real gap that kept them from getting their own QR codes.
const OUT_OF_STATE_STORES = [
  "Harrison", "Brookfield", "Fishkill", "Carmel", "Yorktown", "Nourish'd", "Rochelle",
  "PWRBLD Philadelphia", "Ares Philadelphia", "Ares Hamilton",
  "Wyomissing", "Bethlehem", "Meriden", "Orange", "Shelton", "Fairfield",
  "New Castle", "Ares Sewell", "King of Gains", "Ares Mt Laurel",
  "PWRBLD KOP", "PWRBLD Warrington",
];
const ALL_STORES = STORES.concat(OUT_OF_STATE_STORES);

const DATA_FILE = path.join(__dirname, "reports.json");
function loadReports() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return [];
  }
}
function saveReports(reports) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(reports, null, 2));
}

app.get("/api/stores", requireReportsManager, (req, res) => {
  res.json({ stores: STORES, outOfStateStores: OUT_OF_STATE_STORES });
});

// Generates a permanent QR code for the store. The QR intentionally points
// at the stable store URL instead of embedding a signature. On first open,
// /receiving/:store upgrades it to a currently signed URL. That keeps every
// printed code working if the signing secret changes while the signed URL
// still scopes all API calls to exactly one store.
app.get("/api/qr/:store", requireReportsManager, async (req, res) => {
  const store = req.params.store;
  if (!ALL_STORES.includes(store)) return res.status(404).send("Unknown store");
  if (!STORE_TRACKING_SECRET) return res.status(503).send("Secure store QR access is not configured");
  const targetUrl = `${req.protocol}://${req.get("host")}/receiving/${encodeURIComponent(store)}`;
  try {
    const buffer = await QRCode.toBuffer(targetUrl, { width: 500, margin: 2 });
    res.set("Content-Type", "image/png");
    res.send(buffer);
  } catch (err) {
    res.status(500).send("Could not generate QR code: " + err.message);
  }
});

// Pulls real "what was actually picked" data from Route Board — this
// is the ground truth the receiving employee's scans get checked
// against, not just the original order.
app.get("/api/expected/:store", requireStoreAccess, async (req, res) => {
  const store = req.params.store;
  try {
    const r = await fetch(`${ROUTE_BOARD_URL}/api/picked-summary/${encodeURIComponent(store)}`);
    const rawText = await r.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      // Route Board sent back something that isn't JSON at all — most
      // likely means the request never reached our actual endpoint
      // (a 404/500 HTML page, a redirect, etc). Surface exactly what
      // came back instead of a generic parse error, so the real cause
      // is visible instead of having to guess at it.
      return res.status(502).json({
        error: "Route Board didn't return valid data for this store.",
        rawResponseStart: rawText.slice(0, 200),
        routeBoardStatus: r.status,
      });
    }
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Could not reach Route Board: " + err.message });
  }
});

app.get("/api/eta/:store", requireStoreAccess, async (req, res) => {
  const store = req.params.store;
  try {
    const upstream = await fetch(`${ROUTE_BOARD_URL}/api/store-eta/${encodeURIComponent(store)}`);
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json({ error: data.error || "Delivery status unavailable" });
    const fleetTrackerUrl = data.fleetTrackerUrl;
    const vanImei = data.vanImei;
    delete data.fleetTrackerUrl;
    delete data.vanImei;
    if (data.started && !data.delivered && fleetTrackerUrl && vanImei) {
      const trackingAccess = signVehicleTrackingToken(store, vanImei);
      if (trackingAccess) data.trackUrl = `${fleetTrackerUrl}/track.html?access=${encodeURIComponent(trackingAccess)}`;
    }
    res.set("Cache-Control", "private, no-store");
    res.json(data);
  } catch {
    res.status(502).json({ error: "Could not load delivery status" });
  }
});

// Called once the receiving employee finishes scanning everything —
// compares what they actually scanned against the expected picked
// quantities, builds the report, and saves it permanently.
app.post("/api/submit-receiving-check", requireStoreAccess, (req, res) => {
  const { store, orderName, pickedBy, receivedBy, expectedItems, scannedCounts, extraScans } = req.body;
  if (!store || !expectedItems || !scannedCounts) {
    return res.status(400).json({ error: "store, expectedItems, and scannedCounts are required" });
  }

  let totalExpected = 0;
  let totalDiscrepant = 0;
  const itemResults = expectedItems.map((item) => {
    const scannedQty = scannedCounts[item.sku || item.title] || 0;
    const diff = scannedQty - item.pickedQty; // negative = short, positive = extra
    totalExpected += item.pickedQty;
    if (diff !== 0) totalDiscrepant += Math.abs(diff);
    return {
      title: item.title,
      expectedFromPicking: item.pickedQty,
      actuallyReceived: scannedQty,
      diff,
    };
  });

  // Barcodes scanned that never matched anything on the order at all —
  // wrong item, someone else's delivery, a shelf tag, etc. These have no
  // "expected" counterpart in expectedItems, so they can't be folded into
  // itemResults above; they get their own list instead, and they count
  // toward the error rate the same way a short/over count on a real item
  // would — a wrong item showing up is exactly as much of a receiving
  // discrepancy as a missing one.
  const extraItems = Object.keys(extraScans || {})
    .filter((code) => (extraScans[code] || 0) > 0)
    .map((code) => ({ code, qty: extraScans[code] }));
  const extraQtyTotal = extraItems.reduce((sum, e) => sum + e.qty, 0);
  totalDiscrepant += extraQtyTotal;

  const errorPercent = totalExpected > 0 ? Math.round((totalDiscrepant / totalExpected) * 1000) / 10 : 0;

  const report = {
    id: store + "::" + Date.now(),
    store,
    orderName: orderName || "",
    pickedBy: pickedBy || "Unknown",
    receivedBy: receivedBy || "Unknown",
    submittedAt: new Date().toISOString(),
    items: itemResults,
    extraItems,
    hasErrors: totalDiscrepant > 0,
    errorPercent,
  };

  const reports = loadReports();
  reports.push(report);
  saveReports(reports);

  res.json({ ok: true, report });
});

// For the picking-crew dashboard — every report, most recent first.
app.get("/api/reports", requireReportsManager, (req, res) => {
  const reports = loadReports();
  res.json({ reports: reports.slice().reverse() });
});

// History for one specific store, most recent first — for the
// per-location trend view.
app.get("/api/reports/:store", requireReportsManager, (req, res) => {
  const reports = loadReports().filter((r) => r.store === req.params.store);
  res.json({ reports: reports.slice().reverse() });
});

// Clears reports either for one specific store (test data cleanup) or
// everything, if store is omitted/"all". Reports otherwise persist
// forever with no automatic expiration — this is the only way they
// get removed.
app.post("/api/clear-reports", requireReportsManager, (req, res) => {
  const { store } = req.body;
  const before = loadReports();
  const after = store && store !== "all" ? before.filter((r) => r.store !== store) : [];
  saveReports(after);
  res.json({ ok: true, removed: before.length - after.length });
});

app.get("/receiving/:store", (req, res) => {
  const store = req.params.store;
  if (!ALL_STORES.includes(store)) {
    return res.status(404).type("html").send("<!doctype html><meta name=viewport content='width=device-width'><title>Store not found</title><style>body{font-family:Arial,sans-serif;background:#edf5f2;color:#173b38;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:420px;margin:24px;padding:32px;border-radius:18px;background:white;box-shadow:0 18px 50px #174b4722;text-align:center}h1{font-size:24px}p{line-height:1.6;color:#667b78}</style><main class=card><h1>Store not found</h1><p>This receiving code does not match a Hummus Fit delivery location.</p></main>");
  }

  const access = String(req.query.access || "");
  if (!access) {
    const currentAccess = signStoreToken(store);
    if (!currentAccess) {
      return res.status(503).type("html").send("<!doctype html><meta name=viewport content='width=device-width'><title>Receiving temporarily unavailable</title><style>body{font-family:Arial,sans-serif;background:#edf5f2;color:#173b38;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:420px;margin:24px;padding:32px;border-radius:18px;background:white;box-shadow:0 18px 50px #174b4722;text-align:center}h1{font-size:24px}p{line-height:1.6;color:#667b78}</style><main class=card><h1>Receiving temporarily unavailable</h1><p>Please contact Hummus Fit logistics and try this QR code again.</p></main>");
    }
    res.set("Cache-Control", "private, no-store");
    return res.redirect(302, `/receiving/${encodeURIComponent(store)}?access=${encodeURIComponent(currentAccess)}`);
  }

  if (!verifyStoreToken(access, store)) {
    return res.status(403).type("html").send("<!doctype html><meta name=viewport content='width=device-width'><title>Secure receiving link required</title><style>body{font-family:Arial,sans-serif;background:#edf5f2;color:#173b38;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:420px;margin:24px;padding:32px;border-radius:18px;background:white;box-shadow:0 18px 50px #174b4722;text-align:center}h1{font-size:24px}p{line-height:1.6;color:#667b78}</style><main class=card><h1>Secure receiving link required</h1><p>Please scan the current QR code supplied by Hummus Fit. This link cannot open another store’s orders.</p></main>");
  }
  res.set("Cache-Control", "private, no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.sendFile(path.join(__dirname, "public", "receiving.html"));
});
app.get(["/reports", "/reports.html"], requireReportsManager, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports.html"));
});
app.get(["/out-of-state", "/out-of-state.html"], requireReportsManager, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "out-of-state.html"));
});

app.get(["/", "/index.html"], requireReportsManager, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/receiving.html", (req, res) => res.status(404).send("Not found"));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Receiving check app running on port ${PORT}`);
});
