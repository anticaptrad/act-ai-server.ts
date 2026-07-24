import Fastify from 'fastify';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';

dotenv.config();

const fastify = Fastify({ logger: true });

// Initialize AI SDKs
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const gemini = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
const grok = new OpenAI({ 
  apiKey: process.env.XAI_API_KEY, 
  baseURL: 'https://api.x.ai/v1' 
});

type Provider = 'openai' | 'anthropic' | 'gemini' | 'grok';

interface ScriptRequest {
  topic: string;
  provider: Provider;
}

// Basic health check route
fastify.get('/health', async (request, reply) => {
  return { status: 'OK' };
});

// Generate Script Route
fastify.post('/api/generate/script', async (request, reply) => {
  const { topic, provider } = request.body as ScriptRequest;
  
  if (!topic || !provider) {
    return reply.status(400).send({ error: 'Missing topic or provider' });
  }

  const prompt = `Write a compelling 60-second video script about: ${topic}. Include visual cues.`;

  try {
    let script = '';
    switch (provider) {
      case 'openai': {
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
        });
        script = response.choices[0].message.content || '';
        break;
      }
      case 'anthropic': {
        const response = await anthropic.messages.create({
          model: 'claude-3-5-sonnet-20240620',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        });
        script = ('text' in response.content[0]) ? response.content[0].text : '';
        break;
      }
      case 'gemini': {
        const model = gemini.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const response = await model.generateContent(prompt);
        script = response.response.text();
        break;
      }
      case 'grok': {
        const response = await grok.chat.completions.create({
          model: 'grok-2',
          messages: [{ role: 'user', content: prompt }],
        });
        script = response.choices[0].message.content || '';
        break;
      }
      default:
        return reply.status(400).send({ error: `Unsupported provider: ${provider}` });
    }
    
    return { script };
  } catch (error: any) {
    fastify.log.error(error);
    return reply.status(500).send({ error: error.message });
  }
});

interface VideoRequest {
  script: string;
}

// Generate Video Route (Placeholder)
fastify.post('/api/generate/video', async (request, reply) => {
  const { script } = request.body as VideoRequest;
  
  if (!script) {
    return reply.status(400).send({ error: 'Missing script' });
  }

  fastify.log.info('Triggering video generation API with script payload');
  
  // Simulated delay for video rendering
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  return { 
    status: 'success', 
    videoUrl: 'https://storage.example.com/generated_output.mp4' 
  };
});

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || '3005', 10);
    await fastify.listen({ port, host: '0.0.0.0' });
    fastify.log.info(`AI Server running on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
