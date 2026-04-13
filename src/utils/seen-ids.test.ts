import { describe, expect, it } from "vitest";
import { SeenIds } from "./seen-ids.js";

describe("SeenIds", () => {
	it("returns true for a new id, false for a duplicate", () => {
		const seen = new SeenIds(10);
		expect(seen.record("a")).toBe(true);
		expect(seen.record("a")).toBe(false);
		expect(seen.record("b")).toBe(true);
		expect(seen.record("b")).toBe(false);
	});

	it("tracks size monotonically up to the capacity", () => {
		const seen = new SeenIds(3);
		seen.record("a");
		seen.record("b");
		seen.record("c");
		expect(seen.size).toBe(3);
	});

	it("evicts the oldest id FIFO once capacity is exceeded", () => {
		const seen = new SeenIds(3);
		seen.record("a");
		seen.record("b");
		seen.record("c");
		// `a` was the oldest — pushing `d` should evict it.
		seen.record("d");
		expect(seen.size).toBe(3);
		expect(seen.has("a")).toBe(false);
		expect(seen.has("b")).toBe(true);
		expect(seen.has("c")).toBe(true);
		expect(seen.has("d")).toBe(true);
	});

	it("allows a previously-evicted id to be recorded again", () => {
		const seen = new SeenIds(2);
		seen.record("a");
		seen.record("b");
		seen.record("c"); // evicts a
		// `a` is now gone — `record('a')` should return true again.
		expect(seen.record("a")).toBe(true);
	});

	it("re-inserting a still-present id does not disturb FIFO order", () => {
		const seen = new SeenIds(3);
		seen.record("a");
		seen.record("b");
		seen.record("c");
		// `a` is already in the queue — re-recording does nothing, so the
		// next insertion still evicts `a` (the oldest), not `b`.
		seen.record("a");
		seen.record("d");
		expect(seen.has("a")).toBe(false);
		expect(seen.has("b")).toBe(true);
		expect(seen.has("d")).toBe(true);
	});

	it("defaults to capacity 500", () => {
		const seen = new SeenIds();
		for (let i = 0; i < 500; i++) seen.record(`id-${i}`);
		expect(seen.size).toBe(500);
		expect(seen.has("id-0")).toBe(true);
		// Next insertion evicts id-0.
		seen.record("id-500");
		expect(seen.has("id-0")).toBe(false);
		expect(seen.size).toBe(500);
	});
});
