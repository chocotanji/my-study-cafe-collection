# Study Cafe Collection

A cafe directory backed by two MongoDB databases on one cluster. `cafe_list` contains fixed cafe information and is read-only through this app. `user_input` stores browser-specific Wi-Fi and food ratings, favorites, and personal notes. There are no accounts or public cafe-creation endpoints.

## Project layout

```text
backend/
  config/environment.js          Environment variables and database names
  database/connect.js            Shared MongoClient connection
  functions/api.js               Express app, Netlify handler, and local startup
  middleware/anonymousSession.js  Per-browser HttpOnly session cookie
  routes/cafes.js                Read and search fixed cafe records
  routes/preferences.js          Read and save per-browser preferences
  validation/preferences.js      Validate personal preference updates
frontend/
  index.html                     Cafe list and search
  script.js                      API requests and preference forms
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

Keep `.env.example` as the safe template. Copy it to the ignored local `.env`, replace the URI with a newly rotated credential, and never commit `.env`. Netlify uses the same variable names configured in its environment-variable settings; it does not read local `.env`.

The cafe database user should have read access to `cafe_list` and read/write access to `user_input`. The app creates a unique index on the preference collection the first time preferences are saved.

## Run locally

Use Node.js 22 or newer:

```sh
npm install
cp .env.example .env
npm test
npm run dev
```

Run these commands from the project directory containing `package.json`. Leave `NETLIFY` unset locally. The server connects to MongoDB before listening; configuration or database connection errors are reported at startup. Open [http://localhost:3000](http://localhost:3000).

## Data behavior

- Fixed cafe documents are read from `cafe_list`.`cafe list`. The app does not insert, update, or delete fixed cafe records.
- A random, HttpOnly cookie identifies an anonymous browser for up to one year. No account or personal information is required.
- That browser's preferences are stored in `user_input`.`user input`, keyed to a hash of the anonymous session and the cafe ID.
- Preferences do not sync between devices. Clearing the browser's cookies loses access to that browser's saved preferences.
- Preference fields: `wifiQuality` and `foodQuality` (optional whole numbers from 1–5), `favorite` (boolean), and `personalNotes` (up to 1,000 characters).

## API

All responses are JSON. The list and search results return up to 100 fixed cafe documents.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/api/cafes` | List fixed cafe records |
| `GET` | `/api/cafes/search?terms=quiet` | Case-insensitive literal search |
| `GET` | `/api/session` | Start or resume an anonymous browser session |
| `GET` | `/api/preferences` | Get preferences for the current browser |
| `PUT` | `/api/preferences/:cafeId` | Save Wi-Fi, food, favorite, and notes for a cafe |

The earlier read paths `/api/items` and `/api/search?terms=...` remain aliases. Search matches cafe `title`, `name`, `address`, or `location` fields. Preference updates only accept IDs that exist in the fixed cafe collection.

Example:

```sh
curl http://localhost:3000/api/cafes
curl "http://localhost:3000/api/cafes/search?terms=quiet"
```

The browser automatically sends the anonymous cookie for preference requests; a direct API client should first call `/api/session` and retain its cookie.

## Deploy to Netlify

1. Deploy the repository with Netlify's Git integration. `netlify.toml` configures the `frontend` publish directory, `backend/functions`, and the `/api/*` rewrite.
2. Add `MONGODB_URI`, `CAFE_DATABASE`, `CAFE_COLLECTION`, `USER_INPUT_DATABASE`, and `USER_INPUT_COLLECTION` to Netlify's environment variables for Functions.
3. Configure Atlas Network Access for Netlify and use the least-privileged database roles described above.
4. Verify `/`, `/api/cafes`, and `/api/preferences` in a deploy preview. Check Netlify function logs for database errors.

## Security notes

- The fixed collection is read-only through the API. Preference writes are scoped to a high-entropy, HttpOnly browser cookie.
- Browser-specific preferences are not an account or a strong identity system; anyone who obtains that browser cookie could access its saved preferences.
- The database URI shared in chat should be treated as exposed. Rotate its password in MongoDB Atlas and update local/Netlify environment settings before use.
