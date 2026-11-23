import express from 'express'
import { ObjectId } from 'mongodb'
import { connectToDatabase } from '../database/connect.js'
import { getPreferenceCollection } from '../database/preferences.js'
import { getConfig } from '../config/environment.js'
import { ensureAnonymousSession } from '../middleware/anonymousSession.js'

export const collectionRouter = express.Router()

collectionRouter.use(ensureAnonymousSession)

collectionRouter.get('/', async (req, res) => {
    const config = getConfig()
    const preferences = await getPreferenceCollection(config)
    const savedPreferences = await preferences.find(
        { sessionId: req.anonymousSessionId, inCollection: { $ne: false } },
        { projection: { _id: 0, cafeId: 1 } }
    ).toArray()

    if (savedPreferences.length === 0) {
        return res.json([])
    }

    const cafeDatabase = await connectToDatabase(config.cafeDatabase)
    const cafes = await cafeDatabase.collection(config.cafeCollection)
        .find({ _id: { $in: savedPreferences.map(({ cafeId }) => toMongoId(cafeId)) } })
        .sort({ title: 1, name: 1 })
        .toArray()

    res.json(cafes)
})

collectionRouter.post('/:cafeId', async (req, res) => {
    const cafeId = req.params.cafeId
    if (!isValidCafeId(cafeId)) {
        return res.status(400).json({ error: 'Cafe ID is invalid.' })
    }

    const config = getConfig()
    const cafeDatabase = await connectToDatabase(config.cafeDatabase)
    const cafe = await cafeDatabase.collection(config.cafeCollection)
        .findOne({ _id: toMongoId(cafeId) }, { projection: { _id: 1 } })

    if (!cafe) {
        return res.status(404).json({ error: 'Cafe was not found.' })
    }

    const preferences = await getPreferenceCollection(config)
    const now = new Date()
    await preferences.updateOne(
        { sessionId: req.anonymousSessionId, cafeId },
        {
            $set: { inCollection: true, collectionUpdatedAt: now },
            $setOnInsert: {
                wifiQuality: null,
                foodQuality: null,
                favorite: false,
                personalNotes: '',
                createdAt: now
            }
        },
        { upsert: true }
    )

    res.json({ cafeId, inCollection: true })
})

collectionRouter.delete('/:cafeId', async (req, res) => {
    const cafeId = req.params.cafeId
    if (!isValidCafeId(cafeId)) {
        return res.status(400).json({ error: 'Cafe ID is invalid.' })
    }

    const config = getConfig()
    const preferences = await getPreferenceCollection(config)
    const result = await preferences.updateOne(
        { sessionId: req.anonymousSessionId, cafeId, inCollection: { $ne: false } },
        { $set: { inCollection: false, collectionUpdatedAt: new Date() } }
    )

    res.json({ cafeId, inCollection: false, removed: result.modifiedCount === 1 })
})

function isValidCafeId(cafeId) {
    return /^[a-f\d]{24}$/i.test(cafeId) || /^[\w-]{1,100}$/.test(cafeId)
}

function toMongoId(cafeId) {
    return /^[a-f\d]{24}$/i.test(cafeId)
        ? new ObjectId(cafeId)
        : cafeId
}
