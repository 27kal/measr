/// <reference types="vite/client" />

declare const Deno: { env: { get(name: string): string | undefined } };
