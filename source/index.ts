import { promises } from 'fs'
const { access, writeFile, readFile } = promises
import { join } from 'path'
import { cwd } from 'process'

import mkdirp from 'mkdirp'
import rimrafp from 'rmfr'
import Errlop from 'errlop'
import puppeteer from 'puppeteer'
import reada from 'node-readability'
import TurndownService from 'turndown'
import readJSON, { writeJSON } from '@bevry/jsonfile'
import getarg from 'get-cli-arg'
import micromark from 'micromark'

async function exists(path: string) {
	try {
		await access(path)
		return true
	} catch (err) {
		return false
	}
}

async function missing(path: string) {
	return !(await exists(path))
}

type Urls = Array<string>
interface Meta {
	url: string
	slug: string
	id: String
}
interface Note extends Meta {
	title: string
	content: string
	article: string
}

// config
const clean = getarg('clean') || false
const user = getarg('username') || 'me'

// constants
const pwd = cwd()
const notesPath = join(pwd, 'notes')
const notesRawPath = join(notesPath, 'raw')
const notesReadablePath = join(notesPath, 'readable')
const notesMarkdownPath = join(notesPath, 'markdown')
const notesRenderedPath = join(notesPath, 'rendered')
const notesDatabasePath = join(notesPath, 'database.json')
const listingURL = `https://www.facebook.com/${user}/notes`
const readableStylesheet =
	'https://cdnjs.cloudflare.com/ajax/libs/normalize/8.0.1/normalize.min.css'

// create turndown
let browser: puppeteer.Browser
const turndownService = new TurndownService()

// setup
async function setup() {
	const reset = clean || (await missing(notesDatabasePath))
	// clean
	if (reset) {
		await rimrafp(notesPath).catch((err: Error) =>
			Promise.reject(new Errlop(`Failed to clean: ${notesPath}`, err))
		)
	}
	// directories
	await mkdirp(notesPath).catch((err: Error) =>
		Promise.reject(new Errlop(`Failed to create: ${notesPath}`, err))
	)
	await Promise.all([
		mkdirp(notesRawPath).catch((err: Error) =>
			Promise.reject(new Errlop(`Failed to create: ${notesRawPath}`, err))
		),
		mkdirp(notesReadablePath).catch((err: Error) =>
			Promise.reject(new Errlop(`Failed to create: ${notesReadablePath}`, err))
		),
		mkdirp(notesMarkdownPath).catch((err: Error) =>
			Promise.reject(new Errlop(`Failed to create: ${notesMarkdownPath}`, err))
		),
		mkdirp(notesRenderedPath).catch((err: Error) =>
			Promise.reject(new Errlop(`Failed to create: ${notesRenderedPath}`, err))
		),
	])
	// database
	if (reset) {
		await writeJSON(notesDatabasePath, {})
	}
}

// login
let loggedInUser: string
async function login(): Promise<string> {
	if (loggedInUser) return loggedInUser
	console.log('Please login...')
	try {
		// create browser
		browser = await puppeteer.launch({
			headless: false,
		})
		const context = browser.defaultBrowserContext()
		await context.overridePermissions('https://www.facebook.com', [
			'notifications',
		])

		// Go to the current indexes post
		const page = await browser.newPage()
		await page.goto('https://www.facebook.com', {
			waitUntil: 'networkidle0',
		})
		// https://www.facebook.com
		// 2fa https://www.facebook.com/checkpoint/?next

		// Wait until they are logged in
		await page.waitForSelector(
			'[href="/me/"][aria-label],form[action^="/logout"]'
		)

		// Fetch the username
		const name = await page.evaluate(() => {
			const $el = document.body.querySelector('[href="/me/"][aria-label]')
			const name = $el && $el.getAttribute('aria-label')
			return name || 'anonymous'
		})

		// Close the login page
		await page.close()
		loggedInUser = name
		return name
	} catch (err) {
		throw new Errlop(`An error occurred while logging in`, err)
	}
}

// fetch listing
async function fetchListing(): Promise<Urls> {
	await login()
	console.log('Fetching the URLs of all your notes...')
	try {
		// Go to the current indexes post
		const page = await browser.newPage()
		await page.goto(listingURL, {
			waitUntil: 'networkidle0',
		})

		// Keep scrolling until all documents have been identified
		const urls = await page.evaluate(function (): Promise<Urls> {
			return new Promise(function (resolve, reject) {
				const urls = new Set<string>()
				const logs: string[] = []
				let last = 0
				let attempt = 0
				const attempts = 10
				const timer = setInterval(function () {
					// scroll
					window.scrollTo(0, document.body.scrollHeight)
					// fetch
					const $els = document.querySelectorAll(
						`a[role=link][href^="https://www.facebook.com/notes/"]`
					)
					for (const $el of $els) {
						const url = $el.getAttribute('href')
						if (!url) throw new Error('failed to get the URL for the element')
						urls.add(url)
						console.log({ url, urls, $els })
					}
					// check
					if (urls.size === last) {
						++attempt
						if (attempt >= attempts) {
							clearInterval(timer)
							const listing: Urls = Array.from(urls.values())
							resolve(listing)
						}
					} else {
						attempt = 0
					}
					last = urls.size
				}, 500)
			})
		})

		// Check we got what we are after
		if (!urls.length) {
			throw new Error('the notes listing return zero urls')
		}

		// Close the notes listing
		await page.close()
		return urls
	} catch (err) {
		console.error(err)
		throw new Errlop(
			`An error occurred while fetching the URLs of all the notes`,
			err
		)
	}
}

// fetch note
async function fetchRawNote(meta: Meta): Promise<Note> {
	await login()
	console.log(`Fetching the content for the note: ${meta.id}`)
	try {
		// Go to the current indexes post
		const page = await browser.newPage()
		await page.goto(meta.url, { waitUntil: 'networkidle0' })

		// fetch the title and document body
		const result = await page.evaluate(function () {
			try {
				const $article = document.querySelector('[data-pagelet="page"]')
				if (!$article)
					throw new Error('failed to find the article within the page')
				const $title = $article.querySelector('h2 > span')
				if (!$title)
					throw new Error('failed to find the article title within the page')
				const title = $title.innerHTML
				const content = $article.outerHTML
				const article = [
					`<html><head>`,
					`<title>${title}</title>`,
					`</head><body>`,
					content,
					`</body></html>`,
				].join('\n')
				return { title, content, article }
			} catch (err) {
				if (
					document.body.innerHTML.includes('We limit how often you can post')
				) {
					throw new Error(
						'Failed to fetch the article content because we have been rate limited. Try again in a few hours, or create another Facebook account to continue.'
					)
				} else {
					throw new Error(
						'Failed to fetch the article content probably because we have been rate limited. Try again in a few hours, or create another Facebook account to continue.'
					)
				}
			}
		})

		// check we got what we needed
		if (!result)
			throw new Error(`failed to get the article content for note: ${meta.id}`)

		// close the browser
		await page.close()
		const note: Note = { ...meta, ...result }
		return note
	} catch (err) {
		throw new Errlop(`An error occurred fetching the note: ${meta.id}`, err)
	}
}

// clean
async function fetchReadableNote(raw: Note): Promise<Note> {
	console.log(`Fetching readable content for the note: ${raw.id}`)
	try {
		// clean
		const content = await new Promise<string>(function (resolve, reject) {
			reada(raw.article, function (
				error: Error | null,
				article: {
					content: string | false
					title: string
					textBody: string
					html: string
					document: any
				},
				meta: any
			) {
				if (error) {
					reject(error)
				} else if (!article.content) {
					reject(new Error(`failed to get the readable content for: ${raw.id}`))
				} else {
					console.dir({
						content: article.content,
						text: article.textBody,
					})
					resolve(article.content)
				}
			})
		})

		// check
		if (!content)
			throw new Error(`Could note clean the content for note: ${raw.id}`)

		// wrap
		const article = [
			`<html><head>`,
			`<link rel="stylesheet" href="${readableStylesheet}" />`,
			`<title>${raw.title}</title>`,
			// `<meta name="PublishDate" content="${time}"/>`,
			`</head><body><article>`,
			`<h1 id="title">${raw.title}</h1>`,
			// `<h2 id="published">${time}</h2>`,
			`<div id="content">${content}</div>`,
			`</article></body></html>`,
		].join('\n')

		// return
		const note: Note = { ...raw, content, article }
		return note
	} catch (err) {
		throw new Errlop('An error occurred while cleaning the note content', err)
	}
}

async function fetchMarkdownNote(readable: Note): Promise<Note> {
	console.log(`Fetching markdown content for the note: ${readable.id}`)
	// @ts-ignore
	const result = turndownService.turndown(readable.article)
	let md
	const lines = result.split('\n')
	let divider = 0
	for (let i = 0; i < lines.length; ++i) {
		const line = lines[i]
		if (divider === 0 && line.includes('====')) {
			divider = i + 1
		}
		if (line.includes('![Public](')) {
			divider = i + 1
			break
		}
	}
	md = lines.slice(divider).join('\n')
	if (divider) {
		let header = readable.title + '\n'
		for (let i = 0; i < readable.title.length; ++i) {
			header += '='
		}
		md = header + '\n' + md
	}
	return { ...readable, article: md, content: md }
}

// clean
async function fetchRenderedNote(markdown: Note): Promise<Note> {
	console.log(`Fetching rendered content for the note: ${markdown.id}`)
	try {
		const content = micromark(markdown.content)
		const article = [
			`<html><head>`,
			`<link rel="stylesheet" href="${readableStylesheet}" />`,
			`<title>${markdown.title}</title>`,
			// `<meta name="PublishDate" content="${time}"/>`,
			`</head><body><article>`,
			// `<h1 id="title">${markdown.title}</h1>`,
			// `<h2 id="published">${time}</h2>`,
			`<div id="content">${content}</div>`,
			`</article></body></html>`,
		].join('\n')

		// return
		const note: Note = { ...markdown, content, article }
		return note
	} catch (err) {
		throw new Errlop('An error occurred while rendering the note content', err)
	}
}

async function fetchListingWithCache(): Promise<Urls> {
	if (clean) {
		const urls = await fetchListing()
		await writeJSON(notesDatabasePath, { urls })
		return urls
	} else {
		const { urls } = await readJSON(notesDatabasePath)
		return urls
	}
}

async function fetchRawNoteWithCache(meta: Meta): Promise<Note> {
	const html = join(notesRawPath, meta.id + '.html')
	const json = join(notesRawPath, meta.id + '.json')
	if (clean || (await missing(json))) {
		const note = await fetchRawNote(meta)
		await writeFile(html, note.article)
		await writeJSON(json, note)
		return note
	} else {
		const note: Note = await readJSON(json)
		return note
	}
}

async function fetchReadableNoteWithCache(raw: Note): Promise<Note> {
	const html = join(notesReadablePath, raw.id + '.html')
	const json = join(notesReadablePath, raw.id + '.json')
	if (clean || (await missing(json))) {
		const note = await fetchReadableNote(raw)
		await writeFile(html, note.article)
		await writeJSON(json, note)
		return note
	} else {
		const note: Note = await readJSON(json)
		return note
	}
}

function fetchMetasFromURLs(urls: Urls) {
	if (!Array.isArray(urls)) throw new Error('urls were not an array')
	if (!urls.length) throw new Error('urls did not have a valid length')
	const metas = urls.map((url) => {
		const [slug, id] = url.split('/').slice(-3)
		return { url, slug, id }
	})
	return metas
}

async function fetchMarkdownNoteWithCache(readable: Note): Promise<Note> {
	const md = join(notesMarkdownPath, readable.id + '.md')
	const json = join(notesMarkdownPath, readable.id + '.json')
	if (clean || (await missing(json))) {
		const note = await fetchMarkdownNote(readable)
		await writeFile(md, note.article)
		await writeJSON(json, note)
		return note
	} else {
		const note: Note = await readJSON(json)
		return note
	}
}

async function fetchRenderedNoteWithCache(markdown: Note): Promise<Note> {
	const rendered = join(notesRenderedPath, markdown.id + '.html')
	const json = join(notesRenderedPath, markdown.id + '.json')
	if (clean || (await missing(json))) {
		const note = await fetchRenderedNote(markdown)
		await writeFile(rendered, note.article)
		await writeJSON(json, note)
		return note
	} else {
		const note: Note = await readJSON(json)
		return note
	}
}

// main
export default async function main() {
	// setup
	await setup()

	// fetch notes
	const urls = await fetchListingWithCache()

	// urls to metas
	const metas = fetchMetasFromURLs(urls)

	// download notes
	console.log(`Fetching content for ${metas.length} notes...`)
	for (const meta of metas) {
		console.log(`Fetching note: ${meta.id}`)
		const raw = await fetchRawNoteWithCache(meta)
		const readable = await fetchReadableNoteWithCache(raw)
		const markdown = await fetchMarkdownNoteWithCache(readable)
		const rendered = await fetchRenderedNoteWithCache(markdown)
	}

	// finish
	console.log('all done')
}
