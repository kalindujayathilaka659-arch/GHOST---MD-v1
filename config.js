const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

// Load environment variables from config.env if it exists
const configPath = path.resolve(__dirname, "config.env");
if (fs.existsSync(configPath)) {
  dotenv.config({ path: configPath });
}

function convertToBool(text, fault = "true") {
  return text?.toLowerCase() === fault.toLowerCase();
}

module.exports = {
  SESSION_ID: process.env.SESSION_ID || "KEkljS6b#Bksgu4HFB7CdwK_sYE_mDrXplefWV-qQOc6VOMHIjtI",   /// <-- your session id hear (Session id recommended) // qr in terminal available 
  MONGODB: process.env.MONGODB || "mongodb://mongo:mwNXNdbVtDktxjiiKMLQwjFcetvdcgAB@shortline.proxy.rlwy.net:51637", // change this if you have monogodb url
  OWNER_NUM: (process.env.OWNER_NUM || "94701981053").split(","), // <-- your number 


OLLAMA_HOST: "https://ollama.com",
OLLAMA_MODEL: "gpt-oss:120b-cloud",
OLLAMA_API_KEY: "5f90d76c4e3e4fba854e196ed2738790.I7PxUZBaIkR0ptskUglibBsk",
AUTO_READ_MESSAGES: true,   // ✅ reads ALL messages (DM + Groups)
AUTH_SYSTEM: false,
AUTO_READ_STATUS: true,   // true = read status
AUTO_LIKE_STATUS: true,   // true = like (heart/react) status
AUTO_REPLY_STATUS: false,   
STATUS_REACT_EMOJI: "👻",  // emoji for status reaction
STATUS_REPLY_TEXT: "🔥 Nice status!",
MODE: "groups", // Options: "public" | "private" | "inbox" | "groups"
PREFIX: ".",
AUTO_FAKE_TYPING: true,
FAKE_TYPING_DELAY_MIN: 800,
FAKE_TYPING_DELAY_MAX: 2000,

ALIVE_IMG: process.env.ALIVE_IMG || "https://github.com/nadeelachamath-crypto/GHOST-SUPPORT/blob/main/ChatGPT%20Image%20Oct%2031,%202025,%2010_10_49%20PM.png?raw=true"
};
