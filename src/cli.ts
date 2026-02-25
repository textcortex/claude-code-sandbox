#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import inquirer from "inquirer";
import Docker from "dockerode";
import { ClaudeSandbox } from "./index";
import { loadConfig } from "./config";
import { WebUIServer } from "./web-server";
import { getDockerConfig, isPodman } from "./docker-config";
import { SessionStore } from "./session-store";
import { SHADOW_BASE_PATH } from "./config";
import { recoverSession } from "./recover";
import * as fsExtra from "fs-extra";
import ora from "ora";

// Initialize Docker with config - will be updated after loading config if needed
let dockerConfig = getDockerConfig();
let docker = new Docker(dockerConfig);
const program = new Command();

// Helper function to reinitialize Docker with custom socket path
function reinitializeDocker(socketPath?: string) {
  if (socketPath) {
    dockerConfig = getDockerConfig(socketPath);
    docker = new Docker(dockerConfig);

    // Log if using Podman
    if (isPodman(dockerConfig)) {
      console.log(chalk.blue("Detected Podman socket"));
    }
  }
}

// Helper to ensure Docker is initialized with config
async function ensureDockerConfig() {
  try {
    const config = await loadConfig("./claude-sandbox.config.json");
    reinitializeDocker(config.dockerSocketPath);
  } catch (error) {
    // Config loading failed, continue with default Docker config
  }
}

// Helper function to get Claude Sandbox containers
async function getClaudeSandboxContainers() {
  const containers = await docker.listContainers({ all: true });
  return containers.filter((c) =>
    c.Names.some((name) => name.includes("claude-code-sandbox")),
  );
}

// Helper function to select a container interactively
async function selectContainer(containers: any[]): Promise<string | null> {
  if (containers.length === 0) {
    console.log(chalk.yellow("No Claude Sandbox containers found."));
    return null;
  }

  const choices = containers.map((c) => ({
    name: `${c.Names[0].substring(1)} - ${c.State} (${c.Status})`,
    value: c.Id,
    short: c.Id.substring(0, 12),
  }));

  const { containerId } = await inquirer.prompt([
    {
      type: "list",
      name: "containerId",
      message: "Select a container:",
      choices,
    },
  ]);

  return containerId;
}

program
  .name("claude-sandbox")
  .description("Run Claude Code in isolated Docker containers")
  .version("0.1.0");

// Default command (always web UI)
program
  .option(
    "--shell <shell>",
    "Start with 'claude' or 'bash' shell",
    /^(claude|bash)$/i,
  )
  .action(async (options) => {
    console.log(chalk.blue("🚀 Starting Claude Sandbox..."));

    const config = await loadConfig("./claude-sandbox.config.json");
    config.includeUntracked = false;
    if (options.shell) {
      config.defaultShell = options.shell.toLowerCase();
    }

    const sandbox = new ClaudeSandbox(config);
    await sandbox.run();
  });

// Start command - explicitly start a new container
program
  .command("start")
  .description("Start a new Claude Sandbox container")
  .option(
    "-c, --config <path>",
    "Configuration file",
    "./claude-sandbox.config.json",
  )
  .option("-n, --name <name>", "Container name prefix")
  .option("--no-push", "Disable automatic branch pushing")
  .option("--no-create-pr", "Disable automatic PR creation")
  .option(
    "--include-untracked",
    "Include untracked files when copying to container",
  )
  .option(
    "-b, --branch <branch>",
    "Switch to specific branch on container start (creates if doesn't exist)",
  )
  .option(
    "--remote-branch <branch>",
    "Checkout a remote branch (e.g., origin/feature-branch)",
  )
  .option("--pr <number>", "Checkout a specific PR by number")
  .option(
    "--shell <shell>",
    "Start with 'claude' or 'bash' shell",
    /^(claude|bash)$/i,
  )
  .option("--no-web", "Disable web UI (use terminal attach)")
  .action(async (options) => {
    console.log(chalk.blue("🚀 Starting new Claude Sandbox container..."));

    const config = await loadConfig(options.config);
    config.containerPrefix = options.name || config.containerPrefix;
    config.autoPush = options.push !== false;
    config.autoCreatePR = options.createPr !== false;
    config.includeUntracked = options.includeUntracked || false;
    config.targetBranch = options.branch;
    config.remoteBranch = options.remoteBranch;
    config.prNumber = options.pr;
    config.useWebUI = options.web !== false;
    if (options.shell) {
      config.defaultShell = options.shell.toLowerCase();
    }

    const sandbox = new ClaudeSandbox(config);
    await sandbox.run();
  });

// Attach command - attach to existing container
program
  .command("attach [container-id]")
  .description("Attach to an existing Claude Sandbox container")
  .action(async (containerId) => {
    await ensureDockerConfig();
    const spinner = ora("Looking for containers...").start();

    try {
      let targetContainerId = containerId;

      // If no container ID provided, show selection UI
      if (!targetContainerId) {
        spinner.stop();
        const containers = await getClaudeSandboxContainers();
        targetContainerId = await selectContainer(containers);

        if (!targetContainerId) {
          console.log(chalk.red("No container selected."));
          process.exit(1);
        }
      }

      spinner.text = "Launching web UI...";

      // Always launch web UI
      const webServer = new WebUIServer(docker);
      const url = await webServer.start();
      const fullUrl = `${url}?container=${targetContainerId}`;

      spinner.succeed(chalk.green(`Web UI available at: ${fullUrl}`));
      await webServer.openInBrowser(fullUrl);

      console.log(
        chalk.yellow("Keep this terminal open to maintain the session"),
      );

      // Keep process running
      await new Promise(() => {});
    } catch (error: any) {
      spinner.fail(chalk.red(`Failed: ${error.message}`));
      process.exit(1);
    }
  });

// List command - list all Claude Sandbox containers
program
  .command("list")
  .alias("ls")
  .description("List all Claude Sandbox containers")
  .option("-a, --all", "Show all containers (including stopped)")
  .action(async (options) => {
    await ensureDockerConfig();
    const spinner = ora("Fetching containers...").start();

    try {
      const containers = await docker.listContainers({ all: options.all });
      const claudeContainers = containers.filter((c) =>
        c.Names.some((name) => name.includes("claude-code-sandbox")),
      );

      spinner.stop();

      if (claudeContainers.length === 0) {
        console.log(chalk.yellow("No Claude Sandbox containers found."));
        return;
      }

      console.log(
        chalk.blue(
          `Found ${claudeContainers.length} Claude Sandbox container(s):\n`,
        ),
      );

      claudeContainers.forEach((c) => {
        const name = c.Names[0].substring(1);
        const id = c.Id.substring(0, 12);
        const state =
          c.State === "running" ? chalk.green(c.State) : chalk.gray(c.State);
        const status = c.Status;

        console.log(`${chalk.cyan(id)} - ${name} - ${state} - ${status}`);
      });
    } catch (error: any) {
      spinner.fail(chalk.red(`Failed: ${error.message}`));
      process.exit(1);
    }
  });

// Stop command - stop Claude Sandbox containers
program
  .command("stop [container-id]")
  .description("Stop Claude Sandbox container(s)")
  .option("-a, --all", "Stop all Claude Sandbox containers")
  .action(async (containerId, options) => {
    await ensureDockerConfig();
    const spinner = ora("Stopping containers...").start();

    try {
      if (options.all) {
        // Stop all Claude Sandbox containers
        const containers = await getClaudeSandboxContainers();
        const runningContainers = containers.filter(
          (c) => c.State === "running",
        );

        if (runningContainers.length === 0) {
          spinner.info("No running Claude Sandbox containers found.");
          return;
        }

        for (const c of runningContainers) {
          const container = docker.getContainer(c.Id);
          await container.stop();
          spinner.text = `Stopped ${c.Id.substring(0, 12)}`;
        }

        spinner.succeed(`Stopped ${runningContainers.length} container(s)`);
      } else {
        // Stop specific container
        let targetContainerId = containerId;

        if (!targetContainerId) {
          spinner.stop();
          const containers = await getClaudeSandboxContainers();
          const runningContainers = containers.filter(
            (c) => c.State === "running",
          );
          targetContainerId = await selectContainer(runningContainers);

          if (!targetContainerId) {
            console.log(chalk.red("No container selected."));
            process.exit(1);
          }
          spinner.start();
        }

        const container = docker.getContainer(targetContainerId);
        await container.stop();
        spinner.succeed(
          `Stopped container ${targetContainerId.substring(0, 12)}`,
        );
      }
    } catch (error: any) {
      spinner.fail(chalk.red(`Failed: ${error.message}`));
      process.exit(1);
    }
  });

// Logs command - view container logs
program
  .command("logs [container-id]")
  .description("View logs from a Claude Sandbox container")
  .option("-f, --follow", "Follow log output")
  .option("-n, --tail <lines>", "Number of lines to show from the end", "50")
  .action(async (containerId, options) => {
    try {
      await ensureDockerConfig();
      let targetContainerId = containerId;

      if (!targetContainerId) {
        const containers = await getClaudeSandboxContainers();
        targetContainerId = await selectContainer(containers);

        if (!targetContainerId) {
          console.log(chalk.red("No container selected."));
          process.exit(1);
        }
      }

      const container = docker.getContainer(targetContainerId);
      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        follow: options.follow,
        tail: parseInt(options.tail),
      });

      // Docker logs come with headers, we need to parse them
      container.modem.demuxStream(logStream, process.stdout, process.stderr);

      if (options.follow) {
        console.log(chalk.gray("Following logs... Press Ctrl+C to exit"));
      }
    } catch (error: any) {
      console.error(chalk.red(`Failed: ${error.message}`));
      process.exit(1);
    }
  });

// Clean command - remove stopped containers
program
  .command("clean")
  .description("Remove all stopped Claude Sandbox containers and orphaned data")
  .option("-f, --force", "Remove all containers (including running)")
  .option("--shadows", "Also clean orphaned shadow repos")
  .action(async (options) => {
    await ensureDockerConfig();
    const spinner = ora("Cleaning up containers...").start();

    try {
      const containers = await getClaudeSandboxContainers();
      const targetContainers = options.force
        ? containers
        : containers.filter((c) => c.State !== "running");

      let removed = 0;
      if (targetContainers.length > 0) {
        for (const c of targetContainers) {
          const container = docker.getContainer(c.Id);
          if (c.State === "running" && options.force) {
            await container.stop();
          }
          await container.remove();
          spinner.text = `Removed ${c.Id.substring(0, 12)}`;
          removed++;
        }
      }

      // Clean session records for containers that no longer exist
      spinner.text = "Cleaning session records...";
      const store = new SessionStore();
      const sessions = await store.load();
      let sessionsRemoved = 0;
      for (const session of sessions) {
        try {
          const container = docker.getContainer(session.containerId);
          await container.inspect();
          // Container exists — keep the record
        } catch {
          // Container gone — remove the record
          await store.removeSession(session.containerId);
          sessionsRemoved++;
        }
      }

      // Clean orphaned shadow repos if requested
      let shadowsRemoved = 0;
      if (options.shadows && (await fsExtra.pathExists(SHADOW_BASE_PATH))) {
        spinner.text = "Cleaning orphaned shadow repos...";
        const entries = await fsExtra.readdir(SHADOW_BASE_PATH);
        const activeSessions = await store.load();
        const activeSessionIds = new Set(
          activeSessions.map((s) => s.sessionId),
        );

        for (const entry of entries) {
          if (!activeSessionIds.has(entry)) {
            const shadowPath = `${SHADOW_BASE_PATH}/${entry}`;
            await fsExtra.remove(shadowPath);
            shadowsRemoved++;
          }
        }
      }

      const parts = [];
      if (removed > 0) parts.push(`${removed} container(s)`);
      if (sessionsRemoved > 0) parts.push(`${sessionsRemoved} session record(s)`);
      if (shadowsRemoved > 0) parts.push(`${shadowsRemoved} shadow repo(s)`);

      if (parts.length > 0) {
        spinner.succeed(`Cleaned up ${parts.join(", ")}`);
      } else {
        spinner.info("Nothing to clean up.");
      }
    } catch (error: any) {
      spinner.fail(chalk.red(`Failed: ${error.message}`));
      process.exit(1);
    }
  });

// Purge command - stop and remove all containers
program
  .command("purge")
  .description("Stop and remove all Claude Sandbox containers")
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options) => {
    try {
      await ensureDockerConfig();
      const containers = await getClaudeSandboxContainers();

      if (containers.length === 0) {
        console.log(chalk.yellow("No Claude Sandbox containers found."));
        return;
      }

      // Show what will be removed
      console.log(
        chalk.yellow(`Found ${containers.length} Claude Sandbox container(s):`),
      );
      containers.forEach((c) => {
        console.log(
          `  ${c.Id.substring(0, 12)} - ${c.Names[0].replace("/", "")} - ${c.State}`,
        );
      });

      // Confirm unless -y flag is used
      if (!options.yes) {
        const { confirm } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirm",
            message: "Are you sure you want to stop and remove all containers?",
            default: false,
          },
        ]);

        if (!confirm) {
          console.log(chalk.gray("Purge cancelled."));
          return;
        }
      }

      const spinner = ora("Purging containers...").start();
      let removed = 0;

      for (const c of containers) {
        try {
          const container = docker.getContainer(c.Id);
          spinner.text = `Stopping ${c.Id.substring(0, 12)}...`;

          if (c.State === "running") {
            await container.stop({ t: 5 }); // 5 second timeout
          }

          spinner.text = `Removing ${c.Id.substring(0, 12)}...`;
          await container.remove();
          removed++;
        } catch (error: any) {
          spinner.warn(
            `Failed to remove ${c.Id.substring(0, 12)}: ${error.message}`,
          );
        }
      }

      // Clear all session records
      spinner.text = "Clearing session records...";
      const store = new SessionStore();
      await store.clearAll();

      // Clear all shadow repos
      spinner.text = "Clearing shadow repos...";
      if (await fsExtra.pathExists(SHADOW_BASE_PATH)) {
        await fsExtra.remove(SHADOW_BASE_PATH);
      }

      if (removed === containers.length) {
        spinner.succeed(
          chalk.green(
            `✓ Purged all ${removed} container(s), session records, and shadow repos`,
          ),
        );
      } else {
        spinner.warn(
          chalk.yellow(
            `Purged ${removed} of ${containers.length} container(s), plus session records and shadow repos`,
          ),
        );
      }
    } catch (error: any) {
      console.error(chalk.red(`Purge failed: ${error.message}`));
      process.exit(1);
    }
  });

// Config command - show configuration
program
  .command("config")
  .description("Show current configuration")
  .option(
    "-p, --path <path>",
    "Configuration file path",
    "./claude-sandbox.config.json",
  )
  .action(async (options) => {
    try {
      const config = await loadConfig(options.path);
      console.log(chalk.blue("Current configuration:"));
      console.log(JSON.stringify(config, null, 2));
    } catch (error: any) {
      console.error(chalk.red(`Failed to load config: ${error.message}`));
      process.exit(1);
    }
  });

// Recover command - recover sessions after crash/reboot
program
  .command("recover")
  .description("Recover Claude Sandbox sessions after a crash or reboot")
  .option("-l, --list", "List recoverable sessions without recovering")
  .action(async (options) => {
    await ensureDockerConfig();
    const spinner = ora("Scanning for recoverable sessions...").start();

    try {
      const store = new SessionStore();
      const sessions = await store.getRecoverableSessions(docker);

      spinner.stop();

      if (sessions.length === 0) {
        console.log(chalk.yellow("No recoverable sessions found."));
        return;
      }

      console.log(
        chalk.blue(`Found ${sessions.length} recoverable session(s):\n`),
      );

      for (const session of sessions) {
        const age = getAge(session.startTime);
        const stateColor =
          session.containerState === "running"
            ? chalk.green
            : session.containerState === "stopped"
              ? chalk.yellow
              : chalk.red;

        console.log(
          `  ${chalk.cyan(session.sessionId)} | ` +
            `${chalk.white(session.branchName)} | ` +
            `${stateColor(session.containerState)} | ` +
            `shadow: ${session.shadowExists ? chalk.green("yes") : chalk.red("no")} | ` +
            `${chalk.gray(age)} | ` +
            `${chalk.gray(session.repoPath)}`,
        );
      }
      console.log();

      if (options.list) {
        return;
      }

      // Interactive selection
      const choices = sessions.map((s) => ({
        name: `${s.sessionId} - ${s.branchName} (${s.containerState}, shadow: ${s.shadowExists ? "yes" : "no"}) - ${getAge(s.startTime)}`,
        value: s.containerId,
      }));

      const { selectedId } = await inquirer.prompt([
        {
          type: "list",
          name: "selectedId",
          message: "Select a session to recover:",
          choices,
        },
      ]);

      const session = sessions.find((s) => s.containerId === selectedId)!;
      await recoverSession(docker, session, store);
    } catch (error: any) {
      spinner.fail(chalk.red(`Failed: ${error.message}`));
      process.exit(1);
    }
  });

function getAge(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

program.parse();
