import Docker from "dockerode";
import chalk from "chalk";
import inquirer from "inquirer";
import { exec } from "child_process";
import { promisify } from "util";
import * as fsExtra from "fs-extra";
import path from "path";
import { SessionStore, SessionRecord } from "./session-store";
import { WebUIServer } from "./web-server";

const execAsync = promisify(exec);

type RecoverableSession = SessionRecord & {
  containerState: "running" | "stopped" | "gone";
  shadowExists: boolean;
};

export async function recoverSession(
  docker: Docker,
  session: RecoverableSession,
  store: SessionStore,
): Promise<void> {
  const shortId = session.sessionId;

  if (session.containerState === "running") {
    // Container is already running — launch WebUI and re-attach
    console.log(
      chalk.green(`Container ${shortId} is running. Launching Web UI...`),
    );

    const webServer = new WebUIServer(docker);
    const url = await webServer.start();
    const fullUrl = `${url}?container=${session.containerId}`;
    console.log(chalk.green(`Web UI available at: ${fullUrl}`));
    await webServer.openInBrowser(fullUrl);

    // Update session
    await store.updateSession(session.containerId, {
      status: "active",
      lastActivityTime: new Date().toISOString(),
    });

    console.log(
      chalk.yellow("Keep this terminal open to maintain the session"),
    );
    // Keep process running
    await new Promise(() => {});
  } else if (session.containerState === "stopped") {
    // Container exists but is stopped — restart and re-attach
    console.log(chalk.blue(`Restarting container ${shortId}...`));

    const container = docker.getContainer(session.containerId);
    await container.start();

    console.log(chalk.green(`Container ${shortId} restarted. Launching Web UI...`));

    const webServer = new WebUIServer(docker);
    const url = await webServer.start();
    const fullUrl = `${url}?container=${session.containerId}`;
    console.log(chalk.green(`Web UI available at: ${fullUrl}`));
    await webServer.openInBrowser(fullUrl);

    // Update session
    await store.updateSession(session.containerId, {
      status: "active",
      lastActivityTime: new Date().toISOString(),
    });

    console.log(
      chalk.yellow("Keep this terminal open to maintain the session"),
    );
    // Keep process running
    await new Promise(() => {});
  } else if (session.shadowExists) {
    // Container is gone but shadow repo exists
    console.log(
      chalk.yellow(
        `Container ${shortId} is gone, but shadow repo exists at:`,
      ),
    );
    console.log(chalk.white(`  ${session.shadowRepoPath}`));

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "What would you like to do with the shadow repo?",
        choices: [
          {
            name: "Push to remote (if remote is configured)",
            value: "push",
          },
          {
            name: "Copy to a local path",
            value: "copy",
          },
          {
            name: "Show the shadow repo path (and keep it)",
            value: "show",
          },
          {
            name: "Discard (delete shadow repo and session record)",
            value: "discard",
          },
        ],
      },
    ]);

    switch (action) {
      case "push": {
        try {
          // Check if remote is configured
          const { stdout: remoteOutput } = await execAsync("git remote -v", {
            cwd: session.shadowRepoPath,
          });

          if (!remoteOutput.includes("origin")) {
            console.log(
              chalk.red("No remote 'origin' configured in shadow repo."),
            );
            console.log(
              chalk.yellow(
                `Shadow repo path: ${session.shadowRepoPath}`,
              ),
            );
            break;
          }

          // Stage, commit any remaining changes, and push
          await execAsync("git add -A", { cwd: session.shadowRepoPath });
          try {
            const timestamp = new Date()
              .toISOString()
              .replace(/[:.]/g, "-");
            await execAsync(
              `git commit -m "[recovery] Recovered changes from ${timestamp}"`,
              { cwd: session.shadowRepoPath },
            );
          } catch {
            // Nothing to commit — that's fine
          }

          const { stdout: branchOutput } = await execAsync(
            "git branch --show-current",
            { cwd: session.shadowRepoPath },
          );
          const branch = branchOutput.trim();

          await execAsync(`git push -u origin ${branch}`, {
            cwd: session.shadowRepoPath,
          });
          console.log(
            chalk.green(`Pushed branch '${branch}' to remote.`),
          );
          await store.removeSession(session.containerId);
        } catch (error: any) {
          console.error(chalk.red("Push failed:"), error.message);
          console.log(
            chalk.yellow(
              `Shadow repo preserved at: ${session.shadowRepoPath}`,
            ),
          );
        }
        break;
      }
      case "copy": {
        const { destPath } = await inquirer.prompt([
          {
            type: "input",
            name: "destPath",
            message: "Enter destination path:",
            default: path.join(
              process.cwd(),
              `recovered-${session.sessionId}`,
            ),
          },
        ]);

        const resolvedDest = path.resolve(destPath);
        await fsExtra.copy(session.shadowRepoPath, resolvedDest);
        console.log(chalk.green(`Copied to: ${resolvedDest}`));
        await store.removeSession(session.containerId);
        break;
      }
      case "show": {
        console.log(
          chalk.blue(`Shadow repo path: ${session.shadowRepoPath}`),
        );
        console.log(chalk.gray("Session record preserved."));
        break;
      }
      case "discard": {
        const { confirmDiscard } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirmDiscard",
            message:
              "Are you sure? This will delete the shadow repo permanently.",
            default: false,
          },
        ]);

        if (confirmDiscard) {
          await fsExtra.remove(session.shadowRepoPath);
          await store.removeSession(session.containerId);
          console.log(chalk.gray("Shadow repo and session record removed."));
        } else {
          console.log(chalk.gray("Discard cancelled."));
        }
        break;
      }
    }
  } else {
    // Both container and shadow repo are gone
    console.log(
      chalk.red(
        `Session ${shortId} is unrecoverable (container and shadow repo both gone).`,
      ),
    );
    await store.removeSession(session.containerId);
    console.log(chalk.gray("Session record cleaned up."));
  }
}
