import express from 'express'
import crypto from 'crypto'
import pool from '../utils/db.js'
import {
	google_config,
	create_pkce,
	build_auth_url,
	exchange_code,
	fetch_profile,
} from '../utils/google_oauth.js'
import { resolve_google_user } from '../utils/google_user_sync.js'

// How long the one-time code handed to the frontend stays valid.
export const LOGIN_CODE_TTL_MS = 60 * 1000

// A PKCE S256 challenge is 32 bytes of SHA-256, base64url = 43 characters.
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/

/**
 * Only same-site paths and configured frontend origins are valid
 * post-login destinations — anything else would be an open redirect.
 */
export function safe_return_to(value, allowed_origins = []) {
	if (typeof value !== 'string' || !value) return '/'
	if (
		value.startsWith('/') &&
		!value.startsWith('//') &&
		!value.startsWith('/\\')
	)
		return value
	try {
		const url = new URL(value)
		if (allowed_origins.includes(url.origin)) return url.toString()
	} catch {
		// not a URL
	}
	return '/'
}

function with_query(target, params) {
	const base = 'http://relative.invalid'
	const url = new URL(target, base)
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
	return url.origin === base
		? url.pathname + url.search + url.hash
		: url.toString()
}

const states_match = (a, b) => {
	const x = Buffer.from(String(a))
	const y = Buffer.from(String(b))
	return x.length === y.length && crypto.timingSafeEqual(x, y)
}

const promisify = (fn) =>
	new Promise((resolve, reject) =>
		fn((err) => (err ? reject(err) : resolve()))
	)

/**
 * Google sign-in.
 *
 *   GET  /api/auth/google?challenge=<S256>[&return_to=<url>]
 *   GET  /api/auth/callback/google          (Google redirects here)
 *   POST /api/auth/oauth/exchange {code, verifier}
 *
 * Why the extra exchange step: the callback runs as a top-level visit to
 * the BACKEND's site. When the frontend lives on a different site (e.g.
 * workers.dev vs onrender.com) browsers keep a cookie set at that moment
 * separate from the one the frontend's own requests use (Firefox, Safari,
 * Chrome Incognito), so the frontend would never be logged in. Instead
 * the callback redirects to the frontend with a short-lived single-use
 * code, and the frontend trades it for the session cookie with a normal
 * fetch — the same way PIN login sets its cookie.
 *
 * The frontend creates a random verifier, sends only its SHA-256
 * (challenge) when starting, and must present the verifier to redeem the
 * code, so an intercepted or planted code is useless to anyone else.
 *
 * After the exchange the user sits in the same express-session slot
 * (req.session.user) PIN login uses, so every existing route is unchanged.
 * Failures redirect back to return_to with ?auth_error=<message>.
 */
export function create_oauth_router({
	allowed_origins = [],
	db = pool,
	get_config = google_config,
	fetchImpl = fetch,
} = {}) {
	const router = express.Router()

	// code -> { user_id, challenge, expires }. In memory on purpose: codes
	// live 60 seconds and are single-use. (With several server instances
	// the callback and the exchange could hit different ones; this app
	// runs one.)
	const login_codes = new Map()
	const purge_expired = () => {
		const now = Date.now()
		for (const [code, entry] of login_codes)
			if (entry.expires <= now) login_codes.delete(code)
	}

	const startup_cfg = get_config()
	if (!startup_cfg) {
		console.warn(
			'[oauth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is disabled.'
		)
	} else {
		// Must be listed verbatim under "Authorized redirect URIs" for this
		// OAuth client in Google Cloud Console, or Google answers
		// "Error 400: redirect_uri_mismatch".
		console.log(
			`[oauth] Google redirect URI: ${startup_cfg.redirectUri}`
		)
	}

	router.get('/google', async (req, res) => {
		const cfg = get_config()
		if (!cfg) {
			return res.status(503).json({
				error: 'Google sign-in is not configured',
			})
		}
		const client_challenge = req.query.challenge
		if (
			typeof client_challenge !== 'string' ||
			!CHALLENGE_RE.test(client_challenge)
		) {
			return res
				.status(400)
				.json({
					error: 'A valid sign-in challenge is required',
				})
		}
		const state = crypto.randomBytes(16).toString('base64url')
		const { verifier, challenge } = create_pkce()
		req.session.oauth = {
			state,
			verifier,
			client_challenge,
			return_to: safe_return_to(
				req.query.return_to,
				allowed_origins
			),
		}
		try {
			await promisify((cb) => req.session.save(cb))
		} catch (err) {
			console.warn(
				'[oauth] session save failed:',
				err.message
			)
			return res
				.status(500)
				.json({ error: 'Could not start sign-in' })
		}
		res.redirect(build_auth_url(cfg, { state, challenge }))
	})

	router.get('/callback/google', async (req, res) => {
		const pending = req.session?.oauth
		if (pending) delete req.session.oauth // single use
		const return_to = pending?.return_to || '/'
		const fail = (message) =>
			res.redirect(
				with_query(return_to, { auth_error: message })
			)

		const cfg = get_config()
		if (!cfg) return fail('Google sign-in is not configured')
		if (req.query.error) return fail('Google sign-in was cancelled')
		if (
			!pending ||
			typeof req.query.state !== 'string' ||
			!states_match(req.query.state, pending.state)
		) {
			return fail('Sign-in expired. Please try again.')
		}
		if (typeof req.query.code !== 'string' || !req.query.code)
			return fail('Google sign-in failed. Please try again.')

		try {
			const token = await exchange_code(
				cfg,
				req.query.code,
				pending.verifier,
				fetchImpl
			)
			const profile = await fetch_profile(token, fetchImpl)
			if (!profile?.sub || !profile.email)
				return fail(
					'Google did not return an email address.'
				)
			// An unverified email must never be matched to a local account.
			if (profile.email_verified !== true)
				return fail(
					'Your Google email address is not verified.'
				)

			const resolved = await resolve_google_user(db, profile)
			if (resolved.conflict) return fail(resolved.conflict)

			// Hand the frontend a one-time code; it redeems it at
			// /oauth/exchange (see the note above).
			purge_expired()
			const login_code = crypto
				.randomBytes(32)
				.toString('base64url')
			login_codes.set(login_code, {
				user_id: resolved.user.user_id,
				challenge: pending.client_challenge,
				expires: Date.now() + LOGIN_CODE_TTL_MS,
			})
			res.redirect(
				with_query(return_to, { auth_code: login_code })
			)
		} catch (err) {
			console.warn(
				'[oauth] Google sign-in failed:',
				err.message
			)
			fail('Google sign-in failed. Please try again.')
		}
	})

	router.post('/oauth/exchange', async (req, res) => {
		const { code, verifier } = req.body || {}
		if (typeof code !== 'string' || typeof verifier !== 'string')
			return res
				.status(400)
				.json({
					error: 'code and verifier are required',
				})

		purge_expired()
		const entry = login_codes.get(code)
		login_codes.delete(code) // single use, whether or not it checks out
		const challenge = crypto
			.createHash('sha256')
			.update(verifier)
			.digest('base64url')
		if (
			!entry ||
			entry.expires <= Date.now() ||
			!states_match(challenge, entry.challenge)
		) {
			return res.status(401).json({
				error: 'Invalid or expired sign-in code. Please try again.',
			})
		}

		try {
			const [rows] = await db.query(
				'SELECT user_id, name, email, avatar_url, points FROM users WHERE user_id = ?',
				[entry.user_id]
			)
			if (!rows.length)
				return res
					.status(401)
					.json({ error: 'Account not found' })

			// New session id on login (prevents session fixation).
			await promisify((cb) => req.session.regenerate(cb))
			req.session.user = rows[0]
			await promisify((cb) => req.session.save(cb))
			res.json(rows[0])
		} catch (err) {
			console.warn(
				'[oauth] code exchange failed:',
				err.message
			)
			res.status(500).json({
				error: 'Could not complete sign-in',
			})
		}
	})

	return router
}

export default create_oauth_router
