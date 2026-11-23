import express from 'express'
import { getPreferenceCollection } from '../database/preferences.js'
import { isValidCafeId } from '../database/cafeIds.js'
import { getConfig } from '../config/environment.js'
import { ensureAnonymousSession } from '../middleware/anonymousSession.js'
import {
    LEGACY_FIELDS,
    normalizeStoredPreference,
    validatePreference
} from '../validation/preferences.js'

export const preferencesRouter = express.Router()

preferencesRouter.use(ensureAnonymousSession)

// Read: saved preferences for every cafe in the current browser's list.
preferencesRouter.get('/', async (req, res) => {
    const config = getConfig()
    const collection = await getPreferenceCollection(config)
    const preferences = await collection
        .find(
            { sessionId: req.anonymousSessionId, inCollection: { $ne: false } },
            { projection: { _id: 0, sessionId: 0 } }
        )
        .toArray()

    res.json(preferences.map(normalizeStoredPreference))
})

// Update: replace the ratings, notes, favourite and recommendation for a cafe.
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
    const collection = await getPreferenceCollection(config)
    const now = new Date()
    const update = await collection.updateOne(
        { sessionId: req.anonymousSessionId, cafeId, inCollection: { $ne: false } },
        {
            $set: { ...result.value, updatedAt: now },
            $unset: Object.fromEntries(LEGACY_FIELDS.map(field => [field, '']))
        }
    )

    if (update.matchedCount === 0) {
        return res.status(404).json({ error: 'Add this cafe to your list before saving preferences.' })
    }

    res.json({ cafeId, inCollection: true, ...result.value, updatedAt: now })
})
