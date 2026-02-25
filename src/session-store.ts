import fs from "fs/promises";
import path from "path";
import * as fsExtra from "fs-extra";
import Docker from "dockerode";
import { SESSION_STORE_PATH } from "./config";

export interface SessionRecord {
  containerId: string;
  containerName: string;
  sessionId: string; // first 12 chars of containerId
  repoPath: string; // host repo path
  branchName: string; // branch in container
  originalBranch: string; // host branch at start
  shadowRepoPath: string;
  startTime: string; // ISO 8601
  lastActivityTime: string;
  status: "active" | "stopped" | "exited";
  exitType?: "intentional" | "crash" | "unknown";
  webUIPort?: number;
  config: {
    dockerImage?: string;
    defaultShell?: string;
    autoCommit?: boolean;
    autoCommitIntervalMinutes?: number;
    restartPolicy?: string;
  };
}

interface SessionStoreData {
  sessions: SessionRecord[];
}

export class SessionStore {
  private storePath: string;

  constructor(storePath: string = SESSION_STORE_PATH) {
    this.storePath = storePath;
  }

  async load(): Promise<SessionRecord[]> {
    try {
      const content = await fs.readFile(this.storePath, "utf-8");
      const data: SessionStoreData = JSON.parse(content);
      return data.sessions || [];
    } catch {
      return [];
    }
  }

  private async save(sessions: SessionRecord[]): Promise<void> {
    const dir = path.dirname(this.storePath);
    await fsExtra.ensureDir(dir);

    const data: SessionStoreData = { sessions };
    const tmpPath = this.storePath + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
    await fs.rename(tmpPath, this.storePath);
  }

  async addSession(session: SessionRecord): Promise<void> {
    const sessions = await this.load();
    // Remove any existing session with same containerId
    const filtered = sessions.filter(
      (s) => s.containerId !== session.containerId,
    );
    filtered.push(session);
    await this.save(filtered);
  }

  async updateSession(
    containerId: string,
    updates: Partial<SessionRecord>,
  ): Promise<void> {
    const sessions = await this.load();
    const idx = sessions.findIndex((s) => s.containerId === containerId);
    if (idx >= 0) {
      sessions[idx] = { ...sessions[idx], ...updates };
      await this.save(sessions);
    }
  }

  async removeSession(containerId: string): Promise<void> {
    const sessions = await this.load();
    const filtered = sessions.filter((s) => s.containerId !== containerId);
    await this.save(filtered);
  }

  async getRecoverableSessions(
    docker: Docker,
  ): Promise<
    Array<
      SessionRecord & {
        containerState: "running" | "stopped" | "gone";
        shadowExists: boolean;
      }
    >
  > {
    const sessions = await this.load();
    const results: Array<
      SessionRecord & {
        containerState: "running" | "stopped" | "gone";
        shadowExists: boolean;
      }
    > = [];

    for (const session of sessions) {
      let containerState: "running" | "stopped" | "gone" = "gone";
      try {
        const container = docker.getContainer(session.containerId);
        const info = await container.inspect();
        containerState = info.State.Running ? "running" : "stopped";
      } catch {
        containerState = "gone";
      }

      const shadowExists = await fsExtra.pathExists(session.shadowRepoPath);

      // A session is recoverable if the container still exists or the shadow repo is present
      if (containerState !== "gone" || shadowExists) {
        results.push({ ...session, containerState, shadowExists });
      }
    }

    return results;
  }

  async clearAll(): Promise<void> {
    await this.save([]);
  }
}
