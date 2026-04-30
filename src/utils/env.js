const fs = require("node:fs");
const path = require("node:path");

let loaded = false;

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex === -1) {
    return null;
  }

  const key = trimmed.slice(0, separatorIndex).trim();
  if (!key) {
    return null;
  }

  let value = trimmed.slice(separatorIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value };
}

function loadEnvFile() {
  if (loaded) {
    return;
  }

  loaded = true;

  const envPath = path.resolve(__dirname, "..", "..", ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (!entry) {
      continue;
    }

    if (process.env[entry.key] === undefined) {
      process.env[entry.key] = entry.value;
    }
  }
}

function getEnv(name, fallback) {
  loadEnvFile();
  return process.env[name] !== undefined ? process.env[name] : fallback;
}

function getEnvNumber(name, fallback) {
  const value = getEnv(name, "");
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

module.exports = {
  loadEnvFile,
  getEnv,
  getEnvNumber,
};
