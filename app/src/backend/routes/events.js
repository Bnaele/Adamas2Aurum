import express from 'express'

import pool from '../utils/db.js'
import { error, success } from '../utils/response.js'

const VALID_CURATION = [
	'DRAFT',
	'IN_REVIEW',
	'PUBLISHED',
	'RETIRED',
	'ARCHIVED',
]
const TRANSITIONS = {
	DRAFT: ['IN_REVIEW', 'ARCHIVED'],
	IN_REVIEW: ['PUBLISHED', 'DRAFT', 'ARCHIVED'],
	PUBLISHED: ['RETIRED', 'ARCHIVED', 'IN_REVIEW'],
	RETIRED: ['ARCHIVED', 'PUBLISHED'],
	ARCHIVED: ['DRAFT'],
}

async function hasCurationColumn() {
	try {
		const [rows] = await pool.query(
			`SHOW COLUMNS FROM events LIKE 'curation_status'`
		)
		return rows.length > 0
	} catch {
		return false
	}
}
async function hasCampaignColumn() {
	try {
		const [rows] = await pool.query(
			`SHOW COLUMNS FROM events LIKE 'campaign_id'`
		)
		return rows.length > 0
	} catch {
		return false
	}
}

const router = express.Router()

/**
 * Normalize an incoming datetime to a UTC 'YYYY-MM-DD HH:MM:SS' string
 * for DATETIME storage. The console sends UTC ISO strings; naive
 * 'YYYY-MM-DDTHH:MM' wall times (old clients, manual API use) are read
 * as server-local. Returns null for empty/invalid input.
 * DATETIME columns carry no zone, so everything must be UTC — the
 * public window filter compares against UTC_TIMESTAMP().
 */
function toUtcDatetime(value) {
	if (value == null || value === '') return null
	const d = new Date(value)
	if (isNaN(d)) return null
	const p = (n) => String(n).padStart(2, '0')
	return (
		`${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
		` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
	)
}

router.use((req, res, next) => {
	console.log(
		`[Events Router Log] ${new Date().toISOString()} - ${req.method} ${req.originalUrl}`
	)
	next()
})

function requireAuth(req, res, next) {
	const userId = req.session?.user?.user_id || req.user?.user_id
	if (!userId) {
		return res
			.status(401)
			.json({ error: 'Unauthorised — please log in' })
	}
	if (!req.user) {
		req.user = req.session.user
	}
	next()
}

/**
 * Ensure the authenticated user holds at least one authoring role.
 * FIXED: converted callback-style pool.query -> async/await so the
 * middleware actually calls next() instead of hanging forever.
 */
async function requireEventAuthor(req, res, next) {
	const allowedRoles = ['SUPER_ADMIN', 'EVENT_AUTHOR']
	const placeholders = allowedRoles.map(() => '?').join(', ')

	const sql = `
    SELECT 1 FROM admin_roles
    WHERE user_id = ?
      AND role IN (${placeholders})
    LIMIT 1
  `

	try {
		const [rows] = await pool.query(sql, [
			req.user.user_id,
			...allowedRoles,
		])
		if (!rows.length) {
			return res.status(403).json({
				error: 'Forbidden — event author role required',
			})
		}
		next()
	} catch (err) {
		return res.status(500).json({ error: err.message })
	}
}

router.get('/', async (req, res) => {
	try {
		// Author-only: return every event (including inactive / future) for management
		if (req.query.all === 'true') {
			const userId =
				req.session?.user?.user_id || req.user?.user_id
			if (!userId) {
				return res.status(401).json({
					error: 'Unauthorised — please log in',
				})
			}

			const [roles] = await pool.query(
				`SELECT 1 FROM admin_roles 
				 WHERE user_id = ? AND role IN (?, ?) 
				 LIMIT 1`,
				[userId, 'SUPER_ADMIN', 'EVENT_AUTHOR']
			)

			if (!roles.length) {
				return res.status(403).json({
					error: 'Forbidden — event author access required',
				})
			}

			const [results] = await pool.query(
				'SELECT * FROM events ORDER BY created_at DESC'
			)
			return res.json(results)
		}

		// Public: only PUBLISHED + active AND inside time window.
		// If curation column not yet migrated, gracefully fallback to old check.
		const curationExists = await hasCurationColumn()
		let results
		if (curationExists) {
			const [rows] = await pool.query(
				`SELECT * FROM events 
				 WHERE is_active = TRUE 
				   AND curation_status = 'PUBLISHED'
				   AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP()) 
				   AND (ends_at IS NULL OR ends_at >= UTC_TIMESTAMP())`
			)
			results = rows
		} else {
			const [rows] = await pool.query(
				`SELECT * FROM events 
				 WHERE is_active = TRUE 
				   AND (starts_at IS NULL OR starts_at <= UTC_TIMESTAMP()) 
				   AND (ends_at IS NULL OR ends_at >= UTC_TIMESTAMP())`
			)
			results = rows
		}
		// Per-player completion flags (fail-open: anonymous or legacy DBs
		// get the plain list). "Done" = a counted win: a correct answer
		// on a VERIFIED / FALLBACK_QR location check, or a card award row
		// (which itself implies a verified win). A correct-but-too-far
		// attempt records is_correct=1 with 0 points and must NOT hide
		// the event, so the location join matters.
		const userId = req.session?.user?.user_id || req.user?.user_id
		if (userId) {
			try {
				const [done] = await pool.query(
					`SELECT event_id, MAX(completed_at) AS completed_at FROM (
						SELECT ta.event_id, ta.attempted_at AS completed_at
						FROM trivia_attempts ta
						JOIN location_check_log l ON l.check_id = ta.location_check_id
						WHERE ta.user_id = ? AND ta.is_correct = 1
						  AND l.status IN ('VERIFIED', 'FALLBACK_QR')
						UNION
						SELECT eca.event_id, eca.awarded_at AS completed_at
						FROM event_card_awards eca WHERE eca.user_id = ?
					) done GROUP BY event_id`,
					[userId, userId]
				)
				const doneById = new Map(
					done.map((d) => [
						d.event_id,
						d.completed_at,
					])
				)
				results = results.map((ev) =>
					doneById.has(ev.event_id)
						? {
								...ev,
								completed: true,
								completed_at:
									doneById.get(
										ev.event_id
									),
							}
						: { ...ev, completed: false }
				)
			} catch {
				// e.g. table missing on an old DB — serve list without flags
			}
		}
		res.json(results)
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

router.get('/:id', async (req, res) => {
	try {
		const [results] = await pool.query(
			'SELECT * FROM events WHERE event_id = ?',
			[req.params.id]
		)
		if (!results.length) {
			return res
				.status(404)
				.json({ error: 'Event not found' })
		}
		res.json(results[0])
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

router.post('/', requireAuth, requireEventAuthor, async (req, res) => {
	const {
		title,
		description,
		latitude,
		longitude,
		radius_meters,
		point_threshold,
		point_reward,
		starts_at,
		ends_at,
		repeat_interval,
		attempt_cooldown_s,
		max_attempts_per_window,
		is_active,
		curation_status,
		campaign_id,
	} = req.body

	if (!title || latitude == null || longitude == null || !radius_meters) {
		return res.status(400).json({
			error: 'title, latitude, longitude and radius_meters are required',
		})
	}
	if (curation_status && !VALID_CURATION.includes(curation_status)) {
		return res.status(400).json({
			error: `curation_status must be one of ${VALID_CURATION.join(', ')}`,
		})
	}

	const curationExists = await hasCurationColumn()
	const campaignExists = await hasCampaignColumn()

	let sql, values
	if (curationExists && campaignExists) {
		sql = `
    INSERT INTO events (
      title, description,
      latitude, longitude, radius_meters,
      point_threshold, point_reward,
      starts_at, ends_at,
      repeat_interval, attempt_cooldown_s, max_attempts_per_window,
      is_active, author_id, curation_status, campaign_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
		values = [
			title,
			description ?? null,
			latitude,
			longitude,
			radius_meters,
			point_threshold ?? 0,
			point_reward ?? 10,
			toUtcDatetime(starts_at),
			toUtcDatetime(ends_at),
			repeat_interval ?? null,
			attempt_cooldown_s ?? 86400,
			max_attempts_per_window ?? 1,
			is_active ?? true,
			req.user.user_id,
			curation_status ?? 'DRAFT',
			campaign_id ?? null,
		]
	} else if (curationExists) {
		sql = `
    INSERT INTO events (
      title, description,
      latitude, longitude, radius_meters,
      point_threshold, point_reward,
      starts_at, ends_at,
      repeat_interval, attempt_cooldown_s, max_attempts_per_window,
      is_active, author_id, curation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
		values = [
			title,
			description ?? null,
			latitude,
			longitude,
			radius_meters,
			point_threshold ?? 0,
			point_reward ?? 10,
			toUtcDatetime(starts_at),
			toUtcDatetime(ends_at),
			repeat_interval ?? null,
			attempt_cooldown_s ?? 86400,
			max_attempts_per_window ?? 1,
			is_active ?? true,
			req.user.user_id,
			curation_status ?? 'DRAFT',
		]
	} else {
		sql = `
    INSERT INTO events (
      title, description,
      latitude, longitude, radius_meters,
      point_threshold, point_reward,
      starts_at, ends_at,
      repeat_interval, attempt_cooldown_s, max_attempts_per_window,
      is_active, author_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
		values = [
			title,
			description ?? null,
			latitude,
			longitude,
			radius_meters,
			point_threshold ?? 0,
			point_reward ?? 10,
			toUtcDatetime(starts_at),
			toUtcDatetime(ends_at),
			repeat_interval ?? null,
			attempt_cooldown_s ?? 86400,
			max_attempts_per_window ?? 1,
			is_active ?? true,
			req.user.user_id,
		]
	}

	try {
		const [result] = await pool.query(sql, values)
		res.status(201).json({
			message: 'Event created',
			event_id: result.insertId,
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

router.put('/:id', requireAuth, requireEventAuthor, async (req, res) => {
	const {
		title,
		description,
		latitude,
		longitude,
		radius_meters,
		point_threshold,
		point_reward,
		starts_at,
		ends_at,
		repeat_interval,
		attempt_cooldown_s,
		max_attempts_per_window,
		is_active,
		curation_status,
		campaign_id,
	} = req.body

	if (curation_status && !VALID_CURATION.includes(curation_status)) {
		return res.status(400).json({
			error: `curation_status must be one of ${VALID_CURATION.join(', ')}`,
		})
	}

	try {
		// If curation_status is being changed, validate transition
		if (curation_status) {
			const curationExists = await hasCurationColumn()
			if (curationExists) {
				const [cur] = await pool.query(
					`SELECT curation_status FROM events WHERE event_id = ?`,
					[req.params.id]
				)
				if (cur.length) {
					const from = cur[0].curation_status
					if (
						from !== curation_status &&
						!(
							TRANSITIONS[from] || []
						).includes(curation_status)
					) {
						return res.status(400).json({
							error: `Invalid transition ${from} → ${curation_status}. Allowed: ${(TRANSITIONS[from] || []).join(', ') || 'none'}`,
						})
					}
				}
			}
		}

		const curationExists = await hasCurationColumn()
		const campaignExists = await hasCampaignColumn()

		let sql, values
		if (curationExists && campaignExists) {
			sql = `
    UPDATE events SET title=?, description=?, latitude=?, longitude=?, radius_meters=?, point_threshold=?, point_reward=?, starts_at=?, ends_at=?, repeat_interval=?, attempt_cooldown_s=?, max_attempts_per_window=?, is_active=?, curation_status=?, campaign_id=? WHERE event_id = ?
  `
			values = [
				title,
				description ?? null,
				latitude,
				longitude,
				radius_meters,
				point_threshold ?? 0,
				point_reward ?? 10,
				toUtcDatetime(starts_at),
				toUtcDatetime(ends_at),
				repeat_interval ?? null,
				attempt_cooldown_s ?? 86400,
				max_attempts_per_window ?? 1,
				is_active ?? true,
				curation_status ?? 'DRAFT',
				campaign_id ?? null,
				req.params.id,
			]
		} else if (curationExists) {
			sql = `UPDATE events SET title=?, description=?, latitude=?, longitude=?, radius_meters=?, point_threshold=?, point_reward=?, starts_at=?, ends_at=?, repeat_interval=?, attempt_cooldown_s=?, max_attempts_per_window=?, is_active=?, curation_status=? WHERE event_id = ?`
			values = [
				title,
				description ?? null,
				latitude,
				longitude,
				radius_meters,
				point_threshold ?? 0,
				point_reward ?? 10,
				toUtcDatetime(starts_at),
				toUtcDatetime(ends_at),
				repeat_interval ?? null,
				attempt_cooldown_s ?? 86400,
				max_attempts_per_window ?? 1,
				is_active ?? true,
				curation_status ?? 'DRAFT',
				req.params.id,
			]
		} else {
			sql = `UPDATE events SET title=?, description=?, latitude=?, longitude=?, radius_meters=?, point_threshold=?, point_reward=?, starts_at=?, ends_at=?, repeat_interval=?, attempt_cooldown_s=?, max_attempts_per_window=?, is_active=? WHERE event_id = ?`
			values = [
				title,
				description ?? null,
				latitude,
				longitude,
				radius_meters,
				point_threshold ?? 0,
				point_reward ?? 10,
				toUtcDatetime(starts_at),
				toUtcDatetime(ends_at),
				repeat_interval ?? null,
				attempt_cooldown_s ?? 86400,
				max_attempts_per_window ?? 1,
				is_active ?? true,
				req.params.id,
			]
		}

		const [result] = await pool.query(sql, values)
		if (!result.affectedRows)
			return res
				.status(404)
				.json({ error: 'Event not found' })
		res.json({ message: 'Event updated' })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

router.delete('/:id', requireAuth, requireEventAuthor, async (req, res) => {
	try {
		const [result] = await pool.query(
			'DELETE FROM events WHERE event_id = ?',
			[req.params.id]
		)
		if (!result.affectedRows) {
			return res
				.status(404)
				.json({ error: 'Event not found' })
		}
		res.json({ message: 'Event deleted' })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// ── Curation workflow: transition status ──
router.post(
	'/:id/transition',
	requireAuth,
	requireEventAuthor,
	async (req, res) => {
		const { to } = req.body
		if (!to || !VALID_CURATION.includes(to))
			return res.status(400).json({
				error: `to must be one of ${VALID_CURATION.join(', ')}`,
			})
		try {
			const curationExists = await hasCurationColumn()
			if (!curationExists)
				return res.status(400).json({
					error: 'Curation not yet enabled — run migration',
				})
			const [rows] = await pool.query(
				`SELECT curation_status FROM events WHERE event_id = ?`,
				[req.params.id]
			)
			if (!rows.length)
				return res
					.status(404)
					.json({ error: 'Event not found' })
			const from = rows[0].curation_status
			if (from === to)
				return res.json({ message: `Already ${to}` })
			if (!(TRANSITIONS[from] || []).includes(to)) {
				return res.status(400).json({
					error: `Invalid transition ${from} → ${to}. Allowed: ${(TRANSITIONS[from] || []).join(', ') || 'none'}`,
				})
			}
			// PUBLISHED requires at least one question
			if (to === 'PUBLISHED') {
				const [qs] = await pool.query(
					`SELECT COUNT(*) AS c FROM trivia_questions WHERE event_id = ?`,
					[req.params.id]
				)
				if (qs[0].c === 0)
					return res.status(400).json({
						error: 'Cannot publish without at least one question. Add questions first.',
					})
			}
			await pool.query(
				`UPDATE events SET curation_status = ? WHERE event_id = ?`,
				[to, req.params.id]
			)
			res.json({ message: `Transitioned ${from} → ${to}` })
		} catch (err) {
			res.status(500).json({ error: err.message })
		}
	}
)

// Retire endpoint (alias to transition to RETIRED)
router.post(
	'/:id/retire',
	requireAuth,
	requireEventAuthor,
	async (req, res) => {
		try {
			const curationExists = await hasCurationColumn()
			if (!curationExists)
				return res.status(400).json({
					error: 'Curation not yet enabled',
				})
			const [rows] = await pool.query(
				`SELECT curation_status FROM events WHERE event_id = ?`,
				[req.params.id]
			)
			if (!rows.length)
				return res
					.status(404)
					.json({ error: 'Event not found' })
			// Retire is only valid from PUBLISHED (the one TRANSITIONS
			// path into RETIRED) — retiring a DRAFT/ARCHIVED event
			// would skip the curation workflow.
			const from = rows[0].curation_status
			if (from === 'RETIRED')
				return res.json({ message: 'Already RETIRED' })
			if (from !== 'PUBLISHED')
				return res.status(400).json({
					error: `Invalid transition ${from} → RETIRED. Only PUBLISHED events can be retired.`,
				})
			await pool.query(
				`UPDATE events SET curation_status = 'RETIRED', is_active = FALSE WHERE event_id = ?`,
				[req.params.id]
			)
			res.json({ message: 'Event retired' })
		} catch (err) {
			res.status(500).json({ error: err.message })
		}
	}
)

export default router
