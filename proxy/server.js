const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const util = require("node:util");
const parseEnv = util.parseEnv;
const QRCode = require("qrcode");

const CONTAINER_TMP_DIR = "/shared-tmp";
const HOST_TMP_DIR = process.env.HOST_SHARED_TMP;

let botConfig = null;
let signalConfig = null;
let secretApiKey = "";

class EnhancedTimeout {
  constructor(callback, delay, ...args) {
    this.callback = callback;
    this.args = args;
    this.id = setTimeout(async () => {
      this.id = null;
      try {
        await this.callback(...this.args);
      } catch (err) {
        console.error(
          `EnhancedTimeout background execution error: ${err.message}`,
        );
      }
    }, delay);
  }

  async trigger() {
    if (this.id !== null) {
      clearTimeout(this.id);
      this.id = null;

      // Await the callback in case the caller wants to wait for it
      return await this.callback(...this.args);
    }
    return null;
  }

  cancel() {
    if (this.id !== null) {
      clearTimeout(this.id);
      this.id = null;
    }
  }
}

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
  botConfig.WAHAURL = `https://${botConfig.HOSTNAME}.${botConfig.DOMAIN}:${botConfig.WAHA_PUBLIC_PORT}`;
  botConfig.BOTURL = `https://${botConfig.HOSTNAME}.${botConfig.DOMAIN}:${botConfig.BOT_PUBLIC_PORT}`;
  botConfig.PROXY_WEBHOOK_URL = `http://waha-proxy:${botConfig.PROXY_PORT}/webhook`;

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
          "X-Api-Key": secretApiKey,
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
    timestamp: new Date().getTime(),
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
    if (!replyJson?.apiKey) {
      throw new Error(`GAS did not return WAHA API key to use: ${replyText}`);
    }
    secretApiKey = replyJson.apiKey.trim();

    console.log(`Startup handshake succeeded`);
    await sendSignalMessage(
      signalConfig.GROUPID,
      "Startup handshake succeeded",
      null,
      1000 * 10,
    );
  } catch (err) {
    console.error(
      `FATAL: Could not communicate with GAS (${err.message}). Aborting startup.`,
    );
    process.exit(1);
  }
}

// =========================================================================
// Create the GAS HTTPS server
const certPath = "/app/certs/fullchain.pem";
const keyPath = "/app/certs/privkey.pem";
const serverOptions = {
  key: fs.readFileSync(keyPath),
  cert: fs.readFileSync(certPath),
};
const gasServer = https.createServer(serverOptions, async (req, res) => {
  let resTimeout = gasServer.timeout;
  let connectStartTime = Date.now();
  let changeTimeout = connectStartTime + resTimeout - 10000;
  let method = req.method.toUpperCase();

  if (method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  } else if (method === "POST") {
    let body = "";
    let response = "OK";
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");

    req.on("data", function (chunk) {
      body += chunk;
      if (Date.now() > changeTimeout) {
        resTimeout = resTimeout + 10000;
        res.setTimeout(resTimeout);
        changeTimeout = changeTimeout + 10000;
        console.log(`HTTP Server data: Set new socket timeout: ${resTimeout}`);
      }
    });

    req.on("end", async function () {
      try {
        console.log("Processing end of sendSignalMessage");
        // Check header has API key
        const XapiKey = req.headers?.["x-api-key"];
        if (XapiKey !== secretApiKey) {
          throw new Error("Error: Incorrect API key");
        }
        res.statusCode = 200;

        let jsonObj = JSON.parse(body);
        if (jsonObj.cmd === "sendSignalMessage") {
          console.log(`Received sendSignalMessage: ${jsonObj.message}`);
          if (jsonObj?.qr) {
            console.log(`QR:\n${jsonObj.qr}`);
          }
          await sendSignalMessage(
            signalConfig.GROUPID,
            jsonObj.message,
            jsonObj?.qr ?? null,
            jsonObj?.autoDeletems ?? 0,
          );
        }
      } catch (e) {
        response =
          "ERROR CAUGHT: " +
          `${e?.stack ?? "no stack"}\n${e?.cause ?? "no cause"}`;
        console.error(response);

        res.statusCode = 400;
      } finally {
        res.end(response);
      }
    });
  } else {
    console.error(`HTTP Server warning: Unhandled method ${method}`);
  }
});

//server = https.createServer(serverOptions, async (req, res) => {
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
          name: botConfig.HOSTNAME,
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

      console.log(`GAS response: ${JSON.stringify(gasResponse, null, 2)}`);
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
  const webhookConfig = {
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

  let result = await sendToWaha(
    `/api/sessions/${botConfig.NAME}`,
    "PUT",
    webhookConfig,
  );

  // If session does not exist, create and start it
  if (result.status === 404) {
    console.log(
      `Session '${botConfig.NAME}' not found. Creating and starting it now...`,
    );
    result = await sendToWaha("/api/sessions", "POST", {
      name: botConfig.NAME,
      start: true,
      config: webhookConfig,
    });
  }
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

  gasServer.listen(botConfig.BOT_PUBLIC_PORT, "0.0.0.0", () => {
    console.log(`GAS server listening on port ${botConfig.BOT_PUBLIC_PORT}`);
  });
  registerWahaWebhook();
});

async function removeSignalMessage(groupId, timestamp) {
  console.log(
    `removeSignalMessage: groupId: ${groupId}, ts: ${timestamp}; ${typeof timestamp}`,
  );
  return new Promise((resolve, reject) => {
    const chunks = [];

    const signalClient = net.createConnection(signalConfig.SOCKET, () => {
      const payload = {
        jsonrpc: "2.0",
        id: Date.now(), // Unique ID for tracking responses
        method: "remoteDelete",
        params: {
          groupIds: [groupId],
          targetTimestamp: timestamp,
        },
      };

      console.log("Connected to signal-cli daemon.");

      // Every JSON-RPC request must end with a newline character
      signalClient.write(JSON.stringify(payload) + "\n");

      console.log("Remote delete message sent to Signal daemon");
      console.log(JSON.stringify(payload, null, 2));
    });

    // Accumulate incoming data chunks
    signalClient.on("data", (data) => {
      chunks.push(data);
      if (data.toString().endsWith("\n")) {
        signalClient.end();
      }
    });

    // 3. Resolve response on 'end'
    signalClient.on("end", () => {
      try {
        const responseData = JSON.parse(Buffer.concat(chunks).toString());
        console.log("Daemon Response:", JSON.stringify(responseData, null, 2));
        resolve(responseData);
      } catch (parseErr) {
        console.error(
          `Failed to parse JSON response from daemon: ${parseErr.message}`,
        );
        reject(parseErr);
      }
    });

    // 4. Handle connection errors
    signalClient.on("error", (err) => {
      console.error("Failed to connect to Signal daemon:", err.message);
      reject(err);
    });
  });
}

async function sendSignalMessage(
  groupId,
  text,
  qrData = null,
  autoDeletems = 0,
) {
  let containerPath = null;
  let hostPath = null;
  let filename = `signal_qr_${Date.now()}_${Math.floor(Math.random() * 1000)}.png`;

  // 1. Generate QR code image file
  if (qrData) {
    try {
      containerPath = path.join(CONTAINER_TMP_DIR, filename);
      hostPath = path.join(HOST_TMP_DIR, filename);

      fs.writeFileSync(containerPath, Buffer.from(qrData, "base64"));
      console.log(`Generated volatile QR code image at: ${containerPath}`);
    } catch (err) {
      console.error("Failed to generate QR Code image locally:", err.message);
      return null;
    }
  }

  // Helper function to safely delete the attachment
  const cleanUpFile = () => {
    if (containerPath && fs.existsSync(containerPath)) {
      try {
        fs.unlinkSync(containerPath);
        console.log(
          `Temporary QR file wiped from ${CONTAINER_TMP_DIR} successfully.`,
        );
      } catch (err) {
        console.error(
          `Failed to remove file from ${CONTAINER_TMP_DIR}: ${err.message}`,
        );
      }
    }
  };

  // 2. Wrap network communication in a Promise
  return new Promise((resolve, reject) => {
    const chunks = [];

    const signalClient = net.createConnection(signalConfig.SOCKET, () => {
      const payload = {
        jsonrpc: "2.0",
        id: Date.now(), // Unique ID for tracking responses
        method: "send",
        params: {
          groupId: groupId,
          message: text,
          ...(hostPath && {
            attachments: [hostPath],
          }),
        },
      };

      console.log("Connected to signal-cli daemon.");

      // Every JSON-RPC request must end with a newline character
      signalClient.write(JSON.stringify(payload) + "\n");

      console.log(`Message sent to Signal daemon: "${text}"`);
    });

    // Accumulate incoming data chunks
    signalClient.on("data", (data) => {
      chunks.push(data);
      if (data.toString().endsWith("\n")) {
        signalClient.end();
      }
    });

    // 3. Resolve response on 'end'
    signalClient.on("end", () => {
      try {
        const rawData = Buffer.concat(chunks).toString();
        console.log(`Daemon raw response: ${rawData}`);

        // Split by newline
        const lines = rawData.split("\n");

        let responseData = null;

        for (const line of lines) {
          if (!line.trim()) {
            continue; // skip empty lines
          }

          try {
            const parsedObj = JSON.parse(line);

            if (parsedObj.id !== undefined) {
              responseData = parsedObj;
              break; // Found the correct response
            }
          } catch (e) {
            console.error(`Failed to parse line: ${line}\nERROR: ${e.message}`);
          }
        }
        if (!responseData) {
          throw new Error("Failed to get proper signal-cli daemon response");
        }
        console.log("Daemon Response:", JSON.stringify(responseData, null, 2));
        let retval = {
          responseData: responseData,
          timeoutObj: null,
        };

        if (autoDeletems) {
          // Set a timeout to remove the message
          retval.timeoutObj = new EnhancedTimeout(async () => {
            await removeSignalMessage(groupId, responseData.result.timestamp);
          }, autoDeletems);
        }
        resolve(retval);
      } catch (parseErr) {
        console.error(
          `Failed to parse JSON response from daemon: ${parseErr.message}`,
        );
        reject(parseErr);
      }
    });

    // 4. Handle connection errors
    signalClient.on("error", (err) => {
      console.error("Failed to connect to Signal daemon:", err.message);
      reject(err);
    });

    // 5. Cleanup on 'close'
    signalClient.once("close", async () => {
      cleanUpFile();
    });
  });
}
