export function getConfig() {
    const mongodbUri = process.env.MONGODB_URI?.trim()
    if (!mongodbUri) {
        throw new Error('MONGODB_URI is not configured')
    }

    const port = Number(process.env.PORT ?? 3000)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('PORT must be an integer between 1 and 65535')
    }

    return {
        mongodbUri,
        cafeDatabase: process.env.CAFE_DATABASE?.trim() || 'cafe_list',
        cafeCollection: process.env.CAFE_COLLECTION?.trim() || 'cafe list',
        userInputDatabase: process.env.USER_INPUT_DATABASE?.trim() || 'user_input',
        userInputCollection: process.env.USER_INPUT_COLLECTION?.trim() || 'user input',
        port,
        secureCookies: Boolean(process.env.NETLIFY || process.env.NODE_ENV === 'production')
    }
}
