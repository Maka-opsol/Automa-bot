'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchWithTimeout, fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');
function getDatabase() { return _deps.database || require('./database'); }
const { callChatCompletion } = require('./providers-base');

class ProtocolChameleon {
  image: any;

  async adapt(endpoint: any, apiKey: any, model: any, requestData: any, providerName: any) { 
    log(`Adapting protocol for ${providerName}...`, 'INFO', 'chameleon');
    const schema = await this.getSchema(providerName);
    if (!schema) { log(`No schema found for ${providerName}, cannot adapt.`, 'WARN', 'chameleon'); return null; }
    const newPayload = this.rebuildPayload(requestData, schema);
    try {
      // Apply schema-driven adaptations before calling the standard completion function
      if (newPayload.options._useGeminiFormat || newPayload.options._usePromptField || newPayload.options._forceTextContent) {
        return await this._callAdapted(endpoint, apiKey, model, newPayload, providerName);
      }
      const result = await callChatCompletion(endpoint, apiKey, model, newPayload.base64Image, newPayload.prompt, newPayload.options);
      return result;
    } catch (err: any) { logError('Adapted request still failed', err); return null; }
  }

  /**
   * Build and send a request using a non-standard message format detected from the schema.
   */
  async _callAdapted(endpoint: any, apiKey: any, model: any, payload: any, providerName: any) {
    const { base64Image, prompt, options } = payload;
    const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
    let body;

    if (options._useGeminiFormat) {
      // Google Gemini style: contents[] with parts[]
      const parts = [{ text: prompt }];
      if (base64Image) {
        const imageBlockKey = options._imageBlockKey || 'inline_data';
        const imageData = options._useSourceWrapper
          ? { source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } }
          : { mime_type: 'image/jpeg', data: base64Image };
        (parts as any[]).push({ [imageBlockKey]: imageData });
      }
      body = { contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: options.maxTokens, temperature: options.temperature } };
    } else if (options._usePromptField) {
      // Legacy prompt-field style
      body = { prompt, max_tokens: options.maxTokens, temperature: options.temperature };
// @ts-expect-error
      if (base64Image) body.image = base64Image;
    } else {
      // Fallback: standard OpenAI format
      const content = [{ type: 'text', text: prompt }];
      if (base64Image) {
        const imageBlockKey = options._imageBlockKey || 'image_url';
        const imageBlock = options._useSourceWrapper
          ? { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } }
          : { type: imageBlockKey, image_url: { url: `data:image/jpeg;base64,${base64Image}` } };
        (content as any[]).push(imageBlock);
      }
      body = { model, max_tokens: options.maxTokens || 4096, temperature: options.temperature || 0.1, messages: [{ role: 'user', content }] };
    }

    const response = await require('./utils-fetch').fetchWithTimeout(
      endpoint,
      { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal },
      30000
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
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
    const { extractJSON, validateActionResponse } = require('./providers-base');
    const parsed = extractJSON(text, `chameleon-${providerName}`);
    return validateActionResponse(parsed, `Chameleon(${providerName})`);
  }

  async getSchema(providerName: any) { 
    const cached = getDatabase().selectProviderSchema.get(providerName);
    if (cached) { try { const parsed = JSON.parse(cached.schema); const age = Date.now() - cached.updated_at; if (age < 3600000 * 24) return parsed; } catch (e: any) { log(`Cached schema parse failed for ${providerName}, re-fetching`, 'DEBUG', 'chameleon'); } }
    const urls = getCONFIG().PROTOCOL_CHAMELEON_SCHEMA_URLS;
    if (!urls) return null;
    const url = urls[providerName];
    if (!url) return null;
    try {
      const openapi = await fetchJSON(url, {}, 10000);
      const schema = this.extractChatCompletionSchema(openapi);
      if (schema) { getDatabase().upsertProviderSchema.run(providerName, JSON.stringify(schema), openapi.info?.version || 'unknown', Date.now()); return schema; }
    } catch (e: any) { logError(`Schema fetch failed for ${providerName}`, e); }
    return null;
  }

  extractChatCompletionSchema(openapi: any) { 
    try {
      const path = openapi.paths['/chat/completions'] || openapi.paths['/v1/chat/completions'];
      if (!path) return null;
      const post = path.post;
      if (!post) return null;
      const schema = post.requestBody?.content?.['application/json']?.schema;
      return schema || null;
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
// @ts-expect-error
    const newOptions = { ...options };

    if (!schema || !schema.properties) {
      return { base64Image, prompt, options: newOptions };
    }

    const props = schema.properties;
    const result = { base64Image, prompt, options: newOptions };

    // --- Detect and adapt field name variations ---
    // Map common field aliases
    const fieldAliases = {
      'max_tokens': ['maxTokens', 'max_new_tokens', 'maxNewTokens', 'max_completion_tokens', 'maxCompletionTokens'],
      'temperature': ['temp'],
      'top_p': ['topP', 'top_p'],
      'frequency_penalty': ['frequencyPenalty'],
      'presence_penalty': ['presencePenalty'],
      'stop': ['stop_sequences', 'stopSequences'],
    };

    // If the schema uses different field names, rename our options to match
    for (const [canonical, aliases] of Object.entries(fieldAliases)) {
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
    // Anthropic-style: expects "messages" with role "user" and content as array
    // Some providers wrap image content differently (e.g. "image" instead of "image_url")
    if (props.messages) {
      const msgSchema = props.messages;
      // Check if messages items expect "content" as string (simple) vs array (multi-modal)
      const itemsSchema = msgSchema.items || msgSchema;
      const contentSchema = itemsSchema.properties?.content;

      // If content is expected as a string and we have an image, we need to adapt
      if (contentSchema && contentSchema.type === 'string' && base64Image) {
        // Provider expects text-only content — encode image as markdown in prompt
        newOptions._forceTextContent = true;
        log('Chameleon: provider expects text-only content, encoding image as base64 reference', 'DEBUG', 'chameleon');
      }

      // If the schema has "content" as array type with different block naming
      if (contentSchema && contentSchema.type === 'array') {
        const blockProps = contentSchema.items?.properties || contentSchema.items?.oneOf?.[0]?.properties;
        if (blockProps) {
          // Check if provider uses "image" instead of "image_url"
          if (blockProps.image && !blockProps.image_url) {
            newOptions._imageBlockKey = 'image';
            log('Chameleon: provider uses "image" block format', 'DEBUG', 'chameleon');
          }
          // Check if provider uses "source" wrapper for image data
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

    result.options = newOptions;
    return result;
  }
}

module.exports = new ProtocolChameleon();
module.exports._injectDependencies = _injectDependencies;
