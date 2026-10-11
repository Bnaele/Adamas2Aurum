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
 * Google sign-in. On success the user is stored in the same
 * express-session slot (req.session.user) that PIN login uses, so every
 * existing route works unchanged.
 */
export function create_oauth_router({
	allowed_origins = [],
	db = pool,
	get_config = google_config,
	fetchImpl = fetch,
} = {}) {
	const router = express.Router()

	if (!get_config()) {
		console.warn(
			'[oauth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in is disabled.'
		)
	}

	router.get('/google', async (req, res) => {
		const cfg = get_config()
		if (!cfg) {
			return res.status(503).json({
				error: 'Google sign-in is not configured',
			})
		}
		const state = crypto.randomBytes(16).toString('base64url')
		const { verifier, challenge } = create_pkce()
		req.session.oauth = {
			state,
			verifier,
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

			// New session id on login (prevents session fixation).
			await promisify((cb) => req.session.regenerate(cb))
			req.session.user = resolved.user
			await promisify((cb) => req.session.save(cb))
			res.redirect(return_to)
		} catch (err) {
			console.warn(
				'[oauth] Google sign-in failed:',
				err.message
			)
			fail('Google sign-in failed. Please try again.')
		}
	})

	return router
}

export default create_oauth_router
