const cafeList = document.querySelector('#cafe-list')
const listStatus = document.querySelector('#list-status')
const searchForm = document.querySelector('#search-form')
const searchInput = document.querySelector('#search-terms')
const preferences = new Map()

async function requestJson(url, options) {
    const response = await fetch(url, options)
    const payload = await response.json()

    if (!response.ok) {
        throw new Error(payload.error ?? 'The request could not be completed.')
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
        return cafe.location.address ?? cafe.location.formattedAddress ?? ''
    }
    return ''
}

function makeRatingOptions(selectedValue) {
    const select = document.createElement('select')
    select.required = false

    const unrated = document.createElement('option')
    unrated.value = ''
    unrated.textContent = 'Not rated'
    select.append(unrated)

    for (let value = 1; value <= 5; value += 1) {
        const option = document.createElement('option')
        option.value = String(value)
        option.textContent = `${value} / 5`
        select.append(option)
    }

    select.value = selectedValue == null ? '' : String(selectedValue)
    return select
}

function makeCafeCard(cafe) {
    const cafeId = String(cafe._id)
    const saved = preferences.get(cafeId) ?? {}
    const card = document.createElement('article')
    card.className = 'cafe-card'

    const topLine = document.createElement('div')
    topLine.className = 'card-topline'
    const marker = document.createElement('span')
    marker.className = 'card-marker'
    marker.setAttribute('aria-hidden', 'true')
    marker.textContent = '✳'
    topLine.append(marker)

    const title = document.createElement('h3')
    title.textContent = getCafeName(cafe)
    card.append(topLine, title)

    const address = getCafeAddress(cafe)
    if (address) {
        const addressElement = document.createElement('p')
        addressElement.className = 'cafe-address'
        addressElement.textContent = address
        card.append(addressElement)
    }

    if (typeof cafe.description === 'string' && cafe.description) {
        const description = document.createElement('p')
        description.className = 'cafe-notes'
        description.textContent = cafe.description
        card.append(description)
    }

    const form = document.createElement('form')
    form.className = 'cafe-form preference-form'
    form.dataset.cafeId = cafeId

    const ratings = document.createElement('div')
    ratings.className = 'form-row'
    for (const [field, label] of [['wifiQuality', 'Wi-Fi'], ['foodQuality', 'Food']]) {
        const fieldLabel = document.createElement('label')
        fieldLabel.textContent = `${label} quality`
        const select = makeRatingOptions(saved[field])
        select.name = field
        fieldLabel.append(select)
        ratings.append(fieldLabel)
    }

    const favoriteLabel = document.createElement('label')
    favoriteLabel.className = 'check-label favorite-label'
    const favorite = document.createElement('input')
    favorite.type = 'checkbox'
    favorite.name = 'favorite'
    favorite.checked = Boolean(saved.favorite)
    favoriteLabel.append(favorite, document.createTextNode(' Save to favorites'))

    const notesLabel = document.createElement('label')
    notesLabel.textContent = 'Personal notes'
    const notes = document.createElement('textarea')
    notes.name = 'personalNotes'
    notes.maxLength = 1000
    notes.rows = 2
    notes.placeholder = 'Your own reminder…'
    notes.value = saved.personalNotes ?? ''
    notesLabel.append(notes)

    const footer = document.createElement('div')
    footer.className = 'form-footer'
    const status = document.createElement('p')
    status.className = 'status-message'
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    const button = document.createElement('button')
    button.className = 'primary-button'
    button.type = 'submit'
    button.textContent = 'Save preferences'
    footer.append(status, button)

    form.append(ratings, favoriteLabel, notesLabel, footer)
    card.append(form)
    return card
}

async function loadCafes(terms = '') {
    listStatus.textContent = 'Loading cafes…'
    cafeList.replaceChildren()

    const query = terms.trim()
    const url = query
        ? `/api/cafes/search?terms=${encodeURIComponent(query)}`
        : '/api/cafes'

    try {
        await requestJson('/api/session')
        const [cafes, savedPreferences] = await Promise.all([
            requestJson(url),
            requestJson('/api/preferences')
        ])

        preferences.clear()
        for (const preference of savedPreferences) {
            preferences.set(preference.cafeId, preference)
        }

        if (cafes.length === 0) {
            listStatus.textContent = query
                ? 'No cafes match that search. Try another name.'
                : 'No cafes were found in the fixed cafe collection.'
            return
        }

        listStatus.textContent = `${cafes.length} ${cafes.length === 1 ? 'place' : 'places'} to explore`
        cafeList.replaceChildren(...cafes.map(makeCafeCard))
    } catch (error) {
        listStatus.textContent = error.message
    }
}

searchForm.addEventListener('submit', event => {
    event.preventDefault()
    loadCafes(searchInput.value)
})

cafeList.addEventListener('submit', async event => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || !form.matches('.preference-form')) return

    event.preventDefault()
    const status = form.querySelector('.status-message')
    const button = form.querySelector('button[type="submit"]')
    const formData = new FormData(form)
    const wifiValue = formData.get('wifiQuality')
    const foodValue = formData.get('foodQuality')
    const preference = {
        wifiQuality: wifiValue ? Number(wifiValue) : null,
        foodQuality: foodValue ? Number(foodValue) : null,
        favorite: formData.has('favorite'),
        personalNotes: formData.get('personalNotes')
    }

    button.disabled = true
    status.textContent = 'Saving…'

    try {
        const saved = await requestJson(`/api/preferences/${encodeURIComponent(form.dataset.cafeId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(preference)
        })
        preferences.set(saved.cafeId, saved)
        status.textContent = 'Preferences saved in this browser.'
    } catch (error) {
        status.textContent = error.message
    } finally {
        button.disabled = false
    }
})

loadCafes()
