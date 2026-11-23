# Study Cafe Collection

A personal cafe collection backed by two MongoDB databases on one cluster. `cafe_list` contains fixed cafe information and is read-only through this app. `user_input` stores each browser's collection membership, Wi-Fi and food ratings, favorites, and personal notes. There are no accounts or public cafe-creation endpoints.

## Project layout

```text
backend/
  config/environment.js          Environment variables and database names
  database/connect.js            Shared MongoClient connection
  database/preferences.js        Shared per-browser preference collection
  functions/api.js               Express app, Netlify handler, and local startup
  middleware/anonymousSession.js  Per-browser HttpOnly session cookie
  routes/cafes.js                Search fixed cafe records
  routes/collection.js           Add and remove cafes from a browser collection
  routes/preferences.js        Read, save, and delete per-browser preferences
  validation/preferences.js      Validate personal preference updates
frontend/
  index.html                     Cafe list and search
  script.js                      API requests, map, and preference forms
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

Use Node.js 22 or newer:

```sh
npm install
npm test
npm run dev
```

Create `.env` locally with the settings above, then run these commands from the project directory containing `package.json`. Leave `NETLIFY` unset locally. The server connects to MongoDB before listening; configuration or database connection errors are reported at startup. Open [http://localhost:3000](http://localhost:3000).

## Data behavior

- Fixed cafe documents are read from `cafe_list`.`cafe list`. The app does not insert, update, or delete fixed cafe records. The website starts with an empty personal collection; users search the cafe directory and add profiles to their own browser collection.
- Removing a cafe with **Delete** only removes it from the current browser's collection. The shared cafe record and that browser's saved preferences remain in MongoDB, so the profile can be added again later.
- Cafe records with latitude/longitude or GeoJSON point coordinates appear as pins on the map. For address-only records, selecting **Show on map** looks up the exact address through OpenStreetMap Nominatim; those lookups are cached for the current page session.
- The map starts centered on Toronto and uses Leaflet and OpenStreetMap tiles. Address lookup requests are sent to Nominatim only after a user selects a cafe without coordinates; Toronto is added as search context when the address does not already mention it.
- A random, HttpOnly cookie identifies an anonymous browser for up to one year. No account or personal information is required.
- That browser's preferences are stored in `user_input`.`user input`, keyed to a hash of the anonymous session and the cafe ID.
- Preferences do not sync between devices. Clearing the browser's cookies loses access to that browser's saved preferences.
- Preference fields: `wifiQuality` and `foodQuality` (optional whole numbers from 1–5), `favorite` (boolean), and `personalNotes` (up to 1,000 characters).
- Preference updates use an upsert scoped to the current anonymous browser and cafe. Collection membership is stored alongside preferences in `user_input`.

## API

All responses are JSON. The list and search results return up to 100 fixed cafe documents.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/cafes` | List fixed cafe records |
| `GET` | `/api/cafes/search?terms=quiet` | Case-insensitive literal search |
| `GET` | `/api/collection` | List cafes in the current browser's personal collection |
| `POST` | `/api/collection/:cafeId` | Add a cafe to the current browser's collection |
| `DELETE` | `/api/collection/:cafeId` | Remove a cafe profile from the current browser's collection |
| `GET` | `/api/session` | Start or resume an anonymous browser session |
| `GET` | `/api/preferences` | Get preferences for the current browser |
| `PUT` | `/api/preferences/:cafeId` | Save Wi-Fi, food, favorite, and notes for a cafe |

The earlier read paths `/api/items` and `/api/search?terms=...` remain aliases. Search matches cafe `title`, `name`, `cafeName`, `address`, or `location` fields. Preference and collection updates only accept IDs that exist in the fixed cafe collection.

Example:

```sh
curl http://localhost:3000/api/cafes
curl "http://localhost:3000/api/cafes/search?terms=quiet"
```

The browser automatically sends the anonymous cookie for preference requests; a direct API client should first call `/api/session` and retain its cookie.

## Deploy to Netlify

1. Deploy the repository with Netlify's Git integration. `netlify.toml` configures the `frontend` publish directory, `backend/functions`, and the `/api/*` rewrite.
2. Add `MONGODB_URI`, `CAFE_DATABASE`, `CAFE_COLLECTION`, `USER_INPUT_DATABASE`, and `USER_INPUT_COLLECTION` to Netlify's environment variables for Functions. Mark only `MONGODB_URI` as sensitive; the database names and collection names are public configuration and should be non-sensitive. `PORT` is only used for local startup and does not need to be set on Netlify. The build configuration omits only those non-sensitive setting names from secret scanning; `MONGODB_URI` is not omitted.
3. Configure Atlas Network Access for Netlify and use the least-privileged database roles described above.
4. Verify `/`, `/api/cafes`, and `/api/preferences` in a deploy preview. Check Netlify function logs for database errors.

## Security notes

- The fixed collection is read-only through the API. Preference writes are scoped to a high-entropy, HttpOnly browser cookie.
- Browser-specific preferences are not an account or a strong identity system; anyone who obtains that browser cookie could access its saved preferences.
- The database URI shared in chat should be treated as exposed. Rotate its password in MongoDB Atlas and update local/Netlify environment settings before use.
