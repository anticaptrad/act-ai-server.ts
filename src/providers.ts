// LLM provider clients and script generation.
//
// API keys are read from the environment (injected by the k8s deployment). No
// `.env` / dotenv — that dependency is blacklisted platform-wide (see agents.md).
//
// Clients are constructed lazily, on first use of their provider. Constructing
// them at module load would abort process startup whenever any single key is
// absent (the OpenAI SDK throws from its constructor), which would crash-loop
// the pod and take down the credential-free health probes with it. Lazy
// construction keeps a missing key scoped to the one route that needs it.
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { withSpan } from './telemetry';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'grok';

/** A provider was requested but its credentials are not configured. */
export class ProviderNotConfiguredError extends Error {
  constructor(readonly provider: Provider, readonly envVar: string) {
    super(`Provider "${provider}" is not configured: ${envVar} is unset`);
    this.name = 'ProviderNotConfiguredError';
  }
}

function requireKey(provider: Provider, envVar: string): string {
  const value = process.env[envVar];
  if (!value) throw new ProviderNotConfiguredError(provider, envVar);
  return value;
}

// Model IDs are overridable via env so deployments can pin versions.
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-1.5-pro';
const GROK_MODEL = process.env.GROK_MODEL ?? 'grok-2';

let openaiClient: OpenAI | undefined;
let anthropicClient: Anthropic | undefined;
let geminiClient: GoogleGenerativeAI | undefined;
let grokClient: OpenAI | undefined;

function getOpenAI(): OpenAI {
  return (openaiClient ??= new OpenAI({ apiKey: requireKey('openai', 'OPENAI_API_KEY') }));
}

function getAnthropic(): Anthropic {
  return (anthropicClient ??= new Anthropic({
    apiKey: requireKey('anthropic', 'ANTHROPIC_API_KEY'),
  }));
}

function getGemini(): GoogleGenerativeAI {
  return (geminiClient ??= new GoogleGenerativeAI(requireKey('gemini', 'GEMINI_API_KEY')));
}

// Grok is exposed via an OpenAI-compatible endpoint.
function getGrok(): OpenAI {
  return (grokClient ??= new OpenAI({
    apiKey: requireKey('grok', 'XAI_API_KEY'),
    baseURL: process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1',
  }));
}

export function isProvider(value: unknown): value is Provider {
  return value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'grok';
}

/** Providers whose credentials are present, for readiness reporting. */
export function configuredProviders(): Provider[] {
  const configured: Provider[] = [];
  if (process.env.OPENAI_API_KEY) configured.push('openai');
  if (process.env.ANTHROPIC_API_KEY) configured.push('anthropic');
  if (process.env.GEMINI_API_KEY) configured.push('gemini');
  if (process.env.XAI_API_KEY) configured.push('grok');
  return configured;
}

function modelForProvider(provider: Provider): string {
  switch (provider) {
    case 'openai':
      return OPENAI_MODEL;
    case 'anthropic':
      return ANTHROPIC_MODEL;
    case 'gemini':
      return GEMINI_MODEL;
    case 'grok':
      return GROK_MODEL;
  }
}

/** Route the prompt to the requested LLM and return the generated video script. */
export async function generateScript(topic: string, provider: Provider): Promise<string> {
  const prompt = `Write a compelling 60-second video script about: ${topic}. Include visual cues.`;
  const model = modelForProvider(provider);

  return withSpan(
    'act.ai.script.generate',
    {
      'act.ai.provider': provider,
      'act.ai.model': model,
      'act.ai.topic.characters': topic.length,
      'act.ai.prompt.characters': prompt.length,
    },
    async (span) => {
      let script: string;

      switch (provider) {
        case 'openai': {
          const response = await getOpenAI().chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
          });
          script = response.choices[0]?.message.content ?? '';
          break;
        }
        case 'anthropic': {
          const response = await getAnthropic().messages.create({
            model,
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }],
          });
          // Guard against safety refusals (stop_reason: "refusal") before reading content.
          // Cast: older SDK typings don't yet include the "refusal" stop reason.
          if ((response.stop_reason as string) === 'refusal') {
            throw new Error('Anthropic declined the request');
          }
          const block = response.content[0];
          script = block && block.type === 'text' ? block.text : '';
          break;
        }
        case 'gemini': {
          const geminiModel = getGemini().getGenerativeModel({ model });
          const response = await geminiModel.generateContent(prompt);
          script = response.response.text();
          break;
        }
        case 'grok': {
          const response = await getGrok().chat.completions.create({
            model,
            messages: [{ role: 'user', content: prompt }],
          });
          script = response.choices[0]?.message.content ?? '';
          break;
        }
      }

      span.setAttribute('act.ai.response.characters', script.length);
      span.setAttribute('act.ai.response.empty', script.length === 0);
      return script;
    },
  );
}
