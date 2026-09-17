import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAI } from 'openai';

/**
 * Azure AI Foundry Service
 * Uses OpenAI-compatible API with Azure AI Foundry project endpoint
 * Route: {project-endpoint}/openai/v1/chat/completions
 */
/**
 * Token usage for one LLM call. Returned alongside every structured
 * completion so graph nodes can meter real per-request usage instead of
 * reporting zeroes.
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export const EMPTY_USAGE: LlmUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

@Injectable()
export class AzureAIService {
  private readonly logger = new Logger(AzureAIService.name);
  private readonly client: OpenAI;
  private readonly deployment: string;

  constructor(private readonly configService: ConfigService) {
    const projectEndpoint = this.configService.get<string>(
      'AZURE_AI_PROJECT_ENDPOINT',
    );
    const apiKey = this.configService.get<string>('AZURE_AI_API_KEY');
    this.deployment =
      this.configService.get<string>('AZURE_AI_DEPLOYMENT') || 'gpt-5-mini';

    if (!projectEndpoint || !apiKey) {
      throw new Error(
        'Azure AI configuration missing: AZURE_AI_PROJECT_ENDPOINT and AZURE_AI_API_KEY are required',
      );
    }

    // OpenAI-compatible Foundry integration
    // Project endpoint + /openai/v1 suffix
    const baseURL = `${projectEndpoint}/openai/v1`;

    this.client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL,
      defaultHeaders: {
        'api-key': apiKey,
      },
    });

    this.logger.log(
      `Azure AI Service initialized - Deployment: ${this.deployment}, BaseURL: ${baseURL}`,
    );
  }

  /**
   * Call the LLM with structured output using JSON schema
   * @returns Parsed response + real token usage for per-request metering
   */
  async getStructuredCompletion<T = any>(
    messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }>,
    responseFormat: {
      type: 'json_schema';
      json_schema: {
        name: string;
        strict: boolean;
        schema: Record<string, any>;
      };
    },
    temperature: number = 1,
  ): Promise<{ data: T; usage: LlmUsage }> {
    try {
      this.logger.log(
        `Calling ${this.deployment} with ${messages.length} messages`,
      );

      const completion = await this.client.chat.completions.create({
        model: this.deployment,
        messages: messages,
        temperature: temperature,
        response_format: responseFormat as any,
      });

      const content = completion.choices[0]?.message?.content;

      if (!content) {
        throw new Error('No content in LLM response');
      }

      const usage: LlmUsage = {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0,
      };

      try {
        const parsed = JSON.parse(content);
        this.logger.log(
          `Structured completion received and parsed (tokens: ${usage.totalTokens})`,
        );
        return { data: parsed as T, usage };
      } catch (parseError) {
        this.logger.error(
          `Failed to parse LLM response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
        throw new Error(`Invalid JSON in LLM response: ${content}`);
      }
    } catch (error) {
      this.logger.error(
        `Azure AI call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Call the LLM with simple text completion (for testing connectivity)
   * @param prompt - Simple text prompt
   * @returns Text response
   */
  async getCompletion(prompt: string): Promise<string> {
    try {
      this.logger.log(`Calling ${this.deployment} with simple prompt`);

      const completion = await this.client.chat.completions.create({
        model: this.deployment,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 1, // gpt-5-mini only supports default temperature
      });

      const content = completion.choices[0]?.message?.content;

      if (!content) {
        throw new Error('No content in LLM response');
      }

      this.logger.log('Simple completion received');
      return content;
    } catch (error) {
      this.logger.error(
        `Azure AI call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * Health check - verify Azure AI connectivity
   * @returns true if connection succeeds
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getCompletion('Hello');
      return true;
    } catch (error) {
      this.logger.error('Azure AI health check failed');
      return false;
    }
  }
}
