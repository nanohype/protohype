/**
 * LLM client with GPT-4o primary + Claude 3.5 Sonnet fallback.
 * Uses prompt prefix caching where supported.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { logger } from '../middleware/logger';
import { SYSTEM_PROMPT } from './prompt-builder';

const openai = new OpenAI({ apiKey: config.OPENAI_API_KEY });
const anthropic = config.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY })
  : null;

export async function callLlm(
  contextAndQuestion: string
): Promise<{ answer: string; modelUsed: string }> {
  try {
    return await callOpenAI(contextAndQuestion);
  } catch (err) {
    logger.warn({ err }, 'OpenAI call failed, attempting Anthropic fallback');
    if (!anthropic) throw err;
    return await callAnthropic(contextAndQuestion);
  }
}

async function callOpenAI(userContent: string): Promise<{ answer: string; modelUsed: string }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.1,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    // OpenAI automatically applies prefix caching for identical system prompt prefixes
  });

  const answer = response.choices[0]?.message?.content ?? 'No response generated.';
  return { answer, modelUsed: 'gpt-4o' };
}

async function callAnthropic(userContent: string): Promise<{ answer: string; modelUsed: string }> {
  const response = await anthropic!.messages.create({
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    temperature: 0.1,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // Anthropic prompt caching for stable system prompt
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: userContent }],
  });

  const content = response.content[0];
  const answer = content.type === 'text' ? content.text : 'No response generated.';
  return { answer, modelUsed: 'claude-3-5-sonnet' };
}
