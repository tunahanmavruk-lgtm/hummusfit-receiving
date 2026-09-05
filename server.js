const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const HF_LOGISTICS_HANDOFF_SECRET = process.env.HF_LOGISTICS_HANDOFF_SECRET || "";
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
  return verifyLogisticsToken(parseCookies(req)[HF_LOGISTICS_COOKIE], "reports.manage");
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

app.get("/api/stores", (req, res) => {
  res.json({ stores: STORES, outOfStateStores: OUT_OF_STATE_STORES });
});

// Generates a real QR code image pointing straight at that store's
// receiving-check page — print this and stick it up at the dock.
app.get("/api/qr/:store", async (req, res) => {
  const store = req.params.store;
  if (!ALL_STORES.includes(store)) return res.status(404).send("Unknown store");
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
app.get("/api/expected/:store", async (req, res) => {
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

// Called once the receiving employee finishes scanning everything —
// compares what they actually scanned against the expected picked
// quantities, builds the report, and saves it permanently.
app.post("/api/submit-receiving-check", (req, res) => {
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
app.get("/api/reports", (req, res) => {
  const reports = loadReports();
  res.json({ reports: reports.slice().reverse() });
});

// History for one specific store, most recent first — for the
// per-location trend view.
app.get("/api/reports/:store", (req, res) => {
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
  res.sendFile(path.join(__dirname, "public", "receiving.html"));
});
app.get("/reports", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports.html"));
});
app.get("/out-of-state", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "out-of-state.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Receiving check app running on port ${PORT}`);
});
