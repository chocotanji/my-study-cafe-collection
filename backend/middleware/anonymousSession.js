import { createHash, randomBytes } from 'node:crypto'
import { getConfig } from '../config/environment.js'

const cookieName = 'study_collection_id'
export const sessionHeaderName = 'x-study-session'
const sessionIdPattern = /^[a-f0-9]{64}$/
const maxAgeSeconds = 60 * 60 * 24 * 365

function readCookieToken(req) {
    const cookieHeader = req.headers.cookie
    if (!cookieHeader) return null

    const cookie = cookieHeader.split(';')
        .map(part => part.trim())
        .find(part => part.startsWith(`${cookieName}=`))
    const value = cookie?.slice(cookieName.length + 1)

    return value && sessionIdPattern.test(value) ? value : null
}

function readHeaderToken(req) {
    const value = req.get(sessionHeaderName)?.trim()
    return value && sessionIdPattern.test(value) ? value : null
}

// Identifies an anonymous browser. The page sends its token in a request
// header (stored in localStorage), which keeps working when the site is
// embedded in another page where cookies are blocked. The cookie remains a
// fallback for direct API clients and for browsers that visited before the
// header existed.
export function ensureAnonymousSession(req, res, next) {
    let token = readHeaderToken(req) ?? readCookieToken(req)

    if (!token) {
        token = randomBytes(32).toString('hex')
        const { secureCookies } = getConfig()
        const secureAttribute = secureCookies ? '; Secure' : ''
        res.append(
            'Set-Cookie',
            `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secureAttribute}`
        )
    }

    req.anonymousSessionToken = token
    req.anonymousSessionId = createHash('sha256').update(token).digest('hex')
    res.set('Cache-Control', 'no-store')
    next()
}
