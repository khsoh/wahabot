const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const util = require("node:util");
const parseEnv = util.parseEnv;

let botConfig = null;
let signalConfig = null;

function loadConfig() {
  const demoEnvPath = path.resolve(__dirname, ".env.example");
  const demoConfig = parseEnv(fs.readFileSync(demoEnvPath, "utf8"));
  const envConfig = {};

  const mustChangeKeys = [
    "GASURL",
    "WAHA_API_KEY",
    "WAHA_PASSWORD",
    "WAHA_DEVICENAME",
    "WAHA_HMAC_SECRET",
    "TECHLEAD",
    "ADMINGRP",
    "DOMAIN",
    "CFLARE_API_TOKEN",
    "CFLARE_ACCT_ID",
    "SIGNAL",
  ];
  const numberKeys = ["WAHA_PUBLIC_PORT", "PROXY_PORT", "BOT_PUBLIC_PORT"];

  let botconfig_ok = true;
  for (const [key, demoValue] of Object.entries(demoConfig)) {
    const currentValue = process.env[key];

    // Check 1: is the variable defined in the current environment
    if (currentValue === undefined || currentValue.trim() === "") {
      console.error(`Missing required environment variable: ${key}`);
      botconfig_ok = false;
      continue;
    }

    // Check 2. Check sensitive variables have been changed from demo version
    if (mustChangeKeys.includes(key) && currentValue === demoValue) {
      console.error(
        `Security risk: ${key} is still using the default demo value from .env.demo`,
      );
      botconfig_ok = false;
      continue;
    }

    envConfig[key] = currentValue;

    // Check 3. Number items are numeric
    if (numberKeys.includes(key)) {
      const port = Number(currentValue);
      if (!Number.isFinite(port)) {
        botconfig_ok = false;
        console.error(`Invalid ${key} in .env : "${currentValue}"`);
        continue;
      }

      envConfig[key] = port;
    }
  }

  if (!botconfig_ok) {
    process.exit(1);
  }

  const { SIGNAL: signalRaw, ...botConfig } = envConfig;
  const signalConfig = JSON.parse(signalRaw);
  botConfig.HOSTNAME = fs.readFileSync("/etc/host_hostname", "utf8").trim();
  botConfig.WAHAURL = `https://${botConfig.HOSTNAME}.${botConfig.DOMAIN}:${botConfig.WAHA_PUBLIC_PORT}/`;
  botConfig.BOTURL = `https://${botConfig.HOSTNAME}.${botConfig.DOMAIN}:${botConfig.BOT_PUBLIC_PORT}/`;
  botConfig.PROXY_WEBHOOK_URL = `http://waha-proxy:3000/webhook`;

  return { botConfig, signalConfig };
}

function sendToWaha(path, method, payloadObj) {
  return new Promise((resolve, reject) => {
    const body = payloadObj ? JSON.stringify(payloadObj) : "";

    const req = https.request(
      {
        hostname: "waha",
        port: 3000,
        path: path,
        method: method,
        servername: `${botConfig.HOSTNAME}.${botConfig.DOMAIN}`,
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": botConfig.WAHA_API_KEY,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function announceStartup() {
  ({ botConfig, signalConfig } = loadConfig());

  const rawBody = JSON.stringify({
    event: "proxy.startup",
    timestamp: new Date().toISOString(),
    config: botConfig,
  });

  const signature = crypto
    .createHmac("sha512", botConfig.WAHA_HMAC_SECRET)
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
    const res = await fetch(botConfig.GASURL, {
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

      const gasResponse = await fetch(botConfig.GASURL, {
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

async function registerWahaWebhook() {
  const payload = {
    config: {
      webhooks: [
        {
          url: botConfig.PROXY_WEBHOOK_URL,
          events: ["message", "session.status"],
          hmac: {
            key: botConfig.WAHA_HMAC_SECRET,
          },
        },
      ],
    },
  };

  const result = await sendToWaha("/api/sessions/default", "PUT", payload);
  console.log(
    `Webhook registration response (HTTP ${result.status}): ${result.body}`,
  );
}

// Run announceStartup() FIRST; only open the port if GAS confirms receipt
announceStartup().then(() => {
  server.listen(botConfig.PROXY_PORT, "0.0.0.0", () => {
    console.log(
      `WAHA Proxy verified and listening on port ${botConfig.PROXY_PORT}`,
    );
  });

  registerWahaWebhook();
});
