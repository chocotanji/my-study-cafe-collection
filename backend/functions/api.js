import express from 'express'
import { fileURLToPath } from 'node:url'
import serverless from 'serverless-http'
import { getConfig } from '../config/environment.js'
import { connectToDatabase } from '../database/connect.js'
import { ensureAnonymousSession } from '../middleware/anonymousSession.js'
import { cafesRouter } from '../routes/cafes.js'
import { preferencesRouter } from '../routes/preferences.js'

const collectionName = 'cafe list'

export const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '10kb' }))
app.get('/api/session', ensureAnonymousSession, (req, res) => {
    res.json({ ok: true })
})
app.use('/api', cafesRouter)
app.use('/api/preferences', preferencesRouter)
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API route not found.' })
})

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)

    const status = error.status
        ?? (error.type === 'entity.too.large' ? 413
            : error.type === 'entity.parse.failed' ? 400
                : 500)

    if (status >= 500) {
        console.error('API request failed:', error)
    }

    res.status(status).json({
        error: status === 413
            ? 'Request body is too large.'
            : status === 400
                ? 'Request body must contain valid JSON.'
                : 'Unable to process the request. Check the server logs.'
    })
})

export const handler = serverless(app)

if (!process.env.NETLIFY) {
    const frontendDirectory = fileURLToPath(new URL('../../frontend/', import.meta.url))
    app.use(express.static(frontendDirectory))

    async function startLocalServer() {
        try {
            const config = getConfig()
            await connectToDatabase(config.cafeDatabase)
            const server = app.listen(config.port, () => {
                console.log(`API running at http://localhost:${config.port}`)
            })

            server.on('error', error => {
                console.error(`Unable to start the API server: ${error.message}`)
                process.exitCode = 1
            })
        } catch (error) {
            console.error(`Unable to connect to MongoDB: ${error.message}`)
            process.exitCode = 1
        }
    }

    startLocalServer()
}
