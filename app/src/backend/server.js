/**
 * Adamas2Aurum — Express Server (dev branch)
 *
 * Authentication:
 *   - Google sign-in via OAuth 2.0 (routes/oauth.js). A successful login
 *     stores the user in express-session, exactly like PIN login does, so
 *     every route reads req.user / req.session.user the same way.
 *   - Username + PIN (routes/auth.js) is kept alongside it.
 *
 * Also: initialize_database (schema.sql with CREATE TABLE IF NOT EXISTS),
 * seed_database (only when SEED_DB=true) and the /api/health endpoint.
 */

import express from 'express'
import session from 'express-session'
import mySQLSession from 'express-mysql-session'
import cors from 'cors'
import { createServer } from 'http'

import path from 'path'
import { fileURLToPath } from 'url'

import event_routes from './routes/events.js'
import card_routes from './routes/cards.js'
import auth_routes from './routes/auth.js'
import { create_oauth_router } from './routes/oauth.js'
import trivia_routes from './routes/trivia.js'
import question_routes from './routes/questions.js'
import pool_routes from './routes/event_pool.js'
import leaderboard_routes from './routes/leaderboard.js'
import sync_routes from './routes/sync.js'
import campaign_routes from './routes/campaigns.js'
import analytics_routes from './routes/analytics.js'
import moderation_routes from './routes/moderation.js'
import feedback_routes from './routes/feedback.js'
import trades_routes from './routes/trades.js'
import zones_routes from './routes/zones.js'
import qr_routes from './routes/qr.js'
import battles_routes from './routes/battles.js'
import placement_routes from './routes/placement.js'
import ranked_routes from './routes/ranked.js'
import movement_flags_routes from './routes/movement_flags.js'

import pool from './utils/db.js'
import { execute_sql_script } from './utils/sql_utils.js'
import { setup_websocket_router } from './websocket/socket_router.js'
import { log_buffer } from './utils/logs.js'
import { startRotationScheduler } from './placement/rotation_job.js'
import { startSeasonScheduler } from './placement/season_job.js'
import { ensure_ranked_schema } from './db/ranked_schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = process.env.PORT || 3000

app.set('trust proxy', 1)
app.use(express.json())
const allowed_origins = [
	'http://localhost:8055',
	'http://localhost:5173',
	'http://127.0.0.1:5173',
	'http://localhost:3000',
	'http://127.0.0.1:3000',
	'https://website.adamas2aurum.workers.dev',
]
if (process.env.FRONTEND_URL) allowed_origins.push(process.env.FRONTEND_URL)

app.use(
	cors({
		origin: (origin, callback) => {
			if (!origin || allowed_origins.includes(origin)) {
				callback(null, true)
			} else {
				callback(new Error('Not allowed by CORS'))
			}
		},
		credentials: true,
	})
)

if (!process.env.SESSION_SECRET) {
	const msg =
		'SESSION_SECRET is not set — sessions are signed with the public dev fallback secret, so anyone can forge a session cookie. Set SESSION_SECRET in the environment.'
	if (process.env.NODE_ENV === 'production') {
		console.error(
			`\n${'!'.repeat(72)}\n[SECURITY] ${msg}\n${'!'.repeat(72)}\n`
		)
	} else {
		console.warn(`[session] ${msg}`)
	}
}

const MySQLStore = mySQLSession(session)
const sessionStore = new MySQLStore(
	{
		clearExpired: true,
		checkExpirationInterval: 900000, // 15 mins
		expiration: 86400000, // 24 hrs
	},
	pool
)

const session_middleware = session({
	key: 'a2a-session-key',
	secret: process.env.SESSION_SECRET || 'a2a-dev-secret',
	store: sessionStore,
	resave: false,
	saveUninitialized: false,
	cookie: {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite:
			process.env.NODE_ENV === 'production' ? 'none' : 'lax',
		maxAge: 1000 * 60 * 60 * 24, // 24 hours
	},
})
app.use(session_middleware)
app.use((req, res, next) => {
	req.user = req.session?.user || null
	next()
})

// Google OAuth (/api/auth/google, /api/auth/callback/google) first, then
// the username + PIN routes. Paths don't overlap.
app.use('/api/auth', create_oauth_router({ allowed_origins }))
app.use('/api/auth', auth_routes)

// ── SESSION RESOLUTION MIDDLEWARE ──
// Refreshes req.user from the database for whoever is logged in (Google
// and PIN logins both put the user in req.session.user).
app.use(async (req, res, next) => {
	if (req.session?.user?.user_id) {
		try {
			const [users] = await pool.query(
				'SELECT user_id, name, email, avatar_url, points FROM users WHERE user_id = ?',
				[req.session.user.user_id]
			)
			if (users.length) req.user = users[0]
		} catch (err) {
			console.warn('Session resolve error:', err.message)
		}
	}
	next()
})

app.use('/api/events', qr_routes)
app.use('/api/events', pool_routes)
app.use('/api/events', event_routes)
app.use('/api/cards', card_routes)
app.use('/api/trivia', trivia_routes)
app.get('/api/logs', (req, res) => {
	if (req.query.format === 'json') {
		return res.json({ logs: log_buffer })
	}
	res.type('text/plain').send(log_buffer.join('\n'))
})

// User Story 7 — global points leaderboard. Public read; the "/me"
// sub-route is the only part that requires a session.
app.use('/api/leaderboard', leaderboard_routes)
app.use('/api/ranked', ranked_routes)

// User Story 2 (Sprint 2) — offline attempt sync and deferred verification.
// Mounted under /api/trivia so all trivia-related endpoints share a namespace.
app.use('/api/trivia', sync_routes)

app.use('/api/campaigns', campaign_routes)
app.use('/api/analytics', analytics_routes)
app.use('/api/moderation', moderation_routes)
app.use('/api/feedback', feedback_routes)
app.use('/api/trades', trades_routes)
app.use('/api/zones', zones_routes)
app.use('/api/battles', battles_routes)
app.use('/api/placement', placement_routes)
app.use('/api/movement-flags', movement_flags_routes)

app.get('/api/health', async (req, res) => {
	try {
		const [rows] = await pool.query('SHOW TABLES')
		res.json({ success: true, tables: rows })
	} catch (error) {
		res.status(500).json({ success: false, error: error.message })
	}
})

// ---------------------------------------------------------------------------
// Get current authenticated user (used by frontend checkAuthSession)
// ---------------------------------------------------------------------------
app.get('/api/me', async (req, res) => {
	if (!req.user?.user_id) {
		return res.status(401).json({ error: 'Not authenticated' })
	}
	res.json(req.user)
})

// User Story 6 — question authoring. Mounted at /api so the single
// router can serve both /api/events/:eventId/questions and /api/questions/:id.
app.use('/api', question_routes)

// ---------------------------------------------------------------------------
// Static file serving — backend serves the frontend so everything runs
// from the same origin (port 3000), eliminating cross-origin cookie issues.
// ---------------------------------------------------------------------------
const frontendDir = path.join(__dirname, '..', 'frontend')
const pagesDir = path.join(frontendDir, 'pages')

app.use('/css', express.static(path.join(frontendDir, 'css')))
app.use('/js', express.static(path.join(frontendDir, 'js')))
app.use(express.static(path.join(frontendDir, 'public')))

// Main map page
app.get('/index.html', (_req, res) => {
	res.sendFile(path.join(frontendDir, 'index.html'))
})

app.get('/', (_req, res) => {
	res.sendFile(path.join(frontendDir, 'index.html'))
})

// Other HTML pages
app.get('/pages/auth.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'auth.html'))
})
app.get('/pages/collection.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'collection.html'))
})
app.get('/pages/console.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'console.html'))
})
app.get('/pages/events.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'events.html'))
})
app.get('/pages/battle.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'battle.html'))
})
app.get('/pages/leaderboard.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'leaderboard.html'))
})
app.get('/pages/logs.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'logs.html'))
})
app.get('/pages/spectate.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'spectate.html'))
})
app.get('/pages/terms.html', (_req, res) => {
	res.sendFile(path.join(pagesDir, 'terms.html'))
})

// ---------------------------------------------------------------------------
// Database initialization (unchanged from dev)
// ---------------------------------------------------------------------------
async function ensure_curation_schema() {
	// Campaigns table already in schema.sql with IF NOT EXISTS; these
	// ALTERs are guarded so re-running never errors (1060 = duplicate column).
	const alters = [
		`ALTER TABLE events ADD COLUMN curation_status ENUM('DRAFT','IN_REVIEW','PUBLISHED','RETIRED','ARCHIVED') NOT NULL DEFAULT 'DRAFT'`,
		`ALTER TABLE events ADD COLUMN campaign_id INT NULL`,
		`ALTER TABLE events ADD COLUMN retired_at DATETIME NULL`,
		`ALTER TABLE events ADD COLUMN published_at DATETIME NULL`,
	]
	for (const sql of alters) {
		try {
			await pool.query(sql)
		} catch (err) {
			if (
				err.code !== 'ER_DUP_FIELDNAME' &&
				err.errno !== 1060
			)
				console.warn(
					'[curation migration]',
					err.message
				)
		}
	}
	// FK for campaign_id (may already exist)
	try {
		await pool.query(
			`ALTER TABLE events ADD CONSTRAINT fk_event_campaign FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE SET NULL`
		)
	} catch (err) {
		if (
			err.code !== 'ER_DUP_KEY' &&
			err.errno !== 1022 &&
			!String(err.message).includes('Duplicate')
		) {
			// ignore duplicate FK
		}
	}
	// Backfill: existing active events become PUBLISHED so they stay visible
	try {
		await pool.query(
			`UPDATE events SET curation_status = 'PUBLISHED' WHERE curation_status = 'DRAFT' AND is_active = TRUE`
		)
	} catch {}
}

async function ensure_moderation_schema() {
	// Tables are in schema.sql with IF NOT EXISTS for fresh DBs; create them
	// here as well for DBs that were already initialised before this story.
	try {
		await pool.query(`CREATE TABLE IF NOT EXISTS user_trust_scores (
			user_id INT NOT NULL PRIMARY KEY,
			trust_score DECIMAL(5,2) NOT NULL,
			evidence JSON,
			reason TEXT,
			updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			CONSTRAINT fk_uts_user FOREIGN KEY (user_id) REFERENCES users (user_id) ON DELETE CASCADE,
			CONSTRAINT chk_uts_score CHECK (trust_score BETWEEN 0 AND 100)
		)`)
	} catch (e) {
		console.warn(
			'[moderation migration] user_trust_scores',
			e.message
		)
	}
	try {
		await pool.query(`CREATE TABLE IF NOT EXISTS moderation_actions (
			action_id INT AUTO_INCREMENT PRIMARY KEY,
			target_user_id INT NOT NULL,
			moderator_id INT NOT NULL,
			action_type ENUM('WARNING','RESTRICTION','SUSPENSION') NOT NULL,
			reason TEXT,
			evidence JSON,
			duration_days INT,
			expires_at DATETIME,
			created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
			CONSTRAINT fk_ma_target FOREIGN KEY (target_user_id) REFERENCES users (user_id) ON DELETE CASCADE,
			CONSTRAINT fk_ma_mod FOREIGN KEY (moderator_id) REFERENCES users (user_id)
		)`)
	} catch (e) {
		console.warn(
			'[moderation migration] moderation_actions',
			e.message
		)
	}
	const userAlters = [
		`ALTER TABLE users ADD COLUMN moderation_status ENUM('NONE','WARNED','RESTRICTED','SUSPENDED') NOT NULL DEFAULT 'NONE'`,
		`ALTER TABLE users ADD COLUMN moderation_expires_at DATETIME NULL`,
	]
	for (const sql of userAlters) {
		try {
			await pool.query(sql)
		} catch (err) {
			if (
				err.code !== 'ER_DUP_FIELDNAME' &&
				err.errno !== 1060
			)
				console.warn(
					'[moderation migration]',
					err.message
				)
		}
	}
	// Seed mocked trust scores if empty — gives the console a visible queue on first boot
	try {
		const [cnt] = await pool.query(
			`SELECT COUNT(*) AS c FROM user_trust_scores`
		)
		if (cnt[0].c === 0) {
			const [users] = await pool.query(
				`SELECT user_id, email FROM users ORDER BY user_id ASC LIMIT 6`
			)
			if (users.length) {
				// Map: lowest trust = most suspicious; include varied evidence
				const seeds = [
					{
						// bob — low trust, spoof evidence
						idx: users.find(
							(u) =>
								u.email ===
								'bob@example.com'
						)
							? users.findIndex(
									(u) =>
										u.email ===
										'bob@example.com'
								)
							: 1,
						score: 22.5,
						reason: 'Repeated spoofed location + impossible travel',
						evidence: [
							{
								type: 'SPOOFED_LOCATION',
								detail: 'SPOOFED at Constitution Hill (distance 1240m vs 75m radius)',
								event_id: 2,
								distance_meters: 1240,
								status: 'SPOOFED',
								checked_at: '2026-01-04T10:00:00Z',
							},
							{
								type: 'IMPOSSIBLE_TRAVEL',
								detail: '85.5 m/s between Gold Reef City and Constitution Hill (2 min interval)',
								travel_speed_ms: 85.5,
								prev_event_id: 1,
								curr_event_id: 2,
								checked_at: '2026-01-04T10:02:00Z',
							},
							{
								type: 'FAILED_LOCATION',
								detail: 'FAILED check at Origins of Gold Reef City (890m out)',
								event_id: 1,
								distance_meters: 890,
								status: 'FAILED',
								checked_at: '2026-01-03T15:30:00Z',
							},
						],
					},
					{
						// player — moderate low
						idx: users.find(
							(u) =>
								u.email ===
								'player@example.com'
						)
							? users.findIndex(
									(u) =>
										u.email ===
										'player@example.com'
								)
							: 2,
						score: 44.0,
						reason: 'Velocity anomaly + repeated out-of-range attempts',
						evidence: [
							{
								type: 'IMPOSSIBLE_TRAVEL',
								detail: '42.1 m/s travel flagged',
								travel_speed_ms: 42.1,
								checked_at: '2026-01-05T09:12:00Z',
							},
							{
								type: 'FAILED_LOCATION',
								detail: '3 failed location checks in 10 minutes',
								count: 3,
								status: 'FAILED',
								checked_at: '2026-01-05T09:00:00Z',
							},
						],
					},
					{
						// admin test user — mild flag to show WARNING tier
						idx: users.find(
							(u) =>
								u.email ===
								'admin@wits.ac.za'
						)
							? users.findIndex(
									(u) =>
										u.email ===
										'admin@wits.ac.za'
								)
							: 0,
						score: 58.0,
						reason: 'Occasional spoof flag (single incident)',
						evidence: [
							{
								type: 'SPOOFED_LOCATION',
								detail: 'Single SPOOFED log (possible GPS drift)',
								distance_meters: 310,
								status: 'SPOOFED',
								checked_at: '2026-01-02T11:20:00Z',
							},
						],
					},
				]
				for (const s of seeds) {
					const u = users[s.idx]
					if (!u) continue
					await pool.query(
						`INSERT IGNORE INTO user_trust_scores (user_id, trust_score, evidence, reason) VALUES (?, ?, ?, ?)`,
						[
							u.user_id,
							s.score,
							JSON.stringify(
								s.evidence
							),
							s.reason,
						]
					)
				}
				console.log(
					'[moderation migration] seeded mocked trust scores'
				)
			}
		}
	} catch (e) {
		console.warn('[moderation migration] seed', e.message)
	}
	// Ensure demo moderator exists for manual testing (idempotent)
	try {
		const [mods] = await pool.query(
			`SELECT user_id FROM users WHERE email = 'moderator@example.com'`
		)
		if (!mods.length) {
			const [r] = await pool.query(
				`INSERT INTO users (provider_id, email, name) VALUES (?, ?, ?)`,
				[
					'local:moderator@example.com',
					'moderator@example.com',
					'Maya Moderator',
				]
			)
			const hash =
				'03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'
			await pool.query(
				`INSERT INTO user_credentials (user_id, pin_hash) VALUES (?, ?)`,
				[r.insertId, hash]
			)
			await pool.query(
				`INSERT INTO admin_roles (user_id, role, granted_by) VALUES (?, ?, ?)`,
				[r.insertId, 'MODERATOR', 1]
			)
			console.log(
				'[moderation migration] created demo moderator'
			)
		}
	} catch (e) {
		console.warn('[moderation migration] mod user', e.message)
	}
}

async function ensure_placement_schema() {
	// Procedural event placement (Sprint 3). Guarded the same way as
	// ensure_curation_schema — additive ALTERs, safe to re-run every
	// startup, 1060/ER_DUP_FIELDNAME means the column is already there.
	const alters = [
		`ALTER TABLE events ADD COLUMN is_procedural BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE events ADD COLUMN placement_zone VARCHAR(64) NULL`,
	]
	for (const sql of alters) {
		try {
			await pool.query(sql)
		} catch (err) {
			if (
				err.code !== 'ER_DUP_FIELDNAME' &&
				err.errno !== 1060
			)
				console.warn(
					'[placement migration]',
					err.message
				)
		}
	}
}

async function ensure_movement_trust_schema() {
	// Movement trust check (Sprint 2 anti-cheat v1). The flag lives on the
	// location check it describes, next to prev_check_id/travel_speed_ms.
	// Guarded like the other migrations: 1060 = column already there,
	// 1061 = index already there.
	const alters = [
		`ALTER TABLE location_check_log ADD COLUMN movement_flagged BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE location_check_log ADD INDEX idx_lcl_movement_flagged (movement_flagged, checked_at)`,
	]
	for (const sql of alters) {
		try {
			await pool.query(sql)
		} catch (err) {
			if (
				err.code !== 'ER_DUP_FIELDNAME' &&
				err.errno !== 1060 &&
				err.code !== 'ER_DUP_KEYNAME' &&
				err.errno !== 1061
			)
				console.warn(
					'[movement trust migration]',
					err.message
				)
		}
	}
}

async function ensure_performance_indexes() {
	// Milestone 4: geo + attempt lookups. CREATE INDEX is not idempotent
	// in MySQL, so ignore 1061 (duplicate key name) on existing DBs.
	// This boot-time pass is the single source of truth; schema.sql only
	// documents the index list because bare CREATE INDEX is not re-runnable.
	const indexes = [
		`CREATE INDEX idx_events_lat_lng ON events (latitude, longitude)`,
		`CREATE INDEX idx_events_active_window ON events (is_active, starts_at, ends_at)`,
		`CREATE INDEX idx_ta_user_event ON trivia_attempts (user_id, event_id)`,
		`CREATE INDEX idx_lcl_user_checked ON location_check_log (user_id, checked_at)`,
	]
	for (const sql of indexes) {
		try {
			await pool.query(sql)
		} catch (err) {
			if (err.code !== 'ER_DUP_KEYNAME' && err.errno !== 1061)
				console.warn(
					'[performance indexes]',
					err.message
				)
		}
	}
}

async function initialize_database() {
	// Creates tables if they don't exist yet — safe to run every startup,
	// since schema.sql uses CREATE TABLE IF NOT EXISTS and doesn't touch data.
	await execute_sql_script(pool, './db/schema.sql')
	await ensure_curation_schema()
	await ensure_moderation_schema()
	await ensure_placement_schema()
	await ensure_ranked_schema()
	await ensure_movement_trust_schema()
	await ensure_performance_indexes()
}

async function seed_database() {
	// Destructive: TRUNCATEs and re-inserts all seed data. This must NOT run
	// automatically on every `npm run dev`, since the DB is shared across the
	// whole team — one teammate starting their backend would silently wipe
	// out data another teammate is actively testing against (this is what
	// caused login to intermittently fail with "Invalid credentials" even
	// though the seeded PIN was correct).
	//
	// Run explicitly instead: `npm run db:seed`
	await execute_sql_script(pool, './db/seed.sql')
}

async function view_database() {
	console.log(await pool.query('SELECT NOW() as currentTime;'))
	console.log(await pool.query('SHOW DATABASES;'))
	console.log(
		await pool.query(
			`SHOW TABLES FROM ${process.env.DB_NAME || 'testdb'};`
		)
	)
	// console.log(await pool.query('DESCRIBE ${process.env.DB_NAME || 'testdb'}.battle_turns;'))
}

try {
	await initialize_database()

	if (process.env.SEED_DB === 'true') {
		await seed_database()
	}
	if (process.env.LOG_DB === 'true') {
		await view_database()
	}

	// Always on — but never under Jest, where JEST_WORKER_ID is set. A
	// real setInterval hitting a real (test) DB every tick has no place in
	// a unit test run; startRotationScheduler itself is still exercised
	// directly by rotation_job.test.js.
	if (!process.env.JEST_WORKER_ID) {
		startRotationScheduler(pool)
		startSeasonScheduler(pool)
	}
} catch (err) {
	console.error('error: ', err.message)
}

const server = createServer(app)
setup_websocket_router(server, session_middleware)

server.listen(PORT, () => {
	console.log(`A2A backend running on port ${PORT}`)
	console.log(`Open: http://localhost:${PORT}`)
})
