/**
 * AI Backend Builder — Planner Agent
 * 
 * Analyzes user requirements and produces a structured project plan
 * with entities, features, and a complete file list.
 * 
 * Input:  User's backend description (string)
 * Output: PlannerOutput (validated JSON)
 */

import { BaseAgent } from './base-agent.js';
import { AIClient } from '../services/ai-client.js';
import { Memory } from '../state/memory.js';
import { Logger } from '../utils/logger.js';
import type { PlannerOutput, FileSpec } from '../types/index.js';
import {
  PLANNER_SYSTEM_PROMPT,
  buildPlannerPrompt,
} from '../prompts/planner-prompt.js';
import { MANDATORY_FILES } from '../utils/constants.js';

export class PlannerAgent extends BaseAgent {
  /** Max retries for JSON parsing failures */
  private static readonly MAX_JSON_RETRIES = 2;

  constructor(aiClient: AIClient, memory: Memory, logger: Logger) {
    super('Planner', aiClient, memory, logger);
  }

  /**
   * Execute the planning phase.
   * 
   * @param input - The user's backend requirement description
   * @returns Validated PlannerOutput
   */
  public async execute(input: unknown): Promise<PlannerOutput> {
    const userPrompt = input as string;
    this.log('Starting project planning...');
    this.logger.section('PLANNER AGENT');

    let plan: PlannerOutput | null = null;
    let lastError: Error | null = null;

    // Attempt to get valid JSON from the AI, with retries
    for (let attempt = 0; attempt <= PlannerAgent.MAX_JSON_RETRIES; attempt++) {
      try {
        const prompt = attempt === 0
          ? buildPlannerPrompt(userPrompt)
          : this.buildRetryPrompt(userPrompt, lastError!.message);

        this.log(`Querying AI (attempt ${attempt + 1})...`);
        const rawResponse = await this.aiClient.query(
          'planner',
          prompt,
          PLANNER_SYSTEM_PROMPT
        );

        this.logger.block('Raw Planner Response', rawResponse, this.agentName);

        // Parse and validate the response
        plan = this.parseAndValidate(rawResponse);
        break;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logWarn(`Attempt ${attempt + 1} failed: ${lastError.message}`);

        if (attempt === PlannerAgent.MAX_JSON_RETRIES) {
          this.logError('All planning attempts failed');
          throw new Error(
            `Planner Agent failed after ${PlannerAgent.MAX_JSON_RETRIES + 1} attempts: ${lastError.message}`
          );
        }
      }
    }

    if (!plan) {
      throw new Error('Planner Agent produced no output');
    }

    // Ensure mandatory files exist in the plan
    plan = this.ensureMandatoryFiles(plan);

    // Store the plan in shared memory
    this.memory.setPlan(plan);

    this.log(`Planning complete: "${plan.projectName}" — ${plan.files.length} files`);
    this.logPlanSummary(plan);

    return plan;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Validation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Parse raw AI response into PlannerOutput and validate its structure.
   */
  private parseAndValidate(rawResponse: string): PlannerOutput {
    const parsed = this.parseJSON<PlannerOutput>(rawResponse);

    // Validate required top-level fields
    if (!parsed.projectName || typeof parsed.projectName !== 'string') {
      throw new Error('Plan missing or invalid "projectName"');
    }

    if (!Array.isArray(parsed.entities)) {
      throw new Error('Plan missing or invalid "entities" array');
    }

    if (!Array.isArray(parsed.features)) {
      throw new Error('Plan missing or invalid "features" array');
    }

    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error('Plan missing or empty "files" array');
    }

    // Validate each file spec
    for (const file of parsed.files) {
      if (!file.path || typeof file.path !== 'string') {
        throw new Error(`Invalid file spec: missing "path" — ${JSON.stringify(file)}`);
      }
      if (!file.description || typeof file.description !== 'string') {
        throw new Error(`Invalid file spec: missing "description" for ${file.path}`);
      }
      // Normalize path: remove leading ./ or /
      file.path = file.path.replace(/^\.?\//, '');
    }

    // Validate entities have fields
    for (const entity of parsed.entities) {
      if (!entity.name || typeof entity.name !== 'string') {
        throw new Error('Entity missing "name"');
      }
      if (!Array.isArray(entity.fields)) {
        entity.fields = [];
        this.logWarn(`Entity "${entity.name}" has no fields — may produce incomplete model`);
      }
    }

    // Sanitize project name to kebab-case
    parsed.projectName = parsed.projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return parsed;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mandatory Files Injection
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ensure all mandatory files are present in the plan.
   * If the AI forgot any, inject them with default descriptions.
   */
  private ensureMandatoryFiles(plan: PlannerOutput): PlannerOutput {
    const existingPaths = new Set(plan.files.map((f) => f.path));
    const injected: FileSpec[] = [];

    for (const mandatoryPath of MANDATORY_FILES) {
      if (!existingPaths.has(mandatoryPath)) {
        const description = this.getDefaultDescription(mandatoryPath, plan.projectName);
        plan.files.push({ path: mandatoryPath, description });
        injected.push({ path: mandatoryPath, description });
      }
    }

    // Also ensure .env exists
    if (!existingPaths.has('.env')) {
      plan.files.push({
        path: '.env',
        description: `Environment variables: PORT, MONGODB_URI for ${plan.projectName}, NODE_ENV, JWT_SECRET`,
      });
      injected.push({ path: '.env', description: 'Environment variables' });
    }

    // Ensure error handler middleware exists
    if (!existingPaths.has('middleware/errorHandler.js')) {
      plan.files.push({
        path: 'middleware/errorHandler.js',
        description: 'Centralized Express error handling middleware that catches all errors and returns formatted JSON responses',
      });
    }

    if (injected.length > 0) {
      this.logWarn(
        `Injected ${injected.length} missing mandatory files: ${injected.map((f) => f.path).join(', ')}`
      );
    }

    return plan;
  }

  /**
   * Get a default description for mandatory files the AI may have omitted.
   */
  private getDefaultDescription(path: string, projectName: string): string {
    const descriptions: Record<string, string> = {
      'app.js': `Main Express application entry point for ${projectName}. Imports dotenv/config, sets up Express middleware (json, cors), connects to MongoDB, mounts all route files, adds error handling middleware, and starts the server on PORT from environment.`,
      'package.json': `NPM package manifest for ${projectName}. Sets type to "module" for ES modules, lists dependencies: express, mongoose, dotenv, cors, bcryptjs, jsonwebtoken. Includes start script.`,
      'config/db.js': `MongoDB connection configuration. Exports an async connectDB function that uses mongoose.connect() with MONGODB_URI from process.env. Logs success/failure.`,
    };

    return descriptions[path] ?? `Configuration file for ${projectName}`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Retry Prompt
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build a retry prompt when the previous attempt produced invalid JSON.
   */
  private buildRetryPrompt(userPrompt: string, errorMessage: string): string {
    return `Your previous response was not valid JSON. Error: ${errorMessage}

Please try again. Analyze this requirement and output ONLY valid JSON matching the schema in your system prompt.

## USER REQUIREMENT
${userPrompt}

Remember: Output ONLY the JSON object. No markdown fences, no explanations, no extra text.`;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Logging
  // ─────────────────────────────────────────────────────────────────────────

  /** Log a summary of the generated plan */
  private logPlanSummary(plan: PlannerOutput): void {
    this.logger.block(
      'Plan Summary',
      [
        `Project: ${plan.projectName}`,
        `Entities: ${plan.entities.map((e) => e.name).join(', ')}`,
        `Features: ${plan.features.map((f) => f.name).join(', ')}`,
        `Files (${plan.files.length}):`,
        ...plan.files.map((f) => `  • ${f.path}`),
      ].join('\n'),
      this.agentName
    );
  }
}
