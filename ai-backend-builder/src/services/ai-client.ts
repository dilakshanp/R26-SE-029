/**
 * AI Backend Builder — Unified AI Client
 * 
 * Provides a single interface for querying AI models.
 * Strategy: Flask API (local models) → OpenAI API (fallback).
 * 
 * The Flask API is expected to expose a POST /api/generate endpoint
 * that accepts { model, prompt, system } and returns { response }.
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger.js';
import {
  type AgentRole,
  type AIClientConfig,
  type AIRequest,
  type AIResponse,
} from '../types/index.js';
import { FLASK_ENDPOINTS, OPENAI_API_URL } from '../utils/constants.js';

export class AIClient {
  private config: AIClientConfig;
  private logger: Logger;

  constructor(config: AIClientConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Query an AI model for the given agent role.
   * Tries the local Flask API first; falls back to OpenAI on failure.
   * 
   * @param role   - The agent role (determines which local model to use)
   * @param prompt - The user/task prompt
   * @param systemPrompt - The system prompt defining agent behavior
   * @returns The raw text response from the model
   */
  public async query(
    role: AgentRole,
    prompt: string,
    systemPrompt: string
  ): Promise<string> {
    const modelName = this.config.localModels[role];
    this.logger.info(`Querying model "${modelName}" for role "${role}"`, 'AIClient');

    // Attempt 1: Flask API (local models)
    try {
      const response = await this.sendToFlask(modelName, prompt, systemPrompt);
      this.logger.info(`Flask API responded successfully for role "${role}"`, 'AIClient');
      return response;
    } catch (flaskError: unknown) {
      const errorMsg = flaskError instanceof Error ? flaskError.message : String(flaskError);
      this.logger.warn(
        `Flask API failed for role "${role}": ${errorMsg}. Falling back to OpenAI.`,
        'AIClient'
      );
    }

    // Attempt 2: OpenAI API (fallback)
    if (!this.config.openaiApiKey) {
      throw new Error(
        `Flask API is unavailable and no OpenAI API key is configured. ` +
        `Set "aiBackendBuilder.openaiApiKey" in VS Code settings.`
      );
    }

    try {
      const response = await this.sendToOpenAI(prompt, systemPrompt);
      this.logger.info(`OpenAI fallback responded successfully for role "${role}"`, 'AIClient');
      return response;
    } catch (openaiError: unknown) {
      const errorMsg = openaiError instanceof Error ? openaiError.message : String(openaiError);
      this.logger.error(
        `Both Flask and OpenAI failed for role "${role}": ${errorMsg}`,
        'AIClient'
      );
      throw new Error(`AI query failed for role "${role}": ${errorMsg}`);
    }
  }

  /**
   * Check if the Flask API is reachable.
   */
  public async checkFlaskHealth(): Promise<boolean> {
    try {
      const url = `${this.config.flaskBaseUrl}${FLASK_ENDPOINTS.health}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      return response.ok;
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Flask API (Local Models)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the local Flask API proxy.
   * 
   * Expected Flask endpoint: POST /api/generate
   * Body: { model: string, prompt: string, system: string }
   * Response: { response: string }
   */
  private async sendToFlask(
    model: string,
    prompt: string,
    systemPrompt: string
  ): Promise<string> {
    const url = `${this.config.flaskBaseUrl}${FLASK_ENDPOINTS.generate}`;

    const body: AIRequest = {
      model,
      prompt,
      system: systemPrompt,
    };

    this.logger.debug(`Flask request to ${url} with model "${model}"`, 'AIClient');

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeout
    );

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Flask API returned ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as AIResponse;

      if (data.error) {
        throw new Error(`Flask API error: ${data.error}`);
      }

      if (!data.response || data.response.trim().length === 0) {
        throw new Error('Flask API returned an empty response');
      }

      return data.response;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Flask API request timed out after ${this.config.requestTimeout}ms`
        );
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OpenAI API (Fallback)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a prompt to the OpenAI Chat Completions API.
   * Used as a fallback when the Flask API is unavailable.
   */
  private async sendToOpenAI(
    prompt: string,
    systemPrompt: string
  ): Promise<string> {
    this.logger.debug(
      `OpenAI request with model "${this.config.openaiModel}"`,
      'AIClient'
    );

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeout
    );

    try {
      const response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.openaiModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
          temperature: 0.3,
          max_tokens: 4096,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`OpenAI API returned ${response.status}: ${errorText}`);
      }

      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };

      if (data.error) {
        throw new Error(`OpenAI API error: ${data.error.message}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content || content.trim().length === 0) {
        throw new Error('OpenAI API returned an empty response');
      }

      return content;
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `OpenAI API request timed out after ${this.config.requestTimeout}ms`
        );
      }
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Configuration Helper
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Build an AIClientConfig from the current VS Code settings.
   */
  public static configFromSettings(): AIClientConfig {
    const config = vscode.workspace.getConfiguration('aiBackendBuilder');

    return {
      flaskBaseUrl: config.get<string>('flaskUrl', 'http://localhost:5000'),
      openaiApiKey: config.get<string>('openaiApiKey', ''),
      openaiModel: config.get<string>('openaiModel', 'gpt-4'),
      localModels: {
        planner: config.get<string>('models.planner', 'mistral:7b'),
        codegen: config.get<string>('models.codegen', 'codellama:13b'),
        debug: config.get<string>('models.debug', 'mistral:7b'),
      },
      requestTimeout: config.get<number>('aiRequestTimeout', 120_000),
    };
  }
}
