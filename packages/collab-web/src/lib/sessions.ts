/**
 * Multi-session layer over collab-web's single-room {@link GuestClient}.
 *
 * Every saved link owns one live GuestClient for as long as it stays in the
 * list — the selected session is just the one being rendered. Saved links
 * persist in localStorage, so reopening the app reconnects every session.
 *
 * Keeping rooms joined:
 * - In-flight drops are retried by CollabSocket itself (phase `reconnecting`).
 * - A client that reaches `ended` (welcome timeout, host bye, room closed,
 *   relay gave up) is replaced by a fresh client after a capped backoff, so a
 *   host that comes back on the same room is rejoined without user action.
 * - When the app returns to the foreground after a long background (mobile OS
 *   suspension can silently kill sockets) or the network comes back, each
 *   live room is probed end to end; only rooms that fail the probe rejoin, so
 *   healthy rooms skip re-downloading the full session snapshot.
 */

import { GuestClient } from "./client";
import { parseCollabLink } from "./link";

export interface SavedSession {
	id: string;
	/** Full collab link exactly as the user entered it (secret included). */
	link: string;
	/** Relay room id, the dedupe key: one live client per room. */
	roomId: string;
	/** User label; empty means "use the host's session title". */
	label: string;
	addedAt: number;
	/** Last session title the host reported; shown while a fresh client rejoins. */
	title?: string;
}

export interface SessionRecord {
	readonly saved: SavedSession;
	readonly client: GuestClient;
}

const STORAGE_KEY = "omp.collab.sessions.v1";
const SELECTED_KEY = "omp.collab.selected";
const NAME_KEY = "omp.collab.name";

const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 60_000;
/** Backgrounded longer than this, sockets that still look open may be dead and get probed. */
const STALE_AFTER_HIDDEN_MS = 15_000;
/**
 * Liveness probe: a fetch-transcript for an agent id no host registers. The
 * host answers it at once with a tiny targeted "no transcript available"
 * reply (relay → host → relay → this guest) and changes no state; no answer
 * within GuestClient's 10s transcript timeout means the connection is dead.
 */
const PROBE_AGENT_ID = "__collab_web_liveness_probe__";

interface LiveRecord {
	saved: SavedSession;
	client: GuestClient;
	unsubscribe: () => void;
	retryTimer: Timer | null;
	retryAttempt: number;
	/** A liveness probe is in flight (see #probeAll). */
	probing: boolean;
}

export class SessionStore {
	readonly #storage: Storage;
	readonly #listeners = new Set<() => void>();
	#records: LiveRecord[] = [];
	#published: readonly SessionRecord[] = [];
	#selectedId: string | null;
	#displayName: string;
	#hiddenAt: number | null = null;

	constructor(storage: Storage) {
		this.#storage = storage;
		this.#displayName = readString(storage, NAME_KEY) || "guest";
		this.#selectedId = readString(storage, SELECTED_KEY) || null;
		for (const saved of loadSaved(storage)) this.#records.push(this.#spawn(saved));
		if (!this.#records.some(r => r.saved.id === this.#selectedId)) {
			this.#selectedId = this.#records[0]?.saved.id ?? null;
		}
		this.#publish();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/** Stable reference between mutations, for useSyncExternalStore. */
	getRecords = (): readonly SessionRecord[] => this.#published;

	getSelectedId = (): string | null => this.#selectedId;

	get displayName(): string {
		return this.#displayName;
	}

	/**
	 * Adds a link, or replaces the link of the session already joined to the
	 * same room (e.g. upgrading view → control). Returns the session id.
	 * @throws Error when the link does not parse.
	 */
	add(link: string, label = ""): string {
		const trimmed = link.trim();
		const parsed = parseCollabLink(trimmed);
		if ("error" in parsed) throw new Error(parsed.error);
		const existing = this.#records.find(r => r.saved.roomId === parsed.roomId);
		if (existing) {
			this.#replace(existing, { ...existing.saved, link: trimmed, label: label || existing.saved.label });
			this.select(existing.saved.id);
			return existing.saved.id;
		}
		const saved: SavedSession = {
			id: crypto.randomUUID(),
			link: trimmed,
			roomId: parsed.roomId,
			label: label.trim(),
			addedAt: Date.now(),
		};
		this.#records.push(this.#spawn(saved));
		this.#selectedId = saved.id;
		this.#persist();
		this.#publish();
		return saved.id;
	}

	/**
	 * Points an existing entry at a new link (omp rotates the room on
	 * `/resume` and after a dropped room, which mints a new link).
	 * @throws Error when the link does not parse or its room is already another entry.
	 */
	updateLink(id: string, link: string): void {
		const record = this.#find(id);
		if (!record) return;
		const trimmed = link.trim();
		const parsed = parseCollabLink(trimmed);
		if ("error" in parsed) throw new Error(parsed.error);
		const clash = this.#records.find(r => r.saved.roomId === parsed.roomId && r !== record);
		if (clash) throw new Error("that room is already in the list");
		this.#replace(record, { ...record.saved, link: trimmed, roomId: parsed.roomId });
	}

	rename(id: string, label: string): void {
		const record = this.#find(id);
		if (!record) return;
		record.saved = { ...record.saved, label: label.trim() };
		this.#persist();
		this.#publish();
	}

	remove(id: string): void {
		const index = this.#records.findIndex(r => r.saved.id === id);
		if (index < 0) return;
		const [record] = this.#records.splice(index, 1);
		this.#dispose(record);
		if (this.#selectedId === id) {
			this.#selectedId = this.#records[Math.min(index, this.#records.length - 1)]?.saved.id ?? null;
		}
		this.#persist();
		this.#publish();
	}

	select(id: string | null): void {
		if (id !== null && !this.#find(id)) return;
		if (this.#selectedId === id) return;
		this.#selectedId = id;
		writeString(this.#storage, SELECTED_KEY, id ?? "");
		this.#publish();
	}

	/** Fresh client for one session (the "Rejoin" action). */
	restart(id: string): void {
		const record = this.#find(id);
		if (record) this.#replace(record, record.saved);
	}

	/** New display name applies to every room: each client re-joins with it. */
	setDisplayName(name: string): void {
		const next = name.trim() || "guest";
		if (next === this.#displayName) return;
		this.#displayName = next;
		writeString(this.#storage, NAME_KEY, next);
		// #replace swaps the entry in place (same index, same length), so iterating the live array is safe.
		for (const record of this.#records) this.#replace(record, record.saved);
	}

	/**
	 * Wires app-lifecycle signals: returning from a long background or
	 * regaining the network probes every room; a short trip only revives
	 * ended rooms. Returns the detach function.
	 */
	attachLifecycle(win: Window): () => void {
		const doc = win.document;
		const onVisibility = (): void => {
			if (doc.visibilityState === "hidden") {
				this.#hiddenAt = Date.now();
				return;
			}
			const hiddenFor = this.#hiddenAt === null ? 0 : Date.now() - this.#hiddenAt;
			this.#hiddenAt = null;
			if (hiddenFor >= STALE_AFTER_HIDDEN_MS) this.#probeAll();
			else this.#reviveEnded();
		};
		const onOnline = (): void => this.#probeAll();
		doc.addEventListener("visibilitychange", onVisibility);
		win.addEventListener("online", onOnline);
		return () => {
			doc.removeEventListener("visibilitychange", onVisibility);
			win.removeEventListener("online", onOnline);
		};
	}

	/** Closes every client; the store is unusable afterwards. */
	dispose(): void {
		for (const record of this.#records) this.#dispose(record);
		this.#records = [];
		this.#listeners.clear();
	}

	#find(id: string): LiveRecord | undefined {
		return this.#records.find(r => r.saved.id === id);
	}

	#spawn(saved: SavedSession): LiveRecord {
		const client = new GuestClient(saved.link, this.#displayName);
		const record: LiveRecord = {
			saved,
			client,
			unsubscribe: () => {},
			retryTimer: null,
			retryAttempt: 0,
			probing: false,
		};
		record.unsubscribe = client.subscribe(() => this.#onClientChange(record));
		client.connect();
		return record;
	}

	#replace(record: LiveRecord, saved: SavedSession): void {
		const index = this.#records.indexOf(record);
		if (index < 0) return;
		this.#dispose(record);
		const next = this.#spawn(saved);
		next.retryAttempt = record.retryAttempt;
		this.#records[index] = next;
		this.#persist();
		this.#publish();
	}

	#dispose(record: LiveRecord): void {
		clearTimeout(record.retryTimer ?? undefined);
		record.retryTimer = null;
		record.unsubscribe();
		record.client.close();
	}

	#onClientChange(record: LiveRecord): void {
		const snap = record.client.getSnapshot();
		const title = snap.header?.title ?? snap.state?.sessionName;
		if (title && title !== record.saved.title) {
			record.saved = { ...record.saved, title };
			this.#persist();
			this.#publish();
		}
		const phase = snap.phase;
		if (phase === "live") {
			record.retryAttempt = 0;
			return;
		}
		if (phase !== "ended" || record.retryTimer !== null) return;
		const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** record.retryAttempt);
		record.retryAttempt++;
		record.retryTimer = setTimeout(() => {
			record.retryTimer = null;
			if (this.#records.includes(record)) this.#replace(record, record.saved);
		}, delay);
	}

	/** Ended rooms rejoin now; live rooms rejoin only if the probe gets no answer. Rooms mid-(re)connect are left alone. */
	#probeAll(): void {
		this.#reviveEnded();
		for (const record of this.#records) {
			if (record.probing || record.client.getSnapshot().phase !== "live") continue;
			record.probing = true;
			const client = record.client;
			void client.fetchTranscript(PROBE_AGENT_ID, 0).then(answer => {
				record.probing = false;
				// Answered, removed/replaced meanwhile, or the client already noticed the drop itself.
				if (answer !== null || !this.#records.includes(record)) return;
				if (client.getSnapshot().phase !== "live") return;
				record.retryAttempt = 0;
				this.#replace(record, record.saved);
			});
		}
	}

	#reviveEnded(): void {
		for (const record of this.#records) {
			if (record.client.getSnapshot().phase !== "ended") continue;
			record.retryAttempt = 0;
			this.#replace(record, record.saved);
		}
	}

	#persist(): void {
		const saved = this.#records.map(r => r.saved);
		try {
			this.#storage.setItem(STORAGE_KEY, JSON.stringify(saved));
		} catch {
			// storage unavailable (private mode / quota) — sessions stay in memory
		}
		writeString(this.#storage, SELECTED_KEY, this.#selectedId ?? "");
	}

	#publish(): void {
		this.#published = this.#records.map(r => ({ saved: r.saved, client: r.client }));
		for (const listener of this.#listeners) listener();
	}
}

function loadSaved(storage: Storage): SavedSession[] {
	const raw = readString(storage, STORAGE_KEY);
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: SavedSession[] = [];
	const rooms = new Set<string>();
	for (const item of parsed) {
		if (!isSavedSession(item) || rooms.has(item.roomId)) continue;
		if ("error" in parseCollabLink(item.link)) continue;
		rooms.add(item.roomId);
		out.push(item);
	}
	return out;
}

function isSavedSession(value: unknown): value is SavedSession {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.id === "string" &&
		typeof v.link === "string" &&
		typeof v.roomId === "string" &&
		typeof v.label === "string" &&
		typeof v.addedAt === "number"
	);
}

function readString(storage: Storage, key: string): string {
	try {
		return storage.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function writeString(storage: Storage, key: string, value: string): void {
	try {
		storage.setItem(key, value);
	} catch {
		// storage unavailable — non-fatal
	}
}
