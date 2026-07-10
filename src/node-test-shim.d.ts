declare module "node:test" {
  export function test(
    name: string,
    fn: () => unknown | Promise<unknown>,
  ): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, expected: RegExp, message?: string): void;
    rejects(
      fn: () => unknown | Promise<unknown>,
      predicate?: (error: unknown) => boolean,
    ): Promise<void>;
  };
  export default assert;
}
