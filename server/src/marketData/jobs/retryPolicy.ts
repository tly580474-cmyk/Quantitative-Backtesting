// ─── Retry Policy ──────────────────────────────────────────────────
// Error classification and exponential backoff for provider calls.

import { ProviderError } from '../providers/provider.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface RetryDecision {
  retryable: boolean;
  baseDelayMs: number;
  maxAttempts: number;
}

// ─── Constants ──────────────────────────────────────────────────────

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes cap
const JITTER_MAX_MS = 1000;

// Backoff base delays by error category
const BASE_DELAYS: Record<string, number> = {
  network: 2000, // 2 seconds
  rate_limit: 5000, // 5 seconds — longer initial wait for rate limits
  data_error: 1000, // 1 second — retry once, then skip
};

// ─── Error Classification ───────────────────────────────────────────

/**
 * Classifies a provider error into a retry decision with appropriate
 * backoff strategy, base delay, and maximum attempt count.
 */
export function classifyError(error: ProviderError): RetryDecision {
  switch (error.category) {
    case 'network':
      return {
        retryable: true,
        baseDelayMs: BASE_DELAYS.network,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      };

    case 'rate_limit':
      return {
        retryable: true,
        baseDelayMs: BASE_DELAYS.rate_limit,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      };

    case 'auth':
      return {
        retryable: false,
        baseDelayMs: 0,
        maxAttempts: 0,
      };

    case 'invalid_params':
      return {
        retryable: false,
        baseDelayMs: 0,
        maxAttempts: 0,
      };

    case 'quota_exceeded':
      // Not retryable this session, but could be retried the next day
      return {
        retryable: false,
        baseDelayMs: 0,
        maxAttempts: 0,
      };

    case 'data_error':
      return {
        retryable: true,
        baseDelayMs: BASE_DELAYS.data_error,
        maxAttempts: 1, // Retry once, then skip
      };

    default:
      // Unknown error categories: conservative — don't retry
      return {
        retryable: false,
        baseDelayMs: 0,
        maxAttempts: 0,
      };
  }
}

// ─── Backoff Calculation ────────────────────────────────────────────

/**
 * Calculates the exponential backoff delay for a given attempt number.
 *
 * Formula: baseMs * 2^attempt + random_jitter(0-1000ms)
 * Capped at 5 minutes (MAX_BACKOFF_MS).
 *
 * @param attempt - Zero-based attempt number (0 = first retry)
 * @param baseMs - Base delay in milliseconds
 */
export function calculateBackoff(attempt: number, baseMs: number = 2000): number {
  const exponential = baseMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
  const delay = exponential + jitter;
  return Math.min(delay, MAX_BACKOFF_MS);
}

// ─── Combined Should-Retry Decision ─────────────────────────────────

/**
 * Combined decision: is the error retryable AND have we not exceeded
 * the maximum attempt count?
 *
 * @param error - The provider error that occurred
 * @param attempts - Number of attempts already made (including the failed one)
 * @param maxAttempts - Override for max attempts (defaults to DEFAULT_MAX_ATTEMPTS)
 */
export function shouldRetry(
  error: ProviderError,
  attempts: number,
  maxAttempts?: number,
): boolean {
  const decision = classifyError(error);
  const effectiveMax = maxAttempts ?? decision.maxAttempts;

  if (!decision.retryable) {
    return false;
  }

  return attempts < effectiveMax;
}
