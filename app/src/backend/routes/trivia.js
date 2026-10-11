import express from 'express'
import pool from '../utils/db.js'
import { distance_meters } from '../utils/geo.js'
import { canAwardCard, awardCardIfEligible } from '../services/card_award.js'
import { analyzeMovement } from '../services/movementTrust.js'

const router = express.Router()

// Blocks access to a route unless the player has an active login session.
// req.session.user is populated either by the PIN-based /auth/login route
// or by the Google OAuth callback (routes/oauth.js) — both end up
// setting the same { user_id, name, ... } shape, so this check works
// the same regardless of which auth method the player used.
function requireAuth(req, res, next) {
	const userId = req.session?.user?.user_id || req.user?.user_id
	if (!userId) {
		return res
			.status(401)
			.json({ error: 'Unauthorised — please log in' })
	}
	if (!req.user) {
		req.user = req.session.user
	}
	next()
}

// Whether opening/answering a challenge requires the player to actually be
// within the event's radius_meters. Defaults to true (the real intended
// behaviour). Set REQUIRE_LOCATION_VERIFICATION=false in .env for local
// testing on machines without real GPS (e.g. a desktop/VM relying on
// inaccurate WiFi-based positioning) — see the geolocation accuracy
// discussion from earlier: desktop positioning can be off by hundreds of
// meters, which would otherwise block every attempt during dev.
const LOCATION_VERIFICATION_ENABLED =
	process.env.REQUIRE_LOCATION_VERIFICATION !== 'false'

/**
 * Canonical form of a typed FILL_BLANK answer: case-insensitive, with
 * leading/trailing whitespace trimmed and inner runs collapsed to one
 * space, so " Nelson   MANDELA " matches "Nelson Mandela".
 */
export function normalizeAnswer(text) {
	return String(text ?? '')
		.normalize('NFKC')
		.trim()
		.replace(/\s+/g, ' ')
		.toLowerCase()
}

/**
 * Looks up an event's location + radius from the DB. Shared by both routes
 * below so the "how far is the player" logic only lives in one place.
 */
async function getEventLocation(eventId) {
	const [rows] = await pool.query(
		`SELECT latitude, longitude, radius_meters, point_reward, curation_status, is_active, starts_at, ends_at FROM events WHERE event_id = ?`,
		[eventId]
	)
	return rows[0] || null
}

function isEventPlayable(ev) {
	if (!ev) return { ok: false, reason: 'Event not found.' }
	// If curation column missing (pre-migration) or undefined in test mocks, treat as published
	if (ev.curation_status && ev.curation_status !== 'PUBLISHED')
		return {
			ok: false,
			reason: `This event is ${ev.curation_status.toLowerCase().replace('_', ' ')} and not yet published.`,
		}
	if (
		ev.is_active === false ||
		ev.is_active === 0 ||
		ev.is_active === '0'
	)
		return { ok: false, reason: 'This event is inactive.' }
	const now = new Date()
	if (ev.starts_at && new Date(ev.starts_at) > now)
		return { ok: false, reason: 'This event has not started yet.' }
	if (ev.ends_at && new Date(ev.ends_at) < now)
		return { ok: false, reason: 'This event has ended.' }
	return { ok: true }
}

/**
 * GET TRIVIA QUESTION FOR AN EVENT
 *
 * Called when a player clicks "Attempt Challenge" on a map pin. Picks one
 * random question tied to that event, then fetches its answer options.
 *
 * LOCATION CHECK (new): the frontend now sends the player's current
 * coordinates as ?lat=..&lng=.. query params (see geolocation.js's
 * get_player_location(), wired up in main.js's handleChallengeAttempt).
 * If the player is further from the event than its radius_meters allows,
 * this route refuses to hand out the question at all — satisfying user
 * story 7's "when I open a challenge I'm at" wording literally, rather
 * than only checking distance after the fact at submit time.
 *
 * IMPORTANT: this still only sends back option_id and body (the text shown
 * on each button) — it deliberately does NOT include the is_correct
 * column. If it did, a player could open their browser's Network tab and
 * read the answer straight off the API response before even attempting
 * the question. Keeping correctness server-side-only is what makes the
 * whole quiz trustworthy.
 */
router.get('/event/:eventId', requireAuth, async (req, res) => {
	try {
		const { eventId } = req.params
		const { lat, lng, accuracy, qr_verified, location_check_id } =
			req.query

		const curationEvent = await getEventLocation(eventId)
		if (!curationEvent)
			return res
				.status(404)
				.json({ error: 'Event not found.' })
		const playableCheck = isEventPlayable(curationEvent)
		if (!playableCheck.ok)
			return res
				.status(403)
				.json({ error: playableCheck.reason })

		if (LOCATION_VERIFICATION_ENABLED) {
			const event = curationEvent

			// Path A: QR fallback already verified — frontend passes the
			// location_check_id from POST /api/events/:id/verify-qr
			if (qr_verified === 'true' && location_check_id) {
				const [checkRows] = await pool.query(
					`SELECT check_id FROM location_check_log
           WHERE check_id = ? AND event_id = ? AND status = 'FALLBACK_QR'`,
					[location_check_id, eventId]
				)
				if (!checkRows.length) {
					return res.status(403).json({
						error: 'Invalid QR verification — please scan again.',
					})
				}
				// Falls through to question fetch below
			}
			// Path B: GPS accuracy too poor → tell frontend to trigger QR fallback
			else if (
				accuracy !== undefined &&
				parseFloat(accuracy) > 50
			) {
				return res.status(200).json({
					fallback_required: true,
					reason: `GPS accuracy (${Math.round(parseFloat(accuracy))}m) exceeds threshold. Please scan the QR code at this location.`,
					threshold_m: 50,
					reported_accuracy_m: Math.round(
						parseFloat(accuracy)
					),
				})
			}
			// Path C: Normal GPS verification
			else {
				if (lat === undefined || lng === undefined) {
					return res.status(400).json({
						error: 'Location is required to attempt this challenge.',
					})
				}

				const dist = distance_meters(
					parseFloat(lat),
					parseFloat(lng),
					parseFloat(event.latitude),
					parseFloat(event.longitude)
				)

				if (dist > event.radius_meters) {
					return res.status(403).json({
						error: 'You are too far from this location to attempt the challenge.',
						distance_meters:
							Math.round(dist),
						radius_meters:
							event.radius_meters,
					})
				}
			}
		} // end LOCATION_VERIFICATION_ENABLED

		// ORDER BY RAND() LIMIT 1 = pick one random question for this event,
		// so the same location doesn't always ask the same question.
		const [questions] = await pool.query(
			`SELECT question_id, format, body, time_limit_s, difficulty
       FROM trivia_questions
       WHERE event_id = ?
       ORDER BY RAND() LIMIT 1`,
			[eventId]
		)

		if (!questions.length) {
			// No trivia_questions rows exist for this event_id in the DB yet.
			return res.status(404).json({
				error: 'No active trivia questions found for this location.',
			})
		}

		const question = questions[0]

		// Fetch every answer choice for that specific question. Note: no
		// is_correct here, see comment above the route. FILL_BLANK stores
		// its accepted answer(s) as options, so those are never sent — the
		// player types the answer and /submit grades the text.
		let options = []
		if (question.format !== 'FILL_BLANK') {
			;[options] = await pool.query(
				`SELECT option_id, body FROM trivia_options WHERE question_id = ?`,
				[question.question_id]
			)
		}

		// User story 8 — tell the frontend up front whether this player
		// has ALREADY earned this event's card, so it can show a
		// "replay for practice?" banner instead of silently letting them
		// redo it for no reward. canAwardCard reads the attempt log (the
		// source of truth), NOT card ownership — a player could trade or
		// lose a card later, so ownership is not a reliable "did they ever
		// win here?" signal.
		// requireAuth above guarantees one of these is set; prefer the
		// session but fall back to req.user (e.g. token/bridge auth)
		// instead of crashing with a TypeError.
		const player_id =
			req.session?.user?.user_id ?? req.user?.user_id
		const already_earned = !(await canAwardCard(
			pool,
			player_id,
			eventId
		))

		let earned_card = null
		if (already_earned) {
			const [cardRows] = await pool.query(
				`SELECT c.card_id, c.name, c.image_url, c.rarity
           FROM event_card_awards eca
           JOIN cards c ON eca.card_id = c.card_id
          WHERE eca.user_id = ? AND eca.event_id = ?
          LIMIT 1`,
				[player_id, eventId]
			)
			earned_card = cardRows[0] || null
		}

		// Stash when this question was served, so the submit route can
		// compute server-side elapsed time — otherwise a tampered client
		// could claim a near-zero answer_time_ms to always land the
		// rarest speed-bracket card.
		req.session.trivia_issue = {
			question_id: question.question_id,
			event_id: Number(eventId),
			issued_at: Date.now(),
		}

		res.json({
			question_id: question.question_id,
			body: question.body, // the actual question text
			format: question.format, // e.g. MULTIPLE_CHOICE, TRUE_FALSE
			time_limit_s: question.time_limit_s,
			options: options, // array of { option_id, body }; [] for FILL_BLANK
			card_eligibility: {
				// user story 8 — once-only card banner
				already_earned, // true = this player has won this event before
				earned_card, // { card_id, name, image_url, rarity } | null
			},
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

/**
 * SUBMIT TRIVIA ANSWER & AWARD POINTS
 *
 * Called when the player clicks one of the answer buttons. The frontend
 * sends back only IDs (which question, which option they picked) — the
 * server does the actual grading, since the client can never be trusted
 * to correctly self-report whether it got the answer right.
 *
 * LOCATION CHECK (new): the frontend now also sends claimed_lat/claimed_lng
 * in the request body, captured fresh at submit time (not reused from when
 * the question was first opened) — this means a player who walked away
 * from the location between opening the question and answering it gets
 * caught here too, not just at the GET step above.
 *
 * The real distance is now computed and stored in location_check_log
 * (previously this hardcoded 0, 0, 0, 'VERIFIED' unconditionally — see the
 * old comment that used to be here). Points are only awarded if BOTH the
 * answer was correct AND the location check passed.
 *
 * User story 7: "As a player, when I open a challenge I'm at, I'm shown a
 * question and my answer is checked by the server — and I see the correct
 * answer afterward regardless of whether I got it right." The
 * correct_option_text field added below is what satisfies the second half
 * of that story.
 */
router.post('/submit', requireAuth, async (req, res) => {
	const {
		event_id,
		question_id,
		selected_option_id,
		answer_text,
		answer_time_ms,
		claimed_lat,
		claimed_lng,
		timed_out: clientTimedOut,
	} = req.body
	const user_id = req.session?.user?.user_id ?? req.user?.user_id // comes from the session, not the request body — a player can't spoof this to submit as someone else
	const timedOut = !!clientTimedOut
	const hasAnswerText =
		typeof answer_text === 'string' &&
		normalizeAnswer(answer_text) !== ''

	if (!question_id) {
		return res
			.status(400)
			.json({ error: 'question_id is required' })
	}
	// Timeout submissions carry no selection — the countdown hit zero before
	// the player picked anything. Everything else needs an option_id (or,
	// for FILL_BLANK, typed answer_text) to grade.
	if (!timedOut && !selected_option_id && !hasAnswerText) {
		return res
			.status(400)
			.json({ error: 'selected_option_id is required' })
	}

	try {
		// STEP 1: Fetch the question's time_limit_s up front — needed for
		// authoritative elapsed, timeout detection, points decay, and the
		// speed-bracket card award regardless of whether the player answered
		// or timed out. format decides how STEP 3 grades.
		const [questionRows] = await pool.query(
			`SELECT time_limit_s, format FROM trivia_questions WHERE question_id = ?`,
			[question_id]
		)
		if (!questionRows.length) {
			return res
				.status(404)
				.json({ error: 'Unknown question_id' })
		}
		const isFillBlank = questionRows[0].format === 'FILL_BLANK'
		if (!timedOut && isFillBlank && !hasAnswerText) {
			return res.status(400).json({
				error: 'answer_text is required for a fill-in-the-blank question',
			})
		}
		if (!timedOut && !isFillBlank && !selected_option_id) {
			return res.status(400).json({
				error: 'selected_option_id is required',
			})
		}
		const time_limit_s = questionRows[0].time_limit_s || 30
		const time_limit_ms = time_limit_s * 1000

		// STEP 2: Authoritative elapsed time.
		//   Server-side = Date.now() - issued_at from the session (set when
		//   the question was served). Falls back to client-reported
		//   answer_time_ms if the session record is missing (e.g. server
		//   restart, legacy client, or a different browser tab overwrote it).
		//   The server clock can't be spoofed client-side, so a cheater can't
		//   fake a 1ms answer to always claim the rarest speed-bracket card.
		let elapsed_ms = 0
		const issued = req.session.trivia_issue
		if (
			issued &&
			issued.question_id === question_id &&
			issued.event_id === Number(event_id) &&
			issued.issued_at
		) {
			elapsed_ms = Math.max(0, Date.now() - issued.issued_at)
		} else if (Number.isFinite(Number(answer_time_ms))) {
			elapsed_ms = Math.max(0, Number(answer_time_ms))
		}
		// Clear the stashed issue so a replay against a different question
		// can't accidentally reuse a stale timestamp.
		delete req.session.trivia_issue

		// 1 s grace for the timeout verdict — covers network/serialization
		// latency between the player's click and this request arriving, so
		// someone who answered at 29.99 s isn't punished by a 30.3 s receipt.
		const serverTimedOut = elapsed_ms > time_limit_ms + 1000
		const timedOutFinal = timedOut || serverTimedOut
		// Cap elapsed at the limit for scoring purposes; a player who sat past
		// the limit gets the same floor points/bracket as one who answered at
		// exactly the limit.
		const elapsed_capped = Math.min(elapsed_ms, time_limit_ms)
		const elapsed_fraction =
			time_limit_ms > 0
				? Math.min(
						1,
						Math.max(
							0,
							elapsed_capped /
								time_limit_ms
						)
					)
				: 0

		// STEP 3: Look up whether the option the player picked is flagged
		// correct in the DB. Skipped for timeouts — those are always wrong
		// and there's no selection to grade. The WHERE clause checks BOTH
		// option_id AND question_id together, so submitting an option_id
		// from a different question still 404s instead of grading.
		let isCorrect = false
		if (!timedOutFinal && isFillBlank) {
			// FILL_BLANK: the accepted answer(s) are the question's
			// is_correct options. Compare ignoring case and whitespace.
			const [accepted] = await pool.query(
				`SELECT body FROM trivia_options WHERE question_id = ? AND is_correct = 1`,
				[question_id]
			)
			const given = normalizeAnswer(answer_text)
			isCorrect = accepted.some(
				(o) => normalizeAnswer(o.body) === given
			)
		} else if (!timedOutFinal) {
			const [options] = await pool.query(
				`SELECT is_correct FROM trivia_options WHERE option_id = ? AND question_id = ?`,
				[selected_option_id, question_id]
			)
			if (!options.length) {
				return res.status(404).json({
					error: 'Invalid option selected',
				})
			}
			// MySQL returns TINYINT as 0/1; Boolean(...) converts to true/false.
			isCorrect = Boolean(options[0].is_correct)
		}

		// STEP 4: Separately, find whichever option for this question IS the
		// correct one — regardless of what the player picked. This is what
		// lets us always show the correct answer afterward (user story 7),
		// not just when the player got it wrong.
		const [correctOptionRows] = await pool.query(
			`SELECT option_id, body FROM trivia_options WHERE question_id = ? AND is_correct = 1 LIMIT 1`,
			[question_id]
		)
		const correctOption = correctOptionRows[0] || null // null-safe in case a question was seeded without a correct option marked

		// STEP 5: Look up the event (for point_reward AND now for location
		// verification too — reusing the same shared helper as the GET route
		// above, so both endpoints agree on what "close enough" means).
		const event = await getEventLocation(event_id)
		const playable = isEventPlayable(event)
		if (!playable.ok) {
			return res.status(403).json({ error: playable.reason })
		}

		// STEP 6: Actually verify location, if enabled. distance stays null
		// and status stays 'VERIFIED' when verification is turned off (dev/
		// testing mode) — matching the previous stub behaviour exactly, so
		// nothing breaks for teammates who haven't set the env flag.
		let distance = null
		let locationStatus = 'VERIFIED'

		if (
			req.body.qr_verified === true &&
			req.body.location_check_id
		) {
			const [checkRows] = await pool.query(
				`SELECT check_id FROM location_check_log WHERE check_id = ? AND event_id = ? AND status = 'FALLBACK_QR'`,
				[req.body.location_check_id, event_id]
			)
			locationStatus = checkRows.length
				? 'FALLBACK_QR'
				: 'FAILED'
		} else if (LOCATION_VERIFICATION_ENABLED) {
			if (!event) {
				return res
					.status(404)
					.json({ error: 'Event not found.' })
			}
			if (
				claimed_lat === undefined ||
				claimed_lng === undefined
			) {
				return res.status(400).json({
					error: 'Location is required to submit an answer.',
				})
			}

			distance = distance_meters(
				parseFloat(claimed_lat),
				parseFloat(claimed_lng),
				parseFloat(event.latitude),
				parseFloat(event.longitude)
			)
			// 'FAILED' (not 'REJECTED') — must be a value of the
			// location_check_log.status ENUM, or the insert errors.
			locationStatus =
				distance <= event.radius_meters
					? 'VERIFIED'
					: 'FAILED'
		}

		const locationVerified =
			locationStatus === 'VERIFIED' ||
			locationStatus === 'FALLBACK_QR'

		// STEP 7: Time-decayed points.
		//   A near-instant correct answer earns the full point_reward; using
		//   the whole time limit earns half. Linear decay with a 50 % floor
		//   (and a hard 1-point floor for edge cases like reward=1, where
		//   Math.round(0.5) would otherwise give 0).
		//     points = max(1, round(reward × (1 - elapsed_fraction / 2)))
		//   Timeouts and incorrect answers always earn 0 regardless of speed
		//   or location — points require all three: correct, on time, verified.
		//   Points are also ONCE-ONLY per event: a replay of an already-
		//   completed event earns 0 (practice mode). The prior-win check
		//   runs inside the transaction below and zeroes this out.
		const baseReward = event?.point_reward || 10
		let hadPriorWin = false
		let isReplayWin = false
		let pointsAwarded =
			isCorrect && locationVerified && !timedOutFinal
				? Math.max(
						1,
						Math.round(
							baseReward *
								(1 -
									elapsed_fraction /
										2)
						)
					)
				: 0

		// STEP 8: ATOMIC AWARD + LOG + POINTS (user story 8).
		//
		// The eligibility check, the award-ledger insert (event_card_awards,
		// whose UNIQUE(user_id, event_id) is the hard backstop against a
		// double-submit race), the inventory upsert, the attempt record, and
		// the points ledger all commit together — or none do. The eligibility
		// check runs BEFORE the attempt is inserted, so a winning
		// retry-after-win sees the prior win and is correctly told "no new card".
		const conn = await pool.getConnection()
		let award = {
			awarded: false,
			card: null,
			card_id: null,
			reason: 'NOT_A_WIN',
		}
		try {
			await conn.beginTransaction()

			// 8a. Once-only points: has this player already logged a
			// counted win on this event (verified correct attempt or
			// card award)? Replays still log the attempt below but
			// earn 0 points — checked here, before the insert, so the
			// current attempt never counts itself as the prior win.
			const [priorWinRows] = await conn.query(
				`SELECT (EXISTS(
					SELECT 1 FROM trivia_attempts ta
					JOIN location_check_log l ON l.check_id = ta.location_check_id
					WHERE ta.user_id = ? AND ta.event_id = ? AND ta.is_correct = 1
					  AND l.status IN ('VERIFIED', 'FALLBACK_QR')
				) OR EXISTS(
					SELECT 1 FROM event_card_awards eca
					WHERE eca.user_id = ? AND eca.event_id = ?
				)) AS had_prior_win`,
				[user_id, event_id, user_id, event_id]
			)
			hadPriorWin = Boolean(priorWinRows[0]?.had_prior_win)
			if (hadPriorWin) pointsAwarded = 0
			isReplayWin =
				hadPriorWin &&
				isCorrect &&
				locationVerified &&
				!timedOutFinal

			// 8b. Movement trust check (Sprint 2 anti-cheat v1): compare
			// against the player's previous verified check. FLAG ONLY — the
			// result is stored for moderators and never changes the status,
			// points or card outcome of this attempt.
			const movement = await analyzeMovement(
				conn,
				user_id,
				parseFloat(claimed_lat),
				parseFloat(claimed_lng)
			)

			// 8c. Log the location check with REAL values, plus the movement
			// trust result.
			const [locCheck] = await conn.query(
				`INSERT INTO location_check_log (user_id, event_id, claimed_lat, claimed_lng, distance_meters, status, prev_check_id, travel_speed_ms, movement_flagged)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					user_id,
					event_id,
					claimed_lat ?? 0,
					claimed_lng ?? 0,
					distance !== null
						? Math.round(distance)
						: 0,
					locationStatus,
					movement.prevCheckId,
					movement.travelSpeedMps,
					movement.isSuspicious,
				]
			)

			// 8d. Award the card — once-only, at the player's speed bracket.
			// Only a correct, on-time, location-verified answer is eligible;
			// wrong, timed-out, or out-of-range attempts never trigger
			// issuance. awardCardIfEligible does the canAwardCard check
			// itself, so a retry after a prior win returns ALREADY_EARNED
			// and touches nothing. elapsed_fraction selects the rarity tier
			// (rarest bracket for the fastest answer).
			award =
				isCorrect && locationVerified && !timedOutFinal
					? await awardCardIfEligible(conn, {
							user_id,
							event_id,
							elapsed_fraction,
						})
					: {
							awarded: false,
							card: null,
							card_id: null,
							reason: 'NOT_A_WIN',
						}

			// 8e. Record the attempt itself, carrying the awarded card_id (or
			// NULL). This row is what canAwardCard later queries to answer
			// "has this player ever won this event?" — so it MUST be inserted
			// after, not before, the award check (see the ordering note above).
			await conn.query(
				`INSERT INTO trivia_attempts
           (user_id, event_id, question_id, location_check_id, is_correct, answer_time_ms, card_awarded_id, points_awarded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					user_id,
					event_id,
					question_id,
					locCheck.insertId,
					isCorrect,
					elapsed_capped,
					award.card_id,
					pointsAwarded,
				]
			)

			// 8f. Only touch the points ledger when points were actually
			// awarded — avoids a redundant 0-point UPDATE. Note: points are
			// awarded on every correct+verified answer, including retries for
			// practice; only the CARD is once-only (the story's scope).
			if (pointsAwarded > 0) {
				await conn.query(
					`UPDATE users SET points = points + ? WHERE user_id = ?`,
					[pointsAwarded, user_id]
				)
				await conn.query(
					`INSERT INTO point_transactions (user_id, delta, reason, reference_id) VALUES (?, ?, 'TRIVIA_WIN', ?)`,
					[user_id, pointsAwarded, event_id]
				)
			}

			await conn.commit()
		} catch (txErr) {
			await conn.rollback()
			throw txErr
		} finally {
			conn.release()
		}

		// STEP 9: Build the message, now accounting for the card outcome
		// (awarded / already-earned / correct-only / wrong / too-far /
		// timeout) so each state reads as intended behaviour, not a bug.
		let message
		if (timedOutFinal) {
			message = `Time's up! The correct answer was ${correctOption?.body ?? 'hidden'}.`
		} else if (!locationVerified) {
			message =
				'You were too far from this location for that attempt to count.'
		} else if (isCorrect && award.awarded) {
			message = `Correct! You earned ${pointsAwarded} points and a new card: ${award.card.name} (${award.card.rarity})!`
		} else if (isReplayWin) {
			message = `Correct! You've already completed this event — practice only, no new points.`
		} else if (isCorrect) {
			message = `Correct! You earned ${pointsAwarded} points.`
		} else {
			message = 'Incorrect answer. Try again later!'
		}

		res.json({
			success: true,
			is_correct: isCorrect,
			timed_out: timedOutFinal,
			location_verified: locationVerified,
			distance_meters:
				distance !== null ? Math.round(distance) : null,
			points_awarded: pointsAwarded,
			answer_time_ms: elapsed_ms,
			time_limit_s,
			elapsed_fraction,
			card_awarded: award.awarded, // user story 8 — was a new card issued this attempt?
			awarded_card: award.card, // { card_id, name, image_url, rarity, category } | null
			already_earned_card: award.reason === 'ALREADY_EARNED', // true on a winning retry-after-win
			already_completed: isReplayWin, // replay of a completed event: practice only, 0 points
			correct_option_id: correctOption?.option_id ?? null,
			correct_option_text: correctOption?.body ?? null,
			message,
		})
	} catch (err) {
		res.status(500).json({ error: err.message })
	}
})

export default router
