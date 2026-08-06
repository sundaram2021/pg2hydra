const start = Date.now();

function stamp(): string {
  const seconds = ((Date.now() - start) / 1000).toFixed(1).padStart(6, ' ');
  return `[${seconds}s]`;
}

export const log = {
  step(message: string): void {
    console.log(`${stamp()} ▸ ${message}`);
  },
  info(message: string): void {
    console.log(`${stamp()}   ${message}`);
  },
  warn(message: string): void {
    console.warn(`${stamp()} ! ${message}`);
  },
  error(message: string): void {
    console.error(`${stamp()} ✗ ${message}`);
  },
  done(message: string): void {
    console.log(`${stamp()} ✓ ${message}`);
  },
};
