/** Deterministic xorshift32 PRNG whose state can be saved with a game. */
export const nextRandom = (state: number): [number, number] => {
  let value = state | 0;
  if (value === 0) value = 0x6d2b79f5;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  const nextState = value >>> 0;
  return [nextState / 0x1_0000_0000, nextState];
};

export const shuffled = <T>(items: readonly T[], initialState: number): [T[], number] => {
  const result = [...items];
  let state = initialState >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    let value: number;
    [value, state] = nextRandom(state);
    const other = Math.floor(value * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return [result, state];
};
