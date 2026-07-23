import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SDKHttpClient } from "./http.js";

/**
 * Regression coverage for the config-dir precedence bug: a no-arg client used
 * to hard-code `configDir = ""` in the constructor, ignoring RINE_CONFIG_DIR
 * and the documented precedence. It must now lazily fall back to rine-core's
 * `resolveConfigDir()` at credential-load time (Python-SDK parity).
 */

const ENV_KEY = "RINE_CONFIG_DIR";
const API_ENV_KEY = "RINE_API_URL";
/** rine-core's DEFAULT_API_URL — the correct no-env fallback. */
const DEFAULT_API_URL = "https://rine.network";

let tmpConfig: string;
let prevEnv: string | undefined;
let prevApiEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env[ENV_KEY];
  prevApiEnv = process.env[API_ENV_KEY];
  tmpConfig = fs.mkdtempSync(join(tmpdir(), "rine-sdk-configdir-"));
  fs.writeFileSync(
    join(tmpConfig, "credentials.json"),
    JSON.stringify({ default: { client_id: "id", client_secret: "sec" } }),
  );
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prevEnv;
  if (prevApiEnv === undefined) delete process.env[API_ENV_KEY];
  else process.env[API_ENV_KEY] = prevApiEnv;
  fs.rmSync(tmpConfig, { recursive: true, force: true });
});

describe("SDKHttpClient config-dir resolution", () => {
  it("honors RINE_CONFIG_DIR when no configDir is passed", () => {
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient();
    expect(client.configDir).toBe(tmpConfig);
  });

  it("prefers an explicit configDir over RINE_CONFIG_DIR", () => {
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient({ configDir: "/explicit/dir" });
    expect(client.configDir).toBe("/explicit/dir");
  });

  it("uses an explicit empty-string configDir verbatim (no auto-resolution)", () => {
    // An explicitly-passed "" is a caller choice and must be honored as-is,
    // distinct from the "no argument" case that triggers auto-resolution.
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient({ configDir: "" });
    expect(client.configDir).toBe("");
  });

  it("memoizes the resolved dir across repeated reads", () => {
    process.env[ENV_KEY] = tmpConfig;
    const client = new SDKHttpClient();
    const first = client.configDir;
    // Mutating the env after the first resolution must not change the answer —
    // resolution happens once, matching the Python SDK's construct-time resolve.
    process.env[ENV_KEY] = "/changed/after/resolve";
    expect(client.configDir).toBe(first);
  });
});

describe("SDKHttpClient apiUrl resolution", () => {
  it("resolves apiUrl from RINE_API_URL when none is passed", () => {
    process.env[API_ENV_KEY] = "http://localhost:7001";
    const client = new SDKHttpClient();
    expect(client.apiUrl).toBe("http://localhost:7001");
  });

  it("falls back to core DEFAULT_API_URL (rine.network), not api.rine.network", () => {
    delete process.env[API_ENV_KEY];
    const client = new SDKHttpClient();
    expect(client.apiUrl).toBe(DEFAULT_API_URL);
    expect(client.apiUrl).not.toContain("api.rine.network");
  });

  it("prefers an explicit apiUrl over RINE_API_URL", () => {
    process.env[API_ENV_KEY] = "http://localhost:7001";
    const client = new SDKHttpClient({ apiUrl: "https://explicit.example" });
    expect(client.apiUrl).toBe("https://explicit.example");
  });
});
