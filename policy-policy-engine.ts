'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

class RateLimiter {
  maxRequests: any;
  windowMs: any;
  tokens: any;
  lastRefill: any;
  limiters: any;
  blacklistedEndpoints: any;
  dangerousPatterns: any;
  defaultLimits: any;
  blockedDomains: any;

  constructor(maxRequests: any, windowMs: any) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.tokens = maxRequests;
    this.lastRefill = Date.now();
  }

  consume() { 
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refill = Math.floor(elapsed / this.windowMs) * this.maxRequests;
    if (refill > 0) {
      this.tokens = Math.min(this.maxRequests, this.tokens + refill);
      this.lastRefill += Math.floor(elapsed / this.windowMs) * this.windowMs;
    }
    if (this.tokens <= 0) {
      return false;
    }
    this.tokens--;
    return true;
  }

  getRemaining() { 
    return this.tokens;
  }
}

class PolicyEngine {
  isEnabled: any;
  maxRequests: any;
  windowMs: any;
  tokens: any;
  lastRefill: any;
  limiters: any;
  blacklistedEndpoints: any;
  dangerousPatterns: any;
  defaultLimits: any;
  blockedDomains: any;

  constructor() {
    this.limiters = new Map();
    this.blacklistedEndpoints = new Set([
      '/logout',
      '/signout',
      '/delete',
      '/remove',
      '/deactivate',
      '/admin/delete',
      '/account/delete',
    ]);
    this.dangerousPatterns = [
      /logout/i,
      /sign\s*out/i,
      /delete/i,
      /remove/i,
      /deactivate/i,
      /cancel/i,
      /unsubscribe/i,
    ];
    this.defaultLimits = {
      requestsPerMinute: 10,
      requestsPerHour: 60,
    };
    this.isEnabled = process.env.POLICY_ENFORCED !== 'false';
    this.blockedDomains = new Set(
      (process.env.POLICY_BLOCKED_DOMAINS || '').split(',').filter(Boolean)
    );
  }

  getLimiter(domain: any) { 
    if (!this.limiters.has(domain)) {
      this.limiters.set(domain, new RateLimiter(
        this.defaultLimits.requestsPerMinute,
        60000
      ));
    }
    return this.limiters.get(domain);
  }

  checkAction(action: any, context: any) { 
    if (!this.isEnabled) {
      return { allowed: true, reason: 'Policy disabled' };
    }
    if (context && context.url) {
      try {
        const url = new URL(context.url);
        if (this.blockedDomains.has(url.hostname)) {
          return { allowed: false, reason: `Domain blocked: ${url.hostname}` };
        }
        if (this.blacklistedEndpoints.has(url.pathname)) {
          return { allowed: false, reason: `Endpoint blacklisted: ${url.pathname}` };
        }
        for (const pattern of this.dangerousPatterns) {
          if (pattern.test(url.pathname)) {
            return { allowed: false, reason: `Dangerous endpoint: ${url.pathname}` };
          }
        }
      } catch (err: any) {
        return { allowed: false, reason: `Invalid URL in context: ${context.url}` };
      }
    }
    if (action === 'click' || action === 'flutter_tap') {
      const text = (context && context.elementText) || '';
      for (const pattern of this.dangerousPatterns) {
        if (pattern.test(text)) {
          return { allowed: false, reason: `Dangerous element text: ${text}` };
        }
      }
    }
    if (context && context.domain) {
      const limiter = this.getLimiter(context.domain);
      const hourlyKey = `${context.domain}_hourly`;
      let hourlyLimiter = this.limiters.get(hourlyKey);
      if (!hourlyLimiter) {
        hourlyLimiter = new RateLimiter(
          this.defaultLimits.requestsPerHour,
          3600000
        );
        this.limiters.set(hourlyKey, hourlyLimiter);
      }
      // Check hourly first to avoid consuming per-minute token if hourly blocks
      if (!hourlyLimiter.consume()) {
        return { allowed: false, reason: `Hourly rate limit exceeded for ${context.domain}` };
      }
      if (!limiter.consume()) {
        // Refund the hourly token since the action is denied
        hourlyLimiter.tokens = Math.min(hourlyLimiter.maxRequests, hourlyLimiter.tokens + 1);
        return { allowed: false, reason: `Rate limit exceeded for ${context.domain}` };
      }
    }
    return { allowed: true, reason: 'OK' };
  }

  checkUrl(url: any) { 
    if (!this.isEnabled) return { allowed: true, reason: 'Policy disabled' };
    try {
      const urlObj = new URL(url);
      if (this.blockedDomains.has(urlObj.hostname)) {
        return { allowed: false, reason: `Domain blocked: ${urlObj.hostname}` };
      }
      if (this.blacklistedEndpoints.has(urlObj.pathname)) {
        return { allowed: false, reason: `Endpoint blacklisted: ${urlObj.pathname}` };
      }
      for (const pattern of this.dangerousPatterns) {
        if (pattern.test(urlObj.pathname)) {
          return { allowed: false, reason: `Dangerous path: ${urlObj.pathname}` };
        }
      }
    } catch (err: any) {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }
    return { allowed: true, reason: 'OK' };
  }

  getDomain(url: any) { 
    try {
      return new URL(url).hostname;
    } catch (err: any) {
      return null;
    }
  }

  setLimit(domain: any, requestsPerMinute: any, requestsPerHour: any) { 
    this.limiters.set(domain, new RateLimiter(requestsPerMinute, 60000));
    const hourly = new RateLimiter(requestsPerHour, 3600000);
    this.limiters.set(`${domain}_hourly`, hourly);
  }

  getLimiterStatus(domain: any) { 
    const limiter = this.limiters.get(domain);
    if (!limiter) return { exists: false };
    return {
      exists: true,
      remaining: limiter.getRemaining(),
      max: limiter.maxRequests,
    };
  }

  enable() { 
    this.isEnabled = true;
    log('Policy engine enabled', 'INFO', 'policy');
  }

  disable() { 
    this.isEnabled = false;
    log('Policy engine disabled', 'WARN', 'policy');
  }
}

const policyEngine = new PolicyEngine();

module.exports = { policyEngine, RateLimiter, _injectDependencies };
