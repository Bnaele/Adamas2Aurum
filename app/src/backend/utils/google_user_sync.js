const USER_COLUMNS = 'user_id, name, email, avatar_url, points'

export const PIN_ACCOUNT_CONFLICT =
	'This email is already used by a username + PIN account, so it can’t be signed into with Google. Log in with that username and PIN instead.'

/**
 * Maps a Google profile (OIDC userinfo) onto our `users` table.
 *
 * Email fallback: an existing row with the same email is linked (its
 * provider_id set to this Google account) ONLY if it has no PIN
 * credentials. A row with a PIN is never auto-linked — the Google login
 * is refused instead and the PIN account keeps working as before.
 *
 * Callers must have checked profile.email_verified first.
 */
export async function resolve_google_user(db, profile) {
	const providerId = `google:${profile.sub}`
	const email = String(profile.email).trim().toLowerCase()

	const [byProvider] = await db.query(
		`SELECT ${USER_COLUMNS} FROM users WHERE provider_id = ?`,
		[providerId]
	)
	if (byProvider.length) return { user: byProvider[0] }

	const [byEmail] = await db.query(
		`SELECT u.user_id,
				EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.user_id) AS has_pin
		   FROM users u
		  WHERE u.email = ?`,
		[email]
	)
	if (byEmail.length) {
		const existing = byEmail[0]
		if (Number(existing.has_pin))
			return { conflict: PIN_ACCOUNT_CONFLICT }

		await db.query(
			'UPDATE users SET provider_id = ? WHERE user_id = ?',
			[providerId, existing.user_id]
		)
		const [linked] = await db.query(
			`SELECT ${USER_COLUMNS} FROM users WHERE user_id = ?`,
			[existing.user_id]
		)
		return { user: linked[0] }
	}

	// First-time Google user.
	const name = profile.name || email.split('@')[0]
	const [result] = await db.query(
		`INSERT INTO users (provider_id, email, name, avatar_url, points)
		 VALUES (?, ?, ?, ?, 0)`,
		[providerId, email, name, profile.picture || null]
	)
	const [created] = await db.query(
		`SELECT ${USER_COLUMNS} FROM users WHERE user_id = ?`,
		[result.insertId]
	)
	return { user: created[0] }
}
