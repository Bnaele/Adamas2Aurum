// Ranked season lifecycle. Mirrors the startRotationScheduler(pool)
// pattern already used for procedural event placement: started once
// from server.js, skipped entirely under Jest.

import { rolloverSeasonIfDue } from '../services/rating.js'

const CHECK_INTERVAL_MS = 60 * 60 * 1000 // hourly — plenty of margin around a season boundary

export function startSeasonScheduler(pool) {
	const tick = async () => {
		try {
			const newSeasonId = await rolloverSeasonIfDue(pool)
			if (newSeasonId)
				console.log(
					`[season job] rolled over to season ${newSeasonId}`
				)
		} catch (err) {
			console.error('[season job]', err.message)
		}
	}
	tick() // catch a boundary missed while the server was down
	setInterval(tick, CHECK_INTERVAL_MS)
}
