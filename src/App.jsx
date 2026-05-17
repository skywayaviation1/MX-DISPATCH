import { useEffect, useMemo, useState } from 'react'
import { auth, db } from './firebase'
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore'

/* ============================================================
   BRAND  —  white-label config. Change these to re-skin for a
   partner operator. Colors live in src/index.css (:root vars).
   ============================================================ */
const BRAND = {
  name: 'White Label Jet MX',
  mark: 'WL',
  tagline: 'Mobile Aircraft Maintenance Dispatch',
}

/* Ticket lifecycle. Phase 1 exposes the first set; the dispatch /
   parts / RTS states come online in Phases 2–3. */
const STATUS = {
  OPEN: 'OPEN',
  CONTRACT_PENDING: 'CONTRACT_PENDING',
  CANCELLED: 'CANCELLED',
  CLOSED: 'CLOSED',
}
const PHASE1_STATUSES = ['OPEN', 'CONTRACT_PENDING', 'CANCELLED', 'CLOSED']

/* ---------- helpers ---------- */
function tsToDate(v) {
  if (!v) return null
  if (typeof v.toDate === 'function') return v.toDate()
  return new Date(v)
}
function fmtWhen(v) {
  const d = tsToDate(v)
  if (!d) return '—'
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}
// Newest first. A doc whose serverTimestamp hasn't resolved yet
// (createdAt null for a moment after write) sorts to the top.
function byCreatedDesc(a, b) {
  const da = tsToDate(a.createdAt)
  const db_ = tsToDate(b.createdAt)
  const ta = da ? da.getTime() : Infinity
  const tb = db_ ? db_.getTime() : Infinity
  return tb - ta
}
function ago(v) {
  const d = tsToDate(v)
  if (!d) return ''
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/* ============================================================
   ROOT
   ============================================================ */
export default function App() {
  const [authReady, setAuthReady] = useState(false)
  const [user, setUser] = useState(null)
  const [staff, setStaff] = useState(null) // { role, name } from users/{uid}
  const [staffChecked, setStaffChecked] = useState(false)
  const [showLogin, setShowLogin] = useState(false)

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      setUser(u)
      setAuthReady(true)
      setStaffChecked(false)
      if (u) {
        try {
          const snap = await getDoc(doc(db, 'users', u.uid))
          setStaff(snap.exists() ? snap.data() : null)
        } catch {
          setStaff(null)
        }
      } else {
        setStaff(null)
      }
      setStaffChecked(true)
    })
  }, [])

  if (!authReady) return <Shell><div className="wl-empty">Loading…</div></Shell>

  // Signed in + provisioned as staff -> dashboard
  if (user && staffChecked && staff) {
    return (
      <Shell
        right={
          <>
            <span style={{ color: 'var(--wl-text-faint)', fontSize: 13 }}>
              {staff.name || user.email} · {staff.role}
            </span>
            <button className="wl-btn wl-btn-sm wl-btn-ghost" onClick={() => signOut(auth)}>
              Sign out
            </button>
          </>
        }
      >
        <Dashboard user={user} staff={staff} />
      </Shell>
    )
  }

  // Signed in but NOT provisioned
  if (user && staffChecked && !staff) {
    return (
      <Shell>
        <div className="wl-auth-wrap">
          <div className="wl-auth-title">Access pending</div>
          <p className="wl-auth-sub">
            This sign-in is valid but not yet authorized as dispatch staff.
            An administrator must provision your account.
          </p>
          <button className="wl-btn wl-btn-ghost" style={{ width: '100%' }} onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </Shell>
    )
  }

  // Public
  return (
    <Shell
      right={
        !showLogin && (
          <button className="wl-btn wl-btn-sm wl-btn-ghost" onClick={() => setShowLogin(true)}>
            Staff sign in
          </button>
        )
      }
    >
      {showLogin ? (
        <Login onCancel={() => setShowLogin(false)} />
      ) : (
        <Intake onStaff={() => setShowLogin(true)} />
      )}
    </Shell>
  )
}

/* ============================================================
   SHELL
   ============================================================ */
function Shell({ children, right }) {
  return (
    <>
      <div className="wl-grain" />
      <div className="wl-shell">
        <header className="wl-topbar">
          <div className="wl-brand">
            <div className="wl-mark">{BRAND.mark}</div>
            <div>
              <div className="wl-brand-name">{BRAND.name}</div>
              <div className="wl-brand-sub">{BRAND.tagline}</div>
            </div>
          </div>
          <div className="wl-topbar-right">{right}</div>
        </header>
        {children}
      </div>
    </>
  )
}

/* ============================================================
   PUBLIC INTAKE FORM
   ============================================================ */
const EMPTY = {
  serviceType: '',
  companyName: '', contactName: '', contactEmail: '', contactPhone: '',
  tailNumber: '', acMake: '', acModel: '', acSerial: '',
  airportIdent: '', fbo: '', locationNotes: '',
  urgency: 'NORMAL', requestedDate: '', description: '',
}

function Intake() {
  const [f, setF] = useState(EMPTY)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [doneId, setDoneId] = useState(null)

  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))

  function pickType(t) {
    setF((s) => ({
      ...s,
      serviceType: t,
      urgency: t === 'AOG' ? 'CRITICAL' : 'NORMAL',
    }))
  }

  async function submit() {
    setErr('')
    if (!f.serviceType) return setErr('Select AOG or Scheduled service.')
    const required = [
      ['companyName', 'Operator / company'],
      ['contactName', 'Contact name'],
      ['contactEmail', 'Contact email'],
      ['contactPhone', 'Contact phone'],
      ['tailNumber', 'Tail number'],
      ['acMake', 'Aircraft make'],
      ['acModel', 'Aircraft model'],
      ['airportIdent', 'Airport / location'],
      ['description', 'Description of work'],
    ]
    for (const [k, label] of required) {
      if (!String(f[k]).trim()) return setErr(`${label} is required.`)
    }
    setBusy(true)
    try {
      const ref = await addDoc(collection(db, 'serviceRequests'), {
        serviceType: f.serviceType,
        companyName: f.companyName.trim(),
        contactName: f.contactName.trim(),
        contactEmail: f.contactEmail.trim(),
        contactPhone: f.contactPhone.trim(),
        tailNumber: f.tailNumber.trim().toUpperCase(),
        acMake: f.acMake.trim(),
        acModel: f.acModel.trim(),
        acSerial: f.acSerial.trim(),
        airportIdent: f.airportIdent.trim().toUpperCase(),
        fbo: f.fbo.trim(),
        locationNotes: f.locationNotes.trim(),
        urgency: f.urgency,
        requestedDate: f.serviceType === 'SCHEDULED' ? f.requestedDate : '',
        description: f.description.trim(),
        status: 'NEW',
        ticketId: '',
        createdAt: serverTimestamp(),
      })
      setDoneId(ref.id.slice(0, 8).toUpperCase())
    } catch (e) {
      setErr('Could not submit the request. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  if (doneId) {
    return (
      <div className="wl-intake-wrap">
        <div className="wl-card wl-success">
          <div className="wl-eyebrow">Request received</div>
          <h2 className="wl-h1" style={{ fontSize: 30 }}>You're in the queue</h2>
          <div className="wl-success-id">REF&nbsp;{doneId}</div>
          <p style={{ color: 'var(--wl-text-dim)', maxWidth: 460, margin: '0 auto' }}>
            Our dispatch team has been notified and will contact{' '}
            <strong>{f.contactName}</strong> to confirm scope and issue a service
            agreement before any work begins. Keep this reference number.
          </p>
          <button
            className="wl-btn wl-btn-ghost"
            style={{ marginTop: 26 }}
            onClick={() => { setF(EMPTY); setDoneId(null) }}
          >
            Submit another request
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="wl-intake-wrap">
      <div className="wl-intake-hero">
        <div className="wl-eyebrow">Service Request</div>
        <h1 className="wl-h1">Request maintenance support</h1>
        <p className="wl-lede">
          AOG recovery and scheduled maintenance for visiting and based aircraft.
          Submit the request below — dispatch confirms scope and issues a service
          agreement before work begins.
        </p>
      </div>

      <div className="wl-card">
        <div className="wl-section-title">Service type</div>
        <div className="wl-typetoggle">
          <div
            className={`wl-type ${f.serviceType === 'AOG' ? 'sel-aog' : ''}`}
            onClick={() => pickType('AOG')}
          >
            <div className="wl-type-k" style={{ color: f.serviceType === 'AOG' ? 'var(--wl-aog)' : undefined }}>
              AOG · Aircraft on Ground
            </div>
            <div className="wl-type-d">Aircraft is grounded. Priority dispatch.</div>
          </div>
          <div
            className={`wl-type ${f.serviceType === 'SCHEDULED' ? 'sel-sched' : ''}`}
            onClick={() => pickType('SCHEDULED')}
          >
            <div className="wl-type-k" style={{ color: f.serviceType === 'SCHEDULED' ? 'var(--wl-sched)' : undefined }}>
              Scheduled MX
            </div>
            <div className="wl-type-d">Planned inspection or maintenance.</div>
          </div>
        </div>

        <div className="wl-divider" />

        <div className="wl-section-title">Requesting operator</div>
        <div className="wl-grid">
          <div className="wl-field">
            <label className="wl-label">Operator / company <span className="req">*</span></label>
            <input className="wl-input" value={f.companyName} onChange={set('companyName')} />
          </div>
          <div className="wl-field">
            <label className="wl-label">Contact name <span className="req">*</span></label>
            <input className="wl-input" value={f.contactName} onChange={set('contactName')} />
          </div>
          <div className="wl-field">
            <label className="wl-label">Contact email <span className="req">*</span></label>
            <input className="wl-input" type="email" value={f.contactEmail} onChange={set('contactEmail')} />
          </div>
          <div className="wl-field">
            <label className="wl-label">Contact phone <span className="req">*</span></label>
            <input className="wl-input" value={f.contactPhone} onChange={set('contactPhone')} />
          </div>
        </div>

        <div className="wl-divider" />

        <div className="wl-section-title">Aircraft</div>
        <div className="wl-grid">
          <div className="wl-field">
            <label className="wl-label">Tail number <span className="req">*</span></label>
            <input
              className="wl-input wl-mono-input"
              placeholder="N123AB"
              value={f.tailNumber}
              onChange={set('tailNumber')}
            />
          </div>
          <div className="wl-field">
            <label className="wl-label">Serial number</label>
            <input className="wl-input wl-mono-input" value={f.acSerial} onChange={set('acSerial')} />
          </div>
          <div className="wl-field">
            <label className="wl-label">Make <span className="req">*</span></label>
            <input className="wl-input" placeholder="Cessna" value={f.acMake} onChange={set('acMake')} />
          </div>
          <div className="wl-field">
            <label className="wl-label">Model <span className="req">*</span></label>
            <input className="wl-input" placeholder="Citation CJ3" value={f.acModel} onChange={set('acModel')} />
          </div>
        </div>

        <div className="wl-divider" />

        <div className="wl-section-title">Location</div>
        <div className="wl-grid-3">
          <div className="wl-field">
            <label className="wl-label">Airport (ICAO/FAA) <span className="req">*</span></label>
            <input
              className="wl-input wl-mono-input"
              placeholder="KOPF"
              value={f.airportIdent}
              onChange={set('airportIdent')}
            />
          </div>
          <div className="wl-field">
            <label className="wl-label">FBO / ramp</label>
            <input className="wl-input" value={f.fbo} onChange={set('fbo')} />
          </div>
          <div className="wl-field">
            <label className="wl-label">Position notes</label>
            <input className="wl-input" placeholder="Hangar 4, tie-down B12…" value={f.locationNotes} onChange={set('locationNotes')} />
          </div>
        </div>

        <div className="wl-divider" />

        <div className="wl-section-title">Scope</div>
        <div className="wl-grid">
          {f.serviceType === 'SCHEDULED' && (
            <div className="wl-field">
              <label className="wl-label">Requested date</label>
              <input className="wl-input" type="date" value={f.requestedDate} onChange={set('requestedDate')} />
            </div>
          )}
          <div className="wl-field">
            <label className="wl-label">Urgency</label>
            <select className="wl-select" value={f.urgency} onChange={set('urgency')}>
              <option value="CRITICAL">Critical</option>
              <option value="HIGH">High</option>
              <option value="NORMAL">Normal</option>
            </select>
          </div>
          <div className="wl-field full">
            <label className="wl-label">Squawk / description of work <span className="req">*</span></label>
            <textarea
              className="wl-textarea"
              placeholder="Describe the discrepancy or the maintenance requested. Include ATA chapter or system if known."
              value={f.description}
              onChange={set('description')}
            />
          </div>
        </div>

        {err && <div className="wl-err">{err}</div>}

        <div className="wl-submitbar">
          <p className="wl-fineprint">
            Submitting a request does not create a binding work order. No
            maintenance is performed until scope is confirmed and a written
            service agreement is executed by both parties.
          </p>
          <button className="wl-btn wl-btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   STAFF LOGIN
   ============================================================ */
function Login({ onCancel }) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function go() {
    setErr('')
    setBusy(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), pw)
    } catch {
      setErr('Sign-in failed. Check your email and password.')
      setBusy(false)
    }
  }

  return (
    <div className="wl-auth-wrap">
      <div className="wl-auth-title">Dispatch sign in</div>
      <p className="wl-auth-sub">Authorized maintenance dispatch staff only.</p>
      <div className="wl-card">
        <div className="wl-field" style={{ marginBottom: 14 }}>
          <label className="wl-label">Email</label>
          <input
            className="wl-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
        <div className="wl-field">
          <label className="wl-label">Password</label>
          <input
            className="wl-input"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
        {err && <div className="wl-err">{err}</div>}
        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          <button className="wl-btn wl-btn-primary" style={{ flex: 1 }} onClick={go} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button className="wl-btn wl-btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   DASHBOARD
   ============================================================ */
function Dashboard({ user, staff }) {
  const [tab, setTab] = useState('requests')
  const [requests, setRequests] = useState([])
  const [tickets, setTickets] = useState([])
  const [openReq, setOpenReq] = useState(null)
  const [openTicket, setOpenTicket] = useState(null)

  // Note: queries are intentionally single-clause and sorted in the
  // browser. This keeps Firestore from ever demanding a composite
  // index (no console errors, zero index setup for the operator).
  useEffect(() => {
    const qReq = query(
      collection(db, 'serviceRequests'),
      where('status', '==', 'NEW'),
    )
    return onSnapshot(qReq, (snap) =>
      setRequests(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => byCreatedDesc(a, b)),
      ),
    )
  }, [])

  useEffect(() => {
    return onSnapshot(collection(db, 'serviceTickets'), (snap) =>
      setTickets(
        snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => byCreatedDesc(a, b)),
      ),
    )
  }, [])

  // keep open drawer data fresh from snapshots
  const liveTicket = useMemo(
    () => tickets.find((t) => t.id === openTicket?.id) || null,
    [tickets, openTicket],
  )

  return (
    <div className="wl-dash">
      <nav className="wl-side">
        <div
          className={`wl-nav-item ${tab === 'requests' ? 'active' : ''}`}
          onClick={() => setTab('requests')}
        >
          Requests
          <span className="wl-nav-count">{requests.length}</span>
        </div>
        <div
          className={`wl-nav-item ${tab === 'tickets' ? 'active' : ''}`}
          onClick={() => setTab('tickets')}
        >
          Tickets
          <span className="wl-nav-count">{tickets.length}</span>
        </div>
      </nav>

      <main className="wl-main">
        {tab === 'requests' && (
          <>
            <h1 className="wl-page-h">Incoming requests</h1>
            <p className="wl-page-sub">New service requests awaiting accept / decline.</p>
            {requests.length === 0 ? (
              <div className="wl-empty">No new requests in the queue.</div>
            ) : (
              <div className="wl-list">
                {requests.map((r) => (
                  <div key={r.id} className="wl-row" onClick={() => setOpenReq(r)}>
                    <span className={`wl-pill ${r.serviceType === 'AOG' ? 'wl-pill-aog' : 'wl-pill-sched'}`}>
                      {r.serviceType === 'AOG' ? 'AOG' : 'SCHED'}
                    </span>
                    <span className="wl-row-tail">{r.tailNumber}</span>
                    <div className="wl-row-main">
                      <div className="wl-row-co">{r.companyName}</div>
                      <div className="wl-row-meta">
                        {r.acMake} {r.acModel} · {r.airportIdent}
                        {r.fbo ? ` · ${r.fbo}` : ''} · {r.urgency}
                      </div>
                    </div>
                    <span className="wl-row-time">{ago(r.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'tickets' && (
          <>
            <h1 className="wl-page-h">Service tickets</h1>
            <p className="wl-page-sub">Accepted jobs. Phase 1: intake, aircraft verification, certification basis.</p>
            {tickets.length === 0 ? (
              <div className="wl-empty">No tickets yet. Accept a request to open one.</div>
            ) : (
              <div className="wl-list">
                {tickets.map((t) => (
                  <div key={t.id} className="wl-row" onClick={() => setOpenTicket(t)}>
                    <span className={`wl-pill ${t.serviceType === 'AOG' ? 'wl-pill-aog' : 'wl-pill-sched'}`}>
                      {t.serviceType === 'AOG' ? 'AOG' : 'SCHED'}
                    </span>
                    <span className="wl-row-tail">{t.ticketNumber}</span>
                    <div className="wl-row-main">
                      <div className="wl-row-co">
                        {t.operator?.companyName}{' '}
                        <span style={{ color: 'var(--wl-text-faint)', fontFamily: 'var(--wl-mono)', fontSize: 13 }}>
                          {t.aircraft?.tailNumber}
                        </span>
                      </div>
                      <div className="wl-row-meta">
                        {t.aircraft?.make} {t.aircraft?.model} · {t.location?.airportIdent}
                      </div>
                    </div>
                    <span className="wl-pill wl-pill-status">
                      <span className="wl-dot" />{t.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>

      {openReq && (
        <RequestDrawer
          req={openReq}
          actor={staff.name || user.email}
          onClose={() => setOpenReq(null)}
          onAccepted={() => { setOpenReq(null); setTab('tickets') }}
        />
      )}
      {liveTicket && (
        <TicketDrawer
          ticket={liveTicket}
          actor={staff.name || user.email}
          onClose={() => setOpenTicket(null)}
        />
      )}
    </div>
  )
}

/* ============================================================
   REQUEST DRAWER  —  accept / decline
   ============================================================ */
function RequestDrawer({ req, actor, onClose, onAccepted }) {
  const [busy, setBusy] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState('')

  async function accept() {
    setErr('')
    setBusy(true)
    try {
      const ticketNumber = await runTransaction(db, async (tx) => {
        const cRef = doc(db, 'counters', 'serviceTickets')
        const cSnap = await tx.get(cRef)
        const next = (cSnap.exists() ? cSnap.data().current || 0 : 0) + 1
        tx.set(cRef, { current: next }, { merge: true })
        return `WLJMX-${String(next).padStart(4, '0')}`
      })

      const tRef = await addDoc(collection(db, 'serviceTickets'), {
        ticketNumber,
        requestId: req.id,
        serviceType: req.serviceType,
        urgency: req.urgency,
        description: req.description,
        status: STATUS.OPEN,
        operator: {
          companyName: req.companyName,
          contactName: req.contactName,
          contactEmail: req.contactEmail,
          contactPhone: req.contactPhone,
        },
        aircraft: {
          tailNumber: req.tailNumber,
          make: req.acMake,
          model: req.acModel,
          serial: req.acSerial || '',
        },
        location: {
          airportIdent: req.airportIdent,
          fbo: req.fbo || '',
          notes: req.locationNotes || '',
        },
        aircraftConfirmed: false,
        aircraftConfirmedBy: '',
        aircraftConfirmedAt: '',
        certification: {
          performedUnder: '',
          mechanicName: '', apNumber: '', iaNumber: '',
          repairStationName: '', repairStationCert: '', repairStationRatings: '',
        },
        rts: { signed: false, signedBy: '', basis: '', date: '', statement: '' },
        activity: [
          { ts: new Date().toISOString(), by: actor, text: `Ticket opened from request ${req.id.slice(0, 8).toUpperCase()}` },
        ],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })

      await updateDoc(doc(db, 'serviceRequests', req.id), {
        status: 'ACCEPTED',
        ticketId: tRef.id,
      })
      onAccepted()
    } catch (e) {
      setErr('Could not accept the request. Try again.')
      setBusy(false)
    }
  }

  async function decline() {
    if (!reason.trim()) return setErr('Enter a reason to decline.')
    setBusy(true)
    try {
      await updateDoc(doc(db, 'serviceRequests', req.id), {
        status: 'DECLINED',
        declineReason: reason.trim(),
      })
      onClose()
    } catch {
      setErr('Could not decline the request. Try again.')
      setBusy(false)
    }
  }

  return (
    <Drawer title={`REQ ${req.id.slice(0, 8).toUpperCase()}`} onClose={onClose}
      badge={<span className={`wl-pill ${req.serviceType === 'AOG' ? 'wl-pill-aog' : 'wl-pill-sched'}`}>
        {req.serviceType === 'AOG' ? 'AOG' : 'SCHEDULED'}</span>}>
      <div className="wl-block">
        <div className="wl-block-h">Aircraft</div>
        <dl className="wl-kv">
          <dt>Tail #</dt><dd className="mono">{req.tailNumber}</dd>
          <dt>Serial</dt><dd className="mono">{req.acSerial || '—'}</dd>
          <dt>Make / model</dt><dd>{req.acMake} {req.acModel}</dd>
          <dt>Location</dt><dd className="mono">{req.airportIdent}{req.fbo ? ` · ${req.fbo}` : ''}</dd>
          {req.locationNotes && (<><dt>Position</dt><dd>{req.locationNotes}</dd></>)}
        </dl>
      </div>

      <div className="wl-block">
        <div className="wl-block-h">Requesting operator</div>
        <dl className="wl-kv">
          <dt>Company</dt><dd>{req.companyName}</dd>
          <dt>Contact</dt><dd>{req.contactName}</dd>
          <dt>Email</dt><dd>{req.contactEmail}</dd>
          <dt>Phone</dt><dd className="mono">{req.contactPhone}</dd>
          <dt>Submitted</dt><dd>{fmtWhen(req.createdAt)}</dd>
        </dl>
      </div>

      <div className="wl-block">
        <div className="wl-block-h">Requested scope · {req.urgency}</div>
        <p style={{ fontSize: 14, color: 'var(--wl-text-dim)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {req.description}
        </p>
        {req.requestedDate && (
          <p style={{ marginTop: 10, fontSize: 13, color: 'var(--wl-text-faint)' }}>
            Requested date: <span style={{ fontFamily: 'var(--wl-mono)' }}>{req.requestedDate}</span>
          </p>
        )}
      </div>

      {err && <div className="wl-err">{err}</div>}

      {!declining ? (
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="wl-btn wl-btn-primary" style={{ flex: 1 }} onClick={accept} disabled={busy}>
            {busy ? 'Working…' : 'Accept & open ticket'}
          </button>
          <button className="wl-btn wl-btn-danger" onClick={() => setDeclining(true)} disabled={busy}>
            Decline
          </button>
        </div>
      ) : (
        <div className="wl-block">
          <div className="wl-block-h">Decline reason</div>
          <textarea
            className="wl-textarea"
            placeholder="Reason shared internally (not auto-sent to the operator)."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <button className="wl-btn wl-btn-danger" style={{ flex: 1 }} onClick={decline} disabled={busy}>
              Confirm decline
            </button>
            <button className="wl-btn wl-btn-ghost" onClick={() => setDeclining(false)}>Back</button>
          </div>
        </div>
      )}
    </Drawer>
  )
}

/* ============================================================
   TICKET DRAWER
   ============================================================ */
function TicketDrawer({ ticket, actor, onClose }) {
  const t = ticket
  const ref = doc(db, 'serviceTickets', t.id)
  const [note, setNote] = useState('')
  const [savingCert, setSavingCert] = useState(false)
  const [cert, setCert] = useState(t.certification || { performedUnder: '' })

  useEffect(() => { setCert(t.certification || { performedUnder: '' }) }, [t.id]) // eslint-disable-line

  function log(text) {
    return arrayUnion({ ts: new Date().toISOString(), by: actor, text })
  }

  async function confirmAircraft() {
    await updateDoc(ref, {
      aircraftConfirmed: true,
      aircraftConfirmedBy: actor,
      aircraftConfirmedAt: new Date().toISOString(),
      updatedAt: serverTimestamp(),
      activity: log(`Aircraft identity verified: ${t.aircraft?.tailNumber} / S/N ${t.aircraft?.serial || 'N/A'}`),
    })
  }

  async function setStatus(s) {
    if (s === t.status) return
    await updateDoc(ref, {
      status: s,
      updatedAt: serverTimestamp(),
      activity: log(`Status changed to ${s}`),
    })
  }

  async function addNote() {
    if (!note.trim()) return
    await updateDoc(ref, {
      updatedAt: serverTimestamp(),
      activity: log(note.trim()),
    })
    setNote('')
  }

  async function saveCert() {
    setSavingCert(true)
    try {
      await updateDoc(ref, {
        certification: cert,
        updatedAt: serverTimestamp(),
        activity: log(
          `Certification basis set: ${cert.performedUnder === 'INDIVIDUAL'
            ? 'Individual A&P/IA'
            : cert.performedUnder === 'REPAIR_STATION'
            ? 'Part 145 Repair Station'
            : 'cleared'}`,
        ),
      })
    } finally {
      setSavingCert(false)
    }
  }

  const setC = (k) => (e) => setCert((s) => ({ ...s, [k]: e.target.value }))
  const activity = [...(t.activity || [])].sort((a, b) => (a.ts < b.ts ? 1 : -1))

  return (
    <Drawer
      title={t.ticketNumber}
      onClose={onClose}
      badge={
        <>
          <span className={`wl-pill ${t.serviceType === 'AOG' ? 'wl-pill-aog' : 'wl-pill-sched'}`}>
            {t.serviceType === 'AOG' ? 'AOG' : 'SCHEDULED'}
          </span>
          <span className="wl-pill wl-pill-status"><span className="wl-dot" />{t.status}</span>
        </>
      }
    >
      {/* Locked aircraft identity */}
      <div className="wl-block wl-locked">
        <div className="wl-block-h">
          Aircraft — identity locked
          {t.aircraftConfirmed && (
            <span className="wl-confirmed-tag">✓ Verified</span>
          )}
        </div>
        <dl className="wl-kv">
          <dt>Tail #</dt><dd className="mono">{t.aircraft?.tailNumber}</dd>
          <dt>Serial</dt><dd className="mono">{t.aircraft?.serial || '—'}</dd>
          <dt>Make / model</dt><dd>{t.aircraft?.make} {t.aircraft?.model}</dd>
          <dt>Location</dt><dd className="mono">
            {t.location?.airportIdent}{t.location?.fbo ? ` · ${t.location.fbo}` : ''}
          </dd>
        </dl>
        <div className="wl-locked-note">
          <span>⚠</span>
          <span>
            Identity carried verbatim from the operator's request. Confirm the
            tail number <em>and</em> serial against the airframe data plate before
            dispatch — paperwork must match the aircraft actually worked.
          </span>
        </div>
        <div className="wl-confirm-row">
          {t.aircraftConfirmed ? (
            <span className="wl-confirmed-tag">
              ✓ Verified by {t.aircraftConfirmedBy} · {fmtWhen(t.aircraftConfirmedAt)}
            </span>
          ) : (
            <button className="wl-btn wl-btn-primary wl-btn-sm" onClick={confirmAircraft}>
              Confirm aircraft (tail # / serial verified)
            </button>
          )}
        </div>
      </div>

      {/* Operator + scope */}
      <div className="wl-block">
        <div className="wl-block-h">Operator</div>
        <dl className="wl-kv">
          <dt>Company</dt><dd>{t.operator?.companyName}</dd>
          <dt>Contact</dt><dd>{t.operator?.contactName}</dd>
          <dt>Email</dt><dd>{t.operator?.contactEmail}</dd>
          <dt>Phone</dt><dd className="mono">{t.operator?.contactPhone}</dd>
        </dl>
      </div>

      <div className="wl-block">
        <div className="wl-block-h">Reported scope · {t.urgency}</div>
        <p style={{ fontSize: 14, color: 'var(--wl-text-dim)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
          {t.description}
        </p>
      </div>

      {/* Status */}
      <div className="wl-block">
        <div className="wl-block-h">Status</div>
        <select
          className="wl-select"
          value={t.status}
          onChange={(e) => setStatus(e.target.value)}
          style={{ width: '100%' }}
        >
          {PHASE1_STATUSES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <p style={{ fontSize: 12, color: 'var(--wl-text-faint)', marginTop: 10, lineHeight: 1.5 }}>
          Dispatch, in-progress, parts and return-to-service states come online
          in Phases 2–3 alongside crew and parts modules.
        </p>
      </div>

      {/* Certification basis — holds BOTH models */}
      <div className="wl-block">
        <div className="wl-block-h">Certification basis</div>
        <div className="wl-radio-row">
          {[
            ['INDIVIDUAL', 'Individual A&P / IA'],
            ['REPAIR_STATION', 'Part 145 Repair Station'],
          ].map(([v, label]) => (
            <div
              key={v}
              className={`wl-radio ${cert.performedUnder === v ? 'sel' : ''}`}
              onClick={() => setCert((s) => ({ ...s, performedUnder: v }))}
            >
              {label}
            </div>
          ))}
        </div>

        {cert.performedUnder === 'INDIVIDUAL' && (
          <div className="wl-grid" style={{ marginBottom: 4 }}>
            <div className="wl-field full">
              <label className="wl-mini-label">Mechanic name</label>
              <input className="wl-input" value={cert.mechanicName || ''} onChange={setC('mechanicName')} />
            </div>
            <div className="wl-field">
              <label className="wl-mini-label">A&P certificate #</label>
              <input className="wl-input wl-mono-input" value={cert.apNumber || ''} onChange={setC('apNumber')} />
            </div>
            <div className="wl-field">
              <label className="wl-mini-label">IA # (if applicable)</label>
              <input className="wl-input wl-mono-input" value={cert.iaNumber || ''} onChange={setC('iaNumber')} />
            </div>
          </div>
        )}

        {cert.performedUnder === 'REPAIR_STATION' && (
          <div className="wl-grid" style={{ marginBottom: 4 }}>
            <div className="wl-field full">
              <label className="wl-mini-label">Repair station name</label>
              <input className="wl-input" value={cert.repairStationName || ''} onChange={setC('repairStationName')} />
            </div>
            <div className="wl-field">
              <label className="wl-mini-label">Certificate #</label>
              <input className="wl-input wl-mono-input" value={cert.repairStationCert || ''} onChange={setC('repairStationCert')} />
            </div>
            <div className="wl-field">
              <label className="wl-mini-label">Ratings / limitations</label>
              <input className="wl-input" value={cert.repairStationRatings || ''} onChange={setC('repairStationRatings')} />
            </div>
          </div>
        )}

        {cert.performedUnder && (
          <button
            className="wl-btn wl-btn-sm wl-btn-primary"
            style={{ marginTop: 12 }}
            onClick={saveCert}
            disabled={savingCert}
          >
            {savingCert ? 'Saving…' : 'Save certification basis'}
          </button>
        )}
        <p style={{ fontSize: 12, color: 'var(--wl-text-faint)', marginTop: 12, lineHeight: 1.5 }}>
          This records the regulatory basis the work is performed and returned to
          service under. The signed return-to-service record is captured in
          Phase 3.
        </p>
      </div>

      {/* Activity / notes */}
      <div className="wl-block">
        <div className="wl-block-h">Activity</div>
        <div className="wl-note-row">
          <input
            className="wl-input"
            placeholder="Add a note…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addNote()}
          />
          <button className="wl-btn wl-btn-sm" onClick={addNote}>Add</button>
        </div>
        <div className="wl-activity" style={{ marginTop: 16 }}>
          {activity.length === 0 && (
            <span style={{ color: 'var(--wl-text-faint)', fontSize: 13 }}>No activity yet.</span>
          )}
          {activity.map((a, i) => (
            <div key={i} className="wl-act-item">
              <span className="wl-act-ts">{fmtWhen(a.ts)}</span>
              <span className="wl-act-text">
                {a.text}
                <span style={{ color: 'var(--wl-text-faint)' }}> · {a.by}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  )
}

/* ============================================================
   DRAWER SHELL
   ============================================================ */
function Drawer({ title, badge, onClose, children }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  return (
    <div className="wl-overlay" onClick={onClose}>
      <div className="wl-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="wl-drawer-head">
          <div>
            <div className="wl-drawer-title">{title}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>{badge}</div>
          </div>
          <button className="wl-x" onClick={onClose}>✕</button>
        </div>
        <div className="wl-drawer-body">{children}</div>
      </div>
    </div>
  )
}
