// ELO-style rating for ranked battles, scoped to the active season via
// the existing `leaderboard_entries` table — no new table needed.
//
// Called by whatever resolves a match. Today that's only
// set_battle_finished() in battle_socket.js; when an async/turn-based
// match path exists later, it calls applyRatingUpdate(pool, winnerId,
// loserId) the exact same way — no dependency on the live-match trio.
//
// Quietly no-ops if there's no active season yet, so this can be
// deployed independently of everything else.

const K_FACTOR = 32
const DEFAULT_RATING = 1000
const SEASON_LENGTH_DAYS = 30 // tune to your sprint/term cadence
const SOFT_RESET_FACTOR = 0.5 // fraction of last season's rating that carries over past the 1000 midpoint

export function computeEloDelta(ratingA, ratingB, scoreA) {
	// scoreA: 1 = A won, 0 = A lost, 0.5 = draw
	const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400))
	return Math.round(K_FACTOR * (scoreA - expectedA))
}

export async function getActiveSeason(db) {
	const [[season]] = await db.query(
		`SELECT * FROM seasons WHERE is_active = TRUE ORDER BY starts_at DESC LIMIT 1`
	)
	return season || null
}

async function getOrCreateEntry(db, seasonId, userId) {
	const [rows] = await db.query(
		`SELECT rating, wins, losses FROM leaderboard_entries WHERE season_id = ? AND user_id = ?`,
		[seasonId, userId]
	)
	if (rows.length) return rows[0]

	await db.query(
		`INSERT INTO leaderboard_entries (season_id, user_id, wins, losses, score, rating)
		 VALUES (?, ?, 0, 0, 0, ?)`,
		[seasonId, userId, DEFAULT_RATING]
	)
	return { rating: DEFAULT_RATING, wins: 0, losses: 0 }
}

/**
 * Apply a rating update for a completed match. winnerId/loserId are
 * plain user_ids — this function doesn't know or care whether the
 * match was live-WS or async/turn-based.
 */
export async function applyRatingUpdate(db, winnerId, loserId, isDraw = false) {
	if (!winnerId || !loserId || winnerId === loserId) return null

	const season = await getActiveSeason(db)
	if (!season) return null // ranked isn't configured yet

	const winnerEntry = await getOrCreateEntry(
		db,
		season.season_id,
		winnerId
	)
	const loserEntry = await getOrCreateEntry(db, season.season_id, loserId)

	const scoreWinner = isDraw ? 0.5 : 1
	const scoreLoser = isDraw ? 0.5 : 0

	const winnerDelta = computeEloDelta(
		winnerEntry.rating,
		loserEntry.rating,
		scoreWinner
	)
	const loserDelta = computeEloDelta(
		loserEntry.rating,
		winnerEntry.rating,
		scoreLoser
	)

	const newWinnerRating = Math.max(0, winnerEntry.rating + winnerDelta)
	const newLoserRating = Math.max(0, loserEntry.rating + loserDelta)

	await db.query(
		`UPDATE leaderboard_entries SET rating = ?, wins = wins + ?, losses = losses + ?
		 WHERE season_id = ? AND user_id = ?`,
		[newWinnerRating, isDraw ? 0 : 1, 0, season.season_id, winnerId]
	)
	await db.query(
		`UPDATE leaderboard_entries SET rating = ?, wins = wins + ?, losses = losses + ?
		 WHERE season_id = ? AND user_id = ?`,
		[newLoserRating, 0, isDraw ? 0 : 1, season.season_id, loserId]
	)

	return {
		season_id: season.season_id,
		winner: {
			user_id: winnerId,
			rating: newWinnerRating,
			delta: winnerDelta,
		},
		loser: {
			user_id: loserId,
			rating: newLoserRating,
			delta: loserDelta,
		},
	}
}

/**
 * Season boundary: called by placement/season_job.js on a schedule.
 * Closes the active season, opens the next, and soft-resets rating by
 * compressing everyone toward the 1000 midpoint (not a hard wipe), so
 * there's always a fresh climb without discarding the old standing.
 */
export async function rolloverSeasonIfDue(db) {
	const season = await getActiveSeason(db)
	if (!season || new Date(season.ends_at) > new Date()) return null

	await db.query(
		`UPDATE seasons SET is_active = FALSE WHERE season_id = ?`,
		[season.season_id]
	)

	const now = new Date()
	const ends = new Date(now)
	ends.setDate(ends.getDate() + SEASON_LENGTH_DAYS)
	const nextName = nextSeasonName(season.name)

	const [result] = await db.query(
		`INSERT INTO seasons (name, starts_at, ends_at, is_active) VALUES (?, ?, ?, TRUE)`,
		[nextName, now, ends]
	)
	const newSeasonId = result.insertId

	const [entries] = await db.query(
		`SELECT user_id, rating FROM leaderboard_entries WHERE season_id = ?`,
		[season.season_id]
	)
	if (entries.length) {
		const values = []
		const placeholders = entries
			.map((e) => {
				const softRating = Math.round(
					DEFAULT_RATING +
						(e.rating - DEFAULT_RATING) *
							SOFT_RESET_FACTOR
				)
				values.push(newSeasonId, e.user_id, softRating)
				return '(?, ?, 0, 0, 0, ?)'
			})
			.join(',')
		await db.query(
			`INSERT INTO leaderboard_entries (season_id, user_id, wins, losses, score, rating) VALUES ${placeholders}`,
			values
		)
	}

	return newSeasonId
}

function nextSeasonName(previousName) {
	const match = /(\d+)\s*$/.exec(previousName || '')
	const n = match ? parseInt(match[1], 10) + 1 : 2
	return `Season ${n}`
}
