import express from 'express'
import crypto from 'crypto'
import pool from '../utils/db.js'
import { hashPin, verifyPin, isValidPin } from '../utils/pin_hash.js'
import { createLoginLimiter } from '../utils/login_limiter.js'

const router = express.Router()

// Current Terms of Use + Privacy Policy version. Keep in sync with
// TERMS_VERSION in app/src/frontend/js/constants.js — acceptance
// records store this string, and a bump re-prompts every player.
export const TERMS_VERSION = '1.0'

// Failed username + PIN logins, per ip+username and per ip.
export const loginLimiter = createLoginLimiter()

// PIN-reset tokens (Milestone 4: password reset requirement).
// In-memory single-instance store: token -> { user_id, email, expires_at }.
// 15-minute expiry, single-use. For multi-instance production this would
// move to a `password_resets` table — documented in authentication.md.
export const pinResetTokens = new Map()
export const PIN_RESET_TTL_MS = 15 * 60 * 1000

router.use((req, res, next) => {
	console.log(
		`[Auth Router Log] ${new Date().toISOString()} - ${req.method} ${req.originalUrl}`
	)
	next()
})

// LOGIN ROUTE
router.post('/login', async (req, res) => {
	const { email, pin, password } = req.body
	const inputPin = pin || password // accepts pin or password field from frontend
	const userEmail = email ? email.trim().toLowerCase() : ''

	if (!userEmail || !inputPin) {
		return res
			.status(400)
			.json({ error: 'email and pin are required' })
	}

	const ip = req.ip
	const waitMs = loginLimiter.retryAfterMs(ip, userEmail)
	if (waitMs > 0) {
		res.set('Retry-After', String(Math.ceil(waitMs / 1000)))
		return res.status(429).json({
			error: `Too many failed attempts. Try again in ${Math.ceil(waitMs / 60000)} minute(s).`,
		})
	}

	try {
		const [users] = await pool.query(
			'SELECT user_id, name, email FROM users WHERE LOWER(email) = ?',
			[userEmail]
		)

		if (!users.length) {
			loginLimiter.recordFailure(ip, userEmail)
			return res
				.status(401)
				.json({ error: 'Invalid credentials' })
		}

		const user = users[0]

		const [creds] = await pool.query(
			'SELECT pin_hash FROM user_credentials WHERE user_id = ?',
			[user.user_id]
		)

		const { ok, needsRehash } = await verifyPin(
			inputPin,
			creds[0]?.pin_hash
		)
		if (!ok) {
			loginLimiter.recordFailure(ip, userEmail)
			return res
				.status(401)
				.json({ error: 'Invalid credentials' })
		}
		loginLimiter.recordSuccess(ip, userEmail)

		// Upgrade a legacy unsalted SHA-256 hash to scrypt now that we
		// have the plain PIN. A failure here must not block the login.
		if (needsRehash) {
			try {
				await pool.query(
					'UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?',
					[await hashPin(inputPin), user.user_id]
				)
			} catch (err) {
				console.warn(
					'[auth] PIN hash upgrade failed:',
					err.message
				)
			}
		}

		// Store session
		req.session.user = {
			user_id: user.user_id,
			name: user.name,
			username: user.name,
			email: user.email,
		}

		const [roleRows] = await pool.query(
			'SELECT role FROM admin_roles WHERE user_id = ?',
			[user.user_id]
		)

		res.json({
			message: 'Logged in',
			user: {
				...req.session.user,
				roles: roleRows.map((r) => r.role),
			},
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// REGISTER ROUTE
router.post('/register', async (req, res) => {
	const { name, email, password, pin, terms_accepted, terms_version } =
		req.body
	const inputPin = pin || password
	const userEmail = email ? email.trim().toLowerCase() : ''

	if (!name || !userEmail || !inputPin) {
		return res.status(400).json({
			error: 'name, email, and password/pin are required',
		})
	}
	// The username is stored in users.email, which Google sign-in also
	// uses. An email-looking username could claim someone else's
	// address, so new usernames can't contain '@'. (Login still accepts
	// older accounts that have one.)
	if (userEmail.includes('@')) {
		return res.status(400).json({
			error: "Usernames can't contain '@' — to sign in with an email address, use Google.",
		})
	}
	if (!isValidPin(String(inputPin))) {
		return res
			.status(400)
			.json({ error: 'PIN must be 4 to 6 digits' })
	}
	if (terms_accepted !== true || terms_version !== TERMS_VERSION) {
		return res.status(400).json({
			error: `You must accept the Terms of Use (v${TERMS_VERSION}) to create an account`,
		})
	}

	try {
		const [existing] = await pool.query(
			'SELECT user_id FROM users WHERE LOWER(email) = ?',
			[userEmail]
		)

		if (existing.length > 0) {
			return res
				.status(400)
				.json({ error: 'Email already registered' })
		}

		const provider_id = `local:${userEmail}`
		const [result] = await pool.query(
			'INSERT INTO users (provider_id, email, name, points) VALUES (?, ?, ?, 0)',
			[provider_id, userEmail, name.trim()]
		)

		const userId = result.insertId
		const hashedPin = await hashPin(String(inputPin))

		await pool.query(
			'INSERT INTO user_credentials (user_id, pin_hash) VALUES (?, ?)',
			[userId, hashedPin]
		)

		await pool.query(
			'REPLACE INTO user_terms_acceptances (user_id, terms_version) VALUES (?, ?)',
			[userId, TERMS_VERSION]
		)

		req.session.user = {
			user_id: userId,
			name: name.trim(),
			username: name.trim(),
			email: userEmail,
		}

		const [roleRows] = await pool.query(
			'SELECT role FROM admin_roles WHERE user_id = ?',
			[userId]
		)

		res.status(201).json({
			message: 'Account created successfully',
			user: {
				...req.session.user,
				roles: roleRows.map((r) => r.role),
			},
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// SESSION CHECK ROUTE
router.get('/me', async (req, res) => {
	if (!req.session?.user?.user_id) {
		return res.status(401).json({ error: 'Not authenticated' })
	}

	const { user_id, name, email } = req.session.user

	try {
		const [rows] = await pool.query(
			'SELECT role FROM admin_roles WHERE user_id = ?',
			[user_id]
		)

		res.json({
			user_id,
			name,
			email,
			roles: rows.map((r) => r.role),
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// TERMS STATUS ROUTE — has this session's user accepted current terms?
router.get('/terms-status', async (req, res) => {
	if (!req.session?.user?.user_id) {
		return res.status(401).json({ error: 'Not authenticated' })
	}
	try {
		const [rows] = await pool.query(
			'SELECT terms_version, accepted_at FROM user_terms_acceptances WHERE user_id = ?',
			[req.session.user.user_id]
		)
		const accepted =
			rows.length > 0 &&
			rows[0].terms_version === TERMS_VERSION
		res.json({
			accepted,
			accepted_version: rows[0]?.terms_version || null,
			accepted_at: rows[0]?.accepted_at || null,
			current_version: TERMS_VERSION,
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// ACCEPT TERMS ROUTE — records acceptance (Google sign-ins accept here,
// PIN registrations accept inline via POST /register).
router.post('/accept-terms', async (req, res) => {
	if (!req.session?.user?.user_id) {
		return res.status(401).json({ error: 'Not authenticated' })
	}
	const { version } = req.body
	if (version !== TERMS_VERSION) {
		return res.status(400).json({
			error: `version must be the current Terms of Use (v${TERMS_VERSION})`,
		})
	}
	try {
		await pool.query(
			'REPLACE INTO user_terms_acceptances (user_id, terms_version) VALUES (?, ?)',
			[req.session.user.user_id, TERMS_VERSION]
		)
		res.json({
			accepted: true,
			version: TERMS_VERSION,
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// LOGOUT ROUTE
router.post('/logout', (req, res) => {
	req.session.destroy(() => {
		res.clearCookie('a2a-session-key')
		res.json({ message: 'Logged out' })
	})
})

function requireSession(req, res, next) {
	if (!req.session?.user?.user_id) {
		return res.status(401).json({ error: 'Not authenticated' })
	}
	next()
}

// PROFILE ROUTE — display name, login handle, and whether this account
// has a PIN (username + PIN accounts do; Google accounts don't).
router.get('/profile', requireSession, async (req, res) => {
	try {
		const [rows] = await pool.query(
			'SELECT user_id, name, email, provider_id FROM users WHERE user_id = ?',
			[req.session.user.user_id]
		)
		if (!rows.length) {
			return res
				.status(404)
				.json({ error: 'Account not found' })
		}
		const [creds] = await pool.query(
			'SELECT 1 AS has_pin FROM user_credentials WHERE user_id = ?',
			[req.session.user.user_id]
		)
		const u = rows[0]
		res.json({
			user_id: u.user_id,
			name: u.name,
			username: u.email,
			has_pin: creds.length > 0,
			is_local: String(u.provider_id || '').startsWith(
				'local:'
			),
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// EDIT DISPLAY NAME ROUTE — renames what the header avatar and menus
// show. The login handle (username/email) is identity and stays as-is.
router.patch('/profile', requireSession, async (req, res) => {
	const name = String(req.body?.name ?? '').trim()
	if (!name || name.length > 100) {
		return res.status(400).json({
			error: 'Display name must be 1 to 100 characters',
		})
	}
	try {
		const [result] = await pool.query(
			'UPDATE users SET name = ? WHERE user_id = ?',
			[name, req.session.user.user_id]
		)
		if (!result.affectedRows) {
			return res
				.status(404)
				.json({ error: 'Account not found' })
		}
		req.session.user.name = name
		req.session.user.username = name
		res.json({
			message: 'Display name updated',
			user: {
				user_id: req.session.user.user_id,
				name,
				email: req.session.user.email,
			},
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// CHANGE PIN ROUTE — username + PIN accounts only. Google accounts have
// no PIN row, so they get a clear message instead of a cryptic 401.
router.post('/change-pin', requireSession, async (req, res) => {
	const { current_pin, new_pin } = req.body || {}
	if (!current_pin || !new_pin) {
		return res.status(400).json({
			error: 'current_pin and new_pin are required',
		})
	}
	try {
		const [creds] = await pool.query(
			'SELECT pin_hash FROM user_credentials WHERE user_id = ?',
			[req.session.user.user_id]
		)
		if (!creds.length) {
			return res.status(400).json({
				error: 'This account signs in with Google — there is no PIN to change.',
			})
		}
		const { ok } = await verifyPin(
			String(current_pin),
			creds[0]?.pin_hash
		)
		if (!ok) {
			return res
				.status(401)
				.json({ error: 'Current PIN is incorrect' })
		}
		if (!isValidPin(String(new_pin))) {
			return res
				.status(400)
				.json({ error: 'PIN must be 4 to 6 digits' })
		}
		await pool.query(
			'UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?',
			[
				await hashPin(String(new_pin)),
				req.session.user.user_id,
			]
		)
		res.json({ message: 'PIN updated' })
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// DELETE ACCOUNT ROUTE — removes the login (PIN hash, roles, terms
// record) and anonymises the users row so game history keeps referential
// integrity without holding personal data. The player can no longer log
// in; signing in again with Google starts a brand-new empty account.
router.delete('/account', requireSession, async (req, res) => {
	if (req.body?.confirmation !== 'DELETE') {
		return res.status(400).json({
			error: 'Type DELETE to confirm account deletion',
		})
	}
	const userId = req.session.user.user_id
	const conn = await pool.getConnection()
	try {
		await conn.beginTransaction()
		await conn.query(
			'DELETE FROM user_credentials WHERE user_id = ?',
			[userId]
		)
		await conn.query('DELETE FROM admin_roles WHERE user_id = ?', [
			userId,
		])
		await conn.query(
			'UPDATE admin_roles SET granted_by = NULL WHERE granted_by = ?',
			[userId]
		)
		await conn.query(
			'DELETE FROM user_terms_acceptances WHERE user_id = ?',
			[userId]
		)
		const anon = `deleted_${userId}_${Date.now().toString(36)}@deleted.local`
		await conn.query(
			'UPDATE users SET name = ?, email = ?, provider_id = ?, avatar_url = NULL, points = 0 WHERE user_id = ?',
			[
				'Deleted player',
				anon,
				`deleted:${userId}:${Date.now().toString(36)}`,
				userId,
			]
		)
		await conn.commit()
	} catch (err) {
		await conn.rollback()
		conn.release()
		return res.status(500).json({ error: err.message })
	}
	conn.release()
	req.session.destroy(() => {
		res.clearCookie('a2a-session-key')
		res.json({ message: 'Account deleted' })
	})
})

// FORGOT-PIN ROUTE — Milestone 4 password-reset requirement.
// Username + PIN accounts only. Generates a single-use 15-minute token.
// Always returns 200 with a generic message to avoid user enumeration;
// includes `reset_token` in the response so the flow is demonstrable
// without an SMTP server (production would email it instead).
router.post('/forgot-pin', async (req, res) => {
	const email = String(req.body?.email ?? '')
		.trim()
		.toLowerCase()
	if (!email) {
		return res.status(400).json({ error: 'email is required' })
	}
	try {
		const [users] = await pool.query(
			'SELECT user_id, email FROM users WHERE LOWER(email) = ?',
			[email]
		)
		if (!users.length) {
			return res.json({
				message: 'If that username exists, a reset token was created.',
			})
		}
		const [creds] = await pool.query(
			'SELECT user_id FROM user_credentials WHERE user_id = ?',
			[users[0].user_id]
		)
		if (!creds.length) {
			return res.status(400).json({
				error: 'This account signs in with Google — there is no PIN to reset.',
			})
		}
		const token = crypto.randomBytes(32).toString('hex')
		pinResetTokens.set(token, {
			user_id: users[0].user_id,
			email: users[0].email,
			expires_at: Date.now() + PIN_RESET_TTL_MS,
		})
		res.json({
			message: 'If that username exists, a reset token was created.',
			reset_token: token,
			expires_in_s: PIN_RESET_TTL_MS / 1000,
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

// RESET-PIN ROUTE — consumes a forgot-pin token and sets a new PIN.
router.post('/reset-pin', async (req, res) => {
	const email = String(req.body?.email ?? '')
		.trim()
		.toLowerCase()
	const { token, new_pin } = req.body || {}
	if (!email || !token || !new_pin) {
		return res.status(400).json({
			error: 'email, token and new_pin are required',
		})
	}
	if (!isValidPin(String(new_pin))) {
		return res
			.status(400)
			.json({ error: 'PIN must be 4 to 6 digits' })
	}
	const record = pinResetTokens.get(String(token))
	if (!record || record.email.toLowerCase() !== email) {
		return res
			.status(400)
			.json({ error: 'Invalid or expired reset token' })
	}
	if (Date.now() > record.expires_at) {
		pinResetTokens.delete(String(token))
		return res
			.status(400)
			.json({ error: 'Invalid or expired reset token' })
	}
	try {
		await pool.query(
			'UPDATE user_credentials SET pin_hash = ? WHERE user_id = ?',
			[await hashPin(String(new_pin)), record.user_id]
		)
		pinResetTokens.delete(String(token))
		res.json({
			message: 'PIN has been reset — you can now log in.',
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

export default router
