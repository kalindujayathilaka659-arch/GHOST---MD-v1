// ====================== IMPORTS ======================
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

const fs = require("fs");
const path = require("path");
const P = require("pino");
const qrcode = require("qrcode-terminal");
const axios = require("axios");
const { File } = require("megajs");
const express = require("express");
const chokidar = require("chokidar");
const readline = require("readline");

const app = express();
const port = process.env.PORT || 8000;

const rawConfig = require("./config");

// ====================== BASIC SETTINGS ======================
const prefix = rawConfig.PREFIX || "!";
const sessionDir = path.join(__dirname, "auth_info_baileys");
const sessionFilePath = path.join(sessionDir, "creds.json");

// ✅ owner jid fixed (supports string/array)
const ownerListRaw = Array.isArray(rawConfig.OWNER_NUM)
  ? rawConfig.OWNER_NUM
  : rawConfig.OWNER_NUM
  ? [rawConfig.OWNER_NUM]
  : [];

const normalizeNumber = (n) => String(n || "").replace(/\D/g, "");
const ownerList = ownerListRaw.map(normalizeNumber).filter(Boolean);
const ownerJid = ownerList[0] ? ownerList[0] + "@s.whatsapp.net" : null;

// ====================== HELPERS ======================
function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeUnlink(file) {
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {}
}

function setStatusLine(msg) {
  // Works only in real terminal (TTY). PM2 logs are not TTY.
  if (process.stdout && process.stdout.isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(String(msg));
  }
}

// Unwrap ephemeral + viewOnce wrappers
function unwrapBaileysMessage(msg) {
  if (!msg) return msg;

  let root = msg;
  let t = getContentType(root);

  while (
    t === "ephemeralMessage" ||
    t === "viewOnceMessage" ||
    t === "viewOnceMessageV2" ||
    t === "viewOnceMessageV2Extension"
  ) {
    if (t === "ephemeralMessage") root = root?.ephemeralMessage?.message || null;
    else root = root?.[t]?.message || null;

    if (!root) return msg;
    t = getContentType(root);
  }

  return root || msg;
}

// ====================== MEGA DOWNLOAD CONFIG (SPEED) ======================
const MEGA_FILE_CONCURRENCY = Number(process.env.MEGA_FILE_CONCURRENCY || 3);
const MEGA_MAX_CONNECTIONS = Number(process.env.MEGA_MAX_CONNECTIONS || 6);
const MEGA_FORCE_HTTPS =
  String(process.env.MEGA_FORCE_HTTPS || "false").toLowerCase() === "true";

function megaHandleRetries(tries, error, cb) {
  if (tries > 6) return cb(error);
  setTimeout(cb, 400 * Math.pow(1.6, tries));
}

function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const job = queue.shift();
    Promise.resolve()
      .then(job.fn)
      .then((res) => {
        active--;
        job.resolve(res);
        next();
      })
      .catch((err) => {
        active--;
        job.reject(err);
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

async function loadChildrenIfNeeded(node) {
  if (!node?.directory) return;
  if (Array.isArray(node.children) && node.children.length) return;

  if (typeof node.loadAttributes === "function") {
    await new Promise((resolve, reject) => {
      node.loadAttributes((err) => (err ? reject(err) : resolve()));
    }).catch(() => {});
  }
}

async function collectMegaFiles(node, targetPath, out) {
  if (!node) return;

  if (node.directory) {
    ensureDirSync(targetPath);
    await loadChildrenIfNeeded(node);

    const kids = node.children || [];
    for (const child of kids) {
      await collectMegaFiles(child, path.join(targetPath, child.name), out);
    }
    return;
  }

  out.push({ node, targetPath });
}

async function downloadSingleMegaFile(node, targetPath) {
  ensureDirSync(path.dirname(targetPath));

  // Skip if exists and size ok
  if (fs.existsSync(targetPath) && node.size) {
    const stat = fs.statSync(targetPath);
    if (stat.size >= node.size) return { skipped: true };
  }

  return await new Promise((resolve, reject) => {
    const stream = node.download({
      maxConnections: MEGA_MAX_CONNECTIONS,
      forceHttps: MEGA_FORCE_HTTPS,
      handleRetries: megaHandleRetries,
    });

    const w = fs.createWriteStream(targetPath);

    stream.on("error", reject);
    w.on("error", reject);
    w.on("finish", () => resolve({ skipped: false }));

    stream.pipe(w);
  });
}

// ====================== DOWNLOAD BOT FILES (MEGA FOLDERS) ======================
const MEGA_URLS = {
  plugins: "https://mega.nz/folder/GB1GTTIK#xBoT5PycVrZgfUzXZ_eJ6Q",
  lib: "https://mega.nz/folder/LUtHyIYQ#pJugHcyOXimoe0S4YjzEAg",
  cookies: "https://mega.nz/folder/2FNwSY5D#MTQRmOi7U1Oebygqys-1SQ",
};


// ✅ Download ONLY these if missing/empty
const MEGA_BACKED_FOLDERS = ["plugins", "lib", "cookies"];

// ✅ Never download these (workspace-only)
const LOCAL_ONLY_FOLDERS = ["temp", "auth_info_baileys"];

async function ensureBotFiles() {
  // Always create folders locally
  [...MEGA_BACKED_FOLDERS, ...LOCAL_ONLY_FOLDERS].forEach((f) =>
    ensureDirSync(path.join(__dirname, f))
  );

  // Download only missing/empty MEGA folders
  const missingMega = MEGA_BACKED_FOLDERS.filter((f) => {
    const full = path.join(__dirname, f);
    return !fs.existsSync(full) || fs.readdirSync(full).length === 0;
  });

  if (missingMega.length === 0) return;

  // ✅ SHOW "downloading" in BOTH terminal + PM2
  if (process.stdout && process.stdout.isTTY) {
    setStatusLine("⬇️ Files downloading...");
  } else {
    console.log("⬇️ Files downloading...");
  }

  const limit = createLimiter(MEGA_FILE_CONCURRENCY);

  try {
    for (const folderName of missingMega) {
      const url = MEGA_URLS[folderName];
      if (!url) continue;

      const megaFolder = File.fromURL(url);
      await megaFolder.loadAttributes();
      if (!megaFolder.directory) continue;

      const jobs = [];
      await collectMegaFiles(megaFolder, path.join(__dirname, folderName), jobs);
      if (!jobs.length) continue;

      await Promise.allSettled(
        jobs.map(({ node, targetPath }) =>
          limit(() => downloadSingleMegaFile(node, targetPath))
        )
      );
    }

    // ✅ SHOW "downloaded" in BOTH terminal + PM2
    if (process.stdout && process.stdout.isTTY) {
      setStatusLine("✅ Files downloaded ✅");
      process.stdout.write("\n");
    } else {
      console.log("✅ Files downloaded ✅");
    }
  } catch (e) {
    if (process.stdout && process.stdout.isTTY) {
      setStatusLine("❌ Bot files download failed");
      process.stdout.write("\n");
    }
    console.log("❌ Bot files download failed:", e.message);
  }
}


// ====================== SESSION SETUP ======================
async function ensureSession() {
  try {
    ensureDirSync(sessionDir);

    if (fs.existsSync(sessionFilePath)) {
      const stat = fs.statSync(sessionFilePath);
      if (stat.size > 50) {
        console.log("✅ Existing session found, skipping download");
        return;
      }
      safeUnlink(sessionFilePath);
    }

    if (!rawConfig.SESSION_ID) {
      console.log("📌 No SESSION_ID found");
      console.log("📌 QR will be generated in terminal");
      return;
    }

    console.log("⬇️ Downloading session from MEGA...");

    const file = File.fromURL(`https://mega.nz/file/${rawConfig.SESSION_ID}`);
    await file.loadAttributes();

    await new Promise((resolve, reject) => {
      const w = fs.createWriteStream(sessionFilePath);
      file.download().pipe(w);
      w.on("finish", resolve);
      w.on("error", reject);
    });

    const stat = fs.statSync(sessionFilePath);
    if (stat.size < 50) {
      safeUnlink(sessionFilePath);
      console.log("⚠️ Session file invalid, switching to QR login");
      return;
    }

    console.log("✅ Session downloaded successfully");
  } catch (err) {
    safeUnlink(sessionFilePath);
    console.log("⚠️ Session download failed, switching to QR login");
    console.error("Reason:", err.message);
  }
}

// ====================== PLUGIN LOADER ======================
function loadPlugin(client, filePath) {
  if (!filePath.endsWith(".js") || path.basename(filePath) === "loader.js") return;
  try {
    delete require.cache[require.resolve(filePath)];
    const plugin = require(filePath);
    if (typeof plugin === "function") plugin(client);
    console.log(`✅ Loaded plugin: ${path.basename(filePath)}`);
  } catch (err) {
    console.log(`❌ Failed to load plugin ${path.basename(filePath)}:`, err.message);
  }
}

function loadPlugins(client) {
  const pluginsPath = path.join(__dirname, "plugins");
  console.log("📂 Loading plugins from:", pluginsPath);

  if (!fs.existsSync(pluginsPath)) return;

  fs.readdirSync(pluginsPath).forEach((file) =>
    loadPlugin(client, path.join(pluginsPath, file))
  );

  chokidar
    .watch(pluginsPath, { ignoreInitial: true })
    .on("add", (filePath) => loadPlugin(client, filePath))
    .on("change", (filePath) => loadPlugin(client, filePath));
}

// ====================== CONNECT FUNCTION ======================
async function connectToWA() {
  ensureDirSync(path.join(__dirname, "temp"));
  ensureDirSync(sessionDir);

  const { getBuffer, getGroupAdmins } = require("./lib/functions");
  const { sms } = require("./lib/msg");
  const connectDB = require("./lib/mongodb");
  const { readEnv } = require("./lib/database");

  await connectDB();
  await readEnv();

  console.log("🔌 Connecting GHOST MD...");

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.macOS("Firefox"),
    syncFullHistory: true,
    auth: state,
    version,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📌 QR Generated! Scan from WhatsApp ✅");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;

      const shouldReconnect =
        code !== DisconnectReason.loggedOut &&
        code !== DisconnectReason.badSession;

      console.log(shouldReconnect ? "🔄 Reconnecting..." : "🔒 Logged out / bad session.");

      if (shouldReconnect) setTimeout(() => connectToWA().catch(console.error), 2000);
    }

    if (connection === "open") {
      console.log("✅ GHOST MD connected ✅");
      loadPlugins(sock);

      if (ownerJid) {
        sock.sendMessage(ownerJid, {
          image: {
            url: "https://github.com/nadeelachamath-crypto/GHOST-SUPPORT/blob/main/ChatGPT%20Image%20Oct%2031,%202025,%2010_10_49%20PM.png?raw=true",
          },
          caption: "👻GHOST MD👻 connected successfully ✅",
        });
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.sendFileUrl = async (jid, url, caption = "", quoted, options = {}) => {
    try {
      let mime = "application/octet-stream";
      try {
        const head = await axios.head(url, { timeout: 15000 });
        if (head?.headers?.["content-type"]) mime = head.headers["content-type"];
      } catch {}

      const baseType = String(mime).split("/")[0];
      const mediaData = await getBuffer(url);

      if (baseType === "image")
        return sock.sendMessage(jid, { image: mediaData, caption, ...options }, { quoted });

      if (baseType === "video")
        return sock.sendMessage(
          jid,
          { video: mediaData, caption, mimetype: "video/mp4", ...options },
          { quoted }
        );

      if (baseType === "audio")
        return sock.sendMessage(
          jid,
          { audio: mediaData, mimetype: "audio/mpeg", ...options },
          { quoted }
        );

      if (mime === "application/pdf")
        return sock.sendMessage(
          jid,
          { document: mediaData, mimetype: mime, caption, ...options },
          { quoted }
        );

      return sock.sendMessage(
        jid,
        { document: mediaData, mimetype: mime, fileName: "file", caption, ...options },
        { quoted }
      );
    } catch (err) {
      console.error("❌ sendFileUrl error:", err.message);
    }
  };

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const mek = messages?.[0];
      if (!mek?.message) return;

      const from = mek.key.remoteJid;
      const isGroup = from.endsWith("@g.us");

      mek.message = unwrapBaileysMessage(mek.message);

      const sender = mek.key.fromMe
        ? sock.user.id.split(":")[0] + "@s.whatsapp.net"
        : mek.key.participant || from;

      const senderNumber = normalizeNumber(sender.split("@")[0]);
      const botNumber = normalizeNumber(sock.user.id.split(":")[0]);

      const isOwner = ownerList.includes(senderNumber) || senderNumber === botNumber;

      switch (rawConfig.MODE) {
        case "private":
          if (!isOwner) return;
          break;
        case "inbox":
          if (isGroup && !isOwner) return;
          break;
        case "groups":
          if (!isGroup && !isOwner) return;
          break;
        case "public":
          break;
        default:
          console.warn(`⚠️ Unknown MODE: "${rawConfig.MODE}", defaulting to private.`);
          if (!isOwner) return;
      }

      if (rawConfig.AUTO_STATUS_SEEN && from === "status@broadcast") {
        try {
          await sock.readMessages([mek.key]);
        } catch {}
        return;
      }

      if (rawConfig.AUTO_READ) {
        try {
          await sock.readMessages([mek.key]);
        } catch {}
      }

      if (rawConfig.AUTO_REACT) {
        try {
          await sock.sendMessage(from, { react: { text: "✅", key: mek.key } });
        } catch {}
      }

      const { sms } = require("./lib/msg");
      const m = sms(sock, mek);
      const type = getContentType(mek.message);

      if (from === "status@broadcast") return;

      const body =
        type === "conversation"
          ? mek.message.conversation
          : type === "extendedTextMessage"
          ? mek.message.extendedTextMessage.text
          : type === "imageMessage"
          ? mek.message.imageMessage.caption
          : type === "videoMessage"
          ? mek.message.videoMessage.caption
          : "";

      const text = String(body || "");
      const isCmd = text.startsWith(prefix);

      const command = isCmd ? text.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase() : "";
      const args = isCmd ? text.slice(prefix.length).trim().split(/\s+/).slice(1) : [];
      const q = args.join(" ");

      const groupMetadata = isGroup ? await sock.groupMetadata(from).catch(() => null) : null;
      const participants = groupMetadata?.participants || [];
      const { getGroupAdmins } = require("./lib/functions");
      const groupAdmins = isGroup ? await getGroupAdmins(participants) : [];

      const reply = (txt) => sock.sendMessage(from, { text: txt }, { quoted: mek });

      const events = require("./command");

      if (isCmd) {
        const cmdObj = events.commands.find(
          (c) => c.pattern === command || c.alias?.includes(command)
        );

        if (cmdObj) {
          if (cmdObj.react) {
            try {
              sock.sendMessage(from, { react: { text: cmdObj.react, key: mek.key } });
            } catch {}
          }

          try {
            await cmdObj.function(sock, mek, m, {
              from,
              body: text,
              q,
              args,
              isGroup,
              sender,
              isOwner,
              reply,
              groupAdmins,
            });
          } catch (err) {
            console.error("❌ Command error:", err.message);
          }
        }
      }

      for (const cmd of events.commands) {
        const shouldRun =
          (cmd.on === "body" && text) ||
          (cmd.on === "text" && q) ||
          (cmd.on === "image" && type === "imageMessage") ||
          (cmd.on === "sticker" && type === "stickerMessage");

        if (shouldRun) {
          try {
            await cmd.function(sock, mek, m, { from, body: text, q, reply });
          } catch (e) {
            console.error(`❌ Trigger error [${cmd.on}]`, e.message);
          }
        }
      }
    } catch (err) {
      console.error("❌ Message handler error:", err.message);
    }
  });
}

// ====================== EXPRESS PING ======================
app.get("/", (req, res) => {
  res.send("👻GHOST MD👻 started ✅");
});

app.listen(port, () => console.log(`🌐 Server running on http://localhost:${port}`));

// ====================== START BOT ======================
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e?.message || e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e?.message || e));

(async () => {
  await ensureBotFiles();
  await ensureSession();
  await connectToWA();
})();
