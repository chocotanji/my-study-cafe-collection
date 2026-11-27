// Cafe records can come from a spreadsheet import, which keeps the column
// headers as field names ("Café name", "Phone No", ...). The website reads a
// fixed set of camelCase fields, so every record is mapped to that shape here.

// Search and sort run inside MongoDB, so they need the raw field names too.
export const cafeNameFields = ['Café name', 'Cafe name', 'cafeName', 'name', 'title']
export const searchableFields = [...cafeNameFields, 'Address', 'address', 'location']
export const cafeSort = Object.fromEntries(cafeNameFields.map(field => [field, 1]))

const fieldAliases = {
    cafeName: ['cafeName', 'Café name', 'Cafe name', 'Café Name', 'Cafe Name'],
    address: ['address', 'Address'],
    rating: ['rating', 'Rating'],
    priceRange: ['priceRange', 'Price Range', 'Price range'],
    typeOfStore: ['typeOfStore', 'Type of Store', 'Type of store'],
    plusCodes: ['plusCodes', 'Plus Codes', 'Plus codes', 'Plus Code'],
    operatingHoursRaw: ['operatingHoursRaw', 'Operating hours', 'Operating Hours'],
    phoneNo: ['phoneNo', 'Phone No', 'Phone No.', 'Phone'],
    webLink: ['webLink', 'Web Link', 'Web link', 'Website']
}

const emptyValues = new Set(['', 'n/a', 'na', 'null', 'none', 'undefined', '-'])

function cleanValue(value) {
    // A header such as "Phone No." is imported as a nested object
    // ({ "Phone No": { "": "1416..." } }), so unwrap a single nested value.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const values = Object.values(value)
        if (values.length !== 1) return undefined
        value = values[0]
    }
    if (value == null) return undefined
    if (typeof value === 'string') {
        const trimmed = value.trim()
        return emptyValues.has(trimmed.toLowerCase()) ? undefined : trimmed
    }
    return value
}

function pick(cafe, aliases) {
    for (const field of aliases) {
        const value = cleanValue(cafe[field])
        if (value !== undefined) return value
    }
    return undefined
}

const dayOrder = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const dayPrefixes = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 }

function dayIndex(token) {
    const key = token.trim().toLowerCase().slice(0, 3)
    return key in dayPrefixes ? dayPrefixes[key] : -1
}

// "Mon–Fri", "Sat-Sun", "Sun,Tue–Thu", "Sun–Wed" (wraps over the weekend)
function parseDays(spec) {
    const days = []
    for (const part of spec.split(',')) {
        const range = part.split(/[-–—]/)
        if (range.length > 2) return null
        const start = dayIndex(range[0])
        const end = range.length === 2 ? dayIndex(range[1]) : start
        if (start < 0 || end < 0) return null
        for (let day = start; ; day = (day + 1) % 7) {
            days.push(dayOrder[day])
            if (day === end) break
        }
    }
    return days
}

function padTime(time) {
    const [hours, minutes] = time.split(':')
    return `${hours.padStart(2, '0')}:${minutes}`
}

// "Mon Closed; Tue–Fri 9:00–17:00; Sat–Sun 10:00-18:00" -> { monday: 'Closed', ... }
// Returns null when any part can't be read, so the raw text is shown instead.
export function parseOperatingHours(value) {
    if (typeof value !== 'string' || !value.trim()) return null

    const hoursByDay = {}
    for (const segment of value.split(';')) {
        const text = segment.trim()
        if (!text) continue

        const match = text.match(/^(.+?)\s+(closed|\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2})$/i)
        if (!match) return null

        const days = parseDays(match[1])
        if (!days) return null

        let hours = 'Closed'
        if (!/^closed$/i.test(match[2])) {
            const [open, close] = match[2].split(/\s*[-–—]\s*/)
            hours = `${padTime(open)}-${padTime(close)}`
        }
        for (const day of days) hoursByDay[day] = hours
    }

    return Object.keys(hoursByDay).length > 0 ? hoursByDay : null
}

export function normalizeCafe(cafe) {
    if (!cafe || typeof cafe !== 'object') return cafe

    const normalized = { ...cafe }
    for (const [field, aliases] of Object.entries(fieldAliases)) {
        const value = pick(cafe, aliases)
        if (value === undefined) delete normalized[field]
        else normalized[field] = value
    }

    if (typeof normalized.rating === 'string') {
        const rating = Number(normalized.rating)
        if (Number.isFinite(rating)) normalized.rating = rating
        else delete normalized.rating
    }
    if (normalized.phoneNo !== undefined) {
        normalized.phoneNo = String(normalized.phoneNo)
    }

    const hasHoursByDay = cafe.hoursByDay && typeof cafe.hoursByDay === 'object'
    if (!hasHoursByDay) {
        const hoursByDay = parseOperatingHours(normalized.operatingHoursRaw)
        if (hoursByDay) normalized.hoursByDay = hoursByDay
    }

    return normalized
}
