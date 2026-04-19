/**
 * AI Backend Builder — Process Runner
 * 
 * Runs child processes (node app.js, npm install) for the Debug Agent.
 * Captures stdout/stderr, handles timeouts, and returns structured results.
 */

import { spawn, type ChildProcess } from 'child_process';
import { Logger } from '../utils/logger.js';
import type { ProcessResult } from '../types/index.js';

export class ProcessRunner {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run `node <entryFile>` in the specified directory.
   * The process is killed after the timeout to prevent infinite hangs
   * (e.g., Express servers that start and listen indefinitely).
   * 
   * @param cwd       - Working directory (project root)
   * @param entryFile - Entry file to run (default: "app.js")
   * @param timeout   - Max runtime in ms (default: 10000)
   * @returns Structured process result
   */
  public async runNode(
    cwd: string,
    entryFile: string = 'app.js',
    timeout: number = 10_000
  ): Promise<ProcessResult> {
    this.logger.info(`Running: node ${entryFile} (timeout: ${timeout}ms)`, 'ProcessRunner');
    return this.execute('node', [entryFile], cwd, timeout);
  }

  /**
   * Run `npm install` in the specified directory.
   * Uses a longer timeout since dependency installation can be slow.
   * 
   * @param cwd - Working directory (project root)
   * @returns Structured process result
   */
  public async runNpmInstall(cwd: string): Promise<ProcessResult> {
    this.logger.info('Running: npm install', 'ProcessRunner');
    return this.execute('npm', ['install'], cwd, 60_000);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a command as a child process.
   * Captures output streams and enforces a timeout.
   */
  private execute(
    command: string,
    args: string[],
    cwd: string,
    timeout: number
  ): Promise<ProcessResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const child: ChildProcess = spawn(command, args, {
        cwd,
        env: {
          ...process.env,
          NODE_ENV: 'development',
        },
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Capture stdout
      child.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        this.logger.debug(`[stdout] ${chunk.trimEnd()}`, 'ProcessRunner');
      });

      // Capture stderr
      child.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        // Only log non-npm-warn lines as debug to reduce noise
        if (!chunk.includes('npm warn') && !chunk.includes('npm WARN')) {
          this.logger.debug(`[stderr] ${chunk.trimEnd()}`, 'ProcessRunner');
        }
      });

      // Handle process exit
      child.on('close', (code) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);

        const result: ProcessResult = {
          exitCode: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
        };

        if (code === 0 || timedOut) {
          this.logger.info(
            `Process exited with code ${code}${timedOut ? ' (timed out)' : ''}`,
            'ProcessRunner'
          );
        } else {
          this.logger.warn(
            `Process exited with code ${code}`,
            'ProcessRunner'
          );
        }

        resolve(result);
      });

      // Handle spawn errors
      child.on('error', (error) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);

        this.logger.error(`Process error: ${error.message}`, 'ProcessRunner');
        resolve({
          exitCode: null,
          stdout: stdout.trim(),
          stderr: `${stderr.trim()}\nSpawn Error: ${error.message}`,
          timedOut: false,
        });
      });

      // Set timeout — kill the process if it runs too long.
      // For a server (Express), a timeout with listening output is actually success.
      const timer = setTimeout(() => {
        timedOut = true;

        // Check if the server started successfully before killing
        const serverStarted =
          stdout.includes('listening') ||
          stdout.includes('started') ||
          stdout.includes('running on') ||
          stdout.includes('Server') ||
          stdout.includes('Connected');

        if (serverStarted) {
          this.logger.info(
            'Server appears to have started successfully — killing process',
            'ProcessRunner'
          );
        } else {
          this.logger.warn(
            `Process timed out after ${timeout}ms — killing`,
            'ProcessRunner'
          );
        }

        // Kill the process tree
        this.killProcess(child);
      }, timeout);
    });
  }

  /**
   * Kill a child process and its descendants.
   */
  private killProcess(child: ChildProcess): void {
    try {
      if (child.pid) {
        // Try to kill the entire process group
        process.kill(-child.pid, 'SIGTERM');
      }
    } catch {
      // Fallback: kill just the child
      try {
        child.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }

    // Force-kill after 2 seconds if still alive
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }, 2000);
  }

  /**
   * Analyze a process result to determine if the server started
   * successfully. A server that starts and listens on a port is
   * considered successful even if the process was killed by timeout.
   */
  public isServerStartSuccess(result: ProcessResult): boolean {
    // Server started and was killed by timeout — that's success
    if (result.timedOut) {
      const output = result.stdout + result.stderr;
      const serverPatterns = [
        /listening on/i,
        /server started/i,
        /running on port/i,
        /server running/i,
        /connected to/i,
        /app listening/i,
      ];
      return serverPatterns.some((pattern) => pattern.test(output));
    }

    // Clean exit with no errors
    if (result.exitCode === 0 && !result.stderr) {
      return true;
    }

    return false;
  }
}
