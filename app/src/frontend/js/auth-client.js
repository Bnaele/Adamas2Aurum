/**
 * Auth client wrapper — provides simple functions for the auth drawer.
 *
 * Username + PIN login uses the PIN/session routes in /api/auth.
 *
 * Google sign-in is a full-page redirect through the backend
 * (routes/oauth.js). The backend can't log the browser in itself at the end
 * of that redirect: when the frontend and backend are on different sites,
 * browsers keep a cookie set during the redirect separate from the one our
 * fetch() calls use. So the backend sends us back with a one-time
 * ?auth_code=..., and completeGoogleSignIn() trades it for the session
 * cookie with a normal fetch — the same way PIN login gets its cookie.
 * A random verifier (kept in sessionStorage, only its SHA-256 sent to the
 * backend up front) ties the code to this browser tab.
 */
import { API_BASE, TERMS_VERSION } from './constants.js'

const AUTH_API = `${API_BASE}/api/auth`

export async function usernameSignIn(username, pin) {
	try {
		const res = await fetch(`${AUTH_API}/login`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: username, pin }),
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || 'Login failed')
		return { data: data.user, error: null }
	} catch (error) {
		return { data: null, error }
	}
}

export async function usernameSignUp(
	name,
	username,
	pin,
	termsAccepted = false
) {
	try {
		const res = await fetch(`${AUTH_API}/register`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name,
				email: username,
				pin,
				terms_accepted: termsAccepted,
				terms_version: TERMS_VERSION,
			}),
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(data.error || 'Registration failed')
		return { data: data.user, error: null }
	} catch (error) {
		return { data: null, error }
	}
}

export async function getTermsStatus() {
	try {
		const res = await fetch(`${AUTH_API}/terms-status`, {
			credentials: 'include',
		})
		if (!res.ok)
			return { data: null, error: new Error('no session') }
		return { data: await res.json(), error: null }
	} catch (error) {
		return { data: null, error }
	}
}

export async function acceptTerms() {
	try {
		const res = await fetch(`${AUTH_API}/accept-terms`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ version: TERMS_VERSION }),
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(
				data.error || 'Could not record acceptance'
			)
		return { data, error: null }
	} catch (error) {
		return { data: null, error }
	}
}

const VERIFIER_KEY = 'a2a_google_verifier'

function base64url(bytes) {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

async function sha256_base64url(text) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text)
	)
	return base64url(new Uint8Array(digest))
}

export async function googleSignIn() {
	try {
		const bytes = new Uint8Array(32)
		crypto.getRandomValues(bytes)
		const verifier = base64url(bytes)
		const challenge = await sha256_base64url(verifier)
		sessionStorage.setItem(VERIFIER_KEY, verifier)

		// Back to the main map after Google — the same page username + PIN
		// login lands players on (redirectAfterLogin in auth-helpers.js).
		// The backend only accepts return_to values on origins in its CORS
		// allow-list, and reports failures as ?auth_error=<message> on it.
		const returnTo = new URL('/', window.location.origin).href
		const url =
			`${AUTH_API}/google?return_to=${encodeURIComponent(returnTo)}` +
			`&challenge=${challenge}`
		window.location.href = url
		// Same { data, error } shape as usernameSignIn/usernameSignUp so the
		// auth drawer's handler is unchanged.
		return { data: { url }, error: null }
	} catch (error) {
		return { data: null, error }
	}
}

/**
 * Call on page load. If the URL carries ?auth_code=... (we are returning
 * from Google), remove it from the address bar and redeem it for the
 * session cookie. Resolves to null when there is no code to redeem.
 */
export async function completeGoogleSignIn() {
	const params = new URLSearchParams(window.location.search)
	const code = params.get('auth_code')
	if (!code) return null

	params.delete('auth_code')
	const qs = params.toString()
	history.replaceState(
		null,
		'',
		window.location.pathname +
			(qs ? `?${qs}` : '') +
			window.location.hash
	)

	const verifier = sessionStorage.getItem(VERIFIER_KEY)
	sessionStorage.removeItem(VERIFIER_KEY)
	try {
		if (!verifier)
			throw new Error(
				'Sign-in was started in a different tab or browser. Please try again.'
			)
		const res = await fetch(`${AUTH_API}/oauth/exchange`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code, verifier }),
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || 'Google sign-in failed')
		return { data, error: null }
	} catch (error) {
		return { data: null, error }
	}
}

/** Clear the express-session cookie too. */
export async function clearBridgeSession() {
	await fetch(`${AUTH_API}/logout`, {
		method: 'POST',
		credentials: 'include',
	})
}

/** Request a PIN-reset token (password-reset requirement). */
export async function requestPinReset(username) {
	try {
		const res = await fetch(`${AUTH_API}/forgot-pin`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email: username }),
		})
		const data = await res.json()
		if (!res.ok)
			throw new Error(data.error || 'Reset request failed')
		return { data, error: null }
	} catch (error) {
		return { data: null, error }
	}
}

/** Consume a PIN-reset token and set a new PIN. */
export async function confirmPinReset(username, token, newPin) {
	try {
		const res = await fetch(`${AUTH_API}/reset-pin`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				email: username,
				token,
				new_pin: newPin,
			}),
		})
		const data = await res.json()
		if (!res.ok) throw new Error(data.error || 'Reset failed')
		return { data, error: null }
	} catch (error) {
		return { data: null, error }
	}
}
