/**
 * Auth client wrapper — provides simple functions for the auth drawer.
 *
 * Username + PIN login uses the PIN/session routes in /api/auth. Google
 * sign-in is a full-page redirect: the backend (routes/oauth.js) sends the
 * browser to Google and brings it back with the session cookie set.
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

export function googleSignIn() {
	const returnTo = new URL('/', window.location.origin).href
	const url = `${AUTH_API}/google?return_to=${encodeURIComponent(returnTo)}`
	window.location.href = url
	// Same { data, error } shape as usernameSignIn/usernameSignUp so the
	// auth drawer's handler is unchanged.
	return { data: { url }, error: null }
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
