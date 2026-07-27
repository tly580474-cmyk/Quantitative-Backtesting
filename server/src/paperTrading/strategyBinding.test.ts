import { describe, expect, it } from 'vitest';
import {
  PAPER_STRATEGY_BINDING_VERSION,
  assertBindingStatusTransition,
  canTransitionBindingStatus,
  type PaperStrategyBindingStatus,
} from './strategyBinding.js';

describe('paper trading strategy binding state machine', () => {
  it('exposes a version derived from shared trading rules', () => {
    expect(PAPER_STRATEGY_BINDING_VERSION).toMatch(/^paper-binding-/);
  });

  it('allows paused -> active / stopped transitions', () => {
    expect(canTransitionBindingStatus('paused', 'active')).toBe(true);
    expect(canTransitionBindingStatus('paused', 'stopped')).toBe(true);
    expect(canTransitionBindingStatus('paused', 'paused')).toBe(false);
    expect(canTransitionBindingStatus('paused', 'error')).toBe(false);
  });

  it('allows active -> paused / stopped / error transitions', () => {
    expect(canTransitionBindingStatus('active', 'paused')).toBe(true);
    expect(canTransitionBindingStatus('active', 'stopped')).toBe(true);
    expect(canTransitionBindingStatus('active', 'error')).toBe(true);
    expect(canTransitionBindingStatus('active', 'active')).toBe(false);
  });

  it('allows stopped -> paused only (cannot directly resume to active)', () => {
    expect(canTransitionBindingStatus('stopped', 'paused')).toBe(true);
    expect(canTransitionBindingStatus('stopped', 'active')).toBe(false);
    expect(canTransitionBindingStatus('stopped', 'error')).toBe(false);
  });

  it('allows error -> paused / stopped transitions', () => {
    expect(canTransitionBindingStatus('error', 'paused')).toBe(true);
    expect(canTransitionBindingStatus('error', 'stopped')).toBe(true);
    expect(canTransitionBindingStatus('error', 'active')).toBe(false);
  });

  it('throws on illegal transitions', () => {
    expect(() => assertBindingStatusTransition('active', 'active')).toThrow(
      '非法策略绑定状态转换：active -> active',
    );
    expect(() => assertBindingStatusTransition('stopped', 'active')).toThrow(
      '非法策略绑定状态转换：stopped -> active',
    );
  });

  it('rejects every self-transition', () => {
    expect(canTransitionBindingStatus('paused', 'paused')).toBe(false);
    expect(canTransitionBindingStatus('active', 'active')).toBe(false);
    expect(canTransitionBindingStatus('stopped', 'stopped')).toBe(false);
    expect(canTransitionBindingStatus('error', 'error')).toBe(false);
  });

  it('covers all allowed transitions exhaustively', () => {
    const allowed: Array<[PaperStrategyBindingStatus, PaperStrategyBindingStatus]> = [
      ['paused', 'active'],
      ['paused', 'stopped'],
      ['active', 'paused'],
      ['active', 'stopped'],
      ['active', 'error'],
      ['stopped', 'paused'],
      ['error', 'paused'],
      ['error', 'stopped'],
    ];
    for (const [from, to] of allowed) {
      expect(canTransitionBindingStatus(from, to)).toBe(true);
    }
  });

  it('asserts does not throw for legal transitions', () => {
    expect(() => assertBindingStatusTransition('paused', 'active')).not.toThrow();
    expect(() => assertBindingStatusTransition('error', 'stopped')).not.toThrow();
  });
});
