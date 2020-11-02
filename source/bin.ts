import main from './index.js'
import Errlop from 'errlop'

main().catch((err) => {
	const error = new Errlop('the export failed', err)
	console.error(error)
	// throw error
})
