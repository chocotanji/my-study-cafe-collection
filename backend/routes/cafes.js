import express from 'express'
import { connectToDatabase } from '../database/connect.js'
import { getConfig } from '../config/environment.js'

const MAX_RESULTS = 100
const searchableFields = ['title', 'name', 'cafeName', 'address', 'location']

export const cafesRouter = express.Router()

async function listCafes(req, res) {
    const config = getConfig()
    const db = await connectToDatabase(config.cafeDatabase)
    const cafes = await db.collection(config.cafeCollection)
        .find({})
        .sort({ cafeName: 1, title: 1, name: 1 })
        .limit(MAX_RESULTS)
        .toArray()

    res.json(cafes)
}

async function searchCafes(req, res) {
    const terms = req.query.terms ?? ''
    if (typeof terms !== 'string') {
        return res.status(400).json({ error: 'Search terms must be a string.' })
    }
    if (terms.length > 100) {
        return res.status(400).json({ error: 'Search terms must be at most 100 characters.' })
    }

    const config = getConfig()
    const db = await connectToDatabase(config.cafeDatabase)
    const expression = new RegExp(escapeRegExp(terms), 'i')
    const cafes = await db.collection(config.cafeCollection)
        .find({
            $or: searchableFields.map(field => ({ [field]: expression }))
        })
        .sort({ cafeName: 1, title: 1, name: 1 })
        .limit(MAX_RESULTS)
        .toArray()

    res.json(cafes)
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

cafesRouter.get(['/cafes', '/items'], listCafes)
cafesRouter.get(['/cafes/search', '/search'], searchCafes)
