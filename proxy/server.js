const http = require("http");
const crypto = require("crypto");
const os = require("os");

const PORT = process.env.PROXY_PORT || 4000;
const GASURL = process.env.GASURL;
const PROXY_WEBHOOK_URL = `http://waha-proxy:${PORT}/webhook`;
const WAHA_PUBLIC_URL = `https://${os.hostname()}.${process.env.DOMAIN}:${process.env.SERVER_PORT}`;
const BOT_NAME = process.env.WAHA_DEVICENAME || "defaultbot";
const HMAC_SECRET = process.env.WAHA_HMAC_SECRET || "";

async function announceStartup() {
  if (!GASURL || !HMAC_SECRET) {
    console.error(
      "FATAL: GASURL or WAHA_HMAC_SECRET is missing. Aborting startup.",
    );
    process.exit(1);
  }

  const rawBody = JSON.stringify({
    event: "proxy.startup",
    timestamp: new Date().toISOString(),
    config: {
      proxyWebhookUrl: PROXY_WEBHOOK_URL,
      botName: BOT_NAME,
      wahaUrl: WAHA_PUBLIC_URL,
    },
  });

  const signature = crypto
    .createHmac("sha512", HMAC_SECRET)
    .update(rawBody)
    .digest("hex");

  const startupEnvelope = {
    headers: {
      hmac: signature,
      algorithm: "sha512",
    },
    rawBody: rawBody,
  };

  try {
    const res = await fetch(GASURL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(startupEnvelope),
      signal: AbortSignal.timeout(10000), // Abort if GAS takes longer than 10 seconds
    });

    const replyText = await res.text();

    if (!res.ok) {
      throw new Error(`GAS returned HTTP ${res.status}: ${replyText}`);
    }

    // Verify GAS accepted the HMAC signature and saved the config
    const replyJson = JSON.parse(replyText);
    if (replyJson.status !== "ok") {
      throw new Error(`GAS rejected startup payload: ${replyText}`);
    }

    console.log(`Startup handshake succeeded: ${replyText}`);
  } catch (err) {
    console.error(
      `FATAL: Could not communicate with GAS (${err.message}). Aborting startup.`,
    );
    process.exit(1);
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    return res.end("Not Found");
  }

  const incomingHmac = req.headers["x-webhook-hmac"];
  const hmacAlgorithm = req.headers["x-webhook-hmac-algorithm"];

  if (!incomingHmac || !hmacAlgorithm) {
    console.warn(
      "Dropped request: Missing x-webhook-hmac or x-webhook-hmac-algorithm header",
    );
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing required HMAC headers" }));
  }

  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
  });

  req.on("end", async () => {
    try {
      const envelope = {
        type: "waha_event",
        headers: {
          hmac: incomingHmac,
          algorithm: hmacAlgorithm,
        },
        rawBody: rawBody,
      };

      const gasResponse = await fetch(GASURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ forwarded: true, gasStatus: gasResponse.status }),
      );
    } catch (err) {
      console.error("Proxy error:", err.message);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });
});

// Run announceStartup() FIRST; only open the port if GAS confirms receipt
announceStartup().then(() => {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`WAHA Proxy verified and listening on port ${PORT}`);
  });
});
