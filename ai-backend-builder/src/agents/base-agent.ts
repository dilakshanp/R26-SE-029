/**
 * AI Backend Builder — Base Agent
 * 
 * Abstract base class that all specialized agents extend.
 * Provides shared utilities for AI interaction, JSON parsing,
 * and code extraction from model responses.
 */

import { AIClient } from '../services/ai-client.js';
import { Memory } from '../state/memory.js';
import { Logger } from '../utils/logger.js';

export abstract class BaseAgent {
  protected aiClient: AIClient;
  protected memory: Memory;
  protected logger: Logger;
  protected agentName: string;

  constructor(
    agentName: string,
    aiClient: AIClient,
    memory: Memory,
    logger: Logger
  ) {
    this.agentName = agentName;
    this.aiClient = aiClient;
    this.memory = memory;
    this.logger = logger;
  }

  /**
   * Execute the agent's primary task.
   * Must be implemented by each specialized agent.
   */
  abstract execute(input: unknown): Promise<unknown>;

  // ─────────────────────────────────────────────────────────────────────────
  // JSON Parsing
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Safely extract and parse JSON from an LLM response.
   * Handles common issues: markdown fences, leading/trailing text, etc.
   */
  protected parseJSON<T>(raw: string): T {
    // Try direct parse first
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Continue to extraction attempts
    }

    // Try extracting JSON from markdown code fences
    const fencePatterns = [
      /```json\s*\n?([\s\S]*?)\n?\s*```/,
      /```\s*\n?([\s\S]*?)\n?\s*```/,
    ];

    for (const pattern of fencePatterns) {
      const match = raw.match(pattern);
      if (match?.[1]) {
        try {
          return JSON.parse(match[1].trim()) as T;
        } catch {
          // Continue
        }
      }
    }

    // Try finding JSON object in the text (first { to last })
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const candidate = raw.substring(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // Continue
      }
    }

    // Try finding JSON array in the text
    const firstBracket = raw.indexOf('[');
    const lastBracket = raw.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket > firstBracket) {
      const candidate = raw.substring(firstBracket, lastBracket + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // Continue
      }
    }

    // All attempts failed
    this.logger.error(
      `Failed to parse JSON from response (${raw.length} chars). First 200: ${raw.substring(0, 200)}`,
      this.agentName
    );
    throw new Error(`Failed to parse JSON from ${this.agentName} response`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Code Extraction
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Extract pure source code from an LLM response.
   * Strips markdown fences and surrounding text.
   */
  protected extractCode(raw: string): string {
    let code = raw.trim();

    // Remove markdown code fences
    const fencePatterns = [
      /^```(?:javascript|js|typescript|ts|json)?\s*\n?([\s\S]*?)\n?\s*```$/,
      /^```\s*\n?([\s\S]*?)\n?\s*```$/,
    ];

    for (const pattern of fencePatterns) {
      const match = code.match(pattern);
      if (match?.[1]) {
        code = match[1];
        break;
      }
    }

    // Remove any leading "Here is the code:" type preambles
    const preamblePatterns = [
      /^(?:Here (?:is|are) .*?:\s*\n)/i,
      /^(?:The (?:following|code) .*?:\s*\n)/i,
      /^(?:\/\/ file:.*?\n)/,
    ];

    for (const pattern of preamblePatterns) {
      code = code.replace(pattern, '');
    }

    // Remove trailing explanations after the code
    // Look for a clear separator (empty lines followed by non-code text)
    const lines = code.split('\n');
    let lastCodeLine = lines.length - 1;

    // Walk backwards to find where real code ends
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Skip empty lines
      if (line === '') { continue; }
      // If line looks like explanation text (not code), skip it
      if (
        line.startsWith('This ') ||
        line.startsWith('The ') ||
        line.startsWith('Note:') ||
        line.startsWith('In this ') ||
        line.startsWith('I ') ||
        line.startsWith('Make sure')
      ) {
        lastCodeLine = i - 1;
      } else {
        break;
      }
    }

    if (lastCodeLine < lines.length - 1) {
      code = lines.slice(0, lastCodeLine + 1).join('\n');
    }

    return code.trim();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Logging Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Log an info message tagged with this agent's name */
  protected log(message: string): void {
    this.logger.info(message, this.agentName);
  }

  /** Log a warning tagged with this agent's name */
  protected logWarn(message: string): void {
    this.logger.warn(message, this.agentName);
  }

  /** Log an error tagged with this agent's name */
  protected logError(message: string): void {
    this.logger.error(message, this.agentName);
  }
}
