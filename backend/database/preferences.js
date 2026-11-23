import { connectToDatabase } from './connect.js'

let indexPromise

export async function getPreferenceCollection(config) {
    const db = await connectToDatabase(config.userInputDatabase)
    const collection = db.collection(config.userInputCollection)

    if (!indexPromise) {
        indexPromise = collection.createIndex(
            { sessionId: 1, cafeId: 1 },
            { unique: true }
        ).catch(error => {
            indexPromise = undefined
            throw error
        })
    }

    await indexPromise
    return collection
}
