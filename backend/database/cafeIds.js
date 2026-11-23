import { ObjectId } from 'mongodb'
import { connectToDatabase } from './connect.js'

const objectIdPattern = /^[a-f\d]{24}$/i

export function isValidCafeId(cafeId) {
    return typeof cafeId === 'string'
        && (objectIdPattern.test(cafeId) || /^[\w-]{1,100}$/.test(cafeId))
}

export function toMongoId(cafeId) {
    return objectIdPattern.test(cafeId) ? new ObjectId(cafeId) : cafeId
}

export async function cafeExists(config, cafeId) {
    const db = await connectToDatabase(config.cafeDatabase)
    const cafe = await db.collection(config.cafeCollection)
        .findOne({ _id: toMongoId(cafeId) }, { projection: { _id: 1 } })
    return Boolean(cafe)
}
