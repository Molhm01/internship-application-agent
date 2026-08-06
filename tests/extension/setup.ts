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
  scripting: {
    executeScript: ReturnType<typeof vi.fn>;
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
    // Defaults to succeeding: a test about reinjection failing has to say so,
    // rather than every unrelated test silently exercising the failure path.
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
  };

  // `typeof chrome` covers the entire extension API; the double cast keeps the
  // mock to the handful of calls the code under test actually makes.
  globalThis.chrome = mock as unknown as typeof chrome;
  return mock;
}

/**
 * jsdom implements `input.files` but not `DataTransfer`, which is the only way
 * a browser extension can put a file into a file input. Without this, every
 * upload test would fail on the constructor rather than on the behaviour it is
 * testing — and the production code must keep using the real API, because that
 * is what works in Chrome.
 */
function installDataTransferPolyfill(): void {
  if (typeof globalThis.DataTransfer !== 'undefined') return;

  class FileListPolyfill extends Array<File> {
    item(index: number): File | null {
      return this[index] ?? null;
    }
  }

  class DataTransferPolyfill {
    readonly files: File[] = new FileListPolyfill();
    readonly items = {
      add: (file: File): void => {
        this.files.push(file);
      },
    };
  }

  globalThis.DataTransfer = DataTransferPolyfill as unknown as typeof DataTransfer;

  // jsdom's own `files` setter type-checks its argument against the real
  // `FileList` interface, which nothing outside jsdom can construct. Accepting
  // the polyfill here is what lets the *unmodified* production code — which
  // uses `DataTransfer` because that is what Chrome requires — be exercised.
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
  const assigned = new WeakMap<HTMLInputElement, File[]>();
  Object.defineProperty(HTMLInputElement.prototype, 'files', {
    configurable: true,
    get(this: HTMLInputElement): unknown {
      const override = assigned.get(this);
      if (override) return override;
      return native?.get?.call(this) ?? null;
    },
    set(this: HTMLInputElement, value: unknown) {
      if (Array.isArray(value)) {
        assigned.set(this, value as File[]);
        return;
      }
      // A page clearing the control (`input.value = ''`) must clear ours too,
      // otherwise a widget that drops the file would still verify.
      assigned.delete(this);
      native?.set?.call(this, value);
    },
  });

  const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', {
    configurable: true,
    get(this: HTMLInputElement): unknown {
      return nativeValue?.get?.call(this);
    },
    set(this: HTMLInputElement, value: unknown) {
      if (this.type === 'file' && value === '') assigned.delete(this);
      nativeValue?.set?.call(this, value);
    },
  });
}

beforeEach(() => {
  installChromeMock();
  installDataTransferPolyfill();
});
