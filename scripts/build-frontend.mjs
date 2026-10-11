import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import { ensureVendor } from './ensure-vendor.mjs'

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(repoRoot, 'app', 'src', 'frontend')
const outDir = join(repoRoot, 'dist')

function walk(dir) {
	const files = []
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		if (statSync(full).isDirectory()) {
			if (entry !== 'node_modules') files.push(...walk(full))
		} else {
			files.push(full)
		}
	}
	return files
}

function dirSize(dir) {
	let total = 0
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry)
		const stat = statSync(full)
		total += stat.isDirectory() ? dirSize(full) : stat.size
	}
	return total
}

const mib = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MiB'

ensureVendor()

const allFiles = walk(srcDir)
const jsFiles = new Set(
	allFiles.filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
)
const cssFiles = new Set(allFiles.filter((f) => f.endsWith('.css')))

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await esbuild.build({
	entryPoints: [...jsFiles, ...cssFiles],
	outdir: outDir,
	outbase: srcDir,
	bundle: false,
	minify: true,
	legalComments: 'none',
	logLevel: 'silent',
})

let copied = 0
for (const file of allFiles) {
	if (jsFiles.has(file) || cssFiles.has(file)) continue
	if (file.endsWith('.test.js')) continue
	const target = join(outDir, relative(srcDir, file))
	mkdirSync(dirname(target), { recursive: true })
	copyFileSync(file, target)
	copied++
}

console.log(
	`built dist/: ${jsFiles.size} JS + ${cssFiles.size} CSS minified, ${copied} files copied`
)
console.log(
	`size: ${mib(dirSize(srcDir))} (source, incl. node_modules) -> ${mib(
		dirSize(outDir)
	)} (dist)`
)
