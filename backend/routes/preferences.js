import express from 'express'
import { ObjectId } from 'mongodb'
import { connectToDatabase } from '../database/connect.js'
import { getPreferenceCollection } from '../database/preferences.js'
import { getConfig } from '../config/environment.js'
import { ensureAnonymousSession } from '../middleware/anonymousSession.js'
import { validatePreference } from '../validation/preferences.js'

export const preferencesRouter = express.Router()

preferencesRouter.use(ensureAnonymousSession)

preferencesRouter.get('/', async (req, res) => {
    const config = getConfig()
    const collection = await getPreferenceCollection(config)
    const preferences = await collection
        .find(
            { sessionId: req.anonymousSessionId },
            { projection: { _id: 0, sessionId: 0 } }
        )
        .toArray()

    res.json(preferences)
})

preferencesRouter.put('/:cafeId', async (req, res) => {
    const cafeId = req.params.cafeId
    if (!isValidCafeId(cafeId)) {
        return res.status(400).json({ error: 'Cafe ID is invalid.' })
    }

    const result = validatePreference(req.body)
    if (!result.valid) {
        return res.status(400).json({ error: result.error })
    }

    const config = getConfig()
    const cafeDatabase = await connectToDatabase(config.cafeDatabase)
    const cafe = await cafeDatabase.collection(config.cafeCollection)
        .findOne({ _id: toMongoId(cafeId) }, { projection: { _id: 1 } })

    if (!cafe) {
        return res.status(404).json({ error: 'Cafe was not found.' })
    }

    const collection = await getPreferenceCollection(config)
    const now = new Date()
    await collection.updateOne(
        { sessionId: req.anonymousSessionId, cafeId },
        {
            $set: { ...result.value, updatedAt: now },
            $setOnInsert: { createdAt: now }
        },
        { upsert: true }
    )

    res.json({ cafeId, ...result.value, updatedAt: now })
})

function isValidCafeId(cafeId) {
    return /^[a-f\d]{24}$/i.test(cafeId) || /^[\w-]{1,100}$/.test(cafeId)
}

function toMongoId(cafeId) {
    return /^[a-f\d]{24}$/i.test(cafeId)
        ? new ObjectId(cafeId)
        : cafeId
}
