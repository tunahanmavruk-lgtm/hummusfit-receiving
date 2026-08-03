const express = require("express");
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

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
  res.json({ stores: STORES });
});

// Generates a real QR code image pointing straight at that store's
// receiving-check page — print this and stick it up at the dock.
app.get("/api/qr/:store", async (req, res) => {
  const store = req.params.store;
  if (!STORES.includes(store)) return res.status(404).send("Unknown store");
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
    const data = await r.json();
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
  const { store, orderName, pickedBy, receivedBy, expectedItems, scannedCounts } = req.body;
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

  const errorPercent = totalExpected > 0 ? Math.round((totalDiscrepant / totalExpected) * 1000) / 10 : 0;

  const report = {
    id: store + "::" + Date.now(),
    store,
    orderName: orderName || "",
    pickedBy: pickedBy || "Unknown",
    receivedBy: receivedBy || "Unknown",
    submittedAt: new Date().toISOString(),
    items: itemResults,
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

app.get("/receiving/:store", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "receiving.html"));
});
app.get("/reports", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "reports.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Receiving check app running on port ${PORT}`);
});
