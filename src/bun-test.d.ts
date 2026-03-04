declare module "bun:test" {
  export const describe: (name: string, fn: () => void | Promise<void>) => void;
  export const it: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: unknown;
  export const mock: unknown;
  export const beforeEach: unknown;
  export const afterEach: unknown;
}
