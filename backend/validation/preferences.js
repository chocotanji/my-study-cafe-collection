const MAX_PERSONAL_NOTES_LENGTH = 1000

function isRating(value) {
    return value === null || (Number.isInteger(value) && value >= 1 && value <= 5)
}

export function validatePreference(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return { valid: false, error: 'Request body must be an object.' }
    }

    const wifiQuality = input.wifiQuality ?? null
    if (!isRating(wifiQuality)) {
        return { valid: false, error: 'Wi-Fi quality must be null or a whole number from 1 to 5.' }
    }

    const foodQuality = input.foodQuality ?? null
    if (!isRating(foodQuality)) {
        return { valid: false, error: 'Food quality must be null or a whole number from 1 to 5.' }
    }

    const favorite = input.favorite ?? false
    if (typeof favorite !== 'boolean') {
        return { valid: false, error: 'Favorite must be true or false.' }
    }

    const personalNotes = input.personalNotes ?? ''
    if (typeof personalNotes !== 'string' || personalNotes.trim().length > MAX_PERSONAL_NOTES_LENGTH) {
        return { valid: false, error: `Personal notes must be at most ${MAX_PERSONAL_NOTES_LENGTH} characters.` }
    }

    return {
        valid: true,
        value: {
            wifiQuality,
            foodQuality,
            favorite,
            personalNotes: personalNotes.trim()
        }
    }
}
