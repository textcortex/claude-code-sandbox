import * as path from 'path';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import chalk from 'chalk';

const execAsync = promisify(exec);

export interface ShadowRepoOptions {
  originalRepo: string;
  claudeBranch: string; // The target Claude branch to create
  sessionId: string;
}

export class ShadowRepository {
  private shadowPath: string;
  private initialized = false;
  private rsyncExcludeFile: string;

  constructor(
    private options: ShadowRepoOptions,
    private basePath: string = path.join(os.homedir(), '.cache', 'claude-sandbox', 'shadows')
  ) {
    this.shadowPath = path.join(this.basePath, this.options.sessionId);
    this.rsyncExcludeFile = path.join(
      this.basePath,
      `${this.options.sessionId}-excludes.txt`
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log(chalk.blue('🔨 Creating shadow repository...'));

    // Ensure base directory exists
    await fs.ensureDir(this.basePath);

    // Remove any existing shadow repo completely
    if (await fs.pathExists(this.shadowPath)) {
      try {
        // Force remove with sudo if needed
        await execAsync(`rm -rf ${this.shadowPath}`);
      } catch (error) {
        // Fallback to fs.remove
        await fs.remove(this.shadowPath);
      }
    }

    // Clone with minimal data
    try {
      // First, determine the current branch in the original repo
      const { stdout: currentBranch } = await execAsync(
        'git branch --show-current',
        {
          cwd: this.options.originalRepo
        }
      );
      const sourceBranch = currentBranch.trim() || 'main';

      // Try different clone approaches for robustness
      let cloneSuccess = false;

      // Approach 1: Try standard clone
      try {
        const cloneCmd = `git clone --single-branch --branch ${sourceBranch} --depth 1 "${this.options.originalRepo}" "${this.shadowPath}"`;
        await execAsync(cloneCmd);
        cloneSuccess = true;
      } catch (cloneError) {
        console.log(
          chalk.yellow('  Standard clone failed, trying alternative...')
        );

        // Approach 2: Try without depth limit
        try {
          const cloneCmd = `git clone --single-branch --branch ${sourceBranch} "${this.options.originalRepo}" "${this.shadowPath}"`;
          await execAsync(cloneCmd);
          cloneSuccess = true;
        } catch (cloneError2) {
          console.log(
            chalk.yellow('  Alternative clone failed, trying copy approach...')
          );

          // Approach 3: Copy working tree and init new repo
          await fs.ensureDir(this.shadowPath);
          await execAsync(
            `cp -r "${this.options.originalRepo}/." "${this.shadowPath}/"`
          );

          // Remove and reinit git repo
          await fs.remove(path.join(this.shadowPath, '.git'));
          await execAsync('git init', { cwd: this.shadowPath });
          await execAsync('git add .', { cwd: this.shadowPath });
          await execAsync(
            `git commit -m "Initial commit from ${sourceBranch}"`,
            { cwd: this.shadowPath }
          );
          cloneSuccess = true;
        }
      }

      if (!cloneSuccess) {
        throw new Error('All clone approaches failed');
      }

      // Create the Claude branch locally if it's different from source
      if (this.options.claudeBranch !== sourceBranch) {
        await execAsync(`git checkout -b ${this.options.claudeBranch}`, {
          cwd: this.shadowPath
        });
      }

      // Configure remote to point to the actual GitHub remote, not local repo
      try {
        const { stdout: remoteUrl } = await execAsync(
          'git remote get-url origin',
          {
            cwd: this.options.originalRepo
          }
        );
        const actualRemote = remoteUrl.trim();

        if (
          actualRemote &&
          !actualRemote.startsWith('/') &&
          !actualRemote.startsWith('file://')
        ) {
          // Set the remote to the actual GitHub/remote URL
          await execAsync(`git remote set-url origin "${actualRemote}"`, {
            cwd: this.shadowPath
          });
          console.log(chalk.blue(`  ✓ Configured remote: ${actualRemote}`));
        }
      } catch (remoteError) {
        console.log(
          chalk.gray('  (Could not configure remote URL, using local)')
        );
      }

      // Create an initial commit if the repo is empty (no HEAD)
      try {
        await execAsync('git rev-parse HEAD', { cwd: this.shadowPath });
      } catch (noHeadError) {
        // No HEAD exists, create initial commit
        console.log(chalk.blue('  Creating initial commit...'));
        try {
          await execAsync('git add .', { cwd: this.shadowPath });
          await execAsync('git commit -m "Initial commit" --allow-empty', {
            cwd: this.shadowPath
          });
          console.log(chalk.green('  ✓ Initial commit created'));
        } catch (commitError) {
          // If commit fails, create empty commit
          await execAsync(
            'git commit --allow-empty -m "Initial empty commit"',
            { cwd: this.shadowPath }
          );
          console.log(chalk.green('  ✓ Empty initial commit created'));
        }
      }

      console.log(chalk.green('✓ Shadow repository created'));
      this.initialized = true;

      // Stage all files after initial setup to track them
      try {
        await execAsync('git add .', { cwd: this.shadowPath });
        console.log(chalk.gray('  Staged all files for tracking'));

        // Create initial commit to ensure deletions can be tracked
        await execAsync(
          'git commit -m "Initial snapshot of working directory" --allow-empty',
          { cwd: this.shadowPath }
        );
        console.log(chalk.gray('  Created initial commit for change tracking'));
      } catch (stageError: any) {
        console.log(chalk.gray('  Could not stage files:', stageError.message));
      }
    } catch (error) {
      console.error(chalk.red('Failed to create shadow repository:'), error);
      throw error;
    }
  }

  private async prepareRsyncRules(): Promise<void> {
    try {
      // Start with built-in excludes that should never be synced
      const excludes: string[] = [
        '.git',
        '.git/**',
        'node_modules',
        'node_modules/**',
        '.next',
        '.next/**',
        '__pycache__',
        '__pycache__/**',
        '.venv',
        '.venv/**',
        '*.pyc',
        '*.pyo',
        '.DS_Store',
        'Thumbs.db'
      ];

      // Get list of git-tracked files to ensure they're always included
      let trackedFiles: string[] = [];
      try {
        const { stdout } = await execAsync('git ls-files', {
          cwd: this.options.originalRepo
        });
        trackedFiles = stdout
          .trim()
          .split('\n')
          .filter((f) => f.trim());
        console.log(
          chalk.gray(`  Found ${trackedFiles.length} git-tracked files`)
        );
      } catch (error) {
        console.log(
          chalk.yellow('  Warning: Could not get git-tracked files:', error)
        );
      }

      // Check for .gitignore in original repo
      const gitignorePath = path.join(this.options.originalRepo, '.gitignore');
      if (await fs.pathExists(gitignorePath)) {
        const gitignoreContent = await fs.readFile(gitignorePath, 'utf-8');
        const lines = gitignoreContent.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          // Skip empty lines and comments
          if (!trimmed || trimmed.startsWith('#')) continue;

          // Convert gitignore patterns to rsync patterns
          const pattern = trimmed;

          // Handle negation (gitignore: !pattern, rsync: + pattern)
          if (pattern.startsWith('!')) {
            // Rsync uses + for inclusion, but we'll skip these for simplicity
            continue;
          }

          // If pattern ends with /, it's a directory
          if (pattern.endsWith('/')) {
            excludes.push(pattern);
            excludes.push(pattern + '**');
          } else {
            // Add the pattern as-is
            excludes.push(pattern);

            // If it doesn't contain /, it matches anywhere, so add **/ prefix
            if (!pattern.includes('/')) {
              excludes.push('**/' + pattern);
            }
          }
        }
      }

      // Create include patterns for all git-tracked files
      // This ensures git-tracked files are synced even if they match gitignore patterns
      const includes: string[] = [];
      for (const file of trackedFiles) {
        includes.push(`+ ${file}`);
        // Also include parent directories
        const parts = file.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dir = parts.slice(0, i).join('/');
          includes.push(`+ ${dir}/`);
        }
      }

      // Remove duplicates from includes
      const uniqueIncludes = [...new Set(includes)];

      // Write the rsync rules file: includes first, then excludes
      // Rsync processes rules in order, so includes must come before excludes
      const allRules = [...uniqueIncludes, ...excludes.map((e) => `- ${e}`)];
      await fs.writeFile(this.rsyncExcludeFile, allRules.join('\n'));

      console.log(
        chalk.gray(
          `  Created rsync rules file with ${uniqueIncludes.length} includes and ${excludes.length} excludes`
        )
      );
    } catch (error) {
      console.log(
        chalk.yellow('  Warning: Could not prepare rsync rules:', error)
      );
      // Create a basic exclude file with just the essentials
      const basicExcludes = [
        '- .git',
        '- node_modules',
        '- .next',
        '- __pycache__',
        '- .venv'
      ];
      await fs.writeFile(this.rsyncExcludeFile, basicExcludes.join('\n'));
    }
  }

  async resetToContainerBranch(containerId: string): Promise<void> {
    console.log(
      chalk.blue('🔄 Resetting shadow repo to match container branch...')
    );

    try {
      // Ensure shadow repo is initialized first
      if (!this.initialized) {
        await this.initialize();
      }

      // Get the current branch from the container
      const { stdout: containerBranch } = await execAsync(
        `docker exec ${containerId} git -C /workspace rev-parse --abbrev-ref HEAD`
      );
      const targetBranch = containerBranch.trim();
      console.log(chalk.blue(`  Container is on branch: ${targetBranch}`));

      // Get the current branch in shadow repo (if it has one)
      let currentShadowBranch = '';
      try {
        const { stdout: shadowBranch } = await execAsync(
          'git rev-parse --abbrev-ref HEAD',
          { cwd: this.shadowPath }
        );
        currentShadowBranch = shadowBranch.trim();
        console.log(chalk.blue(`  Shadow repo is on: ${currentShadowBranch}`));
      } catch (error) {
        console.log(chalk.blue('  Shadow repo has no HEAD yet'));
      }

      if (targetBranch !== currentShadowBranch) {
        console.log(
          chalk.blue('  Resetting shadow repo to match container...')
        );

        // Fetch all branches from the original repo
        try {
          await execAsync('git fetch origin', { cwd: this.shadowPath });
        } catch (error) {
          console.warn(chalk.yellow('Warning: Failed to fetch from origin'));
        }

        // Check if the target branch exists remotely and create/checkout accordingly
        try {
          // Try to checkout the branch if it exists remotely and reset to match it
          await execAsync(
            `git checkout -B ${targetBranch} origin/${targetBranch}`,
            { cwd: this.shadowPath }
          );
          console.log(
            chalk.green(
              `✓ Shadow repo reset to remote branch: ${targetBranch}`
            )
          );
        } catch (error) {
          try {
            // If that fails, try to checkout locally existing branch
            await execAsync(`git checkout ${targetBranch}`, {
              cwd: this.shadowPath
            });
            console.log(
              chalk.green(
                `✓ Shadow repo switched to local branch: ${targetBranch}`
              )
            );
          } catch (localError) {
            // If that fails too, create a new branch
            await execAsync(`git checkout -b ${targetBranch}`, {
              cwd: this.shadowPath
            });
            console.log(
              chalk.green(`✓ Shadow repo created new branch: ${targetBranch}`)
            );
          }
        }

        // Mark that we need to resync after branch reset
        console.log(
          chalk.blue('✓ Branch reset complete - files will be synced next')
        );
      } else {
        console.log(
          chalk.gray(
            `  Shadow repo already on correct branch: ${targetBranch}`
          )
        );
      }
    } catch (error) {
      console.warn(
        chalk.yellow('⚠ Failed to reset shadow repo branch:'),
        error
      );
    }
  }

  async syncFromContainer(
    containerId: string,
    containerPath: string = '/workspace'
  ): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    console.log(chalk.blue('🔄 Syncing files from container...'));

    // Prepare rsync rules
    await this.prepareRsyncRules();

    // First, ensure files in container are owned by claude user
    try {
      console.log(chalk.blue('  Fixing file ownership in container...'));

      // Try multiple approaches to fix ownership
      let ownershipFixed = false;

      // Approach 1: Run as root
      try {
        await execAsync(
          `docker exec --user root ${containerId} chown -R claude:claude ${containerPath}`
        );
        ownershipFixed = true;
      } catch (rootError) {
        // Approach 2: Try without --user root
        try {
          await execAsync(
            `docker exec ${containerId} chown -R claude:claude ${containerPath}`
          );
          ownershipFixed = true;
        } catch (normalError) {
          // Approach 3: Use sudo if available
          try {
            await execAsync(
              `docker exec ${containerId} sudo chown -R claude:claude ${containerPath}`
            );
            ownershipFixed = true;
          } catch (sudoError) {
            // Continue without fixing ownership
          }
        }
      }

      // Verify the change worked
      if (ownershipFixed) {
        try {
          const { stdout: verification } = await execAsync(
            `docker exec ${containerId} ls -la ${containerPath}/README.md 2>/dev/null || echo "no readme"`
          );
          if (verification.includes('claude claude')) {
            console.log(chalk.green('  ✓ Container file ownership fixed'));
          } else {
            console.log(
              chalk.yellow(
                '  ⚠ Ownership fix verification failed, but continuing...'
              )
            );
          }
        } catch (verifyError) {
          console.log(
            chalk.gray('  (Could not verify ownership fix, continuing...)')
          );
        }
      } else {
        console.log(
          chalk.gray(
            '  (Could not fix container file ownership, continuing...)'
          )
        );
      }
    } catch (error) {
      console.log(
        chalk.gray('  (Ownership fix failed, continuing with sync...)')
      );
    }

    // Check if rsync is available in container
    const hasRsync = await this.checkRsyncInContainer(containerId);

    if (hasRsync) {
      await this.syncWithRsync(containerId, containerPath);
    } else {
      await this.syncWithDockerCp(containerId, containerPath);
    }

    // Stage all changes including deletions
    try {
      await execAsync('git add -A', { cwd: this.shadowPath });
    } catch (stageError) {
      console.log(chalk.gray('  Could not stage changes:', stageError));
    }

    console.log(chalk.green('✓ Files synced successfully'));
  }

  private async checkRsyncInContainer(containerId: string): Promise<boolean> {
    try {
      await execAsync(`docker exec ${containerId} which rsync`);
      return true;
    } catch {
      // Try to install rsync if not available
      try {
        console.log(chalk.yellow('  Installing rsync in container...'));

        // Try different package managers
        const installCommands = [
          'apk add --no-cache rsync', // Alpine
          'apt-get update && apt-get install -y rsync', // Ubuntu/Debian
          'yum install -y rsync', // CentOS/RHEL
          'dnf install -y rsync' // Fedora
        ];

        for (const cmd of installCommands) {
          try {
            // Try as root first, then as normal user
            const execCommands = [
              `docker exec --user root ${containerId} sh -c "${cmd}"`,
              `docker exec ${containerId} sh -c "sudo ${cmd}"`,
              `docker exec ${containerId} sh -c "${cmd}"`
            ];

            for (const execCmd of execCommands) {
              try {
                await execAsync(execCmd);
                // Test if rsync is now available
                await execAsync(`docker exec ${containerId} which rsync`);
                console.log(chalk.green('  ✓ rsync installed successfully'));
                return true;
              } catch (execError) {
                continue;
              }
            }
          } catch (cmdError) {
            // Continue to next command
            continue;
          }
        }

        console.log(
          chalk.gray('  (Could not install rsync with any package manager)')
        );
        return false;
      } catch (installError) {
        console.log(chalk.gray('  (Could not install rsync, using docker cp)'));
        return false;
      }
    }
  }

  private async syncWithRsync(
    containerId: string,
    containerPath: string
  ): Promise<void> {
    // Create a temporary directory in container for rsync
    const tempDir = '/tmp/sync-staging';
    await execAsync(`docker exec ${containerId} mkdir -p ${tempDir}`);

    // Copy exclude file to container
    const containerExcludeFile = '/tmp/rsync-excludes.txt';
    await execAsync(
      `docker cp ${this.rsyncExcludeFile} ${containerId}:${containerExcludeFile}`
    );

    // Rsync directly from container to shadow repo with proper deletion handling
    // First, clear the shadow repo (except .git) to ensure deletions are reflected
    await execAsync(
      `find ${this.shadowPath} -mindepth 1 -not -path '${this.shadowPath}/.git*' -delete`
    );

    // Rsync within container to staging area using exclude file
    const rsyncCmd = `docker exec ${containerId} rsync -av --delete \
      --exclude-from=${containerExcludeFile} \
      ${containerPath}/ ${tempDir}/`;

    await execAsync(rsyncCmd);

    // Copy from container staging to shadow repo
    await execAsync(
      `docker cp ${containerId}:${tempDir}/. ${this.shadowPath}/`
    );

    // Clean up staging directory and exclude file
    try {
      await execAsync(`docker exec ${containerId} rm -rf ${tempDir}`);
      await execAsync(
        `docker exec --user root ${containerId} rm -f ${containerExcludeFile}`
      );
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
  }

  private async syncWithDockerCp(
    containerId: string,
    containerPath: string
  ): Promise<void> {
    console.log(
      chalk.yellow('⚠️  Using docker cp (rsync not available in container)')
    );

    // Create a temp directory for staging the copy
    const tempCopyPath = path.join(this.basePath, 'temp-copy');

    try {
      // Remove temp directory if it exists
      if (await fs.pathExists(tempCopyPath)) {
        await fs.remove(tempCopyPath);
      }

      // Create temp directory
      await fs.ensureDir(tempCopyPath);

      // Copy files to temp directory first (to avoid corrupting shadow repo)
      await execAsync(
        `docker cp ${containerId}:${containerPath}/. ${tempCopyPath}/`
      );

      // Now selectively copy files to shadow repo, using exclude file

      // Use rsync on host to copy files using exclude file
      try {
        await execAsync(
          `rsync -av --exclude-from=${this.rsyncExcludeFile} ${tempCopyPath}/ ${this.shadowPath}/`
        );
      } catch (rsyncError) {
        // Fallback to cp if rsync not available on host
        console.log(chalk.gray('  (rsync not available on host, using cp)'));

        // Manual copy excluding directories - read exclude patterns
        const excludeContent = await fs.readFile(
          this.rsyncExcludeFile,
          'utf-8'
        );
        const excludePatterns = excludeContent
          .split('\n')
          .filter((p) => p.trim());

        const { stdout: fileList } = await execAsync(
          `find ${tempCopyPath} -type f`
        );
        const files = fileList
          .trim()
          .split('\n')
          .filter((f) => f.trim());

        for (const file of files) {
          const relativePath = path.relative(tempCopyPath, file);

          // Check if file matches any exclude pattern
          let shouldExclude = false;
          for (const pattern of excludePatterns) {
            if (!pattern) continue;

            // Simple pattern matching (not full glob)
            if (pattern.includes('**')) {
              const basePattern = pattern.replace('**/', '').replace('/**', '');
              if (relativePath.includes(basePattern)) {
                shouldExclude = true;
                break;
              }
            } else if (pattern.endsWith('*')) {
              const prefix = pattern.slice(0, -1);
              if (
                relativePath.startsWith(prefix) ||
                path.basename(relativePath).startsWith(prefix)
              ) {
                shouldExclude = true;
                break;
              }
            } else {
              if (
                relativePath === pattern ||
                relativePath.startsWith(pattern + '/') ||
                path.basename(relativePath) === pattern
              ) {
                shouldExclude = true;
                break;
              }
            }
          }

          if (shouldExclude) {
            continue;
          }

          const targetPath = path.join(this.shadowPath, relativePath);
          const targetDir = path.dirname(targetPath);

          await fs.ensureDir(targetDir);
          await fs.copy(file, targetPath);
        }
      }

      // Fix ownership of copied files
      try {
        const currentUser =
          process.env.USER || process.env.USERNAME || 'claude';
        await execAsync(
          `chown -R ${currentUser}:${currentUser} ${this.shadowPath}`
        );
      } catch (error) {
        console.log(
          chalk.gray('  (Could not fix file ownership, continuing...)')
        );
      }
    } finally {
      // Clean up temp directory
      if (await fs.pathExists(tempCopyPath)) {
        await fs.remove(tempCopyPath);
      }
    }
  }

  async getChanges(): Promise<{ hasChanges: boolean; summary: string }> {
    const { stdout: status } = await execAsync('git status --porcelain', {
      cwd: this.shadowPath
    });

    if (!status.trim()) {
      return { hasChanges: false, summary: 'No changes detected' };
    }

    const lines = status.trim().split('\n');
    const modified = lines.filter(
      (l) => l.startsWith(' M') || l.startsWith('M ') || l.startsWith('MM')
    ).length;
    const added = lines.filter(
      (l) => l.startsWith('??') || l.startsWith('A ') || l.startsWith('AM')
    ).length;
    const deleted = lines.filter(
      (l) => l.startsWith(' D') || l.startsWith('D ')
    ).length;

    const summary = `Modified: ${modified}, Added: ${added}, Deleted: ${deleted}`;

    return { hasChanges: true, summary };
  }

  async showDiff(): Promise<void> {
    const { stdout } = await execAsync('git diff', { cwd: this.shadowPath });
    console.log(stdout);
  }

  async cleanup(preserve: boolean = false): Promise<void> {
    if (preserve) {
      console.log(chalk.gray('💾 Shadow repository preserved at: ' + this.shadowPath));
      // Still clean up the exclude file
      if (await fs.pathExists(this.rsyncExcludeFile)) {
        try {
          await fs.remove(this.rsyncExcludeFile);
        } catch (error) {
          // Ignore exclude file cleanup errors
        }
      }
      return;
    }

    if (await fs.pathExists(this.shadowPath)) {
      try {
        // Try to force remove with rm -rf first
        await execAsync(`rm -rf "${this.shadowPath}"`);
        console.log(chalk.gray('🧹 Shadow repository cleaned up'));
      } catch (error) {
        // Fallback to fs.remove with retry logic
        let retries = 3;
        while (retries > 0) {
          try {
            await fs.remove(this.shadowPath);
            console.log(chalk.gray('🧹 Shadow repository cleaned up'));
            break;
          } catch (err) {
            retries--;
            if (retries === 0) {
              console.error(
                chalk.yellow('⚠ Failed to cleanup shadow repository:'),
                err
              );
            } else {
              // Wait a bit before retry
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
          }
        }
      }
    }
    if (await fs.pathExists(this.rsyncExcludeFile)) {
      try {
        await fs.remove(this.rsyncExcludeFile);
      } catch (error) {
        // Ignore exclude file cleanup errors
      }
    }
  }

  getPath(): string {
    return this.shadowPath;
  }
}
