/**
 * A group's visibility must be stated.
 *
 * There was a `?? "private"` here, and it is the defect this file pins twice
 * over. `public` and `private` are different products — one lists the group at
 * dir.rine.network and turns the member-joined signal off, the other does
 * neither — so a default silently decided that for whoever ran the command, and
 * it decided it differently on different surfaces.
 *
 * **The compile-time half is the `@ts-expect-error` directives below.** A test
 * that passes cannot demonstrate a type error, so each one is the assertion: it
 * is `tsc` that fails, with "Unused '@ts-expect-error' directive", the moment
 * `visibility` becomes optional again. The runtime half is for a JavaScript
 * caller, who gets no compile step at all.
 */

import { describe, expect, it, vi } from "vitest";
import { GroupsResource } from "./groups.js";
import { VISIBILITY_REQUIRED_MESSAGE } from "./groups-create.js";

type SDKHttpClient = import("../api/http.js").SDKHttpClient;

function makeHttp(): { http: SDKHttpClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const stub = {
    configDir: null,
    async post<T>(_path: string, body: unknown): Promise<T> {
      bodies.push(body);
      return {
        id: "33333333-3333-4333-8333-333333333333",
        name: "dev",
        handle: "#dev@acme.rine.network",
        created_at: "2026-04-11T12:00:00Z",
      } as T;
    },
  } as unknown as SDKHttpClient;
  return { http: stub, bodies };
}

describe("GroupsResource.create — visibility is required", () => {
  it("omitting it is a compile error, in every call style", () => {
    const groups = new GroupsResource(makeHttp().http);
    const calls = [
      // @ts-expect-error the positional form needs the options bag.
      () => groups.create("dev"),
      // @ts-expect-error the options bag needs a visibility.
      () => groups.create("dev", { enrollment: "closed" }),
      // @ts-expect-error the same for the one-argument form.
      () => groups.create({ name: "dev" }),
    ];
    // The directives above are the assertion; this only keeps the calls from
    // being elided and proves each one is still a real call expression.
    expect(calls).toHaveLength(3);
  });

  it("a JavaScript caller is refused, and told what both choices mean", async () => {
    const { http, bodies } = makeHttp();
    const groups = new GroupsResource(http);

    const failure = await groups
      // @ts-expect-error the JS caller this refusal exists for.
      .create("dev")
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TypeError);
    const message = (failure as Error).message;
    // An agent reading the refusal can choose without reading docs.
    expect(message).toContain('"private"');
    expect(message).toContain('"public"');
    expect(message).toContain("dir.rine.network");
    expect(message).toContain("member-joined signal is off");
    expect(message).toBe(VISIBILITY_REQUIRED_MESSAGE);
    // And nothing reached the server — there is no default to send.
    expect(bodies).toHaveLength(0);
  });

  it("a stated visibility reaches the wire unchanged", async () => {
    const { http, bodies } = makeHttp();
    const groups = new GroupsResource(http);

    await groups.create("dev", { visibility: "public" });
    await groups.create({ name: "dev2", visibility: "private" });

    expect(bodies).toEqual([
      { name: "dev", visibility: "public" },
      { name: "dev2", visibility: "private" },
    ]);
  });

  it("an unknown value is refused rather than sent", async () => {
    const { http, bodies } = makeHttp();
    const groups = new GroupsResource(http);

    await expect(
      // @ts-expect-error only the two documented values exist.
      groups.create("dev", { visibility: "unlisted" }),
    ).rejects.toThrow(TypeError);
    expect(bodies).toHaveLength(0);
  });

  it("update() still treats visibility as optional — it is a patch", async () => {
    const patches: unknown[] = [];
    const http = {
      configDir: null,
      async patch<T>(_p: string, body: unknown): Promise<T> {
        patches.push(body);
        return {
          id: "33333333-3333-4333-8333-333333333333",
          name: "dev",
          handle: "#dev@acme.rine.network",
          created_at: "2026-04-11T12:00:00Z",
        } as T;
      },
    } as unknown as SDKHttpClient;
    const groups = new GroupsResource(http);

    await groups.update(
      "33333333-3333-4333-8333-333333333333" as import("../types.js").GroupUuid,
      { description: "just the description" },
    );

    expect(patches).toEqual([{ description: "just the description" }]);
  });
});

describe("GroupsResource.create — no hidden default survives", () => {
  it("never sends a visibility the caller did not choose", async () => {
    const { http, bodies } = makeHttp();
    const groups = new GroupsResource(http);
    const post = vi.spyOn(http, "post");

    await groups.create("dev", { visibility: "private" });

    expect(post).toHaveBeenCalledTimes(1);
    expect((bodies[0] as Record<string, unknown>)["visibility"]).toBe(
      "private",
    );
  });
});
