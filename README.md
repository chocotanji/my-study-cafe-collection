# Study Cafe Collection

A personal cafe collection backed by two MongoDB databases on one cluster. `cafe_list` contains fixed cafe information and is read-only through this app. `user_input` stores each browser's personal cafe list: which cafes are on it, seven study ratings, a note, a favourite flag, and a recommendation. There are no accounts or public cafe-creation endpoints.

## Project layout

```text
backend/
  config/environment.js          Environment variables and database names
  database/connect.js            Shared MongoClient connection
  database/cafeIds.js            Cafe ID validation and lookup in the fixed directory
  database/preferences.js        Shared per-browser preference collection
  functions/api.js               Express app, Netlify handler, and local startup
  middleware/anonymousSession.js  Per-browser HttpOnly session cookie
  routes/cafes.js                Search fixed cafe records
  routes/collection.js           Add cafes to, list, and delete cafe profiles from a browser's list
  routes/preferences.js          Read and update per-browser cafe preferences
  validation/preferences.js      Preference fields, defaults, and validation
frontend/
  index.html                     Personal cafe list, filters, and search
  script.js                      API requests, map, cafe profiles, and preference forms
  style.css                      Responsive page styles
netlify.toml                     Netlify hosting and function routing
```

## Configure the environment

The two MongoDB URLs refer to the same cluster and credentials, with different database names. The app uses one `MONGODB_URI` to connect to the cluster, then selects the databases separately:

```dotenv
MONGODB_URI=mongodb+srv://username:password@cluster.example.mongodb.net/
CAFE_DATABASE=cafe_list
CAFE_COLLECTION="cafe list"
USER_INPUT_DATABASE=user_input
USER_INPUT_COLLECTION="user input"
PORT=3000
```

All `.env*` files are intentionally ignored by Git, including `.env.example`. Create a local `.env` using the variable names above, enter a newly rotated URI, and never commit the file. Netlify uses the same variable names configured in its environment-variable settings; it does not read local `.env`.

The cafe database user should have read access to `cafe_list` and read/write access to `user_input`. The app creates a unique index on the preference collection the first time preferences are saved.

## Run locally

Use Node.js 22 or newer. Run every command from the project directory containing `package.json`.

### With the Netlify CLI (recommended)

This runs the frontend, the `/api/*` rewrite and the API function the same way Netlify does in production, and loads the environment variables saved on Netlify, so no `.env` file is needed.

```sh
npm install
npx netlify-cli login
npx netlify-cli link
npm run dev:netlify
```

`login` and `link` are only needed once; choose **my-study-cafe-collection** when linking. Then open [http://localhost:8888](http://localhost:8888). `npm run dev:netlify` runs `netlify-cli dev` through `npx`, so the CLI doesn't have to be installed globally. If you already have `netlify` installed, `netlify dev` does the same thing.

If port 8888 is busy, run `npx netlify-cli dev --port 8890` and open that port instead. If cafes fail to load with a MongoDB connection error, add your IP address to the Atlas cluster's network access list.

### With plain Node

```sh
npm install
npm test
npm run dev
```

Create `.env` locally with the settings above first. Leave `NETLIFY` unset. The server connects to MongoDB before listening, and configuration or database connection errors are reported at startup. It serves both the page and the API on `PORT`, by default [http://localhost:3000](http://localhost:3000), and restarts when backend files change.

## Personal cafe list (CRUD)

1. **Create** – search the cafe directory and select **Add to my list**. This creates an empty cafe profile for the current browser and opens its review form.
2. **Read** – with the search box empty, the page shows the browser's list. Each profile shows its ratings, note, favourite and recommendation badges, and a study score. The list is shown in name order. A row of filter buttons above it (All, Favourites, Recommended, Not recommended, Not rated yet) narrows it down; the selected button is highlighted.
3. **Update** – select **Edit** on a profile to change any rating, the note, the favourite flag, or the recommendation, then **Save**.
Every cafe card also has a **View more** panel with the cafe's type, rating, price range, phone number, website, address, plus code, and opening hours for each day of the week (today, in Toronto time, is highlighted). These come from the fixed cafe record's `typeOfStore`, `rating`, `priceRange`, `phoneNo`, `webLink`, `address`, `plusCodes`, `hoursByDay`, and `operatingHoursRaw` fields.

4. **Delete** – select **Delete** and confirm. The cafe is removed from the list and everything saved for it is permanently erased. Adding it again starts a fresh profile.

### Profile fields

| Field | Values |
| --- | --- |
| `wifiQuality`, `powerOutlets`, `studyFriendly`, `spacious`, `cleanliness`, `foodAndDrinkQuality` | `null` (not rated) or a whole number 1–5, where 5 is best |
| `noiseLevel` | `null` or a whole number 1–5, from 1 (silent) to 5 (loud) |
| `favorite` | `true` or `false` |
| `recommend` | `true` (recommend), `false` (don't recommend), or `null` (undecided) |
| `personalNotes` | Text, up to 1,000 characters |

The study score shown on each profile is the average of the ratings that have been filled in, with the noise level inverted so quieter cafes score higher. Ratings saved by earlier versions as `foodQuality` are read as `foodAndDrinkQuality` and replaced the next time the profile is saved.

## Data behavior

- Fixed cafe documents are read from `cafe_list`.`cafe list`. The app never inserts, updates, or deletes fixed cafe records; deleting a profile only affects the browser's own data in `user_input`.
- Every cafe in the browser's list has a pin on the map. Pins stay on the map through searches and filters and are removed only when the cafe profile is deleted. Favourites use an orange pin; search results that aren't in the list can be pinned temporarily with **Show on map** and use a dashed pin.
- Cafe records have addresses but no coordinates, so a pin's position is looked up through OpenStreetMap Nominatim when the cafe is added (or when **Show on map** is selected). The position is then saved on the cafe profile as `mapLocation`, so later visits show the pin without another lookup, and deleting the profile erases it. Lookups run one per second, as Nominatim's usage policy requires, and Toronto is added as search context when the address does not already mention it. Records that do include latitude/longitude or GeoJSON coordinates use them directly.
- The map starts centered on Toronto and uses Leaflet and OpenStreetMap tiles.
- A random token identifies an anonymous browser. No account or personal information is required. The page gets the token from `/api/session`, keeps it in `localStorage`, and sends it with every request in an `X-Study-Session` header, which keeps the list working even when the site is embedded in another page and the browser blocks its cookie. An HttpOnly cookie carrying the same token (valid for one year) remains as a fallback for direct API clients and for browsers that visited before the header existed; those browsers keep their existing list.
- Each profile is one document in `user_input`.`user input`, keyed to a hash of the anonymous session and the cafe ID.
- Profiles do not sync between devices. Clearing the browser's site data loses access to that browser's list.

## API

All responses are JSON. The list and search results return up to 100 fixed cafe documents.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/cafes` | List fixed cafe records |
| `GET` | `/api/cafes/search?terms=quiet` | Case-insensitive literal search |
| `GET` | `/api/session` | Start or resume an anonymous browser session |
| `POST` | `/api/collection/:cafeId` | **Create** a cafe profile in the current browser's list (201 when new) |
| `GET` | `/api/collection` | **Read** the cafes in the current browser's list |
| `GET` | `/api/preferences` | **Read** the saved profile fields for every cafe in the list |
| `PUT` | `/api/preferences/:cafeId` | **Update** a profile's ratings, note, favourite, and recommendation (404 if the cafe isn't in the list) |
| `PUT` | `/api/collection/:cafeId/location` | Save the map position (`{ "lat": 43.65, "lng": -79.38 }`) of a cafe in the list |
| `DELETE` | `/api/collection/:cafeId` | **Delete** a cafe profile and erase all of its saved data |

The earlier read paths `/api/items` and `/api/search?terms=...` remain aliases. Search matches cafe `title`, `name`, `cafeName`, `address`, or `location` fields. Adding a cafe only accepts IDs that exist in the fixed cafe collection.

Example, with `netlify dev` running (use port 3000 instead with `npm run dev`):

```sh
curl http://localhost:8888/api/cafes
curl "http://localhost:8888/api/cafes/search?terms=quiet"
```

A direct API client should first call `/api/session` and then either keep the returned cookie or send the returned `token` in an `X-Study-Session` header.

## Deploy to Netlify

1. Deploy the repository with Netlify's Git integration. `netlify.toml` configures the `frontend` publish directory, `backend/functions`, and the `/api/*` rewrite.
2. Add `MONGODB_URI`, `CAFE_DATABASE`, `CAFE_COLLECTION`, `USER_INPUT_DATABASE`, and `USER_INPUT_COLLECTION` to Netlify's environment variables for Functions. Mark only `MONGODB_URI` as sensitive; the database names and collection names are public configuration and should be non-sensitive. `PORT` is only used by `npm run dev` / `npm start` and does not need to be set on Netlify. The build configuration omits only those non-sensitive setting names from secret scanning; `MONGODB_URI` is not omitted.
3. Configure Atlas Network Access for Netlify and use the least-privileged database roles described above.
4. Verify `/`, `/api/cafes`, `/api/collection`, and `/api/preferences` in a deploy preview. Check Netlify function logs for database errors.

## Security notes

- The fixed collection is read-only through the API. Preference writes are scoped to a high-entropy anonymous browser token.
- Browser-specific preferences are not an account or a strong identity system; anyone who obtains that browser's token (from its cookie or `localStorage`) could access its saved list.
- The database URI shared in chat should be treated as exposed. Rotate its password in MongoDB Atlas and update local/Netlify environment settings before use.
