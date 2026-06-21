export interface SeededRandom {
  next(): number;
  nextInt(min: number, max: number): number;
  clone(): SeededRandom;
}

/** Convert a string seed to a 32-bit integer. */
export function seedToInt32(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i);
    hash = ((hash << 5) - hash) + ch;
    hash |= 0;
  }
  return hash;
}

class SeededRandomImpl implements SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed | 0;
  }

  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  clone(): SeededRandom {
    const c = new SeededRandomImpl(0);
    c.state = this.state;
    return c;
  }
}

export function createSeededRandom(seed: string): SeededRandom {
  return new SeededRandomImpl(seedToInt32(seed));
}
