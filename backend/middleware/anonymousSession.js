import { createHash, randomBytes } from 'node:crypto'
import { getConfig } from '../config/environment.js'

const cookieName = 'study_collection_id'
const sessionIdPattern = /^[a-f0-9]{64}$/
const maxAgeSeconds = 60 * 60 * 24 * 365

function readSessionId(req) {
    const cookieHeader = req.headers.cookie
    if (!cookieHeader) return null

    const cookie = cookieHeader.split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(`${cookieName}=`))
    const value = cookie?.slice(cookieName.length + 1)

    return value && sessionIdPattern.test(value) ? value : null
}

export function ensureAnonymousSession(req, res, next) {
    let sessionId = readSessionId(req)

    if (!sessionId) {
        sessionId = randomBytes(32).toString('hex')
        const { secureCookies } = getConfig()
        const secureAttribute = secureCookies ? '; Secure' : ''
        res.append(
            'Set-Cookie',
            `${cookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureAttribute}`
        )
    }

    req.anonymousSessionId = createHash('sha256').update(sessionId).digest('hex')
    res.set('Cache-Control', 'no-store')
    next()
}
