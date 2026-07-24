// LLM provider clients and script generation.
//
// API keys are read from the environment (injected by the k8s deployment). No
// `.env` / dotenv — that dependency is blacklisted platform-wide (see agents.md).
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'grok';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

// Grok is exposed via an OpenAI-compatible endpoint.
const grok = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1',
});

// Model IDs are overridable via env so deployments can pin versions.
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-1.5-pro';
const GROK_MODEL = process.env.GROK_MODEL ?? 'grok-2';

export function isProvider(value: unknown): value is Provider {
  return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'grok';
}

/** Route the prompt to the requested LLM and return the generated video script. */
export async function generateScript(topic: string, provider: Provider): Promise<string> {
  const prompt = `Write a compelling 60-second video script about: ${topic}. Include visual cues.`;

  switch (provider) {
    case 'openai': {
      const response = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0]?.message.content ?? '';
    }
    case 'anthropic': {
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      // Guard against safety refusals (stop_reason: "refusal") before reading content.
      if (response.stop_reason === 'refusal') {
        throw new Error('Anthropic declined the request');
      }
      const block = response.content[0];
      return block && block.type === 'text' ? block.text : '';
    }
    case 'gemini': {
      const model = gemini.getGenerativeModel({ model: GEMINI_MODEL });
      const response = await model.generateContent(prompt);
      return response.response.text();
    }
    case 'grok': {
      const response = await grok.chat.completions.create({
        model: GROK_MODEL,
        messages: [{ role: 'user', content: prompt }],
      });
      return response.choices[0]?.message.content ?? '';
    }
    default:
      throw new Error(`Unsupported provider: ${provider as string}`);
  }
}
