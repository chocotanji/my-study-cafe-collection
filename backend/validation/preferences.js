export const MAX_PERSONAL_NOTES_LENGTH = 1000

// Every rating is optional and, when set, a whole number from 1 to 5.
// noiseLevel runs from 1 (silent) to 5 (loud); all others treat 5 as best.
export const RATING_FIELDS = [
    ['wifiQuality', 'Wi-Fi quality'],
    ['powerOutlets', 'Power outlets'],
    ['studyFriendly', 'Study friendliness'],
    ['spacious', 'Spaciousness'],
    ['cleanliness', 'Cleanliness'],
    ['noiseLevel', 'Noise level'],
    ['foodAndDrinkQuality', 'Food and drink quality']
]

// Fields written by older versions of the app that are replaced on save.
export const LEGACY_FIELDS = ['foodQuality']

function isRating(value) {
    return value === null || (Number.isInteger(value) && value >= 1 && value <= 5)
}

export function emptyPreference() {
    return {
        ...Object.fromEntries(RATING_FIELDS.map(([field]) => [field, null])),
        favorite: false,
        recommend: null,
        personalNotes: ''
    }
}

export function validatePreference(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { valid: false, error: 'Request body must be an object.' }
    }

    const value = {}
    for (const [field, label] of RATING_FIELDS) {
        const rating = input[field] ?? null
        if (!isRating(rating)) {
            return { valid: false, error: `${label} must be null or a whole number from 1 to 5.` }
        }
        value[field] = rating
    }

    const favorite = input.favorite ?? false
    if (typeof favorite !== 'boolean') {
        return { valid: false, error: 'Favorite must be true or false.' }
    }
    value.favorite = favorite

    const recommend = input.recommend ?? null
    if (recommend !== null && typeof recommend !== 'boolean') {
        return { valid: false, error: 'Recommend must be true, false, or null.' }
    }
    value.recommend = recommend

    const personalNotes = input.personalNotes ?? ''
    if (typeof personalNotes !== 'string' || personalNotes.trim().length > MAX_PERSONAL_NOTES_LENGTH) {
        return { valid: false, error: `Personal notes must be at most ${MAX_PERSONAL_NOTES_LENGTH} characters.` }
    }
    value.personalNotes = personalNotes.trim()

    return { valid: true, value }
}

// Fills in defaults and maps fields saved by older versions of the app.
export function normalizeStoredPreference(document) {
    const { foodQuality, ...rest } = document
    const preference = { ...emptyPreference(), ...rest }
    if (rest.foodAndDrinkQuality === undefined && isRating(foodQuality ?? null)) {
        preference.foodAndDrinkQuality = foodQuality ?? null
    }
    return preference
}

// Map position looked up from a cafe's address, saved on the visitor's profile
// so its pin can be shown without another address lookup.
export function validateMapLocation(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { valid: false, error: 'Request body must be an object.' }
    }

    const { lat, lng } = input
    if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
        return { valid: false, error: 'Latitude must be a number from -90 to 90.' }
    }
    if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
        return { valid: false, error: 'Longitude must be a number from -180 to 180.' }
    }

    return { valid: true, value: { lat, lng } }
}
