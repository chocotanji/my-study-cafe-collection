import express from 'express'
import { connectToDatabase } from '../database/connect.js'
import { getPreferenceCollection } from '../database/preferences.js'
import { cafeExists, isValidCafeId, toMongoId } from '../database/cafeIds.js'
import { getConfig } from '../config/environment.js'
import { ensureAnonymousSession } from '../middleware/anonymousSession.js'
import { emptyPreference, validateMapLocation } from '../validation/preferences.js'

export const collectionRouter = express.Router()

collectionRouter.use(ensureAnonymousSession)

// Read: cafes in the current browser's personal list.
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
        .sort({ cafeName: 1, title: 1, name: 1 })
        .toArray()

    res.json(cafes)
})

// Create: add a cafe profile to the personal list with empty preferences.
collectionRouter.post('/:cafeId', async (req, res) => {
    const cafeId = req.params.cafeId
    if (!isValidCafeId(cafeId)) {
        return res.status(400).json({ error: 'Cafe ID is invalid.' })
    }

    const config = getConfig()
    if (!await cafeExists(config, cafeId)) {
        return res.status(404).json({ error: 'Cafe was not found.' })
    }

    const preferences = await getPreferenceCollection(config)
    const filter = { sessionId: req.anonymousSessionId, cafeId }

    // Earlier versions hid removed cafes instead of erasing them. Clear any
    // such leftover so a re-added cafe always starts with a fresh profile.
    await preferences.deleteOne({ ...filter, inCollection: false })

    const now = new Date()
    const result = await preferences.updateOne(
        filter,
        {
            $set: { inCollection: true },
            $setOnInsert: { ...emptyPreference(), createdAt: now, collectionUpdatedAt: now }
        },
        { upsert: true }
    )

    res.status(result.upsertedCount === 1 ? 201 : 200)
        .json({ cafeId, inCollection: true, created: result.upsertedCount === 1 })
})

// Update: remember where a listed cafe's pin goes on the map.
collectionRouter.put('/:cafeId/location', async (req, res) => {
    const cafeId = req.params.cafeId
    if (!isValidCafeId(cafeId)) {
        return res.status(400).json({ error: 'Cafe ID is invalid.' })
    }

    const result = validateMapLocation(req.body)
    if (!result.valid) {
        return res.status(400).json({ error: result.error })
    }

    const config = getConfig()
    const preferences = await getPreferenceCollection(config)
    const update = await preferences.updateOne(
        { sessionId: req.anonymousSessionId, cafeId, inCollection: { $ne: false } },
        { $set: { mapLocation: result.value } }
    )

    if (update.matchedCount === 0) {
        return res.status(404).json({ error: 'This cafe is not in your list.' })
    }

    res.json({ cafeId, mapLocation: result.value })
})

// Delete: remove the cafe profile and permanently erase everything saved for it.
collectionRouter.delete('/:cafeId', async (req, res) => {
    const cafeId = req.params.cafeId
    if (!isValidCafeId(cafeId)) {
        return res.status(400).json({ error: 'Cafe ID is invalid.' })
    }

    const config = getConfig()
    const preferences = await getPreferenceCollection(config)
    const result = await preferences.deleteOne({ sessionId: req.anonymousSessionId, cafeId })

    res.json({ cafeId, inCollection: false, deleted: result.deletedCount === 1 })
})
