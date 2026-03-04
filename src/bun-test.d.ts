declare module "bun:test" {
  export const describe: (name: string, fn: () => void | Promise<void>) => void;
  export const it: (name: string, fn: () => void | Promise<void>) => void;
  export const expect: unknown;
  export const mock: unknown;
  export const beforeEach: unknown;
  export const afterEach: unknown;
}

declare module "bun" {
  export type Socket = unknown;
  export type Subprocess = unknown;
  export type FileSink = unknown;
  export function listen(config: unknown): unknown;
  export function spawn(command: string[], options?: unknown): unknown;
}

declare module "dbus-next" {
  export function systemBus(): unknown;
}

declare module "shell-quote" {
  export function quote(parts: string[]): string;
  const shellquote: {
    quote(parts: string[]): string;
  };
  export default shellquote;
}

declare module "msgpackr" {
  export function pack(input: unknown): Uint8Array;
  export function unpack(input: Uint8Array | Buffer): unknown;
}

declare module "systeminformation" {
  const si: {
    cpuTemperature: () => Promise<{ main: number }>;
    battery: () => Promise<{ hasBattery: boolean; percent: number; isCharging: boolean }>;
  };
  export default si;
}

declare module "@pondwader/socks5-server" {
  export type Socks5Server = unknown;
  export function createServer(): unknown;
}
