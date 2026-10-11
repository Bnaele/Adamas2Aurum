/**
 * Minimal Google OAuth 2.0 helpers (authorization-code flow + PKCE).
 * No SDK needed: it is one redirect, one token POST and one userinfo GET.
 */
import crypto from 'crypto'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_USERINFO_URL =
	'https://openidconnect.googleapis.com/v1/userinfo'

const REQUEST_TIMEOUT_MS = 8000

/**
 * Reads the Google client config from the environment, or null when
 * Google sign-in isn't configured.
 *
 * The redirect URI is <BASE_URL>/api/auth/callback/google — the same path
 * Better Auth used, so the authorised redirect URI in Google Cloud
 * Console doesn't need to change. BETTER_AUTH_URL is accepted as a
 * fallback so an existing deployment keeps working until BASE_URL is set.
 */
export function google_config(env = process.env) {
	const clientId = env.GOOGLE_CLIENT_ID
	const clientSecret = env.GOOGLE_CLIENT_SECRET
	if (!clientId || !clientSecret) return null
	const base = (
		env.BASE_URL ||
		env.BETTER_AUTH_URL ||
		'http://localhost:3000'
	).replace(/\/+$/, '')
	return {
		clientId,
		clientSecret,
		redirectUri: `${base}/api/auth/callback/google`,
	}
}

export function create_pkce() {
	const verifier = crypto.randomBytes(32).toString('base64url')
	const challenge = crypto
		.createHash('sha256')
		.update(verifier)
		.digest('base64url')
	return { verifier, challenge }
}

export function build_auth_url(cfg, { state, challenge }) {
	const url = new URL(GOOGLE_AUTH_URL)
	url.search = new URLSearchParams({
		client_id: cfg.clientId,
		redirect_uri: cfg.redirectUri,
		response_type: 'code',
		scope: 'openid email profile',
		state,
		code_challenge: challenge,
		code_challenge_method: 'S256',
		prompt: 'select_account',
	}).toString()
	return url.toString()
}

/** Exchanges the authorization code for an access token. */
export async function exchange_code(cfg, code, verifier, fetchImpl = fetch) {
	const res = await fetchImpl(GOOGLE_TOKEN_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
		},
		body: new URLSearchParams({
			code,
			client_id: cfg.clientId,
			client_secret: cfg.clientSecret,
			redirect_uri: cfg.redirectUri,
			grant_type: 'authorization_code',
			code_verifier: verifier,
		}),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok)
		throw new Error(`Google token exchange failed (${res.status})`)
	const body = await res.json()
	if (!body.access_token)
		throw new Error('Google token response had no access_token')
	return body.access_token
}

/** @returns {Promise<{sub: string, email: string, email_verified: boolean, name?: string, picture?: string}>} */
export async function fetch_profile(accessToken, fetchImpl = fetch) {
	const res = await fetchImpl(GOOGLE_USERINFO_URL, {
		headers: { Authorization: `Bearer ${accessToken}` },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	})
	if (!res.ok)
		throw new Error(
			`Google userinfo request failed (${res.status})`
		)
	return res.json()
}
