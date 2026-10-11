import express from 'express'
import pool from '../utils/db.js'
import { getActiveSeason } from '../services/rating.js'

const router = express.Router()

function requireAuth(req, res, next) {
	const userId = req.session?.user?.user_id || req.user?.user_id
	if (!userId)
		return res
			.status(401)
			.json({ error: 'Unauthorised — please log in' })
	if (!req.user) req.user = req.session.user
	next()
}

// Public — mirrors leaderboard_routes' public-read pattern.
router.get('/season', async (req, res) => {
	try {
		const season = await getActiveSeason(pool)
		res.json({ season })
	} catch (err) {
		console.error('ranked season error:', err)
		res.status(500).json({ error: 'Could not load season' })
	}
})

router.get('/me', requireAuth, async (req, res) => {
	try {
		const season = await getActiveSeason(pool)
		if (!season) return res.json({ rating: null, season: null })

		const [[entry]] = await pool.query(
			`SELECT rating, wins, losses FROM leaderboard_entries WHERE season_id = ? AND user_id = ?`,
			[season.season_id, req.user.user_id]
		)
		res.json({
			season_id: season.season_id,
			rating: entry?.rating ?? 1000,
			wins: entry?.wins ?? 0,
			losses: entry?.losses ?? 0,
		})
	} catch (err) {
		console.error('ranked me error:', err)
		res.status(500).json({ error: 'Could not load your rating' })
	}
})

// Same-band opponents, queried from the DB (not the live in-memory
// lobby in battle_socket.js) — this keeps that file's hot path untouched.
router.get('/opponents', requireAuth, async (req, res) => {
	try {
		const season = await getActiveSeason(pool)
		if (!season) return res.json({ opponents: [] })

		const [[me]] = await pool.query(
			`SELECT rating FROM leaderboard_entries WHERE season_id = ? AND user_id = ?`,
			[season.season_id, req.user.user_id]
		)
		const myRating = me?.rating ?? 1000
		const band = 150

		const [rows] = await pool.query(
			`SELECT le.user_id, le.rating, u.name
			 FROM leaderboard_entries le
			 JOIN users u ON u.user_id = le.user_id
			 WHERE le.season_id = ? AND le.user_id != ? AND le.rating BETWEEN ? AND ?`,
			[
				season.season_id,
				req.user.user_id,
				myRating - band,
				myRating + band,
			]
		)
		res.json({ opponents: rows, my_rating: myRating })
	} catch (err) {
		console.error('ranked opponents error:', err)
		res.status(500).json({ error: 'Could not load opponents' })
	}
})

export default router
