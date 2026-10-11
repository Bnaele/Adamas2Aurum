import pool from '../utils/db.js'

// Ranked matchmaking & seasons. Additive-only, safe to re-run every
// startup — same guarded-ALTER pattern as ensure_curation_schema /
// ensure_placement_schema in server.js. 1060/ER_DUP_FIELDNAME means
// the column already exists.
export async function ensure_ranked_schema() {
	try {
		await pool.query(
			`ALTER TABLE leaderboard_entries ADD COLUMN rating INT NOT NULL DEFAULT 1000`
		)
	} catch (err) {
		if (err.code !== 'ER_DUP_FIELDNAME' && err.errno !== 1060)
			console.warn('[ranked migration]', err.message)
	}

	// Guarantee there is always exactly one active season to rate against.
	const [[activeSeason]] = await pool.query(
		`SELECT season_id FROM seasons WHERE is_active = TRUE LIMIT 1`
	)
	if (!activeSeason) {
		const [[anySeason]] = await pool.query(
			`SELECT season_id FROM seasons ORDER BY starts_at DESC LIMIT 1`
		)
		if (anySeason) {
			await pool.query(
				`UPDATE seasons SET is_active = TRUE WHERE season_id = ?`,
				[anySeason.season_id]
			)
		} else {
			const now = new Date()
			const ends = new Date(now)
			ends.setDate(ends.getDate() + 30)
			await pool.query(
				`INSERT INTO seasons (name, starts_at, ends_at, is_active) VALUES (?, ?, ?, TRUE)`,
				['Season 1', now, ends]
			)
		}
	}
}
