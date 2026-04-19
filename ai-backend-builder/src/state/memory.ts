/**
 * AI Backend Builder — Shared Memory / State Manager
 * 
 * Singleton state store that all agents read from and write to.
 * Maintains the plan, generated files, debug history, and system status.
 */

import { Logger } from '../utils/logger.js';
import type {
  SystemState,
  SystemStatus,
  PlannerOutput,
  GeneratedFile,
  DebugResult,
  FileStatus,
} from '../types/index.js';

export class Memory {
  private state: SystemState;
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.state = this.createInitialState();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Initialization & Reset
  // ─────────────────────────────────────────────────────────────────────────

  /** Create a fresh initial state */
  private createInitialState(): SystemState {
    return {
      plan: null,
      generatedFiles: new Map(),
      debugHistory: [],
      currentAttempt: 0,
      status: 'idle',
      userPrompt: '',
      projectRoot: '',
      startTime: Date.now(),
      errors: [],
    };
  }

  /** Reset all state for a new execution run */
  public reset(): void {
    this.state = this.createInitialState();
    this.logger.info('Memory state reset', 'Memory');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status
  // ─────────────────────────────────────────────────────────────────────────

  /** Get the current system status */
  public getStatus(): SystemStatus {
    return this.state.status;
  }

  /** Update the system status */
  public setStatus(status: SystemStatus): void {
    this.state.status = status;
    this.logger.info(`Status changed → ${status}`, 'Memory');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // User Prompt & Project Root
  // ─────────────────────────────────────────────────────────────────────────

  /** Store the original user prompt */
  public setUserPrompt(prompt: string): void {
    this.state.userPrompt = prompt;
  }

  /** Get the original user prompt */
  public getUserPrompt(): string {
    return this.state.userPrompt;
  }

  /** Store the project root path */
  public setProjectRoot(root: string): void {
    this.state.projectRoot = root;
  }

  /** Get the project root path */
  public getProjectRoot(): string {
    return this.state.projectRoot;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Plan Management
  // ─────────────────────────────────────────────────────────────────────────

  /** Store the planner's output */
  public setPlan(plan: PlannerOutput): void {
    this.state.plan = plan;
    this.logger.info(
      `Plan stored: project="${plan.projectName}", ` +
      `entities=${plan.entities.length}, ` +
      `features=${plan.features.length}, ` +
      `files=${plan.files.length}`,
      'Memory'
    );
  }

  /** Get the current plan */
  public getPlan(): PlannerOutput | null {
    return this.state.plan;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Generated Files Management
  // ─────────────────────────────────────────────────────────────────────────

  /** Add or update a generated file in memory */
  public addGeneratedFile(path: string, content: string, status: FileStatus = 'generated'): void {
    this.state.generatedFiles.set(path, { path, content, status });
    this.logger.debug(`File stored: ${path} (${status})`, 'Memory');
  }

  /** Get a specific generated file */
  public getGeneratedFile(path: string): GeneratedFile | undefined {
    return this.state.generatedFiles.get(path);
  }

  /** Get all generated files */
  public getAllGeneratedFiles(): Map<string, GeneratedFile> {
    return this.state.generatedFiles;
  }

  /** Update the status of a generated file */
  public updateFileStatus(path: string, status: FileStatus, errorMessage?: string): void {
    const file = this.state.generatedFiles.get(path);
    if (file) {
      file.status = status;
      if (errorMessage) {
        file.errorMessage = errorMessage;
      }
      this.logger.debug(`File status updated: ${path} → ${status}`, 'Memory');
    }
  }

  /**
   * Get the contents of specific files for context-building.
   * Useful for agents that need to see other generated files.
   */
  public getFileContents(paths: string[]): Map<string, string> {
    const contents = new Map<string, string>();
    for (const path of paths) {
      const file = this.state.generatedFiles.get(path);
      if (file && file.content) {
        contents.set(path, file.content);
      }
    }
    return contents;
  }

  /**
   * Get all file paths that have been successfully generated.
   */
  public getGeneratedFilePaths(): string[] {
    return Array.from(this.state.generatedFiles.entries())
      .filter(([_, file]) => file.status === 'generated' || file.status === 'fixed')
      .map(([path]) => path);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Debug History
  // ─────────────────────────────────────────────────────────────────────────

  /** Record a debug result */
  public addDebugResult(result: DebugResult): void {
    this.state.debugHistory.push(result);
    this.state.currentAttempt++;
    this.logger.info(
      `Debug attempt ${this.state.currentAttempt}: ${result.success ? 'SUCCESS' : 'FAILED'} ` +
      `(${result.errors.length} errors)`,
      'Memory'
    );
  }

  /** Get the current debug attempt number */
  public getCurrentAttempt(): number {
    return this.state.currentAttempt;
  }

  /** Get the most recent debug result */
  public getLastDebugResult(): DebugResult | undefined {
    return this.state.debugHistory[this.state.debugHistory.length - 1];
  }

  /** Get full debug history */
  public getDebugHistory(): DebugResult[] {
    return [...this.state.debugHistory];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Error Tracking
  // ─────────────────────────────────────────────────────────────────────────

  /** Add a general error message */
  public addError(error: string): void {
    this.state.errors.push(error);
    this.logger.error(error, 'Memory');
  }

  /** Get all recorded errors */
  public getErrors(): string[] {
    return [...this.state.errors];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Snapshot
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get a serializable snapshot of the current state.
   * Useful for logging and debugging the system itself.
   */
  public getSnapshot(): Record<string, unknown> {
    return {
      status: this.state.status,
      userPrompt: this.state.userPrompt.substring(0, 100) + '...',
      projectRoot: this.state.projectRoot,
      planExists: this.state.plan !== null,
      projectName: this.state.plan?.projectName ?? null,
      totalFiles: this.state.generatedFiles.size,
      generatedFiles: this.getGeneratedFilePaths(),
      debugAttempts: this.state.currentAttempt,
      lastDebugSuccess: this.getLastDebugResult()?.success ?? null,
      errors: this.state.errors,
      elapsedMs: Date.now() - this.state.startTime,
    };
  }

  /**
   * Get the elapsed time since the run started.
   */
  public getElapsedTime(): number {
    return Date.now() - this.state.startTime;
  }
}
