/**
 * Provider registry.
 *
 * A lightweight in-memory registry that holds all registered
 * MarketDataProvider instances.  The first provider registered
 * automatically becomes the "active" provider and is used by
 * downstream consumers unless explicitly overridden.
 */

import type { MarketDataProvider } from './provider.js';
import { ProviderError } from './provider.js';

// ─── Internal state ──────────────────────────────────────────────────

const registry = new Map<string, MarketDataProvider>();

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Register a provider.  If a provider with the same `id` already
 * exists it is replaced (last-write-wins).
 */
export function registerProvider(provider: MarketDataProvider): void {
  registry.set(provider.id, provider);
}

/**
 * Retrieve a provider by id.
 *
 * Throws `ProviderError` (category `data_error`) if the provider
 * is not found.
 */
export function getProvider(id: string): MarketDataProvider {
  const provider = registry.get(id);
  if (!provider) {
    throw new ProviderError(
      `Provider not found: "${id}". Registered providers: ${listProviderIds().join(', ') || '(none)'}`,
      'data_error',
      false,
    );
  }
  return provider;
}

/**
 * Return the first registered provider.
 *
 * This is the convenient default for code paths that need "a"
 * provider but do not care which one when only a single provider
 * is registered.
 *
 * Throws if no providers are registered.
 */
export function getActiveProvider(): MarketDataProvider {
  const first = registry.values().next().value;
  if (!first) {
    throw new ProviderError(
      'No market data providers registered.',
      'data_error',
      false,
    );
  }
  return first as MarketDataProvider;
}

/**
 * Return all registered providers in insertion order.
 */
export function listProviders(): MarketDataProvider[] {
  return Array.from(registry.values());
}

/**
 * Return `true` if a provider with the given `id` is registered.
 */
export function hasProvider(id: string): boolean {
  return registry.has(id);
}

// ─── Internal helpers ────────────────────────────────────────────────

function listProviderIds(): string[] {
  return Array.from(registry.keys());
}
