import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { Credentials } from "./types";
import chalk from "chalk";

export class CredentialManager {
  async discover(): Promise<Credentials> {
    const credentials: Credentials = {};

    // Discover Claude credentials (optional)
    try {
      credentials.claude = await this.discoverClaudeCredentials();
    } catch {
      // Claude credentials are optional - user can set them in the container
      console.log(
        chalk.yellow(
          "No Claude credentials found on host. You can set them in the container.",
        ),
      );
    }

    // Discover GitHub credentials
    credentials.github = await this.discoverGitHubCredentials();

    return credentials;
  }

  private async discoverClaudeCredentials(): Promise<Credentials["claude"]> {
    // Check environment variables
    if (process.env.ANTHROPIC_API_KEY) {
      return {
        type: "api_key",
        value: process.env.ANTHROPIC_API_KEY,
      };
    }

    // Check for ~/.claude.json configuration
    try {
      const claudeConfigPath = path.join(os.homedir(), ".claude.json");
      const configContent = await fs.readFile(claudeConfigPath, "utf-8");
      const config = JSON.parse(configContent);

      if (config.api_key) {
        return {
          type: "api_key",
          value: config.api_key,
        };
      }
    } catch {
      // File doesn't exist or is invalid, continue checking other sources
    }

    // Check for Bedrock configuration
    if (process.env.CLAUDE_CODE_USE_BEDROCK === "1") {
      return {
        type: "bedrock",
        value: "bedrock",
        region: process.env.AWS_REGION || "us-east-1",
      };
    }

    // Check for Vertex configuration
    if (process.env.CLAUDE_CODE_USE_VERTEX === "1") {
      return {
        type: "vertex",
        value: "vertex",
        project: process.env.GOOGLE_CLOUD_PROJECT,
      };
    }

    // Try to find OAuth tokens (Claude Max)
    const oauthToken = await this.findOAuthToken();
    if (oauthToken) {
      return {
        type: "oauth",
        value: oauthToken,
      };
    }

    throw new Error(
      "No Claude credentials found. Please set ANTHROPIC_API_KEY or create ~/.claude.json with your API key.",
    );
  }

  private async findOAuthToken(): Promise<string | null> {
    // Check common locations for Claude OAuth tokens/credentials
    const possiblePaths = [
      // Linux/cross-platform credential locations
      path.join(os.homedir(), ".claude", ".credentials.json"),
      path.join(os.homedir(), ".claude", "auth.json"),
      path.join(os.homedir(), ".config", "claude", "auth.json"),
      // macOS credential locations
      path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Claude",
        "auth.json",
      ),
    ];

    for (const authPath of possiblePaths) {
      try {
        const content = await fs.readFile(authPath, "utf-8");
        const auth = JSON.parse(content);
        // Check various token field names used by Claude Code
        if (auth.claudeAiOauth || auth.accessToken || auth.access_token) {
          // Return indicator that OAuth credentials exist
          // The actual credentials will be copied via _copyClaudeConfig
          return "oauth-credentials-found";
        }
      } catch {
        // Continue checking other paths
      }
    }

    // Try to get from system keychain (macOS)
    if (process.platform === "darwin") {
      try {
        const token = execSync(
          'security find-generic-password -s "claude-auth" -w 2>/dev/null',
          {
            encoding: "utf-8",
          },
        ).trim();
        if (token) return token;
      } catch {
        // Keychain access failed
      }
    }

    return null;
  }

  private async discoverGitHubCredentials(): Promise<Credentials["github"]> {
    const github: Credentials["github"] = {};

    // Check for GitHub token in environment
    if (process.env.GITHUB_TOKEN) {
      github.token = process.env.GITHUB_TOKEN;
    } else if (process.env.GH_TOKEN) {
      github.token = process.env.GH_TOKEN;
    } else {
      // Try to get from gh CLI
      try {
        const token = execSync("gh auth token 2>/dev/null", {
          encoding: "utf-8",
        }).trim();
        if (token) github.token = token;
      } catch {
        // gh CLI not available or not authenticated
      }
    }

    // Get git config
    try {
      const gitConfig = await fs.readFile(
        path.join(os.homedir(), ".gitconfig"),
        "utf-8",
      );
      github.gitConfig = gitConfig;
    } catch {
      // No git config found
    }

    return github;
  }
}
