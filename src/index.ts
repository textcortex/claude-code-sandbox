import Docker from "dockerode";
import { simpleGit, SimpleGit } from "simple-git";
import chalk from "chalk";
import { CredentialManager } from "./credentials";
import { GitMonitor } from "./git-monitor";
import { ContainerManager } from "./container";
import { UIManager } from "./ui";
import { WebUIServer } from "./web-server";
import { SandboxConfig } from "./types";
import { getDockerConfig, isPodman } from "./docker-config";
import { SHADOW_BASE_PATH } from "./config";
import { SessionStore } from "./session-store";
import path from "path";

export class ClaudeSandbox {
  private docker: Docker;
  private git: SimpleGit;
  private config: SandboxConfig;
  private credentialManager: CredentialManager;
  private gitMonitor: GitMonitor;
  private containerManager: ContainerManager;
  private ui: UIManager;
  private webServer?: WebUIServer;
  private containerId?: string;
  private sessionStore: SessionStore;

  constructor(config: SandboxConfig) {
    this.config = config;
    const dockerConfig = getDockerConfig(config.dockerSocketPath);
    this.docker = new Docker(dockerConfig);

    // Log if using Podman
    if (isPodman(dockerConfig)) {
      console.log(chalk.blue("Detected Podman socket"));
    }

    this.git = simpleGit();
    this.credentialManager = new CredentialManager();
    this.gitMonitor = new GitMonitor(this.git);
    this.containerManager = new ContainerManager(this.docker, config);
    this.ui = new UIManager();
    this.sessionStore = new SessionStore();
  }

  async run(): Promise<void> {
    try {
      // Verify we're in a git repository
      await this.verifyGitRepo();

      // Check current branch
      const currentBranch = await this.git.branchLocal();
      console.log(chalk.blue(`Current branch: ${currentBranch.current}`));

      // Determine target branch based on config options (but don't checkout in host repo)
      let branchName = "";
      let prFetchRef = "";
      let remoteFetchRef = "";

      if (this.config.prNumber) {
        // Get PR branch name from GitHub but don't checkout locally
        console.log(chalk.blue(`Getting PR #${this.config.prNumber} info...`));
        try {
          const { execSync } = require("child_process");

          // Get PR info to find the actual branch name
          const prInfo = execSync(
            `gh pr view ${this.config.prNumber} --json headRefName`,
            {
              encoding: "utf-8",
              cwd: process.cwd(),
            },
          );
          const prData = JSON.parse(prInfo);
          branchName = prData.headRefName;
          prFetchRef = `pull/${this.config.prNumber}/head:${branchName}`;

          console.log(
            chalk.blue(
              `PR #${this.config.prNumber} uses branch: ${branchName}`,
            ),
          );
          console.log(
            chalk.blue(`Will setup container with PR branch: ${branchName}`),
          );
        } catch (error) {
          console.error(
            chalk.red(`✗ Failed to get PR #${this.config.prNumber} info:`),
            error,
          );
          throw error;
        }
      } else if (this.config.remoteBranch) {
        // Parse remote branch but don't checkout locally
        console.log(
          chalk.blue(
            `Will setup container with remote branch: ${this.config.remoteBranch}`,
          ),
        );
        try {
          // Parse remote/branch format
          const parts = this.config.remoteBranch.split("/");
          if (parts.length < 2) {
            throw new Error(
              'Remote branch must be in format "remote/branch" (e.g., "origin/feature-branch")',
            );
          }

          const remote = parts[0];
          const branch = parts.slice(1).join("/");

          console.log(chalk.blue(`Remote: ${remote}, Branch: ${branch}`));
          branchName = branch;
          remoteFetchRef = `${remote}/${branch}`;
        } catch (error) {
          console.error(
            chalk.red(
              `✗ Failed to parse remote branch ${this.config.remoteBranch}:`,
            ),
            error,
          );
          throw error;
        }
      } else {
        // Use target branch from config or generate one
        branchName =
          this.config.targetBranch ||
          (() => {
            const timestamp = new Date()
              .toISOString()
              .replace(/[:.]/g, "-")
              .split("T")[0];
            return `claude/${timestamp}-${Date.now()}`;
          })();
        console.log(
          chalk.blue(`Will create branch in container: ${branchName}`),
        );
      }

      // Discover credentials (optional - don't fail if not found)
      const credentials = await this.credentialManager.discover();

      // Prepare container environment
      const containerConfig = await this.prepareContainer(
        branchName,
        credentials,
        prFetchRef,
        remoteFetchRef,
      );

      // Start container
      const containerId = await this.containerManager.start(containerConfig);
      this.containerId = containerId;
      console.log(
        chalk.green(`✓ Started container: ${containerId.substring(0, 12)}`),
      );

      // Record session for recovery
      const shadowBasePath = this.config.shadowBasePath || SHADOW_BASE_PATH;
      const sessionId = containerId.substring(0, 12);
      await this.sessionStore.addSession({
        containerId,
        containerName: `${this.config.containerPrefix || "claude-code-sandbox"}-${Date.now()}`,
        sessionId,
        repoPath: process.cwd(),
        branchName,
        originalBranch: currentBranch.current,
        shadowRepoPath: path.join(shadowBasePath, sessionId),
        startTime: new Date().toISOString(),
        lastActivityTime: new Date().toISOString(),
        status: "active",
        config: {
          dockerImage: this.config.dockerImage,
          defaultShell: this.config.defaultShell,
          autoCommit: this.config.autoCommit,
          autoCommitIntervalMinutes: this.config.autoCommitIntervalMinutes,
          restartPolicy: this.config.restartPolicy,
        },
      });

      // Start monitoring for commits
      this.gitMonitor.on("commit", async (commit) => {
        await this.handleCommit(commit);
      });

      await this.gitMonitor.start(branchName);
      console.log(chalk.blue("✓ Git monitoring started"));

      // Launch web UI or attach to terminal directly
      if (this.config.useWebUI !== false) {
        this.webServer = new WebUIServer(this.docker);

        // Pass repo info and persistence config to web server
        this.webServer.setRepoInfo(process.cwd(), branchName);
        this.webServer.setShadowBasePath(
          this.config.shadowBasePath || SHADOW_BASE_PATH,
        );
        this.webServer.setAutoCommitConfig(
          this.config.autoCommit !== false,
          this.config.autoCommitIntervalMinutes || 5,
        );

        const webUrl = await this.webServer.start();

        // Open browser to the web UI with container ID
        const fullUrl = `${webUrl}?container=${containerId}`;
        await this.webServer.openInBrowser(fullUrl);

        console.log(chalk.green(`\n✓ Web UI available at: ${fullUrl}`));
        console.log(
          chalk.yellow("Keep this terminal open to maintain the session"),
        );

        // Keep the process running
        await new Promise(() => {}); // This will keep the process alive
      } else {
        // Terminal mode - attach directly to container
        console.log(chalk.green("\n✓ Attaching to container terminal..."));
        console.log(chalk.yellow("Press Ctrl+P, Ctrl+Q to detach\n"));

        await this.attachToContainer(containerId);
      }
    } catch (error) {
      console.error(chalk.red("Error:"), error);
      throw error;
    }
  }

  private async verifyGitRepo(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      throw new Error(
        "Not a git repository. Please run claude-sandbox from within a git repository.",
      );
    }
  }

  private async prepareContainer(
    branchName: string,
    credentials: any,
    prFetchRef?: string,
    remoteFetchRef?: string,
  ): Promise<any> {
    const workDir = process.cwd();
    const repoName = path.basename(workDir);

    return {
      branchName,
      credentials,
      workDir,
      repoName,
      dockerImage: this.config.dockerImage || "claude-code-sandbox:latest",
      prFetchRef,
      remoteFetchRef,
    };
  }

  private async handleCommit(commit: any): Promise<void> {
    // Show commit notification
    this.ui.showCommitNotification(commit);

    // Show diff
    const diff = await this.git.diff(["HEAD~1", "HEAD"]);
    this.ui.showDiff(diff);

    // Ask user what to do
    const action = await this.ui.askCommitAction();

    switch (action) {
      case "nothing":
        console.log(chalk.blue("Continuing..."));
        break;
      case "push":
        await this.pushBranch();
        break;
      case "push-pr":
        await this.pushBranchAndCreatePR();
        break;
      case "exit":
        await this.cleanup();
        process.exit(0);
    }
  }

  private async pushBranch(): Promise<void> {
    const currentBranch = await this.git.branchLocal();
    await this.git.push("origin", currentBranch.current);
    console.log(chalk.green(`✓ Pushed branch: ${currentBranch.current}`));
  }

  private async pushBranchAndCreatePR(): Promise<void> {
    await this.pushBranch();

    // Use gh CLI to create PR
    const { execSync } = require("child_process");
    try {
      execSync("gh pr create --fill", { stdio: "inherit" });
      console.log(chalk.green("✓ Created pull request"));
    } catch (error) {
      console.error(
        chalk.yellow(
          "Could not create PR automatically. Please create it manually.",
        ),
      );
    }
  }

  private async cleanup(intentional: boolean = true): Promise<void> {
    await this.gitMonitor.stop();
    await this.containerManager.cleanup(intentional);
    if (this.webServer) {
      await this.webServer.stop(intentional);
    }

    // Update session store
    if (this.containerId) {
      if (intentional) {
        await this.sessionStore.removeSession(this.containerId);
      } else {
        await this.sessionStore.updateSession(this.containerId, {
          status: "stopped",
          exitType: "crash",
          lastActivityTime: new Date().toISOString(),
        });
      }
    }
  }

  private async attachToContainer(containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);

    // Get current terminal size
    const getTerminalSize = () => ({
      h: process.stdout.rows || 24,
      w: process.stdout.columns || 80,
    });

    const termSize = getTerminalSize();

    // Execute the startup script in an interactive session
    const dockerExec = await container.exec({
      Cmd: ["/bin/bash", "-l", "-c", "/home/claude/start-session.sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
    });

    const stream = await dockerExec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    });

    // Set initial terminal size
    await dockerExec.resize(termSize);

    // Handle terminal resize events
    const resizeHandler = async () => {
      try {
        await dockerExec.resize(getTerminalSize());
      } catch {
        // Ignore resize errors (exec might have ended)
      }
    };
    process.stdout.on("resize", resizeHandler);

    // Set up raw mode for proper terminal handling
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Pipe streams
    process.stdin.pipe(stream);
    stream.pipe(process.stdout);

    // Handle stream end
    stream.on("end", async () => {
      process.stdout.off("resize", resizeHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      await this.cleanup();
      process.exit(0);
    });

    // Handle Ctrl+C gracefully
    process.on("SIGINT", async () => {
      process.stdout.off("resize", resizeHandler);
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      await this.cleanup();
      process.exit(0);
    });
  }
}

export * from "./types";
