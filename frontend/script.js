const cafeList = document.querySelector('#cafe-list')
const listStatus = document.querySelector('#list-status')
const mapStatus = document.querySelector('#map-status')
const searchForm = document.querySelector('#search-form')
const searchInput = document.querySelector('#search-terms')
const searchContainer = document.querySelector('.search-container')
const searchSuggestions = document.querySelector('#search-suggestions')
const listTools = document.querySelector('#list-tools')
const filterButtons = [...document.querySelectorAll('#list-tools [data-filter]')]
let currentFilter = 'all'
const showListButton = document.querySelector('#show-list')
const preferences = new Map()
// Cafes in the visitor's list, keyed by ID. Their pins stay on the map
// regardless of search or filter, until the cafe profile is deleted.
const savedCafes = new Map()
const savedMarkers = new Map()
// Temporary pins for cafes that are not in the list (search results).
const resultMarkers = new Map()
const pendingLocations = new Set()
const failedLocations = new Set()
let savedCafesLoaded = false
const geocodingCache = new Map()
const torontoCenter = [43.6532, -79.3832]
let cafeMap
const markerIcons = {}
let selectedCafeMarker
let geocodingQueue = Promise.resolve()
let lastGeocodingAt = 0
let searchTimeout
let cafeLoadRequestId = 0
let currentCafes = []
let currentQuery = ''
let currentSelectedCafeId = ''
const openEditors = new Set()
const cardMessages = new Map()
const openDetails = new Set()

// Kept in sync with backend/validation/preferences.js.
const RATING_FIELDS = [
    { field: 'wifiQuality', label: 'Wi-Fi quality', scale: ['Unusable', 'Patchy', 'Okay', 'Fast', 'Excellent'] },
    { field: 'powerOutlets', label: 'Power outlets', scale: ['Hardly any', 'A few', 'Some', 'Plenty', 'At every seat'] },
    { field: 'studyFriendly', label: 'Study friendly', scale: ['Not at all', 'A little', 'Somewhat', 'Very', 'Ideal'] },
    { field: 'spacious', label: 'Spacious', scale: ['Cramped', 'Snug', 'Comfortable', 'Roomy', 'Very spacious'] },
    { field: 'cleanliness', label: 'Cleanliness', scale: ['Dirty', 'Untidy', 'Clean enough', 'Clean', 'Spotless'] },
    { field: 'noiseLevel', label: 'Noise level', scale: ['Silent', 'Quiet', 'Moderate', 'Lively', 'Loud'], lowerIsBetter: true },
    { field: 'foodAndDrinkQuality', label: 'Food & drink', scale: ['Poor', 'Fair', 'Good', 'Very good', 'Excellent'] }
]

function emptyPreference(cafeId) {
    return {
        cafeId,
        inCollection: true,
        ...Object.fromEntries(RATING_FIELDS.map(({ field }) => [field, null])),
        favorite: false,
        recommend: null,
        personalNotes: ''
    }
}

const SESSION_STORAGE_KEY = 'studyCafeSession'
const SESSION_HEADER = 'X-Study-Session'
const sessionTokenPattern = /^[a-f0-9]{64}$/
let sessionToken = readStoredSessionToken()
let sessionRequest

function readStoredSessionToken() {
    try {
        const stored = window.localStorage.getItem(SESSION_STORAGE_KEY)
        return stored && sessionTokenPattern.test(stored) ? stored : null
    } catch {
        // Storage can be blocked, for example in some embedded previews.
        return null
    }
}

function storeSessionToken(token) {
    sessionToken = token
    try {
        window.localStorage.setItem(SESSION_STORAGE_KEY, token)
    } catch {
        // Fall back to keeping the token for this page view only.
    }
}

// Every request carries the browser's anonymous token in a header, so the
// list works even where the browser blocks the session cookie.
function ensureSession() {
    if (sessionToken) return Promise.resolve(sessionToken)

    sessionRequest ??= fetch('/api/session', { credentials: 'same-origin' })
        .then(async response => {
            const payload = await readJson(response)
            if (!response.ok || !sessionTokenPattern.test(payload.token ?? '')) {
                throw new Error(payload.error ?? 'Your session could not be started. Please reload the page.')
            }
            storeSessionToken(payload.token)
            return payload.token
        })
        .finally(() => {
            sessionRequest = undefined
        })

    return sessionRequest
}

async function readJson(response) {
    try {
        return await response.json()
    } catch {
        return {}
    }
}

async function requestJson(url, options = {}) {
    const token = await ensureSession()
    const headers = new Headers(options.headers)
    headers.set(SESSION_HEADER, token)

    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' })
    const payload = await readJson(response)

    if (!response.ok) {
        throw new Error(payload.error ?? `The request could not be completed (error ${response.status}).`)
    }

    return payload
}

function getCafeName(cafe) {
    return cafe.name ?? cafe.title ?? cafe.cafeName ?? 'Cafe'
}

function getCafeAddress(cafe) {
    if (typeof cafe.address === 'string') return cafe.address
    if (typeof cafe.location === 'string') return cafe.location
    if (cafe.location && typeof cafe.location === 'object') {
        const address = cafe.location.address ?? cafe.location.formattedAddress
        return typeof address === 'string' ? address : ''
    }
    return ''
}

function validCoordinates(latitude, longitude) {
    if (
        latitude == null || longitude == null
        || (typeof latitude === 'string' && !latitude.trim())
        || (typeof longitude === 'string' && !longitude.trim())
    ) {
        return null
    }

    const lat = Number(latitude)
    const lng = Number(longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return null
    }
    return { lat, lng }
}

function getCafeCoordinates(cafe) {
    const candidates = [
        [cafe.latitude, cafe.longitude],
        [cafe.lat, cafe.longitude ?? cafe.lng ?? cafe.lon ?? cafe.long],
        cafe.location,
        cafe.coordinates,
        cafe.geo,
        cafe.geolocation,
        cafe.point,
        cafe.geometry
    ]

    for (const candidate of candidates) {
        if (Array.isArray(candidate) && candidate.length >= 2) {
            const coordinates = validCoordinates(candidate[1], candidate[0])
            if (coordinates) return coordinates
        }

        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            const nestedCoordinates = Array.isArray(candidate.coordinates)
                ? validCoordinates(candidate.coordinates[1], candidate.coordinates[0])
                : null
            const coordinates = nestedCoordinates ?? validCoordinates(
                candidate.latitude ?? candidate.lat,
                candidate.longitude ?? candidate.lng ?? candidate.lon ?? candidate.long
            )
            if (coordinates) return coordinates
        }
    }

    return null
}

function initializeMap() {
    if (!window.L) {
        mapStatus.textContent = 'The map could not be loaded. Check your connection and reload the page.'
        return
    }

    cafeMap = window.L.map('cafe-map', { scrollWheelZoom: false }).setView(torontoCenter, 11)
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'
    }).addTo(cafeMap)
    for (const [variant, className] of [
        ['saved', 'cafe-map-marker'],
        ['favorite', 'cafe-map-marker is-favorite'],
        ['result', 'cafe-map-marker is-result']
    ]) {
        markerIcons[variant] = window.L.divIcon({
            className,
            iconSize: [26, 36],
            iconAnchor: [13, 36],
            popupAnchor: [0, -32]
        })
    }
    mapStatus.textContent = 'Cafes you add to your list are pinned here.'
}

function markerIconFor(cafeId) {
    if (!isInPersonalCollection(cafeId)) return markerIcons.result
    return preferences.get(cafeId)?.favorite ? markerIcons.favorite : markerIcons.saved
}

function markerPopup(cafe) {
    const cafeId = String(cafe._id)
    const content = document.createElement('div')
    const name = document.createElement('strong')
    name.textContent = getCafeName(cafe)
    content.append(name)

    const address = getCafeAddress(cafe)
    if (address) {
        const addressElement = document.createElement('p')
        addressElement.className = 'map-popup-address'
        addressElement.textContent = address
        content.append(addressElement)
    }

    if (isInPersonalCollection(cafeId)) {
        const tag = document.createElement('p')
        tag.className = 'map-popup-tag'
        tag.textContent = preferences.get(cafeId)?.favorite ? '♥ Favourite · In your list' : 'In your list'
        content.append(tag)
    }

    const detailsButton = document.createElement('button')
    detailsButton.className = 'map-popup-button'
    detailsButton.type = 'button'
    detailsButton.textContent = 'View cafe details'
    detailsButton.addEventListener('click', () => openCafeCard(cafeId))
    content.append(detailsButton)
    return content
}

// Scrolls to a cafe's card, switching back to the full list if a search or
// filter is currently hiding a saved cafe.
async function openCafeCard(cafeId) {
    let card = document.getElementById(`cafe-${cafeId}`)
    if (!card && isInPersonalCollection(cafeId)) {
        clearTimeout(searchTimeout)
        searchInput.value = ''
        setFilter('all')
        await loadCafes()
        card = document.getElementById(`cafe-${cafeId}`)
    }
    if (!card) return
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    card.focus({ preventScroll: true })
}

function highlightCafeMarker(marker) {
    if (selectedCafeMarker && selectedCafeMarker !== marker) {
        selectedCafeMarker.getElement()?.classList.remove('is-selected')
    }
    selectedCafeMarker = marker
    marker.getElement()?.classList.add('is-selected')
}

function createCafeMarker(cafe, coordinates) {
    const marker = window.L.marker([coordinates.lat, coordinates.lng], { icon: markerIconFor(String(cafe._id)) })
        .addTo(cafeMap)
        .bindPopup(() => markerPopup(cafe))
    marker.on('click', () => highlightCafeMarker(marker))
    return marker
}

function removeMarker(markers, cafeId) {
    const marker = markers.get(cafeId)
    if (!marker) return
    if (selectedCafeMarker === marker) selectedCafeMarker = null
    marker.remove()
    markers.delete(cafeId)
}

function storedLocation(cafe) {
    const mapLocation = preferences.get(String(cafe._id))?.mapLocation
    return getCafeCoordinates(cafe)
        ?? (mapLocation ? validCoordinates(mapLocation.lat, mapLocation.lng) : null)
}

function addSavedMarker(cafe, coordinates) {
    const cafeId = String(cafe._id)
    removeMarker(resultMarkers, cafeId)
    if (savedMarkers.has(cafeId)) return savedMarkers.get(cafeId)
    const marker = createCafeMarker(cafe, coordinates)
    savedMarkers.set(cafeId, marker)
    return marker
}

// Keeps one pin per cafe in the list: adds missing pins, updates favourite
// styling, and removes pins for deleted profiles.
function syncSavedMarkers() {
    if (!cafeMap) return

    for (const cafeId of [...savedMarkers.keys()]) {
        if (!savedCafes.has(cafeId) || !isInPersonalCollection(cafeId)) {
            removeMarker(savedMarkers, cafeId)
        }
    }

    const needLookup = []
    for (const [cafeId, cafe] of savedCafes) {
        if (!isInPersonalCollection(cafeId)) continue

        const marker = savedMarkers.get(cafeId)
        if (marker) {
            const icon = markerIconFor(cafeId)
            if (marker.options.icon !== icon) {
                marker.setIcon(icon)
                if (selectedCafeMarker === marker) marker.getElement()?.classList.add('is-selected')
            }
            continue
        }

        const coordinates = storedLocation(cafe)
        if (coordinates) {
            addSavedMarker(cafe, coordinates)
        } else if (!failedLocations.has(cafeId) && !pendingLocations.has(cafeId) && getCafeAddress(cafe).trim()) {
            needLookup.push(cafe)
        }
    }

    if (needLookup.length > 0) placeSavedPins(needLookup)
}

// Looks up saved cafes' addresses one at a time (the lookup service allows
// one request per second) and remembers each position on the cafe profile.
async function placeSavedPins(cafes) {
    for (const cafe of cafes) pendingLocations.add(String(cafe._id))
    describeMap()

    let placed = 0
    for (const cafe of cafes) {
        const cafeId = String(cafe._id)
        try {
            const coordinates = await geocodeAddress(getCafeAddress(cafe))
            if (!isInPersonalCollection(cafeId) || !savedCafes.has(cafeId)) continue

            addSavedMarker(cafe, coordinates)
            placed += 1
            const preference = preferences.get(cafeId)
            if (preference) preference.mapLocation = coordinates
            requestJson(`/api/collection/${encodeURIComponent(cafeId)}/location`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(coordinates)
            }).catch(error => console.warn(`Could not remember the map position for ${getCafeName(cafe)}:`, error))
        } catch {
            failedLocations.add(cafeId)
        } finally {
            pendingLocations.delete(cafeId)
            describeMap()
        }
    }

    if (placed > 0 && !cafeMap.getContainer().querySelector('.leaflet-popup')) {
        fitMapToPins()
    }
}

// Shows temporary pins for visible search results that are not in the list.
function syncResultMarkers(visibleCafes) {
    if (!cafeMap) return
    const visibleIds = new Set(visibleCafes.map(cafe => String(cafe._id)))

    for (const cafeId of [...resultMarkers.keys()]) {
        if (!visibleIds.has(cafeId) || isInPersonalCollection(cafeId)) {
            removeMarker(resultMarkers, cafeId)
        }
    }

    for (const cafe of visibleCafes) {
        const cafeId = String(cafe._id)
        if (isInPersonalCollection(cafeId) || resultMarkers.has(cafeId)) continue
        const coordinates = getCafeCoordinates(cafe)
        if (coordinates) resultMarkers.set(cafeId, createCafeMarker(cafe, coordinates))
    }
}

function fitMapToPins() {
    if (!cafeMap) return
    const bounds = [...savedMarkers.values(), ...resultMarkers.values()].map(marker => marker.getLatLng())
    if (bounds.length > 0) {
        cafeMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 14 })
    } else {
        cafeMap.setView(torontoCenter, 11)
    }
}

function describeMap() {
    if (!cafeMap) return
    const total = [...savedCafes.keys()].filter(isInPersonalCollection).length
    if (total === 0) {
        mapStatus.textContent = 'Add cafes to your list to pin them on the map.'
        return
    }

    const pinned = savedMarkers.size
    const pending = pendingLocations.size
    const failed = [...failedLocations].filter(cafeId => savedCafes.has(cafeId) && !savedMarkers.has(cafeId)).length
    const parts = [`${pinned} of your ${total} saved ${total === 1 ? 'cafe is' : 'cafes are'} pinned on the map.`]
    if (pending > 0) parts.push(`Placing ${pending} more…`)
    if (failed > 0) parts.push(`${failed} couldn’t be located from ${failed === 1 ? 'its' : 'their'} address.`)
    mapStatus.textContent = parts.join(' ')
}

function updateMap(visibleCafes) {
    syncSavedMarkers()
    syncResultMarkers(visibleCafes)
    fitMapToPins()
    describeMap()
}

async function geocodeAddress(address) {
    const query = address.trim()
    const cached = geocodingCache.get(query)
    if (cached) return cached

    const lookup = geocodingQueue.then(async () => {
        const cachedResult = geocodingCache.get(query)
        if (cachedResult) return cachedResult

        const wait = Math.max(0, 1000 - (Date.now() - lastGeocodingAt))
        if (wait > 0) {
            await new Promise(resolve => setTimeout(resolve, wait))
        }
        lastGeocodingAt = Date.now()

        const searchQuery = /\btoronto\b/i.test(query)
            ? query
            : `${query}, Toronto, Ontario, Canada`
        const response = await fetch(
            `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(searchQuery)}`,
            { headers: { 'Accept-Language': navigator.language || 'en' } }
        )
        if (!response.ok) {
            throw new Error('The address lookup service is unavailable. Please try again later.')
        }

        const results = await response.json()
        const result = Array.isArray(results) ? results[0] : null
        const coordinates = result ? validCoordinates(result.lat, result.lon) : null
        if (!coordinates) {
            throw new Error('No map location was found for this cafe address.')
        }

        geocodingCache.set(query, coordinates)
        return coordinates
    })

    geocodingQueue = lookup.then(() => undefined, () => undefined)
    return lookup
}

async function showCafeOnMap(cafe) {
    if (!cafeMap) {
        throw new Error('The map is not available. Check your connection and reload the page.')
    }

    const cafeId = String(cafe._id)
    const saved = isInPersonalCollection(cafeId)
    let marker = saved ? savedMarkers.get(cafeId) : resultMarkers.get(cafeId)
    if (!marker) {
        let coordinates = saved ? storedLocation(cafe) : getCafeCoordinates(cafe)
        if (!coordinates) {
            const address = getCafeAddress(cafe)
            if (!address.trim()) {
                throw new Error('This cafe has no coordinates or address in the dataset.')
            }
            mapStatus.textContent = `Looking up the address for ${getCafeName(cafe)}…`
            coordinates = await geocodeAddress(address)
        }

        if (saved) {
            savedCafes.set(cafeId, cafe)
            failedLocations.delete(cafeId)
            marker = addSavedMarker(cafe, coordinates)
            if (!preferences.get(cafeId)?.mapLocation && !getCafeCoordinates(cafe)) {
                preferences.get(cafeId).mapLocation = coordinates
                requestJson(`/api/collection/${encodeURIComponent(cafeId)}/location`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(coordinates)
                }).catch(() => {})
            }
        } else {
            marker = createCafeMarker(cafe, coordinates)
            resultMarkers.set(cafeId, marker)
        }
    }

    cafeMap.setView(marker.getLatLng(), 15)
    highlightCafeMarker(marker)
    marker.openPopup()
    document.querySelector('#map-section').scrollIntoView({ behavior: 'smooth', block: 'start' })
    mapStatus.textContent = `${getCafeName(cafe)} is shown on the map.`
}

function hideSearchSuggestions() {
    searchSuggestions.hidden = true
    searchSuggestions.replaceChildren()
    searchInput.setAttribute('aria-expanded', 'false')
}

function showSearchMessage(message) {
    const option = document.createElement('button')
    option.className = 'search-suggestion-message'
    option.type = 'button'
    option.role = 'option'
    option.disabled = true
    option.textContent = message
    searchSuggestions.replaceChildren(option)
    searchSuggestions.hidden = false
    searchInput.setAttribute('aria-expanded', 'true')
}

function showSearchSuggestions(cafes) {
    searchSuggestions.replaceChildren()
    if (cafes.length === 0) {
        showSearchMessage('No matching cafes found.')
        return
    }

    for (const cafe of cafes.slice(0, 8)) {
        const suggestion = document.createElement('button')
        suggestion.className = 'search-suggestion'
        suggestion.type = 'button'
        suggestion.role = 'option'
        suggestion.setAttribute('aria-selected', 'false')
        suggestion.dataset.cafeId = String(cafe._id)
        suggestion.dataset.cafeName = getCafeName(cafe)

        const name = document.createElement('span')
        name.textContent = getCafeName(cafe)
        suggestion.append(name)

        const address = getCafeAddress(cafe)
        if (address) {
            const addressElement = document.createElement('small')
            addressElement.textContent = address
            suggestion.append(addressElement)
        }

        searchSuggestions.append(suggestion)
    }

    searchSuggestions.hidden = false
    searchInput.setAttribute('aria-expanded', 'true')
}

function isInPersonalCollection(cafeId) {
    const preference = preferences.get(cafeId)
    return Boolean(preference && preference.inCollection !== false)
}

function hasRatings(preference) {
    return RATING_FIELDS.some(({ field }) => preference?.[field] != null)
}

// Average of all rated fields out of 5. Quieter cafes score higher for noise.
function studyScore(preference) {
    const values = RATING_FIELDS
        .map(({ field, lowerIsBetter }) => {
            const value = preference?.[field]
            if (value == null) return null
            return lowerIsBetter ? 6 - value : value
        })
        .filter(value => value != null)

    if (values.length === 0) return null
    return values.reduce((sum, value) => sum + value, 0) / values.length
}

function makeElement(tag, className, text) {
    const element = document.createElement(tag)
    if (className) element.className = className
    if (text != null) element.textContent = text
    return element
}

function makeStatus(className = 'collection-action-status') {
    const status = makeElement('p', className)
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    return status
}

function makeRatingSelect({ field, label, scale }, selectedValue) {
    const fieldLabel = makeElement('label', 'rating-field')
    fieldLabel.append(document.createTextNode(label))
    const select = document.createElement('select')
    select.name = field

    const unrated = makeElement('option', null, 'Not rated')
    unrated.value = ''
    select.append(unrated)

    scale.forEach((description, index) => {
        const option = makeElement('option', null, `${index + 1} · ${description}`)
        option.value = String(index + 1)
        select.append(option)
    })

    select.value = selectedValue == null ? '' : String(selectedValue)
    fieldLabel.append(select)
    return fieldLabel
}

function makeBadges(preference) {
    const badges = makeElement('div', 'card-badges')
    if (preference.recommend === true) {
        badges.append(makeElement('span', 'badge badge-recommend', '👍 Recommended'))
    } else if (preference.recommend === false) {
        badges.append(makeElement('span', 'badge badge-not-recommend', '👎 Not recommended'))
    }

    const score = studyScore(preference)
    if (score != null) {
        const scoreBadge = makeElement('span', 'badge badge-score', `${score.toFixed(1)} / 5`)
        scoreBadge.title = 'Study score: the average of your ratings, with quieter cafes scoring higher'
        scoreBadge.setAttribute('aria-label', `Study score ${score.toFixed(1)} out of 5`)
        badges.append(scoreBadge)
    }
    return badges
}

function makePreferenceSummary(preference) {
    const summary = makeElement('div', 'preference-summary')

    if (hasRatings(preference)) {
        const list = makeElement('dl', 'rating-summary')
        for (const { field, label, scale } of RATING_FIELDS) {
            const value = preference[field]
            if (value == null) continue
            const row = makeElement('div', 'rating-row')
            const term = makeElement('dt', null, label)
            const detail = makeElement('dd')
            const dots = makeElement('span', 'rating-dots', '●'.repeat(value) + '○'.repeat(5 - value))
            dots.setAttribute('aria-hidden', 'true')
            const text = makeElement('span', 'rating-text', scale[value - 1])
            const srText = makeElement('span', 'sr-only', `${value} out of 5, `)
            detail.append(dots, srText, text)
            row.append(term, detail)
            list.append(row)
        }
        summary.append(list)
    }

    if (preference.personalNotes) {
        const notes = makeElement('blockquote', 'personal-notes', preference.personalNotes)
        summary.append(notes)
    }

    if (!hasRatings(preference) && !preference.personalNotes) {
        summary.append(makeElement('p', 'empty-profile', 'No ratings or notes yet. Select “Edit” to review this cafe.'))
    }

    return summary
}

function makePreferenceForm(cafe, preference, status) {
    const cafeId = String(cafe._id)
    const form = makeElement('form', 'cafe-form preference-form')
    const nameId = `cafe-${cafeId}-title`
    form.setAttribute('aria-labelledby', nameId)

    const ratings = makeElement('div', 'form-row rating-grid')
    for (const ratingField of RATING_FIELDS) {
        ratings.append(makeRatingSelect(ratingField, preference[ratingField.field]))
    }

    const recommendGroup = makeElement('fieldset', 'recommend-group')
    recommendGroup.append(makeElement('legend', null, 'Would you recommend it?'))
    const currentRecommend = preference.recommend === true ? 'yes' : preference.recommend === false ? 'no' : ''
    for (const [value, label] of [['yes', 'Recommend'], ['no', 'Don’t recommend'], ['', 'Undecided']]) {
        const optionLabel = makeElement('label', 'check-label')
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'recommend'
        radio.value = value
        radio.checked = value === currentRecommend
        optionLabel.append(radio, document.createTextNode(` ${label}`))
        recommendGroup.append(optionLabel)
    }


    const notesLabel = makeElement('label')
    notesLabel.append(document.createTextNode('Notes'))
    const notes = document.createElement('textarea')
    notes.name = 'personalNotes'
    notes.maxLength = 1000
    notes.rows = 3
    notes.placeholder = 'Best seats, opening hours, what to order…'
    notes.value = preference.personalNotes ?? ''
    notesLabel.append(notes)

    const actions = makeElement('div', 'form-actions')
    const saveButton = makeElement('button', 'primary-button', 'Save')
    saveButton.type = 'submit'
    const cancelButton = makeElement('button', 'secondary-button', 'Cancel')
    cancelButton.type = 'button'
    cancelButton.addEventListener('click', () => {
        openEditors.delete(cafeId)
        replaceCard(cafe, { focus: '.edit-button' })
    })
    actions.append(cancelButton, saveButton)

    form.append(ratings, recommendGroup, notesLabel, actions)

    form.addEventListener('submit', async event => {
        event.preventDefault()
        const formData = new FormData(form)
        const recommendValue = formData.get('recommend')
        const body = {
            ...Object.fromEntries(RATING_FIELDS.map(({ field }) => {
                const value = formData.get(field)
                return [field, value ? Number(value) : null]
            })),
            favorite: Boolean(preferences.get(cafeId)?.favorite),
            recommend: recommendValue === 'yes' ? true : recommendValue === 'no' ? false : null,
            personalNotes: formData.get('personalNotes') ?? ''
        }

        saveButton.disabled = true
        cancelButton.disabled = true
        status.textContent = 'Saving…'

        try {
            const saved = await requestJson(`/api/preferences/${encodeURIComponent(cafeId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            preferences.set(cafeId, { ...(preferences.get(cafeId) ?? {}), ...saved })
            syncSavedMarkers()
            openEditors.delete(cafeId)
            cardMessages.set(cafeId, 'Preferences saved.')
            replaceCard(cafe, { focus: '.edit-button' })
        } catch (error) {
            status.textContent = error.message
            saveButton.disabled = false
            cancelButton.disabled = false
        }
    })

    return form
}

const WEEKDAYS = [
    ['monday', 'Monday'],
    ['tuesday', 'Tuesday'],
    ['wednesday', 'Wednesday'],
    ['thursday', 'Thursday'],
    ['friday', 'Friday'],
    ['saturday', 'Saturday'],
    ['sunday', 'Sunday']
]

function torontoWeekday() {
    try {
        return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/Toronto' })
            .format(new Date())
            .toLowerCase()
    } catch {
        return ''
    }
}

function formatClockTime(hours, minutes) {
    const hour = Number(hours)
    const suffix = hour >= 12 && hour < 24 ? 'PM' : 'AM'
    const displayHour = hour % 12 === 0 ? 12 : hour % 12
    return `${displayHour}:${minutes} ${suffix}`
}

function formatHours(value) {
    if (typeof value !== 'string' || !value.trim()) return 'Not listed'
    const match = value.trim().match(/^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/)
    if (!match) return value.trim()
    return `${formatClockTime(match[1], match[2])} – ${formatClockTime(match[3], match[4])}`
}

function formatPhone(value) {
    const digits = String(value).replace(/\D/g, '')
    const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (local.length !== 10) return { display: String(value), href: digits ? `tel:+${digits}` : '' }
    return {
        display: `(${local.slice(0, 3)}) ${local.slice(3, 6)}-${local.slice(6)}`,
        href: `tel:+1${local}`
    }
}

function safeWebLink(value) {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
        const url = new URL(value.trim())
        return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
    } catch {
        return null
    }
}

function makeDetailRow(label, content) {
    const row = makeElement('div', 'detail-row')
    row.append(makeElement('dt', null, label))
    const detail = makeElement('dd')
    detail.append(content)
    row.append(detail)
    return row
}

function makeCafeDetails(cafe) {
    const cafeId = String(cafe._id)
    const details = makeElement('details', 'cafe-details')
    details.open = openDetails.has(cafeId)
    details.addEventListener('toggle', () => {
        if (details.open) openDetails.add(cafeId)
        else openDetails.delete(cafeId)
    })
    const summary = makeElement('summary', null, 'View More Details')
    summary.setAttribute('aria-label', `View more about ${getCafeName(cafe)}`)
    details.append(summary)
    const body = makeElement('div', 'cafe-details-body')

    const facts = makeElement('dl', 'detail-list')
    if (typeof cafe.typeOfStore === 'string' && cafe.typeOfStore) {
        facts.append(makeDetailRow('Type', document.createTextNode(cafe.typeOfStore)))
    }
    if (typeof cafe.rating === 'number') {
        facts.append(makeDetailRow('Rating', document.createTextNode(`${cafe.rating.toFixed(1)} ★`)))
    }
    if (typeof cafe.priceRange === 'string' && cafe.priceRange) {
        facts.append(makeDetailRow('Price', document.createTextNode(cafe.priceRange)))
    }

    // Contact information
    if (cafe.phoneNo) {
        const phone = formatPhone(cafe.phoneNo)
        const content = phone.href ? makeElement('a', null, phone.display) : document.createTextNode(phone.display)
        if (phone.href) content.href = phone.href
        facts.append(makeDetailRow('Phone', content))
    }
    const website = safeWebLink(cafe.webLink)
    if (website) {
        const link = makeElement('a', null, website.hostname.replace(/^www\./, ''))
        link.href = website.href
        link.target = '_blank'
        link.rel = 'noopener noreferrer'
        facts.append(makeDetailRow('Website', link))
    }
    if (!cafe.phoneNo && !website) {
        facts.append(makeDetailRow('Contact', document.createTextNode('No phone or website listed')))
    }
    const address = getCafeAddress(cafe)
    if (address) {
        facts.append(makeDetailRow('Address', document.createTextNode(address)))
    }
    if (typeof cafe.plusCodes === 'string' && cafe.plusCodes) {
        facts.append(makeDetailRow('Plus code', document.createTextNode(cafe.plusCodes)))
    }
    body.append(facts)

    // Opening hours
    const hoursHeading = makeElement('h4', 'detail-heading', 'Opening hours')
    body.append(hoursHeading)
    const hoursByDay = cafe.hoursByDay && typeof cafe.hoursByDay === 'object' ? cafe.hoursByDay : null
    if (hoursByDay && WEEKDAYS.some(([day]) => hoursByDay[day])) {
        const today = torontoWeekday()
        const hours = makeElement('dl', 'hours-list')
        for (const [day, label] of WEEKDAYS) {
            const row = makeDetailRow(label, document.createTextNode(formatHours(hoursByDay[day])))
            if (day === today) {
                row.classList.add('is-today')
                row.querySelector('dt').append(makeElement('span', 'today-label', ' (today)'))
            }
            hours.append(row)
        }
        body.append(hours)
    } else if (typeof cafe.operatingHoursRaw === 'string' && cafe.operatingHoursRaw) {
        body.append(makeElement('p', 'hours-raw', cafe.operatingHoursRaw))
    } else {
        body.append(makeElement('p', 'hours-raw', 'Opening hours are not listed.'))
    }

    details.append(body)
    return details
}

function replaceCard(cafe, { focus } = {}) {
    const existing = document.getElementById(`cafe-${String(cafe._id)}`)
    if (!existing) return
    const card = makeCafeCard(cafe)
    existing.replaceWith(card)
    if (focus) card.querySelector(focus)?.focus()
}

function updateFavoriteButton(button, cafe, isFavorite) {
    const name = getCafeName(cafe)
    button.classList.toggle('is-favorite', isFavorite)
    button.querySelector('img').src = isFavorite ? '/assets/heart-filled.svg' : '/assets/heart-outline.svg'
    button.setAttribute('aria-pressed', String(isFavorite))
    button.setAttribute('aria-label', `Favourite ${name}`)
    button.title = isFavorite ? 'Remove from favourites' : 'Add to favourites'
}

// Heart toggle that saves the favourite straight away, without opening the editor.
function makeFavoriteButton(cafe) {
    const cafeId = String(cafe._id)
    const button = makeElement('button', 'favorite-toggle')
    button.type = 'button'
    const icon = document.createElement('img')
    icon.src = '/assets/heart-outline.svg'
    icon.alt = ''
    button.append(icon)
    updateFavoriteButton(button, cafe, Boolean(preferences.get(cafeId)?.favorite))

    button.addEventListener('click', async () => {
        const current = { ...emptyPreference(cafeId), ...preferences.get(cafeId) }
        const nextFavorite = !current.favorite
        const body = {
            ...Object.fromEntries(RATING_FIELDS.map(({ field }) => [field, current[field] ?? null])),
            favorite: nextFavorite,
            recommend: current.recommend ?? null,
            personalNotes: current.personalNotes ?? ''
        }

        button.disabled = true
        updateFavoriteButton(button, cafe, nextFavorite)
        try {
            const saved = await requestJson(`/api/preferences/${encodeURIComponent(cafeId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            preferences.set(cafeId, { ...(preferences.get(cafeId) ?? {}), ...saved })
            syncSavedMarkers()
            const message = nextFavorite
                ? `${getCafeName(cafe)} was added to your favourites.`
                : `${getCafeName(cafe)} was removed from your favourites.`
            if (currentFilter === 'favorites' && !nextFavorite && !openEditors.has(cafeId)) {
                renderCafes(message)
                return
            }
            const status = document.getElementById(`cafe-${cafeId}`)?.querySelector('[role="status"]')
            if (status) status.textContent = message
        } catch (error) {
            updateFavoriteButton(button, cafe, current.favorite)
            const status = document.getElementById(`cafe-${cafeId}`)?.querySelector('[role="status"]')
            if (status) status.textContent = error.message
        } finally {
            button.disabled = false
        }
    })

    return button
}

function makeCafeCard(cafe) {
    const cafeId = String(cafe._id)
    const inList = isInPersonalCollection(cafeId)
    const preference = inList ? { ...emptyPreference(cafeId), ...preferences.get(cafeId) } : null
    const card = makeElement('article', inList ? 'cafe-card is-in-list' : 'cafe-card')
    card.id = `cafe-${cafeId}`
    card.tabIndex = -1

    const topLine = makeElement('div', 'card-topline')
    if (inList) {
        topLine.append(makeFavoriteButton(cafe), makeBadges(preference))
    } else {
        const marker = makeElement('img', 'card-marker')
        marker.src = '/assets/heart-outline.svg'
        marker.alt = ''
        topLine.append(marker)
    }

    const title = makeElement('h3', null, getCafeName(cafe))
    title.id = `cafe-${cafeId}-title`
    card.append(topLine, title)

    const address = getCafeAddress(cafe)
    if (address) {
        card.append(makeElement('p', 'cafe-address', address))
    }

    const cardActions = makeElement('div', 'card-actions')
    if (address || getCafeCoordinates(cafe)) {
        const mapButton = makeElement('button', 'map-link card-map-button')
        const arrow = makeElement('img', 'map-button-arrow')
        arrow.src = '/assets/arrow.svg'
        arrow.alt = ''
        mapButton.append(arrow, document.createTextNode('Show on Map'))
        mapButton.type = 'button'
        mapButton.addEventListener('click', async () => {
            mapButton.disabled = true
            mapStatus.textContent = `Finding ${getCafeName(cafe)}…`
            try {
                await showCafeOnMap(cafe)
            } catch (error) {
                mapStatus.textContent = error.message
            } finally {
                mapButton.disabled = false
            }
        })
        cardActions.append(mapButton)
    }

    if (typeof cafe.description === 'string' && cafe.description) {
        card.append(makeElement('p', 'cafe-notes', cafe.description))
    }

    card.append(cardActions, makeCafeDetails(cafe))

    const status = makeStatus()
    const message = cardMessages.get(cafeId)
    if (message) {
        status.textContent = message
        cardMessages.delete(cafeId)
    }

    if (!inList) {
        const addButton = makeElement('button', 'primary-button add-button', 'Add to List')
        addButton.type = 'button'
        addButton.addEventListener('click', async () => {
            addButton.disabled = true
            status.textContent = 'Adding to your list…'
            try {
                await requestJson(`/api/collection/${encodeURIComponent(cafeId)}`, { method: 'POST' })
                preferences.set(cafeId, emptyPreference(cafeId))
                savedCafes.set(cafeId, cafe)
                failedLocations.delete(cafeId)
                syncSavedMarkers()
                describeMap()
                openEditors.add(cafeId)
                cardMessages.set(cafeId, 'Added to your list. Rate it below, then save.')
                replaceCard(cafe, { focus: 'select' })
            } catch (error) {
                status.textContent = error.message
                addButton.disabled = false
            }
        })
        cardActions.append(addButton)
        card.append(status)
        return card
    }

    const profile = makeElement('section', 'cafe-profile')
    profile.setAttribute('aria-label', `Your review of ${getCafeName(cafe)}`)

    if (openEditors.has(cafeId)) {
        profile.append(makePreferenceForm(cafe, preference, status), status)
        card.append(profile)
        return card
    }

    profile.append(makePreferenceSummary(preference))

    const actions = makeElement('div', 'form-actions profile-actions')
    const editButton = makeElement('button', 'primary-button edit-button', 'Edit')
    editButton.type = 'button'
    editButton.setAttribute('aria-label', `Edit your review of ${getCafeName(cafe)}`)
    editButton.addEventListener('click', () => {
        openEditors.add(cafeId)
        replaceCard(cafe, { focus: 'select' })
    })

    const deleteButton = makeElement('button', 'secondary-button danger-button', 'Delete')
    deleteButton.type = 'button'
    deleteButton.setAttribute('aria-label', `Delete ${getCafeName(cafe)} from your list`)
    deleteButton.addEventListener('click', async () => {
        const confirmed = window.confirm(
            `Delete ${getCafeName(cafe)} from your list?\n\nThis permanently erases its ratings, notes, favourite and recommendation.`
        )
        if (!confirmed) return

        deleteButton.disabled = true
        editButton.disabled = true
        status.textContent = 'Deleting…'
        try {
            await requestJson(`/api/collection/${encodeURIComponent(cafeId)}`, { method: 'DELETE' })
            preferences.delete(cafeId)
            savedCafes.delete(cafeId)
            failedLocations.delete(cafeId)
            openEditors.delete(cafeId)
            if (!currentQuery) {
                currentCafes = currentCafes.filter(item => String(item._id) !== cafeId)
            }
            renderCafes(`${getCafeName(cafe)} was deleted from your list.`)
        } catch (error) {
            status.textContent = error.message
            deleteButton.disabled = false
            editButton.disabled = false
        }
    })

    actions.append(deleteButton, editButton)
    profile.append(actions, status)
    card.append(profile)
    return card
}

const listFilters = {
    all: () => true,
    favorites: preference => preference.favorite,
    recommended: preference => preference.recommend === true,
    'not-recommended': preference => preference.recommend === false,
    unrated: preference => !hasRatings(preference)
}

function compareByName(a, b) {
    return getCafeName(a).localeCompare(getCafeName(b))
}

function renderCafes(announcement = '') {
    const inListMode = !currentQuery
    listTools.hidden = !inListMode
    showListButton.hidden = inListMode

    let visibleCafes = currentSelectedCafeId
        ? currentCafes.filter(cafe => String(cafe._id) === currentSelectedCafeId)
        : currentCafes

    const totalInList = visibleCafes.length
    if (inListMode) {
        const matches = listFilters[currentFilter] ?? listFilters.all
        visibleCafes = visibleCafes
            .filter(cafe => matches({ ...emptyPreference(String(cafe._id)), ...preferences.get(String(cafe._id)) }))
            .sort(compareByName)
    }

    const prefix = announcement ? `${announcement} ` : ''
    if (visibleCafes.length === 0) {
        cafeList.replaceChildren()
        updateMap([])
        listStatus.textContent = prefix + (currentQuery
            ? 'No cafes match that search. Try another name.'
            : totalInList === 0
                ? 'Your list is empty. Search for a cafe above to add it.'
                : 'No cafes in your list match this filter.')
        return
    }

    const noun = visibleCafes.length === 1 ? 'cafe' : 'cafes'
    listStatus.textContent = prefix + (inListMode
        ? visibleCafes.length === totalInList
            ? `${totalInList} ${noun} in your list`
            : `Showing ${visibleCafes.length} of ${totalInList} cafes in your list`
        : `${visibleCafes.length} ${noun} found. Add any of them to your list.`)
    cafeList.replaceChildren(...visibleCafes.map(makeCafeCard))
    updateMap(visibleCafes)
}

async function loadCafes(terms = '', selectedCafeId = '', { showSuggestions = false } = {}) {
    const requestId = ++cafeLoadRequestId
    const query = terms.trim()
    listStatus.textContent = query ? 'Searching cafes…' : 'Loading your list…'
    cafeList.replaceChildren()
    if (!query || !showSuggestions) hideSearchSuggestions()
    const url = query
        ? `/api/cafes/search?terms=${encodeURIComponent(query)}`
        : '/api/collection'

    try {
        const needSavedCafes = query && !savedCafesLoaded
        const [cafes, savedPreferences, listedCafes] = await Promise.all([
            requestJson(url),
            requestJson('/api/preferences'),
            needSavedCafes ? requestJson('/api/collection') : null
        ])
        if (requestId !== cafeLoadRequestId) return

        if (showSuggestions && searchInput.value.trim() === query) {
            showSearchSuggestions(cafes)
        }

        preferences.clear()
        for (const preference of savedPreferences) {
            preferences.set(preference.cafeId, preference)
        }

        const savedList = query ? listedCafes : cafes
        if (savedList) {
            savedCafes.clear()
            for (const cafe of savedList) savedCafes.set(String(cafe._id), cafe)
            savedCafesLoaded = true
        }

        currentCafes = cafes
        currentQuery = query
        currentSelectedCafeId = selectedCafeId
        renderCafes()
        if (selectedCafeId) {
            document.getElementById(`cafe-${selectedCafeId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
    } catch (error) {
        if (requestId !== cafeLoadRequestId) return
        listStatus.textContent = error.message
        if (cafeMap && savedMarkers.size === 0) mapStatus.textContent = `Unable to load cafe locations: ${error.message}`
        if (showSuggestions && searchInput.value.trim() === query) {
            showSearchMessage('Search is unavailable. Please try again.')
        }
    }
}

searchForm.addEventListener('submit', event => {
    event.preventDefault()
    clearTimeout(searchTimeout)
    hideSearchSuggestions()
    loadCafes(searchInput.value)
})

searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout)
    cafeLoadRequestId += 1
    const terms = searchInput.value.trim()
    if (!terms) {
        loadCafes()
        return
    }

    hideSearchSuggestions()
    searchTimeout = setTimeout(() => {
        loadCafes(terms, '', { showSuggestions: true })
    }, 250)
})

searchSuggestions.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return
    const suggestion = event.target.closest('button[data-cafe-id]')
    if (!(suggestion instanceof HTMLButtonElement)) return

    clearTimeout(searchTimeout)
    searchInput.value = suggestion.dataset.cafeName
    hideSearchSuggestions()
    loadCafes(searchInput.value, suggestion.dataset.cafeId)
})

document.addEventListener('click', event => {
    if (!searchContainer.contains(event.target)) hideSearchSuggestions()
})

showListButton.addEventListener('click', () => {
    clearTimeout(searchTimeout)
    searchInput.value = ''
    loadCafes()
})

function setFilter(filter) {
    currentFilter = listFilters[filter] ? filter : 'all'
    for (const button of filterButtons) {
        button.setAttribute('aria-pressed', String(button.dataset.filter === currentFilter))
    }
}

for (const button of filterButtons) {
    button.addEventListener('click', () => {
        if (button.dataset.filter === currentFilter) return
        setFilter(button.dataset.filter)
        renderCafes()
    })
}

initializeMap()
loadCafes()
