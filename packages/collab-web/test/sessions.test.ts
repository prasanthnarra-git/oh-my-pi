import { afterEach, describe, expect, it } from "bun:test";
import { formatCollabLink } from "../src/lib/link";
import { SessionStore } from "../src/lib/sessions";

/** Nothing listens here: clients stay in connecting/reconnecting, which these tests never wait on. */
const RELAY = "ws://127.0.0.1:9";

class MemoryStorage implements Storage {
	readonly #items = new Map<string, string>();
	get length(): number {
		return this.#items.size;
	}
	clear(): void {
		this.#items.clear();
	}
	getItem(key: string): string | null {
		return this.#items.get(key) ?? null;
	}
	key(index: number): string | null {
		return [...this.#items.keys()][index] ?? null;
	}
	removeItem(key: string): void {
		this.#items.delete(key);
	}
	setItem(key: string, value: string): void {
		this.#items.set(key, value);
	}
}

function link(roomId: string, writeToken = false): string {
	const key = new Uint8Array(32).fill(roomId.length);
	return formatCollabLink(RELAY, roomId, key, writeToken ? new Uint8Array(16).fill(7) : undefined);
}

const stores: SessionStore[] = [];
function open(storage: Storage): SessionStore {
	const store = new SessionStore(storage);
	stores.push(store);
	return store;
}

afterEach(() => {
	for (const store of stores.splice(0)) store.dispose();
});

describe("SessionStore", () => {
	it("keeps one session per room: re-adding a room replaces its link instead of adding a row", () => {
		const store = open(new MemoryStorage());
		const id = store.add(link("RoomAAAAAAAAAAAA"));
		const again = store.add(link("RoomAAAAAAAAAAAA", true), "upgraded");

		expect(again).toBe(id);
		expect(store.getRecords()).toHaveLength(1);
		expect(store.getRecords()[0]!.saved.link).toBe(link("RoomAAAAAAAAAAAA", true));
		expect(store.getRecords()[0]!.saved.label).toBe("upgraded");
	});

	it("restores saved sessions and the selection after a reload, and forgets removed ones", () => {
		const storage = new MemoryStorage();
		const first = open(storage);
		const a = first.add(link("RoomAAAAAAAAAAAA"));
		const b = first.add(link("RoomBBBBBBBBBBBB"));
		const c = first.add(link("RoomCCCCCCCCCCCC"));
		first.select(a);
		first.remove(b);
		first.dispose();

		const reloaded = open(storage);
		expect(reloaded.getRecords().map(r => r.saved.id)).toEqual([a, c]);
		expect(reloaded.getSelectedId()).toBe(a);
	});

	it("selects the neighbour when the selected session is removed, and nothing once the list is empty", () => {
		const store = open(new MemoryStorage());
		const a = store.add(link("RoomAAAAAAAAAAAA"));
		const b = store.add(link("RoomBBBBBBBBBBBB"));
		const c = store.add(link("RoomCCCCCCCCCCCC"));
		store.select(b);

		store.remove(b);
		expect(store.getSelectedId()).toBe(c);
		store.remove(c);
		expect(store.getSelectedId()).toBe(a);
		store.remove(a);
		expect(store.getSelectedId()).toBeNull();
	});

	it("rejects unparseable links and moving a session onto a room another session already holds", () => {
		const store = open(new MemoryStorage());
		expect(() => store.add("not a collab link")).toThrow();
		const a = store.add(link("RoomAAAAAAAAAAAA"));
		store.add(link("RoomBBBBBBBBBBBB"));

		expect(() => store.updateLink(a, link("RoomBBBBBBBBBBBB"))).toThrow("already in the list");
		expect(store.getRecords().map(r => r.saved.roomId)).toEqual(["RoomAAAAAAAAAAAA", "RoomBBBBBBBBBBBB"]);
	});

	it("drops corrupt or duplicate entries from storage instead of failing to load", () => {
		const storage = new MemoryStorage();
		const good = { id: "g", link: link("RoomAAAAAAAAAAAA"), roomId: "RoomAAAAAAAAAAAA", label: "", addedAt: 1 };
		storage.setItem(
			"omp.collab.sessions.v1",
			JSON.stringify([
				good,
				{ ...good, id: "dup" },
				{ id: "bad" },
				{ ...good, id: "x", link: "nope", roomId: "R2" },
			]),
		);

		const store = open(storage);
		expect(store.getRecords().map(r => r.saved.id)).toEqual(["g"]);
	});
});
