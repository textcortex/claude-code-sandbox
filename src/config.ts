import fs from "fs/promises";
import path from "path";
import os from "os";
import { SandboxConfig } from "./types";

// Global config location: ~/.config/claude-sandbox/config.json
const GLOBAL_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "claude-sandbox",
  "config.json"
);

// Persistent data locations
export const SHADOW_BASE_PATH = path.join(
  os.homedir(),
  ".cache",
  "claude-sandbox",
  "shadows"
);
export const SESSION_STORE_PATH = path.join(
  os.homedir(),
  ".cache",
  "claude-sandbox",
  "sessions.json"
);

const DEFAULT_CONFIG: SandboxConfig = {
  dockerImage: "claude-code-sandbox:latest",
  autoPush: true,
  autoCreatePR: true,
  autoStartClaude: true,
  defaultShell: "claude", // Default to Claude mode for backward compatibility
  claudeConfigPath: path.join(os.homedir(), ".claude.json"),
  setupCommands: [], // Example: ["npm install", "pip install -r requirements.txt"]
  allowedTools: ["*"], // All tools allowed in sandbox
  includeUntracked: false, // Don't include untracked files by default
  restartPolicy: "unless-stopped",
  autoCommit: true,
  autoCommitIntervalMinutes: 5,
  // maxThinkingTokens: 100000,
  // bashTimeout: 600000, // 10 minutes
};

async function loadJsonFile(filePath: string): Promise<Partial<SandboxConfig> | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function loadConfig(configPath: string): Promise<SandboxConfig> {
  // Load global config first (if exists)
  const globalConfig = await loadJsonFile(GLOBAL_CONFIG_PATH);

  // Load local project config (if exists)
  const localConfig = await loadJsonFile(path.resolve(configPath));

  // Merge: defaults < global < local
  return {
    ...DEFAULT_CONFIG,
    ...(globalConfig || {}),
    ...(localConfig || {}),
  };
}

export async function saveConfig(
  config: SandboxConfig,
  configPath: string,
): Promise<void> {
  const fullPath = path.resolve(configPath);
  await fs.writeFile(fullPath, JSON.stringify(config, null, 2));
}

export function getGlobalConfigPath(): string {
  return GLOBAL_CONFIG_PATH;
}
