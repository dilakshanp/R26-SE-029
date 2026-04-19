/**
 * AI Backend Builder — Debug Agent
 * 
 * Runs the generated application, captures runtime errors,
 * analyzes stack traces using AI, and suggests targeted fixes.
 * 
 * Input:  Project root path + generated files
 * Output: DebugResult with success status and fix suggestions
 */

import { BaseAgent } from './base-agent.js';
import { AIClient } from '../services/ai-client.js';
import { Memory } from '../state/memory.js';
import { Logger } from '../utils/logger.js';
import { ProcessRunner } from '../services/process-runner.js';
import type {
  DebugResult,
  RuntimeError,
  FixSuggestion,
  ProcessResult,
} from '../types/index.js';
import {
  ERROR_PATTERNS,
  ENVIRONMENT_ERRORS,
} from '../utils/constants.js';
import {
  DEBUG_SYSTEM_PROMPT,
  buildDebugPrompt,
  buildDebugRetryPrompt,
} from '../prompts/debug-prompt.js';

export class DebugAgent extends BaseAgent {
  private processRunner: ProcessRunner;
  private debugTimeout: number;

  constructor(
    aiClient: AIClient,
    memory: Memory,
    logger: Logger,
    processRunner: ProcessRunner,
    debugTimeout: number = 10_000
  ) {
    super('Debug', aiClient, memory, logger);
    this.processRunner = processRunner;
    this.debugTimeout = debugTimeout;
  }

  /**
   * Execute the debug phase.
   * 
   * @param input - The project root filesystem path (string)
   * @returns DebugResult with errors and fix suggestions
   */
  public async execute(input: unknown): Promise<DebugResult> {
    const projectRoot = input as string;
    this.logger.section('DEBUG AGENT');
    this.log(`Debugging project at: ${projectRoot}`);

    // Step 1: Install dependencies
    this.log('Running npm install...');
    const installResult = await this.processRunner.runNpmInstall(projectRoot);

    if (installResult.exitCode !== 0 && !installResult.stderr.includes('npm warn')) {
      // Check if it's a real installation error (not just warnings)
      const hasRealError = installResult.stderr
        .split('\n')
        .some((line) => line.startsWith('npm error') || line.startsWith('npm ERR!'));

      if (hasRealError) {
        this.logError('npm install failed');
        this.logger.block('npm install stderr', installResult.stderr, this.agentName);

        return {
          success: false,
          errors: [{
            message: 'npm install failed: ' + installResult.stderr.substring(0, 500),
            stack: installResult.stderr,
            type: 'runtime',
          }],
          suggestions: [{
            file: 'package.json',
            issue: 'npm install failed — check dependencies',
            fix: '',
            regenerate: true,
          }],
          stdout: installResult.stdout,
          stderr: installResult.stderr,
          exitCode: installResult.exitCode,
        };
      }
    }

    this.log('npm install completed');

    // Step 2: Run the application
    this.log(`Running node app.js (timeout: ${this.debugTimeout}ms)...`);
    const runResult = await this.processRunner.runNode(
      projectRoot,
      'app.js',
      this.debugTimeout
    );

    // Step 3: Analyze the result
    // Check if the server started successfully
    if (this.processRunner.isServerStartSuccess(runResult)) {
      this.log('✓ Application started successfully!');
      return {
        success: true,
        errors: [],
        suggestions: [],
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
      };
    }

    // Step 4: Parse errors from the output
    const errors = this.parseErrors(runResult);
    this.log(`Found ${errors.length} errors`);

    // Step 5: Check for environment errors (not code bugs)
    const envErrors = errors.filter((e) => this.isEnvironmentError(e));
    const codeErrors = errors.filter((e) => !this.isEnvironmentError(e));

    if (codeErrors.length === 0 && envErrors.length > 0) {
      this.log('Only environment errors detected (e.g., MongoDB not running) — treating as success');
      return {
        success: true, // Environment issues are not code bugs
        errors: envErrors,
        suggestions: [],
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
      };
    }

    if (codeErrors.length === 0) {
      // No clear errors found but process failed — might be a startup issue
      this.logWarn('Process failed but no clear errors found in output');
      return {
        success: false,
        errors: [{
          message: `Process exited with code ${runResult.exitCode}`,
          stack: runResult.stderr || runResult.stdout,
          type: 'unknown',
        }],
        suggestions: [],
        stdout: runResult.stdout,
        stderr: runResult.stderr,
        exitCode: runResult.exitCode,
      };
    }

    // Step 6: Get fix suggestions from AI
    this.log('Analyzing errors with AI...');
    const suggestions = await this.getFixSuggestions(codeErrors, runResult);

    const result: DebugResult = {
      success: false,
      errors: codeErrors,
      suggestions,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      exitCode: runResult.exitCode,
    };

    this.memory.addDebugResult(result);
    return result;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Error Parsing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse runtime errors from process output.
   */
  private parseErrors(result: ProcessResult): RuntimeError[] {
    const errors: RuntimeError[] = [];
    const output = result.stderr || result.stdout;

    if (!output) { return errors; }

    // Check for syntax errors
    const syntaxMatch = output.match(ERROR_PATTERNS.SYNTAX_ERROR);
    if (syntaxMatch) {
      errors.push(this.buildError('syntax', syntaxMatch[1], output));
    }

    // Check for reference errors
    const refMatch = output.match(ERROR_PATTERNS.REFERENCE_ERROR);
    if (refMatch) {
      errors.push(this.buildError('runtime', refMatch[1], output));
    }

    // Check for type errors
    const typeMatch = output.match(ERROR_PATTERNS.TYPE_ERROR);
    if (typeMatch) {
      errors.push(this.buildError('runtime', typeMatch[1], output));
    }

    // Check for module not found
    const moduleMatch = output.match(ERROR_PATTERNS.MODULE_NOT_FOUND);
    if (moduleMatch) {
      errors.push(this.buildError('module', `Cannot find module '${moduleMatch[1]}'`, output));
    }

    // Check for ES module errors
    const esmMatch = output.match(ERROR_PATTERNS.ESM_ERROR);
    if (esmMatch) {
      errors.push(this.buildError('module', esmMatch[0], output));
    }

    // Check for MongoDB connection errors
    const mongoMatch = output.match(ERROR_PATTERNS.MONGO_CONNECTION);
    if (mongoMatch) {
      errors.push(this.buildError('connection', mongoMatch[0], output));
    }

    // Check for port-in-use errors
    const portMatch = output.match(ERROR_PATTERNS.PORT_IN_USE);
    if (portMatch) {
      errors.push(this.buildError('connection', `Port ${portMatch[1]} already in use`, output));
    }

    // If no specific pattern matched but process failed, add generic error
    if (errors.length === 0 && result.exitCode !== 0) {
      errors.push({
        message: output.split('\n')[0] || 'Unknown error',
        stack: output,
        type: 'unknown',
      });
    }

    return errors;
  }

  /**
   * Build a RuntimeError with file/line info extracted from stack trace.
   */
  private buildError(
    type: RuntimeError['type'],
    message: string,
    fullOutput: string
  ): RuntimeError {
    const error: RuntimeError = { message, stack: fullOutput, type };

    // Try to extract file and line from stack trace
    const fileMatch =
      fullOutput.match(ERROR_PATTERNS.STACK_FILE_LINE) ||
      fullOutput.match(ERROR_PATTERNS.STACK_FILE_LINE_ALT);

    if (fileMatch) {
      // Extract relative path (remove absolute path prefix)
      let filePath = fileMatch[1];
      const projectPathIndex = filePath.lastIndexOf('/');
      if (projectPathIndex !== -1) {
        // Get just the filename or relative path within the project
        const segments = filePath.split('/');
        // Find a known directory (models, controllers, routes, etc.)
        const knownDirs = ['models', 'controllers', 'routes', 'middleware', 'config'];
        const dirIndex = segments.findIndex((s) => knownDirs.includes(s));
        if (dirIndex !== -1) {
          filePath = segments.slice(dirIndex).join('/');
        } else {
          filePath = segments[segments.length - 1];
        }
      }

      error.file = filePath;
      error.line = parseInt(fileMatch[2], 10);
      error.column = parseInt(fileMatch[3], 10);
    }

    return error;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Environment Error Detection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if an error is an environment issue (not a code bug).
   */
  private isEnvironmentError(error: RuntimeError): boolean {
    if (error.type === 'connection') { return true; }

    for (const pattern of ENVIRONMENT_ERRORS) {
      if (pattern.test(error.message) || pattern.test(error.stack)) {
        return true;
      }
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // AI-Powered Fix Suggestions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Query the AI to analyze errors and suggest fixes.
   */
  private async getFixSuggestions(
    errors: RuntimeError[],
    processResult: ProcessResult
  ): Promise<FixSuggestion[]> {
    try {
      // Gather all file contents from memory
      const allFiles = this.memory.getAllGeneratedFiles();
      const fileContents = new Map<string, string>();
      for (const [path, file] of allFiles) {
        if (file.content) {
          fileContents.set(path, file.content);
        }
      }

      // Build the debug prompt
      const prompt = buildDebugPrompt(
        errors,
        processResult.stderr,
        processResult.stdout,
        fileContents
      );

      // Query the AI
      const rawResponse = await this.aiClient.query(
        'debug',
        prompt,
        DEBUG_SYSTEM_PROMPT
      );

      this.logger.block('Debug AI Response', rawResponse, this.agentName);

      // Parse the response
      return this.parseFixSuggestions(rawResponse);
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logError(`Failed to get AI fix suggestions: ${errorMsg}`);
      return [];
    }
  }

  /**
   * Parse fix suggestions from the AI response.
   * Handles JSON extraction with retry on failure.
   */
  private async parseFixSuggestions(rawResponse: string): Promise<FixSuggestion[]> {
    try {
      const parsed = this.parseJSON<{
        analysis?: string;
        fixes?: FixSuggestion[];
      }>(rawResponse);

      if (parsed.analysis) {
        this.log(`AI Analysis: ${parsed.analysis}`);
      }

      if (Array.isArray(parsed.fixes) && parsed.fixes.length > 0) {
        // Validate each fix
        const validFixes = parsed.fixes.filter((fix) => {
          if (!fix.file || typeof fix.file !== 'string') { return false; }
          if (!fix.fix || typeof fix.fix !== 'string') { return false; }
          // Normalize file path
          fix.file = fix.file.replace(/^\.?\//, '');
          fix.regenerate = fix.regenerate !== false; // Default to true
          return true;
        });

        this.log(`AI suggested ${validFixes.length} valid fixes`);
        return validFixes;
      }

      return [];
    } catch {
      // Try a retry prompt to get valid JSON
      try {
        this.logWarn('First parse failed, retrying with fix prompt...');
        const retryPrompt = buildDebugRetryPrompt(rawResponse);
        const retryResponse = await this.aiClient.query(
          'debug',
          retryPrompt,
          DEBUG_SYSTEM_PROMPT
        );

        const retryParsed = this.parseJSON<{
          fixes?: FixSuggestion[];
        }>(retryResponse);

        return retryParsed.fixes ?? [];
      } catch {
        this.logError('Failed to parse fix suggestions after retry');
        return [];
      }
    }
  }
}
