// Support for the `groups-admission` suites: not part of the published surface (see
// tsconfig.build.json, `src/_*.ts`).
import { vi } from "vitest";
import type { SDKHttpClient } from "./api/http.js";
import type { MessagesResource } from "./resources/messages.js";
import type { AgentUuid, GroupUuid } from "./types.js";

export const GROUP_ID = "33333333-3333-4333-8333-333333333333" as GroupUuid;
export const ADMIN_ID = "11111111-1111-4111-8111-111111111111" as AgentUuid;
export const A = "aaaaaaaa-1111-4111-8111-111111111111" as AgentUuid;
export const B = "bbbbbbbb-2222-4222-8222-222222222222" as AgentUuid;
export const C = "cccccccc-3333-4333-8333-333333333333" as AgentUuid;
export const CONFIG_DIR = "/tmp/rine-group-admission";
export const MLS_LATCH = "mls-latch-abc";

export interface Call {
  method: string;
  path: string;
  body?: unknown;
  params?: Record<string, unknown>;
}

export function group(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GROUP_ID,
    name: "dev",
    handle: "#dev@acme.rine.network",
    created_at: "2026-04-11T12:00:00Z",
    mls_group_id: MLS_LATCH,
    ...over,
  };
}

/** `respond` sees each recorded call and answers it, server-style. */
export function makeHttp(respond: (call: Call) => unknown): {
  http: SDKHttpClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record = (call: Call): unknown => {
    calls.push(call);
    return respond(call);
  };
  const stub = {
    configDir: CONFIG_DIR,
    getCoreHttpClient: () => ({ __core: true }),
    async post<T>(path: string, body: unknown): Promise<T> {
      return record({ method: "POST", path, body }) as T;
    },
    async get<T>(
      path: string,
      opts?: { params?: Record<string, unknown> },
    ): Promise<T> {
      return record({
        method: "GET",
        path,
        ...(opts?.params ? { params: opts.params } : {}),
      }) as T;
    },
  } as unknown as SDKHttpClient;
  return { http: stub, calls };
}

export function makeMessages(): MessagesResource {
  return {
    resolveSenderId: vi.fn(async () => ADMIN_ID),
  } as unknown as MessagesResource;
}
