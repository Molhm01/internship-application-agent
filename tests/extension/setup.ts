import { beforeEach, vi } from 'vitest';

export interface ChromeMock {
  runtime: {
    sendMessage: ReturnType<typeof vi.fn>;
    openOptionsPage: ReturnType<typeof vi.fn>;
    getURL: ReturnType<typeof vi.fn>;
    onMessage: {
      addListener: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
    };
    onInstalled: { addListener: ReturnType<typeof vi.fn> };
  };
  tabs: {
    query: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  storage: {
    local: {
      get: ReturnType<typeof vi.fn>;
      set: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
}

/**
 * A fresh chrome mock per test. Individual tests override the specific calls
 * they care about; anything left at the default resolves to an empty result so
 * an unmocked call fails loudly in an assertion rather than throwing.
 */
export function installChromeMock(): ChromeMock {
  const store: Record<string, unknown> = {};

  const mock: ChromeMock = {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      openOptionsPage: vi.fn(),
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockRejectedValue(new Error('no receiving end')),
      create: vi.fn().mockResolvedValue({ id: 2 }),
    },
    storage: {
      local: {
        get: vi.fn((key: string) => Promise.resolve(key in store ? { [key]: store[key] } : {})),
        set: vi.fn((entries: Record<string, unknown>) => {
          Object.assign(store, entries);
          return Promise.resolve();
        }),
        remove: vi.fn((key: string | string[]) => {
          for (const entry of Array.isArray(key) ? key : [key]) delete store[entry];
          return Promise.resolve();
        }),
      },
    },
  };

  // `typeof chrome` covers the entire extension API; the double cast keeps the
  // mock to the handful of calls the code under test actually makes.
  globalThis.chrome = mock as unknown as typeof chrome;
  return mock;
}

beforeEach(() => {
  installChromeMock();
});
