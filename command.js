const fs = require("fs");
const path = require("path");
const { isOwner } = require("./lib/auth"); // <-- fix here

const commands = [];

function cmd(options, callback) {
  if (!options.pattern || typeof callback !== "function") {
    console.error("Invalid command definition:", options);
    return;
  }

  // 🔐 wrap callback with authorization
  const securedCallback = async (...args) => {
    const reply = args[3]?.reply;
    const sender = args[3]?.sender;

    // ownerOnly check here instead of inside plugin
    if (options.ownerOnly && !isOwner(sender)) {
      return reply?.("❌ *You are not authorized to use this command!*");
    }

    return callback(...args);
  };

  commands.push({ ...options, function: securedCallback });
}

function loadPlugins() {
  const pluginPath = path.join(__dirname, "./plugins");

  if (!fs.existsSync(pluginPath)) return;

  const files = fs.readdirSync(pluginPath).filter(file => file.endsWith(".js"));

  for (const file of files) {
    const pluginFile = path.join(pluginPath, file);
    try {
      require(pluginFile);
      console.log(`✅ Loaded plugin: ${file}`);
    } catch (err) {
      console.error(`❌ Failed to load plugin ${file}:`, err.message);
    }
  }
}

module.exports = {
  cmd,
  loadPlugins,
  commands
};
