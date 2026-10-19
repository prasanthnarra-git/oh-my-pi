import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AgentDrawer } from "./components/agents/AgentDrawer";
import { AgentsPanel } from "./components/agents/AgentsPanel";
import { SessionList } from "./components/sessions/SessionList";
import { Banners } from "./components/shell/Banners";
import { Composer } from "./components/shell/Composer";
import { ConnectScreen } from "./components/shell/ConnectScreen";
import { HeaderBar } from "./components/shell/HeaderBar";
import { Toasts } from "./components/shell/Toasts";
import { Transcript } from "./components/transcript/Transcript";
import type { GuestClient } from "./lib/client";
import { SessionStore } from "./lib/sessions";
import { useGuestSnapshot } from "./lib/use-guest";
import type { ToolRenderHost } from "./tool-render";
import "./components/shell/shell.css";

/**
 * Deep link = everything after the FIRST `#` (legacy links carry a second `#` inside the fragment).
 * The fragment is cleared once read so the room secret does not linger in the address bar or history.
 */
function takeHashLink(): string | null {
	const href = window.location.href;
	const i = href.indexOf("#");
	if (i < 0 || i + 1 >= href.length) return null;
	history.replaceState(null, "", window.location.pathname + window.location.search);
	return href.slice(i + 1);
}

export function App(): ReactNode {
	const [store] = useState(() => new SessionStore(localStorage));
	const records = useSyncExternalStore(store.subscribe, store.getRecords);
	const selectedId = useSyncExternalStore(store.subscribe, store.getSelectedId);
	const [listOpen, setListOpen] = useState(false);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);

	useEffect(() => store.attachLifecycle(window), [store]);

	// Deep link (my.omp.sh-style `#<link>`), on load and while open: adds the room to the list.
	useEffect(() => {
		const intake = (): void => {
			const link = takeHashLink();
			if (!link) return;
			try {
				store.add(link);
				setConnectError(null);
			} catch (err) {
				setConnectError(err instanceof Error ? err.message : String(err));
			}
		};
		intake();
		window.addEventListener("hashchange", intake);
		return () => window.removeEventListener("hashchange", intake);
	}, [store]);

	// Visual Viewport: adjust app height to fit screen space when mobile keyboard opens.
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;

		const updateHeight = () => {
			document.documentElement.style.setProperty("--viewport-height", `${vv.height}px`);
			window.scrollTo(0, 0);
		};

		updateHeight();
		vv.addEventListener("resize", updateHeight);
		vv.addEventListener("scroll", updateHeight);

		return () => {
			vv.removeEventListener("resize", updateHeight);
			vv.removeEventListener("scroll", updateHeight);
		};
	}, []);

	const select = useCallback(
		(id: string): void => {
			store.select(id);
			setListOpen(false);
		},
		[store],
	);
	const showSessions = useCallback(() => setListOpen(true), []);

	const selected = records.find(r => r.saved.id === selectedId) ?? null;

	useEffect(() => {
		if (!selected) document.title = "omp collab";
	}, [selected]);

	if (records.length === 0) {
		return (
			<ConnectScreen
				defaultName={store.displayName}
				error={connectError}
				onConnect={(link, name) => {
					try {
						store.setDisplayName(name);
						store.add(link);
						setConnectError(null);
					} catch (err) {
						setConnectError(err instanceof Error ? err.message : String(err));
					}
				}}
			/>
		);
	}

	const listState = selected === null ? "page" : listOpen ? "open" : "closed";
	return (
		<div className="ms-root" data-list={listState}>
			<aside className="ms-sidebar">
				<SessionList
					store={store}
					records={records}
					selectedId={selectedId}
					editingId={editingId}
					onEditingChange={setEditingId}
					onSelect={select}
				/>
			</aside>
			<div className="ms-backdrop" onClick={() => setListOpen(false)} />
			<div className="ms-content">
				{selected ? (
					<Session
						key={selected.saved.id}
						client={selected.client}
						onShowSessions={showSessions}
						onRejoin={() => store.restart(selected.saved.id)}
						onNewLink={() => {
							setEditingId(selected.saved.id);
							setListOpen(true);
						}}
					/>
				) : (
					<div className="ms-placeholder">Select a session</div>
				)}
			</div>
		</div>
	);
}

interface SessionProps {
	client: GuestClient;
	onShowSessions(): void;
	onRejoin(): void;
	onNewLink(): void;
}

function Session({ client, onShowSessions, onRejoin, onNewLink }: SessionProps): ReactNode {
	const snap = useGuestSnapshot(client);
	const [railOpen, setRailOpen] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const autoOpenedRef = useRef(false);

	const subCount = useMemo(() => snap.agents.filter(a => a.kind === "sub").length, [snap.agents]);

	// Task-card agent chips drill into the same drawer the rail uses.
	const agentIds = useMemo(() => new Set(snap.agents.map(a => a.id)), [snap.agents]);
	const toolHost = useMemo<ToolRenderHost>(
		() => ({
			hasAgent: id => agentIds.has(id),
			openAgent: id => {
				if (agentIds.has(id)) setSelectedId(id);
			},
		}),
		[agentIds],
	);

	// Auto-open the rail the first time a subagent appears.
	useEffect(() => {
		if (subCount > 0 && !autoOpenedRef.current) {
			autoOpenedRef.current = true;
			setRailOpen(true);
		}
	}, [subCount]);

	const title = snap.header?.title ?? snap.state?.sessionName ?? "session";
	useEffect(() => {
		document.title = `${title} · omp collab`;
	}, [title]);

	const drawerAgent = selectedId != null ? snap.agents.find(a => a.id === selectedId) : undefined;
	const toggleRail = useCallback(() => setRailOpen(open => !open), []);
	const closeDrawer = useCallback(() => setSelectedId(null), []);

	return (
		<div className="sh-app">
			<div className="sh-ambient" />
			<HeaderBar
				header={snap.header}
				state={snap.state}
				phase={snap.phase}
				readOnly={snap.readOnly}
				subCount={subCount}
				railOpen={railOpen}
				onToggleRail={toggleRail}
				onShowSessions={onShowSessions}
			/>
			<main className="sh-main">
				<section className="sh-panel" data-rail={railOpen ? "true" : "false"}>
					<div className="sh-transcript">
						<Transcript
							entries={snap.entries}
							stream={snap.stream}
							streamDone={snap.streamDone}
							activeTools={snap.activeTools}
							working={snap.working}
							host={toolHost}
							phase={snap.phase}
						/>
					</div>
					<Composer
						client={client}
						phase={snap.phase}
						readOnly={snap.readOnly}
						uiRequest={snap.uiRequest}
						working={snap.working}
						queuedMessageCount={snap.state?.queuedMessageCount ?? 0}
					/>
				</section>
				{railOpen && (
					<>
						<div className="sh-rail-backdrop" onClick={() => setRailOpen(false)} />
						<aside className="sh-rail">
							<AgentsPanel
								agents={snap.agents}
								progress={snap.progress}
								lifecycle={snap.lifecycle}
								selectedId={selectedId}
								onSelect={setSelectedId}
							/>
						</aside>
					</>
				)}
			</main>
			{drawerAgent && (
				<>
					<div className="ag-drawer-backdrop" onClick={closeDrawer} />
					<AgentDrawer
						agent={drawerAgent}
						progress={snap.progress.get(drawerAgent.id)}
						lifecycle={snap.lifecycle.get(drawerAgent.id)}
						client={client}
						readOnly={snap.readOnly}
						host={toolHost}
						onClose={closeDrawer}
					/>
				</>
			)}
			<Banners
				phase={snap.phase}
				endedReason={snap.endedReason}
				loading={snap.loading}
				onRejoin={onRejoin}
				onNewLink={onNewLink}
			/>
			<Toasts notices={snap.notices} />
		</div>
	);
}
