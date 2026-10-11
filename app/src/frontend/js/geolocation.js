/**
 * Same result as get_player_location(), but gives up after timeoutMs so pin
 * rendering never waits out the full 10 s GPS timeout on a desktop that
 * will never answer. The underlying request keeps running harmlessly;
 * callers fall back to a default location on rejection.
 */
export function get_player_location_with_timeout(timeoutMs = 2500) {
	return Promise.race([
		get_player_location(),
		new Promise((_, reject) =>
			setTimeout(
				() => reject(new Error('Location timed out')),
				timeoutMs
			)
		),
	])
}

// returns: [latitude, longitude]
export function get_player_location() {
	return new Promise((resolve, reject) => {
		if (!navigator.geolocation) {
			reject(new Error('Geolocation not supported'))
			return
		}
		navigator.geolocation.getCurrentPosition(
			(geo) => {
				// returns a GeolocationCoordinates object
				// Source: 'https://developer.mozilla.org/en-US/docs/Web/API/GeolocationCoordinates'
				resolve([
					geo.coords.latitude,
					geo.coords.longitude,
				])
			},
			(geo_error) => {
				reject(
					new Error(
						`Failed to get current player location (${geo_error.code})`
					)
				)
			},
			{ enableHighAccuracy: true, timeout: 10000 }
		) // 10000ms = 10secs
	})
}
