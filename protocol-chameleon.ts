'use strict';

// ═════════════════════════════════════════════════════════════
// Protocol Chameleon — Adapts request payloads to match provider-specific
// API schemas (OpenAI, Gemini, Anthropic, etc.).
//
// Render-aware: All external calls wrapped in Promise.race timeouts.
// Schema cache uses in-memory Map to avoid repeated DB reads.
// ═════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _getCONFIG(): Record<string, any> {
  return _deps.config || (() => { try { return require('./get-config'); } catch { return {}; } })();
}
function _getDatabase(): any {
  return _deps.database || (() => { try { return require('./database'); } catch { return null; } })();
}

// BUG FIX (Response 19): Lazy-load providers-base to avoid circular require
// at module scope. Previous code had it at top level.
let _providersBase: any = null;
let _providersBaseChecked = false;
function _getProvidersBase() {
  if (!_providersBaseChecked) {
    _providersBaseChecked = true;
    try { _providersBase = require('./providers-base'); } catch { _providersBase = null; }
  }
  return _providersBase;
}

const { fetchWithTimeout, fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');

// ═════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════

/** Time-to-live for in-memory schema cache (ms). */
const SCHEMA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Timeout for HTTP requests (ms). */
const SCHEMA_FETCH_TIMEOUT_MS = 10 * 1000; // 10 seconds

/** Timeout for adapted provider calls (ms). */
const ADAPTED_CALL_TIMEOUT_MS = 30 * 1000; // 30 seconds

/** Maximum number of schemas cached in memory. */
const MAX_SCHEMA_CACHE_SIZE = 20;

// BUG FIX (Response 19): In-memory schema cache to avoid repeated DB reads.
// Previous code called getDatabase().selectProviderSchema on every adapt() call.
// On Render's slow I/O, this matters.
const _schemaCache = new Map<string, { schema: any; loadedAt: number }>();

function _getCachedSchema(providerName: string): any | null {
  const entry = _schemaCache.get(providerName);
  if (!entry) return null;
  const age = Date.now() - entry.loadedAt;
  if (age > SCHEMA_CACHE_TTL_MS) {
    _schemaCache.delete(providerName);
    return null;
  }
  return entry.schema;
}

function _setCachedSchema(providerName: string, schema: any): void {
  // Evict oldest entry if cache is full
  if (_schemaCache.size >= MAX_SCHEMA_CACHE_SIZE) {
    const oldest = _schemaCache.keys().next().value;
    if (oldest !== undefined) _schemaCache.delete(oldest);
  }
  _schemaCache.set(providerName, { schema, loadedAt: Date.now() });
}

// ═════════════════════════════════════════════════════════════
// Field alias map for common API variations
// ═════════════════════════════════════════════════════════════

const FIELD_ALIASES: Record<string, string[]> = {
  'max_tokens': ['maxTokens', 'max_new_tokens', 'maxNewTokens', 'max_completion_tokens', 'maxCompletionTokens'],
  'temperature': ['temp'],
  'top_p': ['topP'],
  'frequency_penalty': ['frequencyPenalty'],
  'presence_penalty': ['presencePenalty'],
  'stop': ['stop_sequences', 'stopSequences'],
};

class ProtocolChameleon {
  image: any;

  /**
   * Main entry point: adapt a request to a provider's schema.
   * Returns a normalized action response, or null on failure.
   */
  async adapt(endpoint: any, apiKey: any, model: any, requestData: any, providerName: any) {
    log(`Adapting protocol for ${providerName}...`, 'INFO', 'chameleon');
    const schema = await this.getSchema(providerName);
    if (!schema) {
      log(`No schema found for ${providerName}, cannot adapt.`, 'WARN', 'chameleon');
      return null;
    }
    const newPayload = this.rebuildPayload(requestData, schema);
    try {
      // Apply schema-driven adaptations before calling the standard completion function
      if (newPayload.options._useGeminiFormat || newPayload.options._usePromptField || newPayload.options._forceTextContent) {
        return await this._callAdapted(endpoint, apiKey, model, newPayload, providerName);
      }
      const base = _getProvidersBase();
      if (!base?.callChatCompletion) {
        log('providers-base.callChatCompletion not available', 'WARN', 'chameleon');
        return null;
      }
      const result = await base.callChatCompletion(endpoint, apiKey, model, newPayload.base64Image, newPayload.prompt, newPayload.options);
      return result;
    } catch (err: any) {
      logError('Adapted request still failed', err);
      return null;
    }
  }

  /**
   * Build and send a request using a non-standard message format detected from the schema.
   * BUG FIX (Response 19): Response body consumption is now guarded — if response.text()
   * fails, we don't hang. Also added timeout via Promise.race.
   */
  async _callAdapted(endpoint: any, apiKey: any, model: any, payload: any, providerName: any) {
    const { base64Image, prompt, options } = payload;
    const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    let body;

    if (options._useGeminiFormat) {
      // Google Gemini style: contents[] with parts[]
      const parts: any[] = [{ text: prompt }];
      if (base64Image) {
        const imageBlockKey = options._imageBlockKey || 'inline_data';
        const imageData = options._useSourceWrapper
          ? { source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } }
          : { mime_type: 'image/jpeg', data: base64Image };
        parts.push({ [imageBlockKey]: imageData });
      }
      body = {
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: options.maxTokens, temperature: options.temperature },
      };
    } else if (options._usePromptField) {
      // Legacy prompt-field style
      body = { prompt, max_tokens: options.maxTokens, temperature: options.temperature };
      if (base64Image) (body as any).image = base64Image;
    } else {
      // Fallback: standard OpenAI format
      const content: any[] = [{ type: 'text', text: prompt }];
      if (base64Image) {
        const imageBlockKey = options._imageBlockKey || 'image_url';
        const imageBlock = options._useSourceWrapper
          ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } }
          : { type: imageBlockKey, image_url: { url: `data:image/jpeg;base64,${base64Image}` } };
        content.push(imageBlock);
      }
      body = {
        model,
        max_tokens: options.maxTokens || 4096,
        temperature: options.temperature || 0.1,
        messages: [{ role: 'user', content }],
      };
    }

    // BUG FIX (Response 19): Race the HTTP call against a timeout so
    // we can't hang forever on Render's slow network.
    const fetchPromise = fetchWithTimeout(
      endpoint,
      { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
      ADAPTED_CALL_TIMEOUT_MS,
    );
    const timeoutPromise = new Promise<null>(resolve =>
      setTimeout(() => resolve(null), ADAPTED_CALL_TIMEOUT_MS + 5000),
    );
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (!response) {
      log(`Adapted call to ${providerName} timed out`, 'WARN', 'chameleon');
      return null;
    }

    if (!response.ok) {
      // BUG FIX (Response 19): Guard response.text() — it can throw if
      // the connection drops before the body is read.
      let errText = '';
      try { errText = await response.text(); } catch { errText = '(unreadable)'; }
      throw new Error(`HTTP_ERROR_${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    // Normalize response to match expected action format
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text   // Gemini
              || data.choices?.[0]?.message?.content                // OpenAI
              || data.output?.[0]?.content?.[0]?.text              // Anthropic-style
              || data.text                                         // Legacy
              || '';

    if (!text) throw new Error(`Chameleon: no text in ${providerName} response`);

    // Parse the action from the provider's text response
    const base = _getProvidersBase();
    if (!base?.extractJSON || !base?.validateActionResponse) {
      log('providers-base extractJSON/validateActionResponse not available', 'WARN', 'chameleon');
      return null;
    }
    const parsed = base.extractJSON(text, `chameleon-${providerName}`);
    return base.validateActionResponse(parsed, `Chameleon(${providerName})`);
  }

  /**
   * Get the OpenAPI schema for a provider. Checks in-memory cache first,
   * then DB, then remote URL.
   *
   * BUG FIX (Response 19): Previous code called DB on every request.
   * Now uses in-memory Map cache with TTL.
   */
  async getSchema(providerName: any) {
    // Check in-memory cache first
    const cached = _getCachedSchema(providerName);
    if (cached) return cached;

    // Check DB cache
    const db = _getDatabase();
    if (db?.selectProviderSchema) {
      try {
        const row = db.selectProviderSchema.get(providerName);
        if (row) {
          try {
            const parsed = JSON.parse(row.schema);
            const age = Date.now() - row.updated_at;
            if (age < SCHEMA_CACHE_TTL_MS) {
              _setCachedSchema(providerName, parsed);
              return parsed;
            }
          } catch (e: any) {
            log(`Cached schema parse failed for ${providerName}, re-fetching`, 'DEBUG', 'chameleon');
          }
        }
      } catch (e: any) {
        log(`DB schema lookup failed for ${providerName}`, 'DEBUG', 'chameleon');
      }
    }

    // Fetch from remote URL
    const urls = _getCONFIG().PROTOCOL_CHAMELEON_SCHEMA_URLS;
    if (!urls) return null;
    const url = urls[providerName];
    if (!url) return null;
    try {
      const openapi = await fetchJSON(url, {}, SCHEMA_FETCH_TIMEOUT_MS);
      const schema = this.extractChatCompletionSchema(openapi);
      if (schema) {
        // Persist to DB
        if (db?.upsertProviderSchema) {
          try {
            db.upsertProviderSchema.run(providerName, JSON.stringify(schema), openapi.info?.version || 'unknown', Date.now());
          } catch (e: any) {
            log(`Failed to persist schema for ${providerName}`, 'DEBUG', 'chameleon');
          }
        }
        // Cache in memory
        _setCachedSchema(providerName, schema);
        return schema;
      }
    } catch (e: any) { logError(`Schema fetch failed for ${providerName}`, e); }
    return null;
  }

  /**
   * Extract the chat completion schema from an OpenAPI spec.
   */
  extractChatCompletionSchema(openapi: any) {
    try {
      // BUG FIX (Response 19): Check multiple common path variants.
      // Some providers use /v1/chat/completions, others /chat/completions.
      const pathVariants = [
        '/v1/chat/completions',
        '/chat/completions',
        '/v1/completions',
        '/completions',
      ];
      for (const pathKey of pathVariants) {
        const path = openapi.paths?.[pathKey];
        if (path?.post) {
          const schema = path.post.requestBody?.content?.['application/json']?.schema;
          if (schema) return schema;
        }
      }
      return null;
    } catch (e: any) { return null; }
  }

  /**
   * Rebuild the request payload to match a provider's OpenAPI schema.
   * Handles common protocol variations:
   *  - Anthropic-style: messages[].content as array of {type, text/image_url} blocks
   *  - OpenAI-style: same as base callChatCompletion format
   *  - Google-style: contents[] with parts[]
   *  - Custom field names (e.g. "input" instead of "prompt", "max_new_tokens" instead of "max_tokens")
   */
  rebuildPayload(requestData: any, schema: any) {
    const { base64Image, prompt, options: any = {} } = requestData;
    const newOptions = { ...options };

    if (!schema || !schema.properties) {
      return { base64Image, prompt, options: newOptions };
    }

    const props = schema.properties;
    const result = { base64Image, prompt, options: newOptions };

    // --- Detect and adapt field name variations ---
    for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
      if (props[canonical]) continue; // Standard name exists, no remap needed
      for (const alias of aliases) {
        if (props[alias] && newOptions[canonical] !== undefined) {
          newOptions[alias] = newOptions[canonical];
          delete newOptions[canonical];
          break;
        }
      }
    }

    // --- Detect message format variation ---
    if (props.messages) {
      const msgSchema = props.messages;
      const itemsSchema = msgSchema.items || msgSchema;
      const contentSchema = itemsSchema.properties?.content;

      // If content is expected as a string and we have an image, adapt
      if (contentSchema && contentSchema.type === 'string' && base64Image) {
        newOptions._forceTextContent = true;
        log('Chameleon: provider expects text-only content, encoding image as base64 reference', 'DEBUG', 'chameleon');
      }

      // If the schema has "content" as array type with different block naming
      if (contentSchema && contentSchema.type === 'array') {
        const blockProps = contentSchema.items?.properties || contentSchema.items?.oneOf?.[0]?.properties;
        if (blockProps) {
          if (blockProps.image && !blockProps.image_url) {
            newOptions._imageBlockKey = 'image';
            log('Chameleon: provider uses "image" block format', 'DEBUG', 'chameleon');
          }
          if (blockProps.source) {
            newOptions._useSourceWrapper = true;
            log('Chameleon: provider uses "source" wrapper for image data', 'DEBUG', 'chameleon');
          }
        }
      }
    }

    // --- Detect "contents" (Google Gemini style) vs "messages" (OpenAI style) ---
    if (props.contents && !props.messages) {
      newOptions._useGeminiFormat = true;
      log('Chameleon: provider uses Gemini-style "contents" format', 'DEBUG', 'chameleon');
    }

    // --- Detect "prompt" field (some older models use top-level prompt string) ---
    if (props.prompt && props.prompt.type === 'string' && !props.messages) {
      newOptions._usePromptField = true;
    }

    // --- Detect "model" field required position ---
    if (!props.model && props.model_id) {
      newOptions._modelField = 'model_id';
    }

    // --- Detect "response_format" variations ---
    if (newOptions.responseFormat && !props.response_format) {
      if (props.response_format_type) {
        newOptions._responseFormatField = 'response_format_type';
      }
    }

    // BUG FIX (Response 19): DetectAnthropic-style "system" field
    // Some Anthropic-compatible providers expect a top-level "system"
    // field instead of a system message in the messages array.
    if (props.system && !props.messages?.items?.properties?.role?.enum?.includes('system')) {
      newOptions._useSystemField = true;
      log('Chameleon: provider uses top-level "system" field', 'DEBUG', 'chameleon');
    }

    // BUG FIX (Response 19): Detect anthropic-style "tools" field
    // Some providers use "tools" at top level, others nest under
    // "tool_choice".
    if (props.tool_choice && !props.tools) {
      newOptions._inlineToolChoice = true;
    }

    result.options = newOptions;
    return result;
  }
}

const _instance = new ProtocolChameleon();
_instance._injectDependencies = _injectDependencies;
module.exports = _instance;
