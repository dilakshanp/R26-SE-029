/**
 * AI Backend Builder — Orchestrator Agent
 * 
 * The master controller that coordinates all agents through the
 * complete build pipeline:
 *   1. Plan the project (Planner Agent)
 *   2. Create base structure (File Manager)
 *   3. Generate all files (Code Generator Agent)
 *   4. Debug and fix (Debug Agent)
 *   5. Retry on failure (max N attempts)
 * 
 * Maintains system state, reports progress, and handles failures.
 */

import * as vscode from 'vscode';
import { BaseAgent } from './base-agent.js';
import { PlannerAgent } from './planner-agent.js';
import { CodeGenAgent } from './codegen-agent.js';
import { DebugAgent } from './debug-agent.js';
import { AIClient } from '../services/ai-client.js';
import { FileManager } from '../services/file-manager.js';
import { ProcessRunner } from '../services/process-runner.js';
import { Memory } from '../state/memory.js';
import { Logger } from '../utils/logger.js';
import type {
  OrchestratorResult,
  ProgressCallback,
  PlannerOutput,
  FileSpec,
  ExtensionConfig,
  GeneratedFile,
  FixSuggestion,
} from '../types/index.js';
import {
  MANDATORY_DIRECTORIES,
  FILE_GENERATION_ORDER,
  GENERATION_DELAY,
} from '../utils/constants.js';

export class OrchestratorAgent extends BaseAgent {
  private plannerAgent: PlannerAgent;
  private codeGenAgent: CodeGenAgent;
  private debugAgent: DebugAgent;
  private fileManager: FileManager;
  private config: ExtensionConfig;
  private progress?: ProgressCallback;

  constructor(
    config: ExtensionConfig,
    aiClient: AIClient,
    memory: Memory,
    logger: Logger
  ) {
    super('Orchestrator', aiClient, memory, logger);
    this.config = config;

    // Initialize sub-agents
    this.fileManager = new FileManager(logger);
    const processRunner = new ProcessRunner(logger);

    this.plannerAgent = new PlannerAgent(aiClient, memory, logger);
    this.codeGenAgent = new CodeGenAgent(aiClient, memory, logger);
    this.debugAgent = new DebugAgent(
      aiClient,
      memory,
      logger,
      processRunner,
      config.debugTimeout
    );
  }

  /**
   * Main execution entry point.
   * Runs the complete pipeline: Plan → Generate → Debug → Fix → Repeat
   * 
   * @param input - Object with { userPrompt, workspaceUri, progress? }
   * @returns OrchestratorResult with final status
   */
  public async execute(input: unknown): Promise<OrchestratorResult> {
    const {
      userPrompt,
      workspaceUri,
      progress,
    } = input as {
      userPrompt: string;
      workspaceUri: vscode.Uri;
      progress?: ProgressCallback;
    };

    this.progress = progress;
    const startTime = Date.now();

    // Reset state for a new run
    this.memory.reset();
    this.memory.setUserPrompt(userPrompt);

    this.logger.section('ORCHESTRATOR — NEW BUILD');
    this.log(`User prompt: "${userPrompt.substring(0, 100)}..."`);

    try {
      // ─── Phase 1: Planning ─────────────────────────────────────────
      this.reportProgress('🧠 Planning project architecture...', 5);
      this.memory.setStatus('planning');

      const plan = await this.plannerAgent.execute(userPrompt);

      // Determine project root
      const projectUri = vscode.Uri.joinPath(workspaceUri, plan.projectName);
      this.memory.setProjectRoot(projectUri.fsPath);

      this.reportProgress(`📋 Plan ready: ${plan.files.length} files`, 10);

      // ─── Phase 2: Create Base Structure ────────────────────────────
      this.reportProgress('📁 Creating project structure...', 15);

      await this.fileManager.createProjectStructure(
        projectUri,
        MANDATORY_DIRECTORIES
      );

      // ─── Phase 3: Generate All Files ───────────────────────────────
      this.memory.setStatus('generating');
      await this.generateAllFiles(plan, projectUri);

      // ─── Phase 4: Debug Loop ───────────────────────────────────────
      this.memory.setStatus('debugging');
      const debugSuccess = await this.debugLoop(projectUri, plan);

      // ─── Phase 5: Report Result ────────────────────────────────────
      const duration = Date.now() - startTime;
      const result: OrchestratorResult = {
        success: debugSuccess,
        projectName: plan.projectName,
        projectRoot: projectUri.fsPath,
        filesGenerated: this.memory.getGeneratedFilePaths().length,
        debugAttempts: this.memory.getCurrentAttempt(),
        errors: this.memory.getErrors(),
        duration,
      };

      if (debugSuccess) {
        this.memory.setStatus('complete');
        this.reportProgress('✅ Build complete!', 100);
        this.log(`✅ Build complete in ${(duration / 1000).toFixed(1)}s`);
      } else {
        this.memory.setStatus('failed');
        this.reportProgress('❌ Build failed after max retries', 100);
        this.logError(`❌ Build failed after ${this.config.maxRetries} debug attempts`);
      }

      this.logFinalSummary(result);
      return result;
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.memory.setStatus('failed');
      this.memory.addError(errorMsg);
      this.logError(`Fatal error: ${errorMsg}`);

      return {
        success: false,
        projectName: this.memory.getPlan()?.projectName ?? 'unknown',
        projectRoot: this.memory.getProjectRoot(),
        filesGenerated: this.memory.getGeneratedFilePaths().length,
        debugAttempts: this.memory.getCurrentAttempt(),
        errors: [errorMsg, ...this.memory.getErrors()],
        duration: Date.now() - startTime,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 3: File Generation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Generate all files from the plan in dependency order.
   */
  private async generateAllFiles(
    plan: PlannerOutput,
    projectUri: vscode.Uri
  ): Promise<void> {
    const sortedFiles = this.sortFilesByDependency(plan.files);
    const totalFiles = sortedFiles.length;

    this.log(`Generating ${totalFiles} files...`);

    // Read existing files for context-awareness
    const existingPaths = plan.files.map((f) => f.path);
    const existingContents = await this.fileManager.getExistingFileContents(
      projectUri,
      existingPaths
    );

    // Build the shared code generation context
    const context = {
      projectName: plan.projectName,
      entities: plan.entities,
      features: plan.features,
      allFiles: plan.files,
      existingFileContents: existingContents,
    };

    for (let i = 0; i < sortedFiles.length; i++) {
      const fileSpec = sortedFiles[i];
      const progressPct = 20 + Math.floor((i / totalFiles) * 50); // 20-70%

      this.reportProgress(
        `⚙️ Generating (${i + 1}/${totalFiles}): ${fileSpec.path}`,
        progressPct
      );

      // Check for existing content (for context-aware updates)
      const existingContent = existingContents.get(fileSpec.path);

      // Generate the file
      const generated = await this.codeGenAgent.execute({
        fileSpec,
        context,
        existingContent,
      });

      // Write the file to disk immediately
      if (generated.status === 'generated' && generated.content) {
        const fileUri = vscode.Uri.joinPath(projectUri, fileSpec.path);
        await this.fileManager.writeFile(fileUri, generated.content, true);

        // Add to context for subsequent files
        context.existingFileContents.set(fileSpec.path, generated.content);
      }

      // Small delay to avoid rate limiting on AI API
      if (i < sortedFiles.length - 1) {
        await this.delay(GENERATION_DELAY);
      }
    }

    this.log(`Code generation complete: ${totalFiles} files processed`);
  }

  /**
   * Sort files by dependency order so that dependencies are generated first.
   * e.g., models before controllers, controllers before routes.
   */
  private sortFilesByDependency(files: FileSpec[]): FileSpec[] {
    return [...files].sort((a, b) => {
      const orderA = this.getFileOrder(a.path);
      const orderB = this.getFileOrder(b.path);
      return orderA - orderB;
    });
  }

  /**
   * Get the generation priority for a file based on its path.
   * Lower number = generated first.
   */
  private getFileOrder(filePath: string): number {
    for (let i = 0; i < FILE_GENERATION_ORDER.length; i++) {
      const prefix = FILE_GENERATION_ORDER[i];
      if (filePath === prefix || filePath.startsWith(prefix)) {
        return i;
      }
    }
    return FILE_GENERATION_ORDER.length; // Unknown files go last
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 4: Debug Loop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Run the debug-fix loop up to maxRetries times.
   * 
   * @returns true if the application starts successfully
   */
  private async debugLoop(
    projectUri: vscode.Uri,
    plan: PlannerOutput
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      this.logger.section(`DEBUG ATTEMPT ${attempt} / ${this.config.maxRetries}`);
      this.reportProgress(
        `🔍 Debug attempt ${attempt}/${this.config.maxRetries}...`,
        70 + Math.floor((attempt / this.config.maxRetries) * 25)
      );

      // Run the debug agent
      const debugResult = await this.debugAgent.execute(projectUri.fsPath);

      if (debugResult.success) {
        this.log(`✓ Debug attempt ${attempt}: SUCCESS`);
        return true;
      }

      this.logWarn(
        `✗ Debug attempt ${attempt}: ${debugResult.errors.length} errors found`
      );

      // If this is the last attempt, don't try to fix
      if (attempt === this.config.maxRetries) {
        for (const err of debugResult.errors) {
          this.memory.addError(`[Attempt ${attempt}] ${err.message}`);
        }
        return false;
      }

      // Apply fixes
      if (debugResult.suggestions.length > 0) {
        this.reportProgress(
          `🔧 Applying ${debugResult.suggestions.length} fixes...`,
          75 + Math.floor((attempt / this.config.maxRetries) * 20)
        );
        this.memory.setStatus('fixing');
        await this.applyFixes(debugResult.suggestions, projectUri, plan);
      } else {
        this.logWarn('No fix suggestions available — will retry debug');
      }
    }

    return false;
  }

  /**
   * Apply fix suggestions from the Debug Agent.
   * Either directly applies corrected code or regenerates affected files.
   */
  private async applyFixes(
    suggestions: FixSuggestion[],
    projectUri: vscode.Uri,
    plan: PlannerOutput
  ): Promise<void> {
    for (const fix of suggestions) {
      this.log(`Fixing: ${fix.file} — ${fix.issue}`);

      if (fix.fix && fix.fix.trim().length > 10) {
        // Apply the corrected code directly
        const code = this.extractCode(fix.fix);
        const fileUri = vscode.Uri.joinPath(projectUri, fix.file);
        await this.fileManager.writeFile(fileUri, code, true);

        // Update memory
        this.memory.addGeneratedFile(fix.file, code, 'fixed');
        this.log(`Applied fix to: ${fix.file}`);
      } else if (fix.regenerate) {
        // Regenerate the file using the Code Generator Agent
        const fileSpec = plan.files.find((f) => f.path === fix.file);
        if (fileSpec) {
          this.log(`Regenerating: ${fix.file}`);
          const context = {
            projectName: plan.projectName,
            entities: plan.entities,
            features: plan.features,
            allFiles: plan.files,
            existingFileContents: new Map(
              Array.from(this.memory.getAllGeneratedFiles())
                .filter(([_, f]) => f.content)
                .map(([p, f]) => [p, f.content])
            ),
          };

          const generated = await this.codeGenAgent.execute({
            fileSpec: {
              ...fileSpec,
              description: `${fileSpec.description}. FIX NEEDED: ${fix.issue}`,
            },
            context,
          });

          if (generated.status === 'generated' && generated.content) {
            const fileUri = vscode.Uri.joinPath(projectUri, fix.file);
            await this.fileManager.writeFile(fileUri, generated.content, true);
          }
        } else {
          this.logWarn(`Cannot regenerate — file not in plan: ${fix.file}`);
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /** Report progress to the VS Code UI */
  private reportProgress(message: string, increment?: number): void {
    this.log(message);
    if (this.progress) {
      this.progress(message, increment);
    }
  }

  /** Sleep for a given number of milliseconds */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Log a final summary of the build */
  private logFinalSummary(result: OrchestratorResult): void {
    this.logger.section('BUILD SUMMARY');
    this.logger.block(
      'Result',
      [
        `Success: ${result.success ? '✅ YES' : '❌ NO'}`,
        `Project: ${result.projectName}`,
        `Location: ${result.projectRoot}`,
        `Files Generated: ${result.filesGenerated}`,
        `Debug Attempts: ${result.debugAttempts}`,
        `Duration: ${(result.duration / 1000).toFixed(1)}s`,
        result.errors.length > 0
          ? `Errors:\n${result.errors.map((e) => `  • ${e}`).join('\n')}`
          : 'Errors: None',
      ].join('\n'),
      this.agentName
    );
  }
}
