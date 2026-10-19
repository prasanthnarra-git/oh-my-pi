import { Check, Link2, Pencil, Plus, Trash2, X } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { memo, useState } from "react";
import { shortenPath } from "../../lib/format";
import type { SessionRecord, SessionStore } from "../../lib/sessions";
import { useGuestSnapshot } from "../../lib/use-guest";
import { OmpMark } from "../shell/OmpMark";
import { ThemeToggle } from "../shell/ThemeToggle";
import "./sessions.css";

export interface SessionListProps {
	store: SessionStore;
	records: readonly SessionRecord[];
	selectedId: string | null;
	/** Session whose link editor should open (set by the "New link" banner action). */
	editingId: string | null;
	onEditingChange(id: string | null): void;
	onSelect(id: string): void;
}

export function SessionList({
	store,
	records,
	selectedId,
	editingId,
	onEditingChange,
	onSelect,
}: SessionListProps): ReactNode {
	const [adding, setAdding] = useState(records.length === 0);

	return (
		<nav className="ms-list" aria-label="sessions">
			<div className="ms-list-head">
				<span className="sh-brand" aria-label="omp collab">
					<OmpMark />
					<span>omp</span>
					<span className="sh-brand-slash">/</span>
					<span className="sh-brand-app">collab</span>
				</span>
				<div className="ms-list-head-actions">
					<ThemeToggle />
					<button
						type="button"
						className={adding ? "sh-btn sh-btn-icon sh-btn-on" : "sh-btn sh-btn-icon"}
						onClick={() => setAdding(open => !open)}
						title="add session"
						aria-label="add session"
					>
						<Plus size={14} />
					</button>
				</div>
			</div>
			{adding && (
				<AddSessionForm
					store={store}
					onDone={id => {
						setAdding(false);
						onSelect(id);
					}}
				/>
			)}
			<ul className="ms-items">
				{records.map(record => (
					<SessionItem
						key={record.saved.id}
						store={store}
						record={record}
						selected={record.saved.id === selectedId}
						editing={record.saved.id === editingId}
						onEditingChange={onEditingChange}
						onSelect={onSelect}
					/>
				))}
			</ul>
			{records.length === 0 && !adding && (
				<p className="ms-empty">No sessions yet. Tap + and paste a /collab link.</p>
			)}
			<DisplayNameField store={store} />
		</nav>
	);
}

interface AddSessionFormProps {
	store: SessionStore;
	onDone(id: string): void;
}

function AddSessionForm({ store, onDone }: AddSessionFormProps): ReactNode {
	const [link, setLink] = useState("");
	const [label, setLabel] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		if (!link.trim()) {
			setError("Paste a join link first.");
			return;
		}
		try {
			onDone(store.add(link, label));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<form className="ms-add" onSubmit={submit}>
			<input
				className="sh-input sh-input-mono"
				type="text"
				value={link}
				onChange={e => setLink(e.target.value)}
				placeholder="my.omp.sh/#room.key"
				spellCheck={false}
				autoComplete="off"
				autoCapitalize="off"
				aria-label="join link"
			/>
			<input
				className="sh-input"
				type="text"
				value={label}
				onChange={e => setLabel(e.target.value)}
				placeholder="label (optional)"
				spellCheck={false}
				autoComplete="off"
				maxLength={60}
				aria-label="label"
			/>
			{error && <div className="sh-connect-error">{error}</div>}
			<button className="sh-btn sh-btn-primary" type="submit">
				<Plus size={14} /> Add &amp; connect
			</button>
		</form>
	);
}

interface SessionItemProps {
	store: SessionStore;
	record: SessionRecord;
	selected: boolean;
	editing: boolean;
	onEditingChange(id: string | null): void;
	onSelect(id: string): void;
}

/** Subscribes to its own client, so a streaming session re-renders only its row. */
const SessionItem = memo(function SessionItem({
	store,
	record,
	selected,
	editing,
	onEditingChange,
	onSelect,
}: SessionItemProps): ReactNode {
	const snap = useGuestSnapshot(record.client);
	const { saved } = record;
	const title =
		saved.label || snap.header?.title || snap.state?.sessionName || saved.title || `room ${saved.roomId.slice(0, 6)}`;
	const cwd = snap.state?.cwd;

	if (editing) {
		return (
			<li className="ms-item ms-item-editing">
				<EditSessionForm store={store} record={record} onClose={() => onEditingChange(null)} />
			</li>
		);
	}

	return (
		<li className={selected ? "ms-item ms-item-selected" : "ms-item"}>
			<button type="button" className="ms-item-main" onClick={() => onSelect(saved.id)}>
				<span className={`sh-dot sh-dot-${snap.phase}`} title={`connection: ${snap.phase}`} />
				<span className="ms-item-text">
					<span className="ms-item-title">{title}</span>
					<span className="ms-item-meta">
						{snap.phase === "ended" ? (snap.endedReason ?? "ended") : cwd ? shortenPath(cwd) : snap.phase}
					</span>
				</span>
				<span className="ms-item-badges">
					{snap.uiRequest && !snap.readOnly && <span className="ms-badge ms-badge-input">input</span>}
					{snap.working && <span className="ms-badge ms-badge-working">working</span>}
					{snap.readOnly && <span className="ms-badge">view</span>}
				</span>
			</button>
			<button
				type="button"
				className="sh-btn sh-btn-icon ms-item-edit"
				onClick={() => onEditingChange(saved.id)}
				title="edit"
				aria-label={`edit ${title}`}
			>
				<Pencil size={13} />
			</button>
		</li>
	);
});

interface EditSessionFormProps {
	store: SessionStore;
	record: SessionRecord;
	onClose(): void;
}

function EditSessionForm({ store, record, onClose }: EditSessionFormProps): ReactNode {
	const [label, setLabel] = useState(record.saved.label);
	const [link, setLink] = useState("");
	const [error, setError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		try {
			if (link.trim()) store.updateLink(record.saved.id, link);
			store.rename(record.saved.id, label);
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const remove = (): void => {
		if (window.confirm("Remove this session from the list? The host session keeps running.")) {
			store.remove(record.saved.id);
			onClose();
		}
	};

	return (
		<form className="ms-add" onSubmit={submit}>
			<input
				className="sh-input"
				type="text"
				value={label}
				onChange={e => setLabel(e.target.value)}
				placeholder="label (empty: session title)"
				spellCheck={false}
				autoComplete="off"
				maxLength={60}
				aria-label="label"
				autoFocus
			/>
			<label className="ms-link-field">
				<Link2 size={13} />
				<input
					className="sh-input sh-input-mono"
					type="text"
					value={link}
					onChange={e => setLink(e.target.value)}
					placeholder="new link (after /resume or a dropped room)"
					spellCheck={false}
					autoComplete="off"
					autoCapitalize="off"
					aria-label="new join link"
				/>
			</label>
			{error && <div className="sh-connect-error">{error}</div>}
			<div className="ms-edit-actions">
				<button type="button" className="sh-btn ms-danger" onClick={remove}>
					<Trash2 size={13} /> Remove
				</button>
				<span className="ms-spacer" />
				<button type="button" className="sh-btn sh-btn-icon" onClick={onClose} title="cancel" aria-label="cancel">
					<X size={14} />
				</button>
				<button type="submit" className="sh-btn sh-btn-primary sh-btn-icon" title="save" aria-label="save">
					<Check size={14} />
				</button>
			</div>
		</form>
	);
}

function DisplayNameField({ store }: { store: SessionStore }): ReactNode {
	const [name, setName] = useState(store.displayName);
	return (
		<label className="ms-name">
			<span className="sh-field-label">Display name</span>
			<input
				className="sh-input"
				type="text"
				value={name}
				onChange={e => setName(e.target.value)}
				onBlur={() => store.setDisplayName(name)}
				onKeyDown={e => {
					if (e.key === "Enter") e.currentTarget.blur();
				}}
				placeholder="guest"
				spellCheck={false}
				autoComplete="off"
				maxLength={32}
			/>
		</label>
	);
}
