'use strict';
// Last modified: 2026-08-05 — Response 20: Fixed Groq/NVIDIA vision flags, added DeepInfra, updated text-only patterns

// ─── Provider-Specific Request Serializers (P1) ───
//
// This module handles the critical formatting differences between
// LLM API providers. The core problem: providers-base.ts was sending
// `content: [{type:'text',...}]` (array format) to ALL providers,
// but many expect `content: "plain string"` (string format).
//
// Each serializer knows its provider's requirements:
//   - OpenAI-compatible (Groq, z.ai, Agnes, OpenRouter, NVIDIA, Cerebras):
//       text-only → string, vision → array of content parts
//   - Cloudflare Workers AI:
//       always flatten to plain string (CF doesn't reliably support multipart)
//   - Gemini: handled by Google SDK (not this module)
//   - GitHub Models: OpenAI-compatible but limited model support

// ─── Provider Capability Metadata (P4, P11) ───

export interface ProviderCapabilities {
  /** Provider name (matches registry key) */
  name: string;
  /** Whether this provider can process images */
  supportsVision: boolean;
  /** Whether the API accepts content as array of parts (vs plain string) */
  supportsMultipartContent: boolean;
  /** Whether the API accepts a 'system' role in messages */
  supportsSystemRole: boolean;
  /** Whether the API accepts response_format parameter */
  supportsResponseFormat: boolean;
  /** Whether this provider requires a paid plan */
  requiresPaidPlan: boolean;
  /** Whether this is a free-tier provider */
  freeTier: boolean;
  /** Whether this provider is currently enabled */
  enabled: boolean;
  /** The serialization strategy to use */
  serializerType: 'openai' | 'cloudflare' | 'gemini' | 'custom';
}

/**
 * Provider capability registry. Each entry describes what a provider
 * can and cannot do. Used by the registry to filter providers for
 * specific tasks (e.g., vision-required vs text-only) and by the
 * serializers to choose the correct format.
 */
export const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  'Groq': {
    name: 'Groq',
    supportsVision: false,  // Default model llama-3.3-70b-versatile is text-only; vision models available but not default
    supportsMultipartContent: false,  // Default model llama-3.3-70b-versatile is text-only; vision models available but not default
    supportsSystemRole: true,
    supportsResponseFormat: false,  // Groq does NOT reliably support response_format
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  'z.ai': {
    name: 'z.ai',
    supportsVision: true,  // GLM-4.6V-Flash is a vision model
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: false,
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  'Agnes': {
    name: 'Agnes',
    supportsVision: false,  // Agnes is a text-only API based on available models
    supportsMultipartContent: false,
    supportsSystemRole: true,
    supportsResponseFormat: false,
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  'NVIDIA': {
    name: 'NVIDIA',
    supportsVision: false,  // Default model is text-only; vision fallback available (llama-3.2-11b-vision-instruct)
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: false,  // NVIDIA's free tier doesn't reliably support it
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  'Cloudflare': {
    name: 'Cloudflare',
    supportsVision: true,   // All current models are vision-capable (moondream3.1, kimi-k2.7, kimi-k2.6, gemma-4, llama-4-scout, llama-3.2-11b-vision)
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: false,
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'cloudflare',
  },
  'Cerebras': {
    name: 'Cerebras',
    supportsVision: false,  // Cerebras inference is text-only
    supportsMultipartContent: false,
    supportsSystemRole: true,
    supportsResponseFormat: false,  // Not reliable for all models
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  'DeepInfra': {
    name: 'DeepInfra',
    supportsVision: true,  // Qwen2.5-VL is vision-capable
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: false,
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  'Gemini': {
    name: 'Gemini',
    supportsVision: true,
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: false,
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'gemini',
  },
  'OpenRouter': {
    name: 'OpenRouter',
    supportsVision: true,  // depends on model, but tribunal uses vision models
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: false,
    requiresPaidPlan: false,
    freeTier: true,
    enabled: true,
    serializerType: 'openai',
  },
  // Retired July 30, 2026
  'GitHub GPT': {
    name: 'GitHub GPT',
    supportsVision: true,  // gpt-4o-mini supports vision
    supportsMultipartContent: true,
    supportsSystemRole: true,
    supportsResponseFormat: true,  // GitHub Models supports JSON mode
    requiresPaidPlan: false,
    freeTier: true,
    enabled: false,  // P9: DISABLED until health check passes
    serializerType: 'openai',
  },
};

// ─── Message Types ───

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

export interface SerializedPayload {
  model: string;
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> }>;
  max_tokens: number;
  temperature: number;
  response_format?: { type: string };
  [key: string]: any;  // allow provider-specific extensions
}

// ─── Validation ───

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate messages array before sending to a provider.
 * Catches common issues that would result in 400 errors.
 */
function validateMessages(messages: ChatMessage[], providerName: string): ValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(messages) || messages.length === 0) {
    errors.push(`${providerName}: messages must be a non-empty array`);
    return { valid: false, errors };
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.role || typeof msg.role !== 'string') {
      errors.push(`${providerName}: message[${i}] missing or invalid role`);
    }
    if (msg.content === undefined || msg.content === null) {
      errors.push(`${providerName}: message[${i}] missing content`);
    }
    if (typeof msg.content === 'string' && msg.content.trim().length === 0) {
      errors.push(`${providerName}: message[${i}] has empty string content`);
    }
    if (Array.isArray(msg.content) && msg.content.length === 0) {
      errors.push(`${providerName}: message[${i}] has empty content parts array`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ─── OpenAI-Compatible Serializer ───

/**
 * Serialize for OpenAI-compatible providers (Groq, z.ai, Agnes, OpenRouter,
 * NVIDIA, Cerebras, GitHub GPT).
 *
 * Key behavior:
 *   - Text-only request (no image): `content` is a plain string
 *   - Vision request with provider that supports multipart: `content` is array of parts
 *   - Vision request with provider that does NOT support multipart: strip image, send text only
 */
function serializeOpenAI(
  providerName: string,
  model: string,
  prompt: string,
  options: {
    base64Image?: string | null;
    maxTokens?: number;
    temperature?: number;
    responseFormat?: { type: string } | null;
    systemPrompt?: string | null;
  }
): SerializedPayload {
  const caps = PROVIDER_CAPABILITIES[providerName];
  const useVision = options.base64Image && caps?.supportsVision;
  const useMultipart = useVision && caps?.supportsMultipartContent;
  const useSystem = caps?.supportsSystemRole && options.systemPrompt;

  const messages: SerializedPayload['messages'] = [];

  // System message
  if (useSystem) {
    messages.push({ role: 'system', content: options.systemPrompt! });
  }

  // User message
  if (useMultipart) {
    // Array content with text + optional image
    const parts: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: prompt },
    ];
    parts.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${options.base64Image}` },
    });
    messages.push({ role: 'user', content: parts });
  } else {
    // Plain string content (always safe)
    // If we have an image but provider doesn't support vision/multipart,
    // the image is silently dropped. The prompt should contain text
    // descriptions extracted from the image as a fallback.
    messages.push({ role: 'user', content: prompt });
  }

  const payload: SerializedPayload = {
    model,
    messages,
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.1,
  };

  // Only add response_format if provider supports it AND it was requested
  if (options.responseFormat && caps?.supportsResponseFormat) {
    payload.response_format = options.responseFormat;
  }

  return payload;
}

// ─── Cloudflare Workers AI Serializer ───

/**
 * Serialize for Cloudflare Workers AI.
 *
 * Cloudflare Workers AI has an unusual API:
 *   - It uses a different URL structure: /accounts/{id}/ai/run/{model}
 *   - Content should always be a plain string (multipart is unreliable)
 *   - Images should be passed in the messages array but as flat strings
 *   - System role supported by Kimi and newer models
 *   - No response_format support
 *
 * For the MathU bot, we strip images entirely for Cloudflare since
 * it's used as a text-only fallback. The tribunal's vision providers
 * (Groq, Gemini, OpenRouter) handle the image analysis.
 */
function serializeCloudflare(
  providerName: string,
  model: string,
  prompt: string,
  options: {
    base64Image?: string | null;
    maxTokens?: number;
    temperature?: number;
  }
): SerializedPayload {
  const messages: Array<{ role: string; content: string }> = [];

  // System message (supported by Kimi and newer CF models)
  if (options.systemPrompt) {
    messages.push({ role: 'system', content: options.systemPrompt });
  }

  // User message — always plain string, no multipart
  messages.push({
    role: 'user',
    content: prompt,
  });

  return {
    model,
    messages,
    max_tokens: options.maxTokens || 4096,
    temperature: 0.0,  // Cloudflare works best at temp 0
  };
}

// ─── Serializer Router ───

/**
 * Get the correct serializer function for a provider.
 * Returns the serialized payload ready to be JSON.stringify'd and sent.
 */
function serializeForProvider(
  providerName: string,
  model: string,
  prompt: string,
  options: {
    base64Image?: string | null;
    maxTokens?: number;
    temperature?: number;
    responseFormat?: { type: string } | null;
    systemPrompt?: string | null;
  }
): SerializedPayload {
  const caps = PROVIDER_CAPABILITIES[providerName];
  const serializerType = caps?.serializerType || 'openai';

  let payload: SerializedPayload;
  switch (serializerType) {
    case 'cloudflare':
      payload = serializeCloudflare(providerName, model, prompt, options);
      break;
    case 'gemini':
      // Gemini uses the Google SDK, not HTTP API serialization.
      // This should never be called for Gemini, but provide a fallback.
      payload = serializeOpenAI(providerName, model, prompt, options);
      break;
    case 'openai':
    default:
      payload = serializeOpenAI(providerName, model, prompt, options);
      break;
  }

  // Post-serialization validation
  const validation = validateMessages(payload.messages as ChatMessage[], providerName);
  if (!validation.valid) {
    // Log validation errors but don't throw — let the provider return its own error
    // This helps with debugging without crashing the pipeline
    try {
      const { log } = require('./logger');
      log(`Serializer validation warning for ${providerName}: ${validation.errors.join('; ')}`, 'WARN', 'serializers');
    } catch {}
  }

  return payload;
}

/**
 * Check if a provider supports vision (image input) for the given model.
 * Uses capability registry plus optional model-level override.
 */
function providerSupportsVision(providerName: string, model?: string): boolean {
  const caps = PROVIDER_CAPABILITIES[providerName];
  if (!caps) return false;
  // Some models within a provider may not support vision even if the provider does
  // (e.g., OpenRouter has both vision and text-only models)
  if (model) {
    // Known text-only model patterns
    const textOnlyPatterns = [
      'llama-3.3-70b',         // text-only
      'llama-4-scout',         // text-only
      'deepseek-r1-distill',  // text-only
      'qwen3-0.6b',           // text-only
      'gemma2-9b-it',         // text-only
      'qwen3-coder',          // inference-focused, not vision
    ];
    for (const pattern of textOnlyPatterns) {
      if (model.toLowerCase().includes(pattern.toLowerCase())) return false;
    }
  }
  return caps.supportsVision;
}

/**
 * Get capabilities for a provider. Returns null if unknown provider.
 */
function getProviderCapabilities(providerName: string): ProviderCapabilities | null {
  return PROVIDER_CAPABILITIES[providerName] || null;
}

/**
 * Check if a provider is enabled and free-tier.
 */
function isFreeProvider(providerName: string): boolean {
  const caps = PROVIDER_CAPABILITIES[providerName];
  return caps ? (caps.freeTier && caps.enabled) : false;
}

/**
 * Get all enabled free-tier provider names.
 */
function getEnabledFreeProviders(): string[] {
  return Object.entries(PROVIDER_CAPABILITIES)
    .filter(([, caps]) => caps.freeTier && caps.enabled)
    .map(([name]) => name);
}

/**
 * Update a provider's capabilities (e.g., disable a provider after auth failure).
 */
function updateProviderCapabilities(providerName: string, updates: Partial<ProviderCapabilities>): void {
  const caps = PROVIDER_CAPABILITIES[providerName];
  if (caps) {
    Object.assign(caps, updates);
  }
}

module.exports = {
  // Serialization
  serializeForProvider,
  serializeOpenAI,
  serializeCloudflare,
  validateMessages,
  // Capability queries
  providerSupportsVision,
  getProviderCapabilities,
  isFreeProvider,
  getEnabledFreeProviders,
  updateProviderCapabilities,
  PROVIDER_CAPABILITIES,
  // Types for JS consumers
};
