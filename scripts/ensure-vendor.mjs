import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const vendorDir = join(repoRoot, 'app', 'src', 'frontend', 'vendor')
const packageDistDir = join(repoRoot, 'node_modules', 'maplibre-gl', 'dist')

const files = ['maplibre-gl.js', 'maplibre-gl.css']

export function ensureVendor() {
	mkdirSync(vendorDir, { recursive: true })
	for (const file of files) {
		copyFileSync(join(packageDistDir, file), join(vendorDir, file))
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	ensureVendor()
	console.log(`vendored ${files.join(', ')} into ${vendorDir}`)
}
