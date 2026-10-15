import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Plus, Trash2, Upload } from 'lucide-react';
import { api, json, patchJson } from './api';
import { parseParticipantCsv, type ParticipantCsvRow } from './participant-csv';

type Participant = {
  id: string;
  name: string;
  rollNo?: string | null;
  role: string;
  department: string;
  batch: string;
  contribution: string;
  attendance: string;
  sourceKey?: string;
};

const emptyParticipant: Omit<Participant, 'id'> = { name: '', rollNo: '', role: '', department: '', batch: '', contribution: '', attendance: 'present' };
const participantPageSize = 20;

type ParticipantPage = {
  items: Participant[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export function ParticipantManagerPage() {
  const { id } = useParams();
  const [items, setItems] = useState<Participant[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [eventTitle, setEventTitle] = useState('Event participants');
  const [form, setForm] = useState(emptyParticipant);
  const [editing, setEditing] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = useCallback(async (requestedPage = page) => {
    if (!id) return;
    try {
      const [participants, events] = await Promise.all([
        api<ParticipantPage>(`/admin/events/${id}/participants?page=${requestedPage}&pageSize=${participantPageSize}`),
        api<{ items: Array<{ id: string; title: string }> }>('/admin/events?pageSize=100'),
      ]);
      setItems(participants.items);
      setPage(participants.page);
      setTotal(participants.total);
      setTotalPages(Math.max(1, participants.totalPages));
      setEventTitle(events.items.find((event) => event.id === id)?.title || 'Event participants');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load participants.'); }
  }, [id, page]);

  useEffect(() => { void load(page); }, [load, page]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!id) return;
    setError('');
    try {
      if (editing) await api(`/admin/events/${id}/participants/${editing}`, patchJson(form));
      else await api(`/admin/events/${id}/participants`, json(form));
      setForm(emptyParticipant);
      setEditing(null);
      setSaved(editing ? 'Participant updated.' : 'Participant added.');
      void load(page);
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save participant.'); }
  };

  const remove = async (participant: Participant) => {
    if (!id || !window.confirm(`Remove ${participant.name} from this event?`)) return;
    try { await api(`/admin/events/${id}/participants/${participant.id}`, { method: 'DELETE' }); void load(page); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to remove participant.'); }
  };

  const importRows = async () => {
    if (!id || !importText.trim()) return;
    setError('');
    let parsed: ParticipantCsvRow[];
    try { parsed = parseParticipantCsv(importText); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to parse CSV.'); return; }
    try { await api(`/admin/events/${id}/participants/import`, json({ rows: parsed })); setImportText(''); setSaved(`${parsed.length} participant rows imported.`); void load(page); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to import participants.'); }
  };

  if (!id) return <div className="notice notice-danger">Event id is missing.</div>;
  return <div className="page-stack">
    <Link className="back-link" to="/admin/events"><ArrowLeft size={15} /> Back to event manager</Link>
    <div className="section-header"><div><span className="eyebrow">Content / participants</span><h2>{eventTitle}</h2><p>{total} participant records. Import and export are idempotent by source key.</p></div><a className="button button-secondary" href={`/api/v1/admin/events/${id}/participants.csv`}><Download size={16} /> Export CSV</a></div>
    {error ? <div className="notice notice-danger">{error}</div> : null}{saved ? <div className="notice notice-success">{saved}</div> : null}
    <form className="panel editor-form" onSubmit={(event) => void save(event)}><div className="panel-heading"><div><span className="eyebrow">{editing ? 'Edit record' : 'Add record'}</span><h3>Participant details</h3></div></div><div className="form-grid">
      <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label><label>Roll number<input value={form.rollNo || ''} onChange={(e) => setForm({ ...form, rollNo: e.target.value })} /></label><label>Role<input value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} /></label><label>Department<input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label><label>Batch<input value={form.batch} onChange={(e) => setForm({ ...form, batch: e.target.value })} /></label><label>Attendance<input value={form.attendance} onChange={(e) => setForm({ ...form, attendance: e.target.value })} /></label><label>Contribution<textarea rows={2} value={form.contribution} onChange={(e) => setForm({ ...form, contribution: e.target.value })} /></label>
    </div><div className="row-actions"><button className="button button-primary"><Plus size={16} /> {editing ? 'Save changes' : 'Add participant'}</button>{editing ? <button type="button" className="button button-secondary" onClick={() => { setEditing(null); setForm(emptyParticipant); }}>Cancel</button> : null}</div></form>
    <div className="panel editor-form"><div className="panel-heading"><div><span className="eyebrow">Bulk import</span><h3>CSV rows</h3></div><Upload size={17} /></div><p className="form-note">Use all seven headers: Name, Roll No, Role, Department, Batch, Contribution, Attendance. Quoted commas, line breaks, and quotes are supported. Re-importing the same name, roll number, and role updates that record.</p><textarea rows={5} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'Name,Roll No,Role,Department,Batch,Contribution,Attendance\n"Ada, Jr.",42,Lead,"Computer Science",2026,"Welcome\naddress",present'} /><button type="button" className="button button-secondary" onClick={() => void importRows()}>Import rows</button></div>
     <div className="panel table-panel"><div className="data-table"><div className="table-row table-head"><span>Name</span><span>Role / department</span><span>Batch</span><span>Actions</span></div>{items.map((participant) => <div className="table-row" key={participant.id}><div className="row-title"><strong>{participant.name}</strong><small>{participant.rollNo || 'No roll number'}</small></div><span>{participant.role || '—'} · {participant.department || '—'}</span><span>{participant.batch || '—'}</span><div className="row-actions"><button className="text-button" onClick={() => { setEditing(participant.id); setForm({ name: participant.name, rollNo: participant.rollNo || '', role: participant.role, department: participant.department, batch: participant.batch, contribution: participant.contribution, attendance: participant.attendance }); }}>Edit</button><button className="text-button muted" onClick={() => void remove(participant)}><Trash2 size={14} /> Remove</button></div></div>)}{!items.length ? <div className="empty-state">No participant records yet.</div> : null}</div><div className="pagination-controls" aria-label="Participant pagination"><button type="button" className="button button-secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</button><span>Page {page} of {totalPages} · {total} total</span><button type="button" className="button button-secondary" disabled={page >= totalPages} onClick={() => setPage((current) => current + 1)}>Next</button></div></div>
  </div>;
}

type MediaItem = { id: string; originalName: string; url?: string | null; altText: string; caption: string; usageCount: number; status: string };

export function MediaLibraryPage() {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploadDraft, setUploadDraft] = useState({ altText: '', caption: '' });
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ altText: '', caption: '' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const load = () => void api<{ items: MediaItem[] }>('/admin/media?pageSize=100').then((result) => setItems(result.items)).catch((e: Error) => setError(e.message));
  useEffect(load, []);
  const upload = async (event: FormEvent) => { event.preventDefault(); if (!file) return; const body = new FormData(); body.append('file', file); body.append('altText', uploadDraft.altText); body.append('caption', uploadDraft.caption); try { await api('/admin/media', { method: 'POST', body }); setFile(null); setUploadDraft({ altText: '', caption: '' }); setSaved('Media uploaded.'); load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to upload media.'); } };
  const save = async (id: string) => { try { await api(`/admin/media/${id}`, patchJson(draft)); setEditing(null); setSaved('Media metadata saved.'); load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save media metadata.'); } };
  const remove = async (item: MediaItem) => { if (item.usageCount || !window.confirm(`Remove ${item.originalName} from the library?`)) return; try { await api(`/admin/media/${item.id}`, { method: 'DELETE' }); setSaved('Media removed.'); load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to remove media.'); } };
  return <div className="page-stack"><div className="section-header"><div><span className="eyebrow">Website / media</span><h2>One safe library for every image.</h2><p>Edit accessibility metadata and remove only unused assets. Referenced media is protected by the API.</p></div></div>{error ? <div className="notice notice-danger">{error}</div> : null}{saved ? <div className="notice notice-success">{saved}</div> : null}<form className="panel editor-form" onSubmit={(event) => void upload(event)}><div className="form-grid"><label>Image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} required /></label><label>Alt text<input value={uploadDraft.altText} onChange={(e) => setUploadDraft({ ...uploadDraft, altText: e.target.value })} required /></label><label>Caption<textarea rows={2} value={uploadDraft.caption} onChange={(e) => setUploadDraft({ ...uploadDraft, caption: e.target.value })} /></label></div><button className="button button-primary"><Upload size={16} /> Add to library</button></form><div className="photo-grid">{items.map((item) => <figure key={item.id}>{item.url ? <img src={item.url} alt={item.altText} /> : null}{editing === item.id ? <div className="editor-form"><label>Alt text<input value={draft.altText} onChange={(e) => setDraft({ ...draft, altText: e.target.value })} /></label><label>Caption<textarea rows={2} value={draft.caption} onChange={(e) => setDraft({ ...draft, caption: e.target.value })} /></label><div className="row-actions"><button className="button button-primary" onClick={() => void save(item.id)}>Save</button><button className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button></div></div> : <><figcaption><strong>{item.originalName}</strong><br />{item.usageCount} references · {item.status}</figcaption><div className="row-actions"><button className="text-button" onClick={() => { setEditing(item.id); setDraft({ altText: item.altText, caption: item.caption }); }}>Edit metadata</button><button className="text-button muted" disabled={item.usageCount > 0} onClick={() => void remove(item)}><Trash2 size={14} /> {item.usageCount ? 'In use' : 'Remove'}</button></div></>}</figure>)}{!items.length ? <div className="empty-state">No media assets yet.</div> : null}</div></div>;
}

type ArchiveDetail = { id: string; label: string; slug: string; startsOn: string; endsOn: string; published: boolean; events: Array<{ id: string; title: string; startAt: string }>; rosters: Array<{ id: string; designation: string; featured: boolean; member: { id: string; fullName: string; designation: string } }> };

export function ArchiveManagerPage() {
  const { id } = useParams();
  const [archive, setArchive] = useState<ArchiveDetail | null>(null);
  const [members, setMembers] = useState<Array<{ id: string; fullName: string; designation: string }>>([]);
  const [memberId, setMemberId] = useState('');
  const [error, setError] = useState('');
  const load = () => { if (!id) return; void Promise.all([api<{ item: ArchiveDetail }>(`/admin/academic-years/${id}`), api<{ items: typeof members }>('/admin/team')]).then(([archiveResult, teamResult]) => { setArchive(archiveResult.item); setMembers(teamResult.items); setMemberId((current) => current || teamResult.items[0]?.id || ''); }).catch((e: Error) => setError(e.message)); };
  useEffect(load, [id]);
  const assign = async () => { if (!id || !memberId) return; const member = members.find((item) => item.id === memberId); if (!member) return; try { await api(`/admin/academic-years/${id}/roster`, json({ memberId, designation: member.designation, displayOrder: archive?.rosters.length || 0, featured: false })); load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to assign roster member.'); } };
  const remove = async (membershipId: string) => { if (!id || !window.confirm('Remove this historical roster assignment?')) return; try { await api(`/admin/academic-years/${id}/roster/${membershipId}`, { method: 'DELETE' }); load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to remove roster assignment.'); } };
  const toggle = async () => { if (!id || !archive) return; try { await api(`/admin/academic-years/${id}/${archive.published ? 'unpublish' : 'publish'}`, json({})); load(); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to change archive publication.'); } };
  if (error && !archive) return <div className="notice notice-danger">{error}</div>; if (!archive) return <div className="panel loading-panel">Loading archive…</div>;
  return <div className="page-stack"><Link className="back-link" to="/archives"><ArrowLeft size={15} /> Back to archives</Link><div className="section-header"><div><span className="eyebrow">Archives / academic year</span><h2>{archive.label}</h2><p>{archive.events.length} events · {archive.rosters.length} historical roster assignments</p></div><button className="button button-primary" onClick={() => void toggle()}>{archive.published ? 'Unpublish archive' : 'Publish archive'}</button></div>{error ? <div className="notice notice-danger">{error}</div> : null}<div className="panel table-panel"><div className="panel-heading"><div><span className="eyebrow">Historical roster</span><h3>People assigned to this year</h3></div></div><div className="form-grid"><label>Add member<select value={memberId} onChange={(e) => setMemberId(e.target.value)}>{members.map((member) => <option key={member.id} value={member.id}>{member.fullName} · {member.designation}</option>)}</select></label><button className="button button-secondary" onClick={() => void assign()}>Assign to archive</button></div><div className="data-table">{archive.rosters.map((entry) => <div className="table-row" key={entry.id}><div className="row-title"><strong>{entry.member.fullName}</strong><small>{entry.designation}</small></div><span>{entry.featured ? 'Featured' : 'Standard'}</span><button className="text-button muted" onClick={() => void remove(entry.id)}><Trash2 size={14} /> Remove</button></div>)}{!archive.rosters.length ? <div className="empty-state">No historical roster assignments yet.</div> : null}</div></div><div className="panel table-panel"><div className="panel-heading"><div><span className="eyebrow">Assigned events</span><h3>Events in this archive</h3></div></div><div className="data-table">{archive.events.map((event) => <div className="table-row" key={event.id}><strong>{event.title}</strong><span>{new Date(event.startAt).toLocaleDateString('en-IN')}</span><Link className="text-button" to={`/events/${event.id}/edit`}>Edit event</Link></div>)}</div></div></div>;
}
